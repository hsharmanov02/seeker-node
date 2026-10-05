// src/index.js — Cloudflare Worker entry point.
//
// Two serving tiers, one Worker:
//
//   TIER 1 — RapidAPI (existing, untouched):
//     client -> RapidAPI gateway (key/plan enforcement, billing) -> this Worker
//     RapidAPI injects X-RapidAPI-Proxy-Secret on every proxied request.
//     GET /health, GET /reputation?url=<url-or-domain>
//
//   TIER 2 — MCP + x402 (new): machine customers pay per tool call.
//     POST /mcp  (MCP Streamable HTTP, JSON-RPC 2.0)
//       initialize / notifications/initialized / tools/list  -> FREE
//       tools/call check_reputation                          -> $0.01 USDC/call on Base,
//          paid via x402 v2 (EIP-3009 exact). Unpaid calls get HTTP 402 with a
//          base64 PAYMENT-REQUIRED header (canonical v2 envelope) AND a
//          JSON-RPC error body, so both x402-native and MCP clients can pay.
//     Settlement: buyer signs off-chain, this Worker forwards to the xpay
//     facilitator (https://facilitator.xpay.sh) /verify then /settle.
//     xpay submits the tx and PAYS THE GAS ITSELF. USDC lands at PAY_TO.
//     The server NEVER signs, holds no funds, and never sees a private key.
//
// Env vars (set with `npx wrangler secret put <NAME>`):
//   PROXY_SECRET   required in production — the RapidAPI proxy secret.
//                  If unset, auth is skipped (local dev / wrangler dev only).
//   ABUSEIPDB_KEY  optional — free AbuseIPDB key (1,000 checks/day).
//                  The API degrades gracefully without it.

import { checkReputation } from './reputation.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store', // verdicts are per-query; never cache at edge
};

// ---------------------------------------------------------------------------
// x402 settlement config (mirrors the proven x402-spot-prices worker)
// ---------------------------------------------------------------------------
const FACILITATOR = 'https://facilitator.xpay.sh';
const NETWORK = 'eip155:8453'; // Base mainnet
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // native USDC on Base (Circle official)
const PAY_TO = '0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2'; // receive-only; key never on server
const MONAD_NETWORK = "eip155:143";
const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"; // USDC on Monad mainnet
const MONAD_FACILITATOR = "https://facilitator.pieverse.io"; // keyless, gas-sponsored
const PRICE_ATOMIC = '10000'; // $0.01 USDC per threat check (unified 2026-09-29)
const PRICE_HUMAN = '$0.01';
const MAX_TIMEOUT = 300;

// Cheap in-memory per-IP guard. RapidAPI enforces real plan quotas; this only
// blunts accidental floods from a single client (120 req/min/IP).
const _hits = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
function rateLimited(ip) {
  const now = Date.now();
  let e = _hits.get(ip);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + RATE_WINDOW_MS };
    _hits.set(ip, e);
    if (_hits.size > 2000) _hits.clear();
  }
  e.count += 1;
  return e.count > RATE_LIMIT;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function b64encode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s) {
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ---------------------------------------------------------------------------
// x402 v2 payment envelope
// ---------------------------------------------------------------------------
function paymentRequirements() {
  return {
    scheme: 'exact',
    network: NETWORK,
    amount: PRICE_ATOMIC,
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT,
    extra: {
      assetTransferMethod: 'eip3009',
      name: 'USDC',
      version: '2',
    },
  };
}
function paymentRequirementsMonad() {
  return {
    scheme: 'exact',
    network: MONAD_NETWORK,
    amount: PRICE_ATOMIC,
    asset: MONAD_USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT,
    extra: {
      assetTransferMethod: 'eip3009',
      name: 'MONAD_USDC',
      version: '2',
    },
  };
}

const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'Full URL to check, e.g. https://example.com/login',
    },
    domain: {
      type: 'string',
      description: 'Domain to check, e.g. example.com',
    },
    ip: {
      type: 'string',
      description: 'IPv4 or IPv6 address to check, e.g. 203.0.113.7',
    },
  },
  minProperties: 1,
  anyOf: [{ required: ['url'] }, { required: ['domain'] }, { required: ['ip'] }],
};

const TOOL_EXAMPLE_OUTPUT = {
  input: 'https://example.com/login',
  verdict: 'clean',
  score: 0,
  signals: {
    urlhaus_listed: false,
    abuseipdb_confidence: null,
    spamhaus_listed: false,
    domain_age_days: 11231,
  },
  checked_at: '2026-09-29T10:00:00.000Z',
};

function bazaarExtension() {
  return {
    info: {
      input: {
        type: 'mcp',
        protocol: 'Streamable HTTP (JSON-RPC 2.0)',
        method: 'tools/call',
        tool: 'check_reputation',
        argsSchema: TOOL_INPUT_SCHEMA,
      },
      output: {
        type: 'json',
        example: TOOL_EXAMPLE_OUTPUT,
      },
    },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['input', 'output'],
      properties: {
        input: { type: 'object', additionalProperties: true },
        output: { type: 'object', additionalProperties: true },
      },
      additionalProperties: true,
    },
  };
}

function paymentRequiredResponse(base) {
  return {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: {
      url: base + '/mcp',
      description:
        'MCP tool check_reputation: is this URL/domain/IP malicious? ' +
        `Verdict + score + signals. Price: ${PRICE_HUMAN} USDC on Base per call.`,
      mimeType: 'application/json',
      serviceName: 'Threat Reputation MCP',
      tags: ['security', 'threat-intel', 'reputation', 'mcp', 'x402'],
    },
    accepts: [paymentRequirements(), paymentRequirementsMonad()],
    extensions: { bazaar: bazaarExtension() },
  };
}

// HTTP 402 carrying BOTH the canonical x402 header (for x402-native clients)
// and a JSON-RPC error body (for MCP clients).
function mcpFail402(reason, base, rpcId) {
  const body = {
    jsonrpc: '2.0',
    ...(rpcId !== undefined ? { id: rpcId } : {}),
    error: {
      code: 402,
      message:
        `Payment required: ${PRICE_HUMAN} USDC on Base (${NETWORK}) via x402 v2. ` +
        'Sign an EIP-3009 TransferWithAuthorization and retry this tools/call ' +
        'with a PAYMENT-SIGNATURE header carrying the base64 payment payload. ' +
        `Settlement is sponsored (no gas needed); funds go to ${PAY_TO}.`,
      data: {
        x402Version: 2,
        reason,
        accepts: [paymentRequirements(), paymentRequirementsMonad()],
        facilitator: FACILITATOR,
      },
    },
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': b64encode(paymentRequiredResponse(base)),
    },
  });
}

async function settleViaXpay(paymentPayload) {
  const _reqNet = paymentPayload.network || (paymentPayload.accepted || {}).network;
  const _fac = _reqNet === MONAD_NETWORK ? MONAD_FACILITATOR : FACILITATOR;
  const body = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements: paymentRequirements(),
  };
  let v;
  try {
    const r = await fetch(`${_fac}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    v = await r.json();
  } catch (e) {
    return { ok: false, reason: `facilitator /verify unreachable: ${e}` };
  }
  if (!v.isValid) {
    return { ok: false, reason: `payment invalid: ${v.invalidReason || 'unknown'}` };
  }
  let s;
  try {
    const r = await fetch(`${_fac}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    s = await r.json();
  } catch (e) {
    return { ok: false, reason: `facilitator /settle unreachable: ${e}` };
  }
  if (!s.success) {
    return { ok: false, reason: `settlement failed: ${s.errorReason || 'unknown'}` };
  }
  return { ok: true, info: s };
}

// ---------------------------------------------------------------------------
// MCP (Streamable HTTP) — JSON-RPC 2.0 over POST /mcp
// ---------------------------------------------------------------------------
const MCP_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = {
  name: 'threat-reputation',
  title: 'Threat Reputation API',
  version: '1.0.0',
};

function toolDefinition() {
  return {
    name: 'check_reputation',
    title: 'Check threat reputation',
    description:
      'Check whether a URL, domain, or IP address is malicious. Returns a ' +
      'verdict (clean / suspicious / malicious), a 0-100 risk score, and the ' +
      'threat-intel signals behind it (URLhaus, AbuseIPDB, Spamhaus ZEN, ' +
      'domain age, heuristics). ' +
      `PRICE: ${PRICE_HUMAN} USDC on Base (${NETWORK}) per call, paid via ` +
      'x402 v2: call without payment to receive HTTP 402 with payment ' +
      'instructions, then retry with a PAYMENT-SIGNATURE header carrying the ' +
      'signed EIP-3009 authorization. No API key needed.',
    inputSchema: TOOL_INPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: {
      'x402/payment': {
        price: PRICE_HUMAN,
        atomicAmount: PRICE_ATOMIC,
        asset: 'USDC',
        assetContract: USDC,
        network: NETWORK,
        scheme: 'exact',
        payTo: PAY_TO,
        facilitator: FACILITATOR,
      },
    },
  };
}

function rpcResult(id, result) {
  return json({ jsonrpc: '2.0', id, result });
}

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return json({ jsonrpc: '2.0', id, error: err });
}

async function handleToolsCall(id, params, request, env, base) {
  const name = params && params.name;
  if (name !== 'check_reputation') {
    return rpcError(id, -32602, `unknown tool: ${name || '(missing)'}`);
  }
  const args = (params && params.arguments) || {};
  const raw = args.url || args.domain || args.ip;
  if (!raw || typeof raw !== 'string') {
    return rpcError(id, -32602, 'provide one of: url, domain, ip (string)');
  }

  // --- x402 gate: unpaid calls fail closed with a payable 402 ---
  const sigHeader = request.headers.get('PAYMENT-SIGNATURE');
  if (!sigHeader) return mcpFail402('payment required', base, id);

  let payload;
  try {
    payload = b64decode(sigHeader);
  } catch (e) {
    return rpcError(id, -32602, `bad PAYMENT-SIGNATURE: ${e}`);
  }

  // Canonical x402 v2 PaymentPayload carries scheme/network inside `accepted`.
  const accepted = payload.accepted || {};
  const scheme = payload.scheme || accepted.scheme;
  const network = payload.network || accepted.network;
  if (payload.x402Version !== 2 || scheme !== 'exact') {
    return mcpFail402('unsupported payment scheme/version', base, id);
  }
  if (network !== NETWORK && network !== MONAD_NETWORK) {
    return mcpFail402(`wrong network: ${network}`, base, id);
  }

  const { ok, info, reason } = await settleViaXpay(payload);
  if (!ok) return mcpFail402(reason, base, id);

  // --- paid: serve the verdict ---
  let verdict;
  try {
    verdict = await checkReputation(raw, { abuseIPDBKey: env.ABUSEIPDB_KEY || null });
  } catch (err) {
    const status = err.statusCode || 500;
    // Never echo the raw input back on 500s; 400s carry safe hints only.
    return rpcError(
      id,
      -32603,
      status === 400 ? 'bad_request: provide a valid url, domain, or ip' : 'internal_error'
    );
  }

  const paymentResponse = b64encode({
    success: true,
    transaction: info.transaction,
    network: info.network || NETWORK,
    payer: info.payer,
  });
  return json(
    {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(verdict) }],
        isError: false,
      },
    },
    200,
    { 'PAYMENT-RESPONSE': paymentResponse }
  );
}

async function handleMcpMessage(msg, request, env, base) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id, -32600, 'invalid JSON-RPC 2.0 request');
  }
  const id = msg.id;
  switch (msg.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'Threat-intel lookups for AI agents. tools/list is free. ' +
          `tools/call check_reputation costs ${PRICE_HUMAN} USDC on Base per call ` +
          '(x402 v2, EIP-3009 exact). Call unpaid to receive payment instructions (HTTP 402).',
      });
    case 'notifications/initialized':
      // Notification: no id, no response body per JSON-RPC; 202 accepted.
      return new Response(null, { status: 202 });
    case 'tools/list':
      return rpcResult(id, { tools: [toolDefinition()] });
    case 'tools/call':
      return handleToolsCall(id, msg.params, request, env, base);
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

async function handleMcp(request, env, base) {
  if (request.method !== 'POST') {
    return json(
      { error: 'method_not_allowed', hint: 'POST JSON-RPC 2.0 to /mcp (Streamable HTTP)' },
      405
    );
  }
  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return json({ error: 'bad_request', hint: 'Content-Type must be application/json' }, 400);
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'bad_request', hint: 'invalid JSON body' }, 400);
  }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (rateLimited(ip)) {
    return json({ error: 'rate_limited', retry_after_seconds: 60 }, 429);
  }
  if (Array.isArray(body)) {
    // JSON-RPC batch: handle each, return array of non-notification responses.
    const out = [];
    for (const m of body) {
      const r = await handleMcpMessage(m, request, env, base);
      if (r.status !== 202) out.push(await r.json());
    }
    return json(out.length ? out : null, out.length ? 200 : 202);
  }
  return handleMcpMessage(body, request, env, base);
}

// ---------------------------------------------------------------------------
// Machine-discovery documents
// ---------------------------------------------------------------------------
function x402WellKnown(base) {
  return {
    x402Version: 2,
    resources: [
      {
        url: base + '/mcp',
        method: 'POST',
        protocol: 'MCP Streamable HTTP (JSON-RPC 2.0)',
        description: paymentRequiredResponse(base).resource.description,
        accepts: [paymentRequirements(), paymentRequirementsMonad()],
        extensions: { bazaar: bazaarExtension() },
      },
    ],
  };
}

function agentJson(base) {
  const origin = base.replace(/^https?:\/\//, '');
  return {
    version: '1.3',
    origin,
    display_name: 'Threat Reputation MCP',
    description:
      'MCP server (Streamable HTTP): check whether a URL, domain, or IP is ' +
      `malicious. ${PRICE_HUMAN} USDC per tool call on Base, paid via x402 v2 (no API key).`,
    payout_address: PAY_TO,
    payments: {
      x402: {
        networks: [{ network: 'base', asset: 'USDC', contract: USDC }],
      },
    },
    mcp: {
      endpoint: base + '/mcp',
      transport: 'streamable-http',
      tools: [
        {
          name: 'check_reputation',
          price: { amount: 0.01, currency: 'USDC' },
        },
      ],
    },
  };
}

function skillMd(base) {
  return (
    '# Threat Reputation MCP\n\n' +
    'Threat-intel lookups for AI agents, pay-per-call via x402 v2.\n\n' +
    `- MCP endpoint (Streamable HTTP): \`POST ${base}/mcp\`\n` +
    `- Tool: \`check_reputation({url | domain | ip})\` → ` +
    '{verdict: clean|suspicious|malicious, score 0-100, signals}\n' +
    `- Price: ${PRICE_HUMAN} USDC on Base (${NETWORK}), scheme \`exact\` (EIP-3009)\n` +
    `- Pay-to: \`${PAY_TO}\` (receive-only; server never signs)\n` +
    `- Facilitator: ${FACILITATOR} (sponsors settlement gas — buyer needs no ETH)\n` +
    '- Flow: `initialize` → `tools/list` (free) → `tools/call` unpaid → HTTP 402 ' +
    'with base64 `PAYMENT-REQUIRED` header → retry with `PAYMENT-SIGNATURE` header.\n' +
    '- Discovery: `/.well-known/x402`, `/.well-known/agent.json`, ' +
    'Bazaar `extensions.bazaar` on every 402.\n' +
    '- Also served via RapidAPI (human tier): ' +
    'https://rapidapi.com/hsharmanov07/api/threat-reputation-api\n'
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const base = `${url.protocol}//${url.host}`;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    // Liveness probe (also useful for RapidAPI's endpoint test).
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ status: 'ok', time: new Date().toISOString() });
    }

    // --- TIER 2: MCP + x402 (paid per tool call) ---
    if (url.pathname === '/mcp') {
      return handleMcp(request, env, base);
    }
    if (url.pathname === '/.well-known/x402' && request.method === 'GET') {
      return json(x402WellKnown(base));
    }
    if (url.pathname === '/.well-known/agent.json' && request.method === 'GET') {
      return json(agentJson(base));
    }
    if (url.pathname === '/skill.md' && request.method === 'GET') {
      return new Response(skillMd(base), {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      });
    }
    if (url.pathname === '/' && request.method === 'GET') {
      return json({
        service: 'threat-reputation',
        tiers: {
          rapidapi: 'GET /reputation (human tier, RapidAPI key)',
          mcp_x402: `POST /mcp (machine tier, ${PRICE_HUMAN} USDC/call on Base)`,
        },
        mcp_endpoint: base + '/mcp',
        price_per_call: PRICE_HUMAN,
        asset: 'USDC on Base',
        payTo: PAY_TO,
        protocol: 'MCP Streamable HTTP + x402 v2, scheme exact (EIP-3009)',
      });
    }

    // --- TIER 1: RapidAPI (existing behavior, untouched) ---
    if (url.pathname !== '/reputation' || request.method !== 'GET') {
      return json(
        { error: 'not_found', hint: 'GET /reputation?url=<url-or-domain> or POST /mcp' },
        404
      );
    }

    // --- marketplace auth: reject direct hits without the proxy secret ---
    const expected = env.PROXY_SECRET;
    if (expected) {
      const got = request.headers.get('X-RapidAPI-Proxy-Secret');
      if (!got || got !== expected) {
        return json({ error: 'unauthorized', hint: 'missing or invalid proxy secret' }, 401);
      }
    }

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (rateLimited(ip)) {
      return json({ error: 'rate_limited', retry_after_seconds: 60 }, 429);
    }

    const raw = url.searchParams.get('url')
      || url.searchParams.get('domain')
      || url.searchParams.get('ip');
    if (!raw) {
      return json({ error: 'bad_request', hint: 'provide ?url=<url-or-domain> (or ?domain= / ?ip=)' }, 400);
    }

    try {
      const result = await checkReputation(raw, { abuseIPDBKey: env.ABUSEIPDB_KEY || null });
      return json(result);
    } catch (err) {
      const status = err.statusCode || 500;
      // Never echo the raw input back on 500s; 400s carry safe hints only.
      return json({ error: status === 400 ? 'bad_request' : 'internal_error' }, status);
    }
  },
};
