// schemaseal — paid JSON-Schema conformance check: pay $0.01, get PASS/FAIL with exact failing paths + a SHA-256 receipt of (schema,payload,verdict).
// x402 v2 exact on Base; release only after settlement proof to PAY_TO (facilitator PAYMENT-SIGNATURE or on-chain X-PAYMENT-TX via RPC).
// Compact validator (type/required/properties/enum/minimum/maximum + min/max aliases, string lengths, nested items); no imports, nothing stored.

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
    headers: { "Content-Type": "application/json", "User-Agent": "schemaseal/1.0" },
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
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
function check(schema, value, path, errs) {
  if (!schema || typeof schema !== "object") return;
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    errs.push(`${path}: value not in enum`);
  if (schema.type !== undefined) {
    const t = typeOf(value);
    const ok = schema.type === "integer" ? t === "number" && Number.isInteger(value) : t === schema.type;
    if (!ok) { errs.push(`${path}: expected type ${schema.type}, got ${t}`); return; }
  }
  if (typeof value === "number") {
    const lo = schema.minimum !== undefined ? schema.minimum : schema.min;
    const hi = schema.maximum !== undefined ? schema.maximum : schema.max;
    if (lo !== undefined && value < lo) errs.push(`${path}: ${value} < minimum ${lo}`);
    if (hi !== undefined && value > hi) errs.push(`${path}: ${value} > maximum ${hi}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}: longer than maxLength ${schema.maxLength}`);
  }
  if (typeOf(value) === "object") {
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${path}.${r}: required but missing`);
    const props = schema.properties || {};
    for (const k of Object.keys(props)) if (k in value) check(props[k], value[k], `${path}.${k}`, errs);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`, errs));
}
function canon(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
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
      description: "schemaseal: pay $0.01 USDC on Base to validate a JSON payload against a JSON Schema subset (type/required/properties/enum/minimum/maximum) — returns PASS/FAIL with the exact failing paths plus a SHA-256 receipt of (schema,payload,verdict) you can cite. Released only after settlement to payTo is proven.",
      mimeType: "application/json",
      serviceName: "schemaseal",
      tags: ["validation", "json-schema", "conformance", "x402"],
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
async function paidPayload(request, url) {
  // Runs ONLY after payment is proven; parameter validation lives here, never before the 402.
  let j = null;
  if (request.method === "POST") { try { j = JSON.parse(await request.text() || "null"); } catch (e) {} }
  if (!j && url.searchParams.get("schema")) {
    try { j = { schema: JSON.parse(url.searchParams.get("schema")), payload: JSON.parse(url.searchParams.get("payload") || "null") }; } catch (e) {}
  }
  if (!j || typeof j !== "object" || !("schema" in j) || !("payload" in j))
    return sendJson({ error: "POST JSON {schema, payload} (schema = JSON Schema subset)" }, 400);
  if (JSON.stringify(j).length > 50000) return sendJson({ error: "input too large (max 50KB)" }, 400);
  const errs = [];
  check(j.schema, j.payload, "$", errs);
  const verdict = errs.length ? "FAIL" : "PASS";
  const receipt = await sha256hex(canon({ schema: j.schema, payload: j.payload, verdict }));
  return sendJson({ service: "schemaseal", verdict, failing_paths: errs, receipt_sha256: receipt });
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
    if (path === "/health") return sendJson({ status: "ok", service: "schemaseal", payTo: PAY_TO });
    if (path === "/") return sendJson({
      service: "schemaseal — paid JSON-Schema conformance check ($0.01/call)",
      payTo: PAY_TO, network: NETWORK,
      gated: { "/resource": "POST {schema, payload} -> PASS/FAIL + failing paths + SHA-256 receipt" },
      discovery: ["/price", "/.well-known/x402", "/skill.md"],
    });
    if (path === "/price") return sendJson({
      service: "schemaseal", resource: origin + "/resource",
      price: { amount_atomic: String(PRICE_ATOMIC), human: PRICE_HUMAN, asset: USDC, network: NETWORK },
      payTo: PAY_TO,
      how_to_pay: "POST /resource -> 402; retry with PAYMENT-SIGNATURE (x402 v2 exact) or X-PAYMENT-TX: <Base tx hash of >= $0.01 USDC to payTo>.",
    });
    if (path === "/.well-known/x402") return sendJson({
      x402Version: 2,
      resources: [{ url: origin + "/resource", method: "POST", description: paymentRequiredBody(origin).resource.description, accepts: [paymentRequirements()] }],
    });
    if (path === "/skill.md") return new Response(
      `# schemaseal\n\nPaid JSON-Schema conformance check, pay-per-request via x402 v2.\n\n- Endpoint: \`POST ${origin}/resource\` with JSON \`{"schema": {...}, "payload": ...}\`\n- Price: $0.01 USDC on Base (eip155:8453), scheme \`exact\`\n- Pay-to: \`${PAY_TO}\`\n- Schema subset: type, required, properties, enum, minimum/maximum (aliases min/max), minLength/maxLength, items. Returns PASS/FAIL, exact failing paths, and a SHA-256 receipt of (schema,payload,verdict).\n`,
      { status: 200, headers: { "Content-Type": "text/markdown" } });
    if (path === "/resource") return handleResource(request, url, origin);
    return sendJson({ error: "not found" }, 404);
  },
};
