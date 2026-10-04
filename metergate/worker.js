// MeterGate v1 — settlement-conditioned release gate (Cloudflare Worker port).
// Port of ~/workspace/build_mode/metergate_live/metergate.py; see LIVE_TEST.md.
// No deployment implied by this file; it is code ready to deploy.
//
// Behaviour preserved from the Python daemon:
// - GET /resource releases a live CoinGecko spot-price snapshot ONLY after
//   settlement to PAY_TO is proven ($0.01 USDC on Base, eip155:8453, x402 v2
//   scheme "exact"). Without valid proof: HTTP 402 challenge naming PAY_TO.
// - Proof path A: PAYMENT-SIGNATURE header (EIP-3009) settled via the xpay
//   permissionless facilitator /verify + /settle (facilitator broadcasts and
//   pays gas; USDC lands directly at PAY_TO; we never sign anything).
// - Proof path B: X-PAYMENT-TX header (or ?tx=) — buyer settled on-chain
//   themselves; verified via Base public RPC: receipt success, USDC Transfer
//   >= price to PAY_TO, replay check, <= 24h old.
// - Funding-trace accounting (light ChainWard test): settled payers recently
//   funded in USDC by our own address set are flagged loop/self-funded and
//   NEVER counted as arrival. Unverifiable => not external, never arrival.
// - Discovery: /, /health, /price, /.well-known/x402,
//   /.well-known/agent.json, /skill.md, Bazaar extension on every 402.
// - Receive-only: holds no key, signs nothing, custodies nothing, fronts no gas.
//
// STATE TODOs — Workers has no local disk and no cross-isolate memory, so
// three pieces of Python process/disk state cannot be ported 1:1 yet:
//   TODO(KV): settlements.jsonl ledger. Python appends one JSON line per
//     settlement. Here settlements are emitted via console.log only and are
//     NOT persisted. Wire KV/D1 before treating this as accounting.
//   TODO(KV): replay set (_consumed_tx in Python, loaded from the ledger at
//     boot). Below is a best-effort in-isolate Set that resets whenever the
//     isolate recycles, so replay protection is WEAKER than the Python
//     daemon until KV (`consumed:{txhash}`, ~48h TTL) is wired.
//   TODO(Cache API, optional): the 30s CoinGecko price cache below is
//     in-isolate only (Python shared it process-wide). Hit-rate difference
//     only; no behavioural change for callers.
// Also not ported: the Python startup facilitator health check (Workers has
// no boot hook; facilitator failures surface per-request instead, same as the
// Python daemon's per-request calls after its best-effort boot check).

const FACILITATOR = "https://facilitator.xpay.sh";
const NETWORK = "eip155:8453"; // Base mainnet
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // native USDC on Base
const PAY_TO = "0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2"; // receive-only
const PRICE_ATOMIC = 10000; // $0.01 (USDC: 6 decimals)
const PRICE_HUMAN = "$0.01";
const MAX_TIMEOUT = 300;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BASE_RPCS = [
  "https://base.publicnode.com",
  "https://mainnet.base.org",
  "https://1rpc.io/base",
  "https://base-mainnet.public.blastapi.io",
];
// Our own address set for the funding-trace (loop) test: fleet payTo + cc0
// wallet. A payer recently funded in USDC by any of these is not external.
const OUR_ADDRESSES = new Set([
  PAY_TO.toLowerCase(),
  "0x5aa9d50abefaE3BEcADd9fe2975BBC7f034aC004".toLowerCase(),
]);
const TRACE_BLOCK_WINDOW = 2000; // blocks scanned for payer funding
const MAX_TX_AGE_SEC = 24 * 3600; // tx-proof freshness window
const COINGECKO = "https://api.coingecko.com/api/v3/simple/price";

// Best-effort in-isolate state (see STATE TODOs above).
const consumedTx = new Set(); // TODO(KV): replace with KV replay set
const priceCache = { at: 0, key: null, data: null }; // TODO(Cache API, optional)

// ---------------------------------------------------------------- helpers
function log(msg) {
  console.log(`[${new Date().toISOString().replace(/\.\d+Z$/, "Z")}] ${msg}`);
}

function sendJson(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

async function httpJson(url, payload = null, timeoutSec = 25) {
  const init = {
    method: payload !== null ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "User-Agent": "metergate/1.0" },
    signal: AbortSignal.timeout(timeoutSec * 1000),
  };
  if (payload !== null) init.body = JSON.stringify(payload);
  const resp = await fetch(url, init);
  return JSON.parse(await resp.text());
}

function b64(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function b64DecodeText(s) {
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------- Base RPC
async function rpc(method, params) {
  let last = null;
  for (const url of BASE_RPCS) {
    try {
      const out = await httpJson(
        url,
        { jsonrpc: "2.0", id: 1, method, params },
        15
      );
      if (out && out.error) {
        last = new Error(JSON.stringify(out.error));
        continue;
      }
      return out ? out.result ?? null : null;
    } catch (e) {
      last = e; // try next RPC
    }
  }
  throw new Error(`all Base RPCs failed for ${method}: ${last}`);
}

async function fundingTrace(payer) {
  // Light ChainWard funding-trace: was this payer recently funded in USDC by
  // one of OUR addresses? Returns [external, note]. Conservative: unverifiable
  // => [false, "unverified..."] so it never counts as arrival.
  payer = payer.toLowerCase();
  try {
    const latest = parseInt(await rpc("eth_blockNumber", []), 16);
    const fromBlock = Math.max(0, latest - TRACE_BLOCK_WINDOW);
    const topicTo = "0x" + "0".repeat(24) + payer.slice(2);
    const logs =
      (await rpc("eth_getLogs", [
        {
          address: USDC,
          topics: [TRANSFER_TOPIC, null, topicTo],
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "0x" + latest.toString(16),
        },
      ])) || [];
    for (const lg of logs) {
      const funder = "0x" + lg.topics[1].slice(-40);
      if (OUR_ADDRESSES.has(funder.toLowerCase())) {
        return [
          false,
          `loop: payer funded by our address ${funder} in tx ${lg.transactionHash}`,
        ];
      }
    }
    return [
      true,
      `no funding from our set in last ${TRACE_BLOCK_WINDOW} blocks (${logs.length} inbound USDC transfers seen)`,
    ];
  } catch (e) {
    return [false, `unverified: ${e.message || e}`];
  }
}

// ---------------------------------------------------------------- proofs
async function verifyTxProof(txHashRaw) {
  // Verify a buyer-presented settlement tx against PAY_TO on Base.
  // Returns [ok, payer, amountAtomic(BigInt), reason].
  const txHash = (txHashRaw || "").trim().toLowerCase();
  if (!(txHash.startsWith("0x") && txHash.length === 66)) {
    return [false, null, 0n, "malformed tx hash"];
  }
  try {
    BigInt(txHash);
  } catch {
    return [false, null, 0n, "malformed tx hash"];
  }
  if (consumedTx.has(txHash)) {
    // TODO(KV): in-isolate set only; see STATE TODOs in the header.
    return [false, null, 0n, "tx already consumed (replay rejected)"];
  }
  let receipt;
  try {
    receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  } catch (e) {
    return [false, null, 0n, `receipt lookup failed: ${e.message || e}`];
  }
  if (!receipt) return [false, null, 0n, "tx not found on Base"];
  if (receipt.status !== "0x1") return [false, null, 0n, "tx reverted on-chain"];
  const paytoTopic = "0x" + "0".repeat(24) + PAY_TO.toLowerCase().slice(2);
  let payer = null;
  let amount = 0n;
  for (const lg of receipt.logs || []) {
    if ((lg.address || "").toLowerCase() !== USDC.toLowerCase()) continue;
    const topics = lg.topics || [];
    if (
      topics.length >= 3 &&
      topics[0].toLowerCase() === TRANSFER_TOPIC &&
      topics[2].toLowerCase() === paytoTopic
    ) {
      payer = "0x" + topics[1].slice(-40);
      try {
        amount = BigInt(lg.data || "0x0");
      } catch {
        amount = 0n;
      }
      break;
    }
  }
  if (payer === null) {
    return [false, null, 0n, "no USDC transfer to payTo in this tx"];
  }
  if (amount < BigInt(PRICE_ATOMIC)) {
    return [false, payer, amount, `underpaid: ${amount} < ${PRICE_ATOMIC} atomic`];
  }
  try {
    const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    const ts = parseInt(block.timestamp, 16);
    if (Date.now() / 1000 - ts > MAX_TX_AGE_SEC) {
      return [false, payer, amount, "tx too old (>24h) - stale proof rejected"];
    }
  } catch {
    // age check best-effort, as in the Python version
  }
  return [true, payer, amount, "ok"];
}

async function settleViaFacilitator(paymentPayload) {
  // xpay /verify + /settle. Returns [ok, infoOrReason].
  const body = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements: paymentRequirements(),
  };
  let v;
  try {
    v = await httpJson(`${FACILITATOR}/verify`, body, 25);
  } catch (e) {
    return [false, `facilitator /verify unreachable: ${e.message || e}`];
  }
  if (!v || !v.isValid) {
    return [false, `payment invalid: ${(v && v.invalidReason) || "unknown"}`];
  }
  let s;
  try {
    s = await httpJson(`${FACILITATOR}/settle`, body, 90);
  } catch (e) {
    return [false, `facilitator /settle unreachable: ${e.message || e}`];
  }
  if (!s || !s.success) {
    return [false, `settlement failed: ${(s && s.errorReason) || "unknown"}`];
  }
  return [true, s];
}

// ---------------------------------------------------------------- x402 doc
function paymentRequirements() {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: String(PRICE_ATOMIC),
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT,
    extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
  };
}

function bazaarExtension() {
  return {
    info: {
      input: {
        type: "http",
        method: "GET",
        queryParams: {
          ids: "comma-separated CoinGecko ids, max 20 (default: bitcoin,ethereum)",
        },
      },
      output: {
        type: "json",
        example: {
          service: "metergate-spot",
          vs_currency: "usd",
          as_of: 1759564800,
          source: "coingecko",
          prices: { bitcoin: { usd: 114230.5, usd_24h_change: 1.24 } },
        },
      },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["input", "output"],
      properties: {
        input: {
          type: "object",
          required: ["type", "method"],
          properties: {
            type: { const: "http" },
            method: { const: "GET" },
            queryParams: { type: "object" },
          },
          additionalProperties: true,
        },
        output: {
          type: "object",
          required: ["type", "example"],
          properties: {
            type: { const: "json" },
            example: { type: "object" },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  };
}

function paymentRequiredBody(origin) {
  return {
    x402Version: 2,
    error: "payment required: settle to payTo, then present proof",
    resource: {
      url: origin + "/resource",
      description:
        "MeterGate v1 gated spot-price release: live crypto spot-price " +
        `snapshot (USD) for requested CoinGecko ids. Price: ${PRICE_HUMAN} ` +
        "USDC on Base. Output is released only after settlement to payTo " +
        "is proven (x402 PAYMENT-SIGNATURE via facilitator, or on-chain " +
        "tx proof via X-PAYMENT-TX).",
      mimeType: "application/json",
      serviceName: "MeterGate v1 (settlement-gated spot prices)",
      tags: ["crypto", "prices", "x402", "settlement-gated"],
    },
    accepts: [paymentRequirements()],
    extensions: { bazaar: bazaarExtension() },
  };
}

function resourceDescription(origin) {
  return paymentRequiredBody(origin).resource.description;
}

function skillMd(origin) {
  return (
    "# MeterGate v1\n\n" +
    "Settlement-gated crypto spot prices, pay-per-request via x402 v2.\n\n" +
    `- Endpoint: \`GET ${origin}/resource?ids=bitcoin,ethereum\`\n` +
    "- Price: $0.01 USDC on Base (eip155:8453), scheme `exact` (EIP-3009)\n" +
    `- Pay-to: \`${PAY_TO}\`\n` +
    `- Facilitator: ${FACILITATOR} (sponsors settlement gas)\n` +
    "- Release rule: the payload is produced only after settlement to pay-to " +
    "is proven - x402 PAYMENT-SIGNATURE (facilitator-settled) or an on-chain " +
    "USDC transfer tx presented via `X-PAYMENT-TX`. No payment, no artefact.\n" +
    "- Discovery: `/.well-known/x402`, `/.well-known/agent.json`, `/price`\n"
  );
}

// ---------------------------------------------------------------- resource
async function fetchPrices(ids) {
  const now = Date.now() / 1000;
  if (priceCache.key === ids && now - priceCache.at < 30) return priceCache.data;
  const url = `${COINGECKO}?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const out = await httpJson(url, null, 20);
  if (!out || typeof out !== "object" || Object.keys(out).length === 0) {
    throw new Error("empty response from price upstream");
  }
  priceCache.at = now;
  priceCache.key = ids;
  priceCache.data = out;
  return out;
}

function resourcePayload(ids, prices) {
  return {
    service: "metergate-spot",
    vs_currency: "usd",
    as_of: Math.floor(Date.now() / 1000),
    source: "coingecko",
    prices,
  };
}

// ---------------------------------------------------------------- accounting
async function recordSettlement(payer, amountAtomic, tx, mode) {
  // Mirrors the Python record_settlement + ledger_append, minus disk:
  // TODO(KV): persist this record to KV/D1 (the settlements.jsonl analogue)
  // instead of only logging it, and move the replay set to KV with it.
  const [external, note] = await fundingTrace(payer);
  const counted = Boolean(external) && mode !== "test";
  const rec = {
    payer,
    amount_atomic: amountAtomic.toString(),
    tx,
    mode,
    external_funded: external,
    trace_note: note,
    counted_arrival: counted,
    ts: Math.floor(Date.now() / 1000),
  };
  log(
    `settlement recorded: mode=${mode} payer=${payer} amount=${amountAtomic} ` +
      `external=${external} counted_arrival=${counted} (${note})`
  );
  if (tx && mode !== "test") consumedTx.add(String(tx).toLowerCase());
  return rec;
}

function recordTestProof(payer, tx) {
  // Mirrors the Python test-mode ledger entry (never counted as arrival).
  // TODO(KV): persist alongside real settlements when the ledger moves.
  log(`TEST settlement accepted (not arrival): payer=${payer} tx=${tx}`);
}

// ---------------------------------------------------------------- handlers
function fail402(reason, origin) {
  return sendJson({ error: reason, x402Version: 2 }, 402, {
    "PAYMENT-REQUIRED": b64(paymentRequiredBody(origin)),
  });
}

async function release(ids, payer, tx) {
  // Produce the gated artefact — only ever called after proof OK.
  let prices;
  try {
    prices = await fetchPrices(ids);
  } catch (e) {
    // paid but upstream down: be honest, as in the Python version
    return sendJson(
      { error: `price upstream unavailable: ${e.message || e}`, x402Version: 2 },
      502
    );
  }
  return sendJson(resourcePayload(ids, prices), 200, {
    "PAYMENT-RESPONSE": b64({
      success: true,
      transaction: tx,
      network: NETWORK,
      payer,
    }),
  });
}

async function handleResource(request, url, origin, testMode) {
  const idsParam = url.searchParams.get("ids");
  const ids = (idsParam ? idsParam : "bitcoin,ethereum").toLowerCase();
  if (
    ids.length > 200 ||
    ids.split(",").length > 20 ||
    !/^[a-z0-9,-]*$/.test(ids)
  ) {
    return sendJson({ error: "bad ids parameter", x402Version: 2 }, 400);
  }

  // Path B: on-chain tx proof
  const txParam = url.searchParams.get("tx");
  const txProof = request.headers.get("X-PAYMENT-TX") || (txParam ? txParam : null);
  if (txProof) {
    const [ok, payer, amount, reason] = await verifyTxProof(txProof);
    if (!ok) return fail402(`settlement proof rejected: ${reason}`, origin);
    const tx = txProof.trim().toLowerCase();
    await recordSettlement(payer, amount, tx, "tx-proof");
    return release(ids, payer, tx);
  }

  // Path A: facilitator-settled PAYMENT-SIGNATURE
  const sig = request.headers.get("PAYMENT-SIGNATURE");
  if (!sig) return fail402("payment required", origin);
  let payload;
  try {
    payload = JSON.parse(b64DecodeText(sig));
  } catch (e) {
    return sendJson(
      { error: `bad PAYMENT-SIGNATURE: ${e.message || e}`, x402Version: 2 },
      400
    );
  }

  // Test mode: synthetic proof, never counted as arrival.
  // NOTE (not 1:1 with Python): the daemon also required the client to be
  // loopback (127.0.0.1/::1). A Worker has no loopback clients, so that
  // restriction cannot be replicated; test mode here is gated ONLY by the
  // METERGATE_TEST_MODE env var. Keep it unset in any public deployment.
  if (payload && typeof payload === "object" && payload.test === true) {
    if (testMode) {
      const payer = String(payload.payer ?? "0xtestpayer");
      const tx = String(payload.tx ?? "0xtestproof");
      recordTestProof(payer, tx);
      return release(ids, payer, tx);
    }
    return fail402("test proofs are not accepted on the live path", origin);
  }

  const accepted = (payload && payload.accepted) || {};
  const scheme = payload?.scheme ?? accepted.scheme;
  const network = payload?.network ?? accepted.network;
  if (!payload || payload.x402Version !== 2 || scheme !== "exact") {
    return fail402("unsupported payment scheme/version", origin);
  }
  if (network !== NETWORK) {
    return fail402(`wrong network: ${network}`, origin);
  }

  const [ok, info] = await settleViaFacilitator(payload);
  if (!ok) return fail402(info, origin);
  const payer =
    info.payer || payload.payload?.authorization?.from || "unknown";
  const tx = info.transaction ?? null;
  await recordSettlement(payer, BigInt(PRICE_ATOMIC), tx, "facilitator");
  return release(ids, payer, tx);
}

// ---------------------------------------------------------------- worker
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = url.origin;
    const path = url.pathname;
    const testMode = Boolean(env && env.METERGATE_TEST_MODE === "1");
    log(`${request.method} ${path}`);

    if (path === "/health") {
      return sendJson({
        status: "ok",
        service: "metergate-v1",
        test_mode: testMode,
        payTo: PAY_TO,
      });
    }
    if (path === "/") {
      return sendJson({
        service: "MeterGate v1 - settlement-conditioned release gate (live test)",
        network: NETWORK,
        price_per_call: PRICE_HUMAN,
        asset: "USDC on Base",
        payTo: PAY_TO,
        facilitator: FACILITATOR,
        gated: {
          "/resource?ids=bitcoin,ethereum":
            "paid - released only after settlement proof to payTo",
        },
        discovery: ["/price", "/.well-known/x402", "/.well-known/agent.json", "/skill.md"],
        protocol: "x402 v2, scheme exact (EIP-3009); or on-chain tx proof (X-PAYMENT-TX)",
        test_mode: testMode,
      });
    }
    if (path === "/price") {
      return sendJson({
        service: "MeterGate v1",
        resource: origin + "/resource",
        price: {
          amount_atomic: String(PRICE_ATOMIC),
          human: PRICE_HUMAN,
          asset: USDC,
          asset_symbol: "USDC",
          network: NETWORK,
        },
        payTo: PAY_TO,
        how_to_pay:
          "GET /resource -> 402 challenge; then either (a) retry with " +
          "PAYMENT-SIGNATURE (x402 v2 exact/EIP-3009) - settled via " +
          `${FACILITATOR}; or (b) transfer >= ${PRICE_HUMAN} USDC to payTo ` +
          "on Base yourself and retry with header X-PAYMENT-TX: <tx hash>.",
        discovery: origin + "/.well-known/x402",
      });
    }
    if (path === "/.well-known/x402") {
      return sendJson({
        x402Version: 2,
        resources: [
          {
            url: origin + "/resource",
            method: "GET",
            description: resourceDescription(origin),
            accepts: [paymentRequirements()],
            extensions: { bazaar: bazaarExtension() },
          },
        ],
      });
    }
    if (path === "/.well-known/agent.json") {
      return sendJson({
        version: "1.3",
        origin: url.host,
        display_name: "MeterGate v1",
        description:
          "Settlement-gated spot-price snapshots (USD), $0.01 USDC " +
          "per request on Base via x402 v2. Output released only " +
          "after settlement to the pay-to address is proven.",
        payout_address: PAY_TO,
        payments: {
          x402: { networks: [{ network: "base", asset: "USDC", contract: USDC }] },
        },
        intents: [
          {
            name: "get_gated_spot_price",
            description:
              "Live USD spot prices + 24h change, released after settlement proof.",
            endpoint: origin + "/resource",
            method: "GET",
            price: { amount: 0.01, currency: "USDC" },
          },
        ],
      });
    }
    if (path === "/skill.md") {
      return new Response(skillMd(origin), {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      });
    }
    if (path === "/resource") {
      return handleResource(request, url, origin, testMode);
    }
    return sendJson({ error: "not found" }, 404);
  },
};
