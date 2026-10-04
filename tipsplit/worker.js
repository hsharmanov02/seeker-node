// tipsplit — pay $0.01 for a ready-to-send UNSIGNED Base USDC split bundle: ERC-20 transfer call data splitting an amount across up to 5 recipients by %. We never sign or custody.
// x402 v2 exact on Base; instruction generation only after settlement proof to PAY_TO (facilitator PAYMENT-SIGNATURE or on-chain X-PAYMENT-TX via RPC).
// Amounts are BigInt-exact: floored shares plus remainder units assigned in order, so call amounts always sum to the total. Verify via sum_check + checksum_sha256.

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
    headers: { "Content-Type": "application/json", "User-Agent": "tipsplit/1.0" },
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
      description: "tipsplit: pay $0.01 USDC on Base for a ready-to-send unsigned transaction bundle that splits a USDC amount across up to 5 recipients by percentage — correctly ABI-encoded transfer call data with an exact-sum check and checksum. We never sign or custody. Released only after settlement to payTo is proven.",
      mimeType: "application/json",
      serviceName: "tipsplit",
      tags: ["split", "payments", "calldata", "x402"],
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
function decToAtomic(s) { // "12.34" -> 12340000n (USDC 6dp); null if malformed
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(s).trim());
  if (!m) return null;
  return BigInt(m[1]) * 1000000n + BigInt((m[2] || "").padEnd(6, "0"));
}
function encTransfer(addr, amt) { // ERC-20 transfer(address,uint256)
  return "0xa9059cbb" + addr.toLowerCase().slice(2).padStart(64, "0") + amt.toString(16).padStart(64, "0");
}
async function paidPayload(request, url) {
  // Runs ONLY after payment is proven; parameter validation lives here, never before the 402.
  let amountAtomic = url.searchParams.get("amount_atomic"),
    amountUsdc = url.searchParams.get("amount_usdc"),
    recipsRaw = url.searchParams.get("recipients");
  if (request.method === "POST") {
    try {
      const j = await request.json();
      if (j && typeof j === "object") {
        if (amountAtomic === null && j.amount_atomic !== undefined) amountAtomic = j.amount_atomic;
        if (amountUsdc === null && j.amount_usdc !== undefined) amountUsdc = j.amount_usdc;
        if (recipsRaw === null && j.recipients !== undefined) recipsRaw = j.recipients;
      }
    } catch (e) { /* fall through to validation errors */ }
  }
  let recips = recipsRaw;
  if (typeof recips === "string") {
    try { recips = JSON.parse(recips); }
    catch (e) { return sendJson({ error: "recipients must be JSON [{address,pct}]" }, 400); }
  }
  if (!Array.isArray(recips) || recips.length < 1 || recips.length > 5)
    return sendJson({ error: "recipients: 1-5 entries required" }, 400);
  let total = null;
  if (amountAtomic !== null && amountAtomic !== undefined && amountAtomic !== "") {
    try { total = BigInt(String(amountAtomic)); }
    catch (e) { return sendJson({ error: "amount_atomic must be an integer string" }, 400); }
  } else if (amountUsdc !== null && amountUsdc !== undefined) {
    total = decToAtomic(amountUsdc);
    if (total === null) return sendJson({ error: "amount_usdc must be a decimal with <=6dp" }, 400);
  }
  if (total === null || total <= 0n)
    return sendJson({ error: "provide amount_atomic or amount_usdc (> 0)" }, 400);
  let bpSum = 0;
  const norm = [];
  for (const r of recips) {
    const a = String((r && r.address) || "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return sendJson({ error: `bad address: ${a}` }, 400);
    const bp = Math.round(Number(r.pct) * 100);
    if (!isFinite(bp) || bp <= 0) return sendJson({ error: "each pct must be > 0" }, 400);
    bpSum += bp;
    norm.push({ address: a, bp });
  }
  if (bpSum !== 10000)
    return sendJson({ error: `percentages must sum to 100 (got ${bpSum / 100})` }, 400);
  const shares = norm.map((r) => (total * BigInt(r.bp)) / 10000n);
  let rem = total - shares.reduce((x, y) => x + y, 0n);
  for (let i = 0; rem > 0n; i++, rem--) shares[i % shares.length] += 1n;
  const calls = norm.map((r, i) => ({
    to: USDC, value: "0", data: encTransfer(r.address, shares[i]),
    recipient: r.address, pct: r.bp / 100,
    amount_atomic: shares[i].toString(), amount_usdc: (Number(shares[i]) / 1e6).toFixed(6),
  }));
  return sendJson({
    service: "tipsplit", chain: "base", chainId: 8453, token: USDC,
    total_atomic: total.toString(), total_usdc: (Number(total) / 1e6).toFixed(6),
    sum_check_atomic: shares.reduce((x, y) => x + y, 0n).toString(),
    calls, checksum_sha256: await sha256hex(calls.map((c) => c.data).join("")),
    note: "Unsigned instruction bundle only — review, sign and broadcast with your own wallet. tipsplit never signs or custodies funds.",
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
    if (path === "/health") return sendJson({ status: "ok", service: "tipsplit", payTo: PAY_TO });
    if (path === "/") return sendJson({
      service: "tipsplit — unsigned USDC split-bundle generator ($0.01/call)",
      payTo: PAY_TO, network: NETWORK,
      gated: { "/resource": "POST {amount_usdc|amount_atomic, recipients:[{address,pct}]} -> unsigned transfer call data, exact-sum checked" },
      discovery: ["/price", "/.well-known/x402", "/skill.md"],
    });
    if (path === "/price") return sendJson({
      service: "tipsplit", resource: origin + "/resource",
      price: { amount_atomic: String(PRICE_ATOMIC), human: PRICE_HUMAN, asset: USDC, network: NETWORK },
      payTo: PAY_TO,
      how_to_pay: "POST /resource -> 402; retry with PAYMENT-SIGNATURE (x402 v2 exact) or X-PAYMENT-TX: <Base tx hash of >= $0.01 USDC to payTo>.",
    });
    if (path === "/.well-known/x402") return sendJson({
      x402Version: 2,
      resources: [{ url: origin + "/resource", method: "POST", description: paymentRequiredBody(origin).resource.description, accepts: [paymentRequirements()] }],
    });
    if (path === "/skill.md") return new Response(
      `# tipsplit\n\nUnsigned USDC split-bundle generator, pay-per-request via x402 v2.\n\n- Endpoint: \`POST ${origin}/resource\` with JSON \`{"amount_usdc": "100.00", "recipients": [{"address": "0x...", "pct": 60}, {"address": "0x...", "pct": 40}]}\` (1-5 recipients, pct sums to 100; or \`amount_atomic\`)\n- Price: $0.01 USDC on Base (eip155:8453), scheme \`exact\`\n- Pay-to: \`${PAY_TO}\`\n- Returns ready-to-send unsigned ERC-20 transfer call data per recipient, amounts summing exactly to the total, plus a SHA-256 checksum. You sign and broadcast yourself — tipsplit never signs or custodies.\n`,
      { status: 200, headers: { "Content-Type": "text/markdown" } });
    if (path === "/resource") return handleResource(request, url, origin);
    return sendJson({ error: "not found" }, 404);
  },
};
