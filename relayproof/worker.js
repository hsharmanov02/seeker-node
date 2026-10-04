// relayproof — paid webhook relay: pay $0.01, we fetch your target once and return its HTTP status + response hash as a delivery receipt.
// x402 v2 exact on Base; release only after settlement proof to PAY_TO (facilitator PAYMENT-SIGNATURE or on-chain X-PAYMENT-TX via RPC).
// SSRF guard: http(s) only; hostnames resolved via DoH and refused if any address is private/loopback/link-local; redirects not followed.

const FACILITATOR = "https://facilitator.xpay.sh";
const NETWORK = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2";
const PRICE_ATOMIC = 10000; // $0.01
const PRICE_HUMAN = "$0.01";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BASE_RPCS = [
  "https://base.publicnode.com",
  "https://mainnet.base.org",
  "https://1rpc.io/base",
];
const consumedTx = new Set(); // in-isolate replay guard (best effort)

function sendJson(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
async function httpJson(url, payload = null, timeoutSec = 20) {
  const init = {
    method: payload !== null ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "User-Agent": "relayproof/1.0" },
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
function paymentRequirements() {
  return {
    scheme: "exact", network: NETWORK, amount: String(PRICE_ATOMIC),
    asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
  };
}
function paymentRequiredBody(origin) {
  return {
    x402Version: 2,
    error: "payment required: settle to payTo, then present proof",
    resource: {
      url: origin + "/resource",
      description: "relayproof: pay $0.01 USDC on Base and we fetch your target URL once, returning its HTTP status and response-body SHA-256 as a delivery receipt. Released only after settlement to payTo is proven.",
      mimeType: "application/json",
      serviceName: "relayproof",
      tags: ["webhook", "relay", "delivery", "receipt", "x402"],
    },
    accepts: [paymentRequirements()],
  };
}
function fail402(reason, origin) {
  return sendJson({ error: reason, x402Version: 2 }, 402, {
    "PAYMENT-REQUIRED": b64(paymentRequiredBody(origin)),
  });
}
async function verifyTxProof(raw) {
  const tx = (raw || "").trim().toLowerCase();
  if (!(tx.startsWith("0x") && tx.length === 66)) return [false, "malformed tx hash"];
  if (consumedTx.has(tx)) return [false, "tx already consumed (replay rejected)"];
  let rc;
  try { rc = await rpc("eth_getTransactionReceipt", [tx]); }
  catch (e) { return [false, `receipt lookup failed: ${e.message || e}`]; }
  if (!rc) return [false, "tx not found on Base"];
  if (rc.status !== "0x1") return [false, "tx reverted on-chain"];
  const to = "0x" + "0".repeat(24) + PAY_TO.toLowerCase().slice(2);
  for (const lg of rc.logs || []) {
    if ((lg.address || "").toLowerCase() !== USDC.toLowerCase()) continue;
    const t = lg.topics || [];
    if (t.length >= 3 && t[0].toLowerCase() === TRANSFER_TOPIC && t[2].toLowerCase() === to) {
      if (BigInt(lg.data || "0x0") < BigInt(PRICE_ATOMIC)) return [false, "underpaid"];
      consumedTx.add(tx);
      return [true, "0x" + t[1].slice(-40)];
    }
  }
  return [false, "no USDC transfer to payTo in this tx"];
}
async function settleViaFacilitator(payload) {
  const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: paymentRequirements() };
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
function ipBlocked(ip) {
  if (ip.includes(":")) {
    const h = ip.toLowerCase();
    return h === "::" || h === "::1" || h.startsWith("fe8") || h.startsWith("fe9") ||
      h.startsWith("fea") || h.startsWith("feb") || h.startsWith("fc") || h.startsWith("fd");
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !isFinite(n))) return true;
  return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254);
}
async function dohIps(host) {
  const ips = [];
  for (const t of ["A", "AAAA"]) {
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${t}`,
        { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      for (const a of j.Answer || []) if (a.type === 1 || a.type === 28) ips.push(a.data);
    } catch (e) { /* caller treats empty result as unresolvable */ }
  }
  return ips;
}
async function paidPayload(request, url) {
  // Runs ONLY after payment is proven; parameter validation lives here, never before the 402.
  let target = url.searchParams.get("url"), payload = url.searchParams.get("payload");
  if (request.method === "POST") {
    try {
      const j = await request.json();
      if (j && typeof j === "object") {
        if (!target && j.url) target = String(j.url);
        if (payload === null && j.payload !== undefined)
          payload = typeof j.payload === "string" ? j.payload : JSON.stringify(j.payload);
      }
    } catch (e) { /* fall through to missing-target error */ }
  }
  if (!target) return sendJson({ error: "missing 'url' target" }, 400);
  let u;
  try { u = new URL(target); } catch (e) { return sendJson({ error: "invalid url" }, 400); }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return sendJson({ error: "only http(s) targets allowed" }, 400);
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal"))
    return sendJson({ error: "target refused (local hostname)" }, 400);
  const ips = (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) ? [host] : await dohIps(host);
  if (!ips.length) return sendJson({ error: "target hostname did not resolve" }, 400);
  if (ips.some(ipBlocked)) return sendJson({ error: "target refused (private/loopback address)" }, 400);
  const init = {
    method: payload !== null && payload !== undefined ? "POST" : "GET",
    redirect: "manual", signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "relayproof/1.0" },
  };
  if (init.method === "POST") { init.body = payload; init.headers["Content-Type"] = "application/json"; }
  let resp, text;
  try { resp = await fetch(u.toString(), init); text = await resp.text(); }
  catch (e) { return sendJson({ service: "relayproof", target: u.toString(), delivered: false, error: `fetch failed: ${e.message || e}` }); }
  return sendJson({
    service: "relayproof", target: u.toString(), delivered: true,
    status: resp.status, response_bytes: new TextEncoder().encode(text).length,
    response_sha256: await sha256hex(text), resolved_ips: ips,
    fetched_at: new Date().toISOString(),
    note: "Receipt proves this Worker fetched the target once and observed this status/body hash. Redirects are not followed.",
  });
}
async function handleResource(request, url, origin) {
  const txProof = request.headers.get("X-PAYMENT-TX") || url.searchParams.get("tx");
  if (txProof) {
    const [ok, res] = await verifyTxProof(txProof);
    if (!ok) return fail402(`settlement proof rejected: ${res}`, origin);
    return paidPayload(request, url);
  }
  const sig = request.headers.get("PAYMENT-SIGNATURE");
  if (!sig) return fail402("payment required", origin);
  let p;
  try { p = JSON.parse(b64dec(sig)); } catch (e) { return sendJson({ error: `bad PAYMENT-SIGNATURE: ${e.message}` }, 400); }
  const acc = (p && p.accepted) || {};
  if (!p || p.x402Version !== 2 || (p.scheme ?? acc.scheme) !== "exact") return fail402("unsupported payment scheme/version", origin);
  if ((p.network ?? acc.network) !== NETWORK) return fail402("wrong network", origin);
  const [ok, info] = await settleViaFacilitator(p);
  if (!ok) return fail402(info, origin);
  return paidPayload(request, url);
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = url.origin, path = url.pathname;
    if (path === "/health") return sendJson({ status: "ok", service: "relayproof", payTo: PAY_TO });
    if (path === "/") return sendJson({
      service: "relayproof — paid webhook relay with delivery receipt ($0.01/call)",
      payTo: PAY_TO, network: NETWORK,
      gated: { "/resource": "POST {url, payload?} -> target HTTP status + response SHA-256 receipt" },
      discovery: ["/price", "/.well-known/x402", "/skill.md"],
    });
    if (path === "/price") return sendJson({
      service: "relayproof", resource: origin + "/resource",
      price: { amount_atomic: String(PRICE_ATOMIC), human: PRICE_HUMAN, asset: USDC, network: NETWORK },
      payTo: PAY_TO,
      how_to_pay: "POST /resource -> 402; retry with PAYMENT-SIGNATURE (x402 v2 exact) or X-PAYMENT-TX: <Base tx hash of >= $0.01 USDC to payTo>.",
    });
    if (path === "/.well-known/x402") return sendJson({
      x402Version: 2,
      resources: [{ url: origin + "/resource", method: "POST", description: paymentRequiredBody(origin).resource.description, accepts: [paymentRequirements()] }],
    });
    if (path === "/skill.md") return new Response(
      `# relayproof\n\nPaid webhook relay with a delivery receipt, pay-per-request via x402 v2.\n\n- Endpoint: \`POST ${origin}/resource\` with JSON \`{"url": "https://...", "payload": ...}\` (payload optional; its presence makes the relay a POST)\n- Price: $0.01 USDC on Base (eip155:8453), scheme \`exact\`\n- Pay-to: \`${PAY_TO}\`\n- Returns the target's HTTP status, response byte count and response-body SHA-256. Private/loopback targets are refused; redirects are not followed.\n`,
      { status: 200, headers: { "Content-Type": "text/markdown" } });
    if (path === "/resource") return handleResource(request, url, origin);
    return sendJson({ error: "not found" }, 404);
  },
};
