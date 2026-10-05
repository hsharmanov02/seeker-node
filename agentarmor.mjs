/**
 * agentarmor-mcp — Agent Armor: threat-intel tools for AI agents (MCP, Streamable HTTP).
 *
 * Wraps Liminal's live $1/call threat-intel endpoints as MCP tools so any
 * MCP-capable agent can screen URLs, domains, IPs and tokens before acting:
 *   - threat_report -> POST https://x402-spot-prices.hsharmanov02.workers.dev/threat-report ($1)
 *   - site_audit    -> POST .../site-audit   ($1)
 *   - bulk_screen   -> POST .../bulk          ($1, up to 100 ops)
 *
 * PAYMENT MODEL (agent-native, server holds no funds, never signs):
 *   /mcp itself is FREE — no x402 gate. Each tool accepts an optional
 *   `payment_signature` (base64 x402 v2 payment payload). Without it, the
 *   server proxies to the upstream, receives HTTP 402, and returns the
 *   decoded payment terms (accepts: networks, amounts, payTo) so the calling
 *   agent can pay from its OWN wallet and retry with the signature.
 *   With a signature, the server forwards it in the PAYMENT-SIGNATURE header
 *   and returns the paid result. Integrators pay $1 USDC per call via x402.
 *
 * $0 capital: no secrets, no signing, no fund custody.
 */

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "agentarmor-mcp", title: "Agent Armor — Threat Intel for AI Agents", version: "1.0.0" };
const UPSTREAM = "https://x402-spot-prices.hsharmanov02.workers.dev";
const PRICE_NOTE = "$1.00 USDC per call via x402 (Base, Monad, Arbitrum, Optimism, Polygon, Avalanche, Solana)";

// --- rate limiting (per-IP, in-memory) ---
const _hits = new Map();
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

// --- http helpers ---
function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}
function rpcResult(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return json({ jsonrpc: "2.0", id, error: err });
}
function mcpText(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}
function mcpError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// --- validation ---
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i;
const TOKEN_RE = /^0x[0-9a-fA-F]{40}$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

function b64decode(s) {
  // Works in Workers (atob) and Node (Buffer).
  if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("utf8");
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function callUpstream(path, body, paymentSignature) {
  const headers = { "Content-Type": "application/json", "User-Agent": "agentarmor-mcp/1.0" };
  if (paymentSignature) headers["PAYMENT-SIGNATURE"] = paymentSignature;
  const r = await fetch(`${UPSTREAM}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (r.status === 402) {
    // No payment: hand the agent the exact terms so it can pay from its own wallet.
    let accepts = null;
    const pr = r.headers.get("PAYMENT-REQUIRED");
    if (pr) {
      try {
        const decoded = JSON.parse(b64decode(pr));
        accepts = decoded.accepts || decoded.resource?.accepts || null;
      } catch (e) { /* fall through to body */ }
    }
    let detail = null;
    try { detail = await r.json(); } catch (e) { /* ignore */ }
    return {
      status: "payment_required",
      tool: path,
      price: PRICE_NOTE,
      accepts,
      upstream_detail: detail,
      how_to_pay:
        "Sign an x402 v2 'exact'-scheme USDC payment for one of the accepts above " +
        "from your own wallet (amount = 1000000 atomic = $1.00), base64-encode the " +
        "payment payload, and call this tool again with payment_signature set. " +
        "This server never sees your keys and never signs.",
    };
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`upstream ${path} HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  return { status: "ok", tool: path, result: await r.json() };
}

// --- tool definitions ---
const TOOLS = [
  {
    name: "threat_report",
    title: "Threat Report",
    description:
      "Full threat-intel verdict on a domain, IP, or ERC-20 token (DNS, RDAP/domain age, SSL, " +
      "HTTP security headers, stack fingerprinting, email deliverability, geo). " + PRICE_NOTE + ". " +
      "Free to call without payment_signature — returns the x402 payment terms so your wallet can pay and retry.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain to assess (provide exactly one of domain, ip, token)." },
        ip: { type: "string", description: "IPv4/IPv6 address to assess." },
        token: { type: "string", description: "ERC-20 contract address (0x + 40 hex)." },
        chain: { type: "string", enum: ["base", "ethereum"], default: "base", description: "Chain for token assessment." },
        payment_signature: { type: "string", description: "Optional base64 x402 v2 payment payload. Omit to receive payment terms first." },
      },
    },
  },
  {
    name: "site_audit",
    title: "Site Audit",
    description:
      "Deep audit of a live website: SSL certificate, security headers, DNS, and technology stack. " +
      PRICE_NOTE + ". Free to call without payment_signature — returns the x402 payment terms so your wallet can pay and retry.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "http(s) URL to audit (ports 80/443 only)." },
        payment_signature: { type: "string", description: "Optional base64 x402 v2 payment payload. Omit to receive payment terms first." },
      },
    },
  },
  {
    name: "bulk_screen",
    title: "Bulk Screen",
    description:
      "Screen up to 100 targets in one call. Each op: price {ids?}, fx {from?,to?}, geo {ip}, dns {domain,types?}, " +
      "rdap {domain}, email {domain}, ssl {domain}, headers {url}, text {url}, stack {domain}. " +
      PRICE_NOTE + " per bulk call (not per op). Free to call without payment_signature — returns payment terms first.",
    inputSchema: {
      type: "object",
      required: ["ops"],
      properties: {
        ops: {
          type: "array", minItems: 1, maxItems: 100,
          items: { type: "object" },
          description: "Array of 1-100 operation objects, e.g. {\"geo\": {\"ip\": \"1.2.3.4\"}}.",
        },
        payment_signature: { type: "string", description: "Optional base64 x402 v2 payment payload. Omit to receive payment terms first." },
      },
    },
  },
];

function argError(msg) {
  return mcpError(`invalid_arguments: ${msg}`);
}

async function handleToolsCall(id, params) {
  const name = params?.name;
  const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
  const sig = typeof args.payment_signature === "string" && args.payment_signature ? args.payment_signature : null;
  try {
    if (name === "threat_report") {
      const { domain, ip, token, chain } = args;
      const provided = [domain, ip, token].filter((v) => typeof v === "string" && v);
      if (provided.length !== 1) return rpcResult(id, mcpError("invalid_arguments: provide exactly one of domain, ip, token."));
      const body = {};
      if (domain) {
        if (!DOMAIN_RE.test(domain)) return rpcResult(id, argError("domain is not a valid domain name."));
        body.domain = domain.toLowerCase();
      } else if (ip) {
        if (!IPV4_RE.test(ip) && !IPV6_RE.test(ip)) return rpcResult(id, argError("ip is not a valid IPv4/IPv6 address."));
        body.ip = ip;
      } else {
        if (!TOKEN_RE.test(token)) return rpcResult(id, argError("token must be 0x + 40 hex chars."));
        body.token = token;
        if (chain !== undefined) {
          if (chain !== "base" && chain !== "ethereum") return rpcResult(id, argError("chain must be 'base' or 'ethereum'."));
          body.chain = chain;
        }
      }
      const out = await callUpstream("/threat-report", body, sig);
      return rpcResult(id, mcpText(out));
    }
    if (name === "site_audit") {
      const { url } = args;
      if (typeof url !== "string" || !URL_RE.test(url)) return rpcResult(id, argError("url must be an http(s) URL."));
      const out = await callUpstream("/site-audit", { url }, sig);
      return rpcResult(id, mcpText(out));
    }
    if (name === "bulk_screen") {
      const { ops } = args;
      if (!Array.isArray(ops) || ops.length < 1 || ops.length > 100)
        return rpcResult(id, argError("ops must be an array of 1-100 operation objects."));
      if (!ops.every((o) => o && typeof o === "object" && !Array.isArray(o)))
        return rpcResult(id, argError("every op must be an object."));
      const out = await callUpstream("/bulk", { ops }, sig);
      return rpcResult(id, mcpText(out));
    }
    return rpcError(id, -32602, `unknown tool: ${name}`);
  } catch (e) {
    return rpcResult(id, mcpError(`upstream_error: ${e.message || e}`));
  }
}

// --- MCP message router ---
async function handleMcpMessage(msg, request) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && msg.id, -32600, "invalid JSON-RPC 2.0 request");
  }
  const id = msg.id;
  switch (msg.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "Agent Armor: threat-intel tools for AI agents. Screen a domain, IP, token, or website " +
          "before your agent interacts with it. Calling a tool without payment_signature returns the " +
          "x402 payment terms ($1.00 USDC per call); pay from your own wallet and retry with " +
          "payment_signature to get the report. This server never holds funds or signs.",
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call":
      return handleToolsCall(id, msg.params);
    case "ping":
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

async function handleMcp(request) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", hint: "POST JSON-RPC 2.0 to /mcp (Streamable HTTP)" }, 405);
  }
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    return json({ error: "bad_request", hint: "Content-Type must be application/json" }, 400);
  }
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: "bad_request", hint: "invalid JSON body" }, 400); }
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (rateLimited(ip)) return json({ error: "rate_limited", retry_after_seconds: 60 }, 429);
  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) {
      const r = await handleMcpMessage(m, request);
      if (r.status !== 202) out.push(await r.json());
    }
    return json(out.length ? out : null, out.length ? 200 : 202);
  }
  return handleMcpMessage(body, request);
}

// --- worker entrypoint ---
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return handleMcp(request);
    if (url.pathname === "/health") return json({ ok: true, service: "agentarmor-mcp", tools: TOOLS.map((t) => t.name), upstream: UPSTREAM });
    if (url.pathname === "/") {
      return json({
        service: "agentarmor-mcp",
        title: SERVER_INFO.title,
        mcp_endpoint: "/mcp",
        tools: TOOLS.map((t) => t.name),
        pricing: PRICE_NOTE,
        docs: "see README.md in the public repo",
      });
    }
    return json({ error: "not_found" }, 404);
  },
};
