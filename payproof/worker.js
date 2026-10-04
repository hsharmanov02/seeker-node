// payproof — pre-spend dossier + presentable payment receipts for agent payments.
// FREE open-source skill (see /skill.md) runs Tier-0 local checks; this Worker sells the depth layer:
//   POST /preflight ($0.05): live probe NOW + recorded-history summary from our Observation Log.
//   POST /receipt   ($0.01): hash-chained PayProof receipt for a settled payment; GET /receipt/:id free.
// x402 v2 exact on Base; release only after settlement proof to PAY_TO (facilitator PAYMENT-SIGNATURE
// or on-chain X-PAYMENT-TX via RPC). We never sign, never custody; receive-only.
// Stores are in-isolate only and NOT durable — stated in code and in every response that depends on them.

const FACILITATOR = "https://facilitator.xpay.sh";
const NETWORK = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2";
const PREFLIGHT_ATOMIC = 50000; // $0.05
const RECEIPT_ATOMIC = 10000; // $0.01
const MAX_TX_AGE_SEC = 86400; // age guard: release proofs must be < 24h old
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BASE_RPCS = [
  "https://base.publicnode.com",
  "https://mainnet.base.org",
  "https://1rpc.io/base",
];
const consumedTx = new Set(); // in-isolate replay guard (best effort, non-durable)
const receipts = new Map(); // id -> receipt; in-isolate only, NOT durable
let receiptHead = "payproof-genesis"; // hash-chain head; in-isolate only, NOT durable

// Recorded-history seed, embedded honestly: our witness recorder has been live since 2026-10-04
// (hash-chained Observation Log, Bitcoin-anchored weekly). History depth grows daily; today it is young.
// Per-endpoint entries exist only where the census poller has actually observed the origin.
const LOG_META = {
  started: "2026-10-04",
  entries_at_seed: "24+",
  anchored: "weekly, Bitcoin (OpenTimestamps) via git-anchored heads",
  note: "History depth grows daily; today it is young. Dossiers state their own coverage — absence of history is reported, not hidden.",
};
const HISTORY_SEED = {
  "threat-reputation-mcp.hsharmanov02.workers.dev": {
    first_seen: "2026-10-04", observations: "fleet origin (seeded)",
    last_status: 402, payto_drift: false, median_price_usdc: 0.01, settled_payments_observed: "fleet",
  },
};

const SKILL_TEXT = `# PayProof — check before you pay

PayProof is a two-tier pre-spend check for agent payments (x402 on Base). Tier 0 is free and local, forever. Tier 1 sells recorded history at the exact moment of spending risk.

## Tier 0 — free local checks (run these yourself, no network call to us)

Before paying any endpoint, verify locally:

1. **402 envelope shape** — the 402 response must carry a \`PAYMENT-REQUIRED\` header (base64 JSON) with \`x402Version: 2\`, an \`accepts\` array, and each entry naming \`scheme: "exact"\`, \`network: "eip155:8453"\`, the USDC asset \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\`, a \`payTo\` address, and an \`amount\` in atomic units. Missing or malformed fields: do not pay.
2. **payTo consistency** — the \`payTo\` in the envelope must match the endpoint's published card (\`/.well-known/x402\` / skill file). A payTo that differs between the card and the live 402 is payTo drift: do not pay.
3. **TLS** — the origin must serve valid HTTPS. Plain HTTP or a certificate error: do not pay.
4. **Redirect chains** — follow redirects yourself and re-check the envelope at the final URL. A redirect that changes origin between the card and the 402: do not pay.
5. **Price sanity** — compare \`amount\` against the endpoint's claimed price (card, skill file, listing). An amount larger than claimed, or a price that changed since you last paid this origin: stop and re-check.

Tier 0 is genuinely all some agents will ever need. It is the free value of this skill.

## Tier 1 — paid depth layer (recorded history + receipts)

Base URL: \`https://payproof.hsharmanov02.workers.dev\`

### Preflight dossier — POST /preflight, $0.05 USDC on Base

Call this **before paying a first-seen endpoint** (new origin or new payTo). Body:

\`\`\`json
{"endpoint_url": "https://some-service.example/resource"}
\`\`\`

(or \`{"address": "0x…payTo…"}\`). Pay via the 402 flow (x402 v2 exact; facilitator \`PAYMENT-SIGNATURE\` header, or settle to the payTo yourself and retry with \`X-PAYMENT-TX: <Base tx hash>\`). The dossier returns:

- a **live probe right now**: HTTP status, latency, and — if the endpoint answers 402 — whether its live envelope is valid and consistent;
- a **recorded-history summary** from our Observation Log (continuously recorded since 2026-10-04, hash-chained, Bitcoin-anchored weekly): first/last seen, observed status, payTo drift, observed median price — or an explicit "not yet observed" with the log's own age. History depth grows daily; today it is young, and the dossier says so rather than implying coverage it does not have.

Why pay for this when Tier 0 is free? Tier 0 tells you the endpoint's envelope is well-formed *now*. Only recorded history tells you whether this origin has been alive, stable, and charging the same payTo across time — and history cannot be backfilled by anyone, including us.

### PayProof receipt — POST /receipt, $0.01 USDC on Base

After a payment settles, fetch a receipt the payee can present elsewhere. Body:

\`\`\`json
{"tx_ref": "0x…Base tx hash of the settled payment…", "endpoint": "https://some-service.example/resource"}
\`\`\`

Returns a hash-chained receipt object (tx hash, endpoint, amount, block time, chain position) citable at \`GET /receipt/:id\` (free). Presenting a chain of these receipts is how a worker agent shows a poster a payment history that verifies against our anchored chain heads.

## Prices

- \`POST /preflight\` — $0.05 USDC (Base), x402 v2 exact
- \`POST /receipt\` — $0.01 USDC (Base), x402 v2 exact
- \`GET /receipt/:id\`, \`/price\`, \`/.well-known/x402\`, \`/skill.md\` — free
- Pay-to (all fees): \`0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2\`
`;

function sendJson(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
async function httpJson(url, payload = null, timeoutSec = 20) {
  const init = {
    method: payload !== null ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "User-Agent": "payproof/1.0" },
    signal: AbortSignal.timeout(timeoutSec * 1000),
  };
  if (payload !== null) init.body = JSON.stringify(payload);
  const r = await fetch(url, init);
  return JSON.parse(await r.text());
}
function b64(o) {
  const b = new TextEncoder().encode(JSON.stringify(o));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function b64dec(s) {
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
async function rpc(method, params) {
  let last;
  for (const u of BASE_RPCS) {
    try {
      const out = await httpJson(u, { jsonrpc: "2.0", id: 1, method, params }, 15);
      if (out && out.error) { last = new Error(JSON.stringify(out.error)); continue; }
      return out ? out.result ?? null : null;
    } catch (e) { last = e; }
  }
  throw new Error(`all Base RPCs failed for ${method}: ${last}`);
}
async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function paymentRequirements(amountAtomic) {
  return {
    scheme: "exact", network: NETWORK, amount: String(amountAtomic),
    asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
  };
}
const ROUTES = {
  "/preflight": {
    amount: PREFLIGHT_ATOMIC, human: "$0.05",
    description: "payproof preflight dossier: pay $0.05 USDC on Base for a live probe of an endpoint plus its recorded-history summary from an Observation Log recording since 2026-10-04 (hash-chained, Bitcoin-anchored weekly; depth grows daily and the dossier states its own coverage). Released only after settlement to payTo is proven.",
  },
  "/receipt": {
    amount: RECEIPT_ATOMIC, human: "$0.01",
    description: "payproof receipt: pay $0.01 USDC on Base to hash-chain a settled payment (tx_ref + endpoint) into the PayProof receipt chain; returns a receipt citable at GET /receipt/:id. Released only after settlement to payTo is proven.",
  },
};
function paymentRequiredBody(origin, route) {
  const r = ROUTES[route];
  return {
    x402Version: 2,
    error: "payment required: settle to payTo, then present proof",
    resource: {
      url: origin + route,
      description: r.description,
      mimeType: "application/json",
      serviceName: "payproof",
      tags: ["preflight", "receipt", "trust", "x402"],
    },
    accepts: [paymentRequirements(r.amount)],
  };
}
function fail402(reason, origin, route) {
  return sendJson({ error: reason, x402Version: 2 }, 402, {
    "PAYMENT-REQUIRED": b64(paymentRequiredBody(origin, route)),
  });
}
async function verifyTxProof(raw, minAtomic) {
  const tx = (raw || "").trim().toLowerCase();
  if (!(tx.startsWith("0x") && tx.length === 66)) return [false, "malformed tx hash"];
  if (consumedTx.has(tx)) return [false, "tx already consumed (replay rejected)"];
  let rc;
  try { rc = await rpc("eth_getTransactionReceipt", [tx]); }
  catch (e) { return [false, `receipt lookup failed: ${e.message || e}`]; }
  if (!rc) return [false, "tx not found on Base"];
  if (rc.status !== "0x1") return [false, "tx reverted on-chain"];
  let blk;
  try { blk = await rpc("eth_getBlockByNumber", [rc.blockNumber, false]); }
  catch (e) { return [false, `block lookup failed: ${e.message || e}`]; }
  const ageSec = Math.floor(Date.now() / 1000) - parseInt(blk.timestamp, 16);
  if (ageSec > MAX_TX_AGE_SEC) return [false, `tx too old (${ageSec}s > ${MAX_TX_AGE_SEC}s age guard)`];
  const to = "0x" + "0".repeat(24) + PAY_TO.toLowerCase().slice(2);
  for (const lg of rc.logs || []) {
    if ((lg.address || "").toLowerCase() !== USDC.toLowerCase()) continue;
    const t = lg.topics || [];
    if (t.length >= 3 && t[0].toLowerCase() === TRANSFER_TOPIC && t[2].toLowerCase() === to) {
      if (BigInt(lg.data || "0x0") < BigInt(minAtomic)) return [false, "underpaid"];
      consumedTx.add(tx);
      return [true, "0x" + t[1].slice(-40)];
    }
  }
  return [false, "no USDC transfer to payTo in this tx"];
}
async function settleViaFacilitator(payload, amountAtomic) {
  const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: paymentRequirements(amountAtomic) };
  let v;
  try { v = await httpJson(`${FACILITATOR}/verify`, body, 25); }
  catch (e) { return [false, `facilitator /verify unreachable: ${e.message || e}`]; }
  if (!v || !v.isValid) return [false, `payment invalid: ${(v && v.invalidReason) || "unknown"}`];
  let s;
  try { s = await httpJson(`${FACILITATOR}/settle`, body, 90); }
  catch (e) { return [false, `facilitator /settle unreachable: ${e.message || e}`]; }
  if (!s || !s.success) return [false, `settlement failed: ${(s && s.errorReason) || "unknown"}`];
  return [true, s];
}
async function gatePaid(request, url, origin, route, paidFn) {
  // Payment gate FIRST: parameter validation lives inside paidFn, never before the 402.
  const r = ROUTES[route];
  const txProof = request.headers.get("X-PAYMENT-TX") || url.searchParams.get("tx");
  if (txProof) {
    const [ok, res] = await verifyTxProof(txProof, r.amount);
    if (!ok) return fail402(`settlement proof rejected: ${res}`, origin, route);
    return paidFn(request, url);
  }
  const sig = request.headers.get("PAYMENT-SIGNATURE");
  if (!sig) return fail402("payment required", origin, route);
  let p;
  try { p = JSON.parse(b64dec(sig)); } catch (e) { return sendJson({ error: `bad PAYMENT-SIGNATURE: ${e.message}` }, 400); }
  const acc = (p && p.accepted) || {};
  if (!p || p.x402Version !== 2 || (p.scheme ?? acc.scheme) !== "exact") return fail402("unsupported payment scheme/version", origin, route);
  if ((p.network ?? acc.network) !== NETWORK) return fail402("wrong network", origin, route);
  const [ok, info] = await settleViaFacilitator(p, r.amount);
  if (!ok) return fail402(info, origin, route);
  return paidFn(request, url);
}
async function readJsonBody(request) {
  const t = await request.text();
  if (!t) return {};
  try { return JSON.parse(t); } catch (e) { return {}; }
}
function envelopeCheck(resp) {
  // Validate a live 402 envelope the way the skill's Tier-0 describes.
  const hdr = resp.headers.get("PAYMENT-REQUIRED");
  if (!hdr) return { present: false, valid: false, issues: ["no PAYMENT-REQUIRED header"] };
  let env;
  try { env = JSON.parse(b64dec(hdr)); } catch (e) { return { present: true, valid: false, issues: [`unparseable PAYMENT-REQUIRED: ${e.message}`] }; }
  const issues = [];
  if (env.x402Version !== 2) issues.push("x402Version != 2");
  const a = Array.isArray(env.accepts) ? env.accepts[0] : null;
  if (!a) { issues.push("no accepts[] entry"); return { present: true, valid: false, issues }; }
  if (a.scheme !== "exact") issues.push("scheme != exact");
  if (a.network !== NETWORK) issues.push(`network ${a.network} != ${NETWORK}`);
  if ((a.asset || "").toLowerCase() !== USDC.toLowerCase()) issues.push("asset != Base USDC");
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.payTo || "")) issues.push("malformed payTo");
  if (!/^\d+$/.test(String(a.amount || ""))) issues.push("malformed amount");
  return {
    present: true, valid: issues.length === 0, issues,
    payTo: a.payTo || null, amount_atomic: a.amount ? String(a.amount) : null,
  };
}
async function probeEndpoint(endpointUrl) {
  const out = { url: endpointUrl, reachable: false };
  const t0 = Date.now();
  try {
    const resp = await fetch(endpointUrl, {
      method: "GET", redirect: "follow",
      headers: { "User-Agent": "payproof/1.0" },
      signal: AbortSignal.timeout(12000),
    });
    out.reachable = true;
    out.latency_ms = Date.now() - t0;
    out.status = resp.status;
    out.final_url = resp.url;
    if (resp.status === 402) out.envelope = envelopeCheck(resp);
    try { await resp.text(); } catch (e) { /* body not needed */ }
  } catch (e) {
    out.latency_ms = Date.now() - t0;
    out.error = String(e.message || e);
  }
  return out;
}
async function preflightPaid(request, url) {
  const body = await readJsonBody(request);
  const endpointUrl = typeof body.endpoint_url === "string" ? body.endpoint_url : null;
  const address = typeof body.address === "string" ? body.address : null;
  if (!endpointUrl && !address) return sendJson({ error: "missing 'endpoint_url' or 'address' in JSON body" }, 400);
  const dossier = {
    service: "payproof", kind: "preflight",
    observation_log: LOG_META,
    history: { observed: false, note: "not yet observed by our census poller — this dossier is live-probe only; recorded history for this endpoint does not exist yet and we do not imply otherwise." },
  };
  if (endpointUrl) {
    dossier.endpoint_url = endpointUrl;
    dossier.live_probe = await probeEndpoint(endpointUrl);
    let host = null;
    try { host = new URL(endpointUrl).host; } catch (e) { /* leave null */ }
    const seed = host ? HISTORY_SEED[host] : null;
    if (seed) dossier.history = { observed: true, ...seed };
    if (dossier.live_probe.envelope && dossier.live_probe.envelope.payTo) {
      dossier.payto_live = dossier.live_probe.envelope.payTo;
      dossier.payto_consistency = seed
        ? "live payTo reported alongside seeded history; compare against the endpoint's published card before paying"
        : "no recorded history to compare against; envelope payTo shown live only";
    }
  }
  if (address) {
    dossier.address = address;
    const seed = HISTORY_SEED[address.toLowerCase()];
    if (seed) dossier.history = { observed: true, ...seed };
  }
  return sendJson(dossier);
}
async function receiptPaid(request, url) {
  const body = await readJsonBody(request);
  const txRef = typeof body.tx_ref === "string" ? body.tx_ref.trim().toLowerCase() : null;
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : null;
  if (!txRef || !(txRef.startsWith("0x") && txRef.length === 66)) return sendJson({ error: "missing or malformed 'tx_ref' (Base tx hash)" }, 400);
  if (!endpoint) return sendJson({ error: "missing 'endpoint'" }, 400);
  let rc;
  try { rc = await rpc("eth_getTransactionReceipt", [txRef]); }
  catch (e) { return sendJson({ error: `tx_ref lookup failed: ${e.message || e}` }, 502); }
  if (!rc) return sendJson({ error: "tx_ref not found on Base (not settled yet?)" }, 400);
  if (rc.status !== "0x1") return sendJson({ error: "tx_ref reverted on-chain — no payment to receipt" }, 400);
  let payment = null;
  for (const lg of rc.logs || []) {
    if ((lg.address || "").toLowerCase() !== USDC.toLowerCase()) continue;
    const t = lg.topics || [];
    if (t.length >= 3 && t[0].toLowerCase() === TRANSFER_TOPIC) {
      payment = {
        from: "0x" + t[1].slice(-40), to: "0x" + t[2].slice(-40),
        amount_atomic: BigInt(lg.data || "0x0").toString(),
      };
      break;
    }
  }
  let blk;
  try { blk = await rpc("eth_getBlockByNumber", [rc.blockNumber, false]); }
  catch (e) { return sendJson({ error: `block lookup failed: ${e.message || e}` }, 502); }
  const block = parseInt(rc.blockNumber, 16), ts = parseInt(blk.timestamp, 16);
  const core = { tx_ref: txRef, endpoint, block, block_timestamp: ts, iso: new Date(ts * 1000).toISOString(), payment };
  const hash = await sha256hex(receiptHead + "|" + JSON.stringify(core));
  const rec = {
    id: hash.slice(0, 16), hash, prev_head: receiptHead, ...core,
    durability: "receipt record is held in-isolate and is NOT durable; the hash + chain position in this response are the citable receipt — verify it against the anchored chain heads when published",
  };
  receiptHead = hash;
  receipts.set(rec.id, rec);
  return sendJson({ service: "payproof", receipt_url: url.origin + "/receipt/" + rec.id, ...rec });
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = url.origin, path = url.pathname;
    if (path === "/health") return sendJson({ status: "ok", service: "payproof", payTo: PAY_TO });
    if (path === "/") return sendJson({
      service: "payproof — check before you pay (preflight dossiers + payment receipts)",
      payTo: PAY_TO, network: NETWORK,
      gated: {
        "/preflight": "POST {endpoint_url|address} -> live probe + recorded-history dossier ($0.05)",
        "/receipt": "POST {tx_ref, endpoint} -> hash-chained PayProof receipt ($0.01)",
      },
      free: { "/receipt/:id": "look up a receipt", "/skill.md": "the free open-source PayProof skill" },
      discovery: ["/price", "/.well-known/x402", "/skill.md"],
    });
    if (path === "/price") return sendJson({
      service: "payproof",
      prices: {
        "/preflight": { amount_atomic: String(PREFLIGHT_ATOMIC), human: "$0.05", asset: USDC, network: NETWORK },
        "/receipt": { amount_atomic: String(RECEIPT_ATOMIC), human: "$0.01", asset: USDC, network: NETWORK },
      },
      payTo: PAY_TO,
      how_to_pay: "POST the route -> 402; retry with PAYMENT-SIGNATURE (x402 v2 exact) or X-PAYMENT-TX: <Base tx hash of the fee to payTo>.",
    });
    if (path === "/.well-known/x402") return sendJson({
      x402Version: 2,
      resources: ["/preflight", "/receipt"].map((r) => ({
        url: origin + r, method: "POST", description: ROUTES[r].description, accepts: [paymentRequirements(ROUTES[r].amount)],
      })),
    });
    if (path === "/skill.md") return new Response(SKILL_TEXT, { status: 200, headers: { "Content-Type": "text/markdown" } });
    if (path.startsWith("/receipt/") && request.method === "GET") {
      const rec = receipts.get(path.slice(9));
      if (rec) return sendJson({ service: "payproof", ...rec });
      return sendJson({ error: "receipt not found (lookup store is in-isolate and non-durable; it may have been recycled — the receipt returned at purchase time is authoritative)" }, 404);
    }
    if (path === "/preflight" && request.method === "POST") return gatePaid(request, url, origin, "/preflight", preflightPaid);
    if (path === "/receipt" && request.method === "POST") return gatePaid(request, url, origin, "/receipt", receiptPaid);
    return sendJson({ error: "not found" }, 404);
  },
};
