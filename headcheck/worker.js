// headcheck — paid endpoint health verdict: pay $0.01, get DNS + TLS-cert + HTTPS verdict block for a domain, computed live from public sources.
// x402 v2 exact on Base; release only after settlement proof to PAY_TO (facilitator PAYMENT-SIGNATURE or on-chain X-PAYMENT-TX via RPC).
// DNS via keyless DoH (Cloudflare/Google); cert via keyless CT-log APIs (Cert Spotter, crt.sh) — if neither responds, says so and rests on DNS+HTTPS fetch.

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
    headers: { "Content-Type": "application/json", "User-Agent": "headcheck/1.0" },
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
      description: "headcheck: pay $0.01 USDC on Base for a live endpoint health verdict — POST {domain}; checks DNS resolution (DoH), TLS certificate expiry/issuer/SAN coverage from keyless certificate-transparency APIs (Cert Spotter / crt.sh), and a real HTTPS fetch with timing. Returns one verdict block (OK/WARN/FAIL + reasons) an agent can act on. Released only after settlement to payTo is proven.",
      mimeType: "application/json",
      serviceName: "headcheck",
      tags: ["health-check", "tls", "dns", "monitoring", "x402"],
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
  let j = {};
  if (request.method === "POST") { try { j = JSON.parse(await request.text() || "{}"); } catch (e) {} }
  const domain = String(j.domain ?? url.searchParams.get("domain") ?? "")
    .trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain))
    return sendJson({ error: "domain must be a bare hostname like example.com" }, 400);
  // --- DNS via keyless DoH (Cloudflare, then Google) ---
  let dns = { ok: false, addresses: [] };
  for (const base of ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"]) {
    try {
      const r = await fetch(`${base}?name=${encodeURIComponent(domain)}&type=A`,
        { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      const ans = ((d && d.Answer) || []).filter((a) => a.type === 1).map((a) => a.data);
      dns = { ok: ans.length > 0, addresses: ans, source: base };
      if (dns.ok) break;
    } catch (e) { dns = { ok: false, addresses: [], error: String(e.message || e) }; }
  }
  // --- TLS cert via keyless CT-log APIs (Cert Spotter, then crt.sh) ---
  let cert = null;
  const certUrls = [
    `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=false&expand=dns_names&expand=issuer`,
    `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`,
  ];
  for (const u of certUrls) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": "headcheck/1.0" }, signal: AbortSignal.timeout(12000) });
      const arr = await r.json();
      if (!Array.isArray(arr) || !arr.length) continue;
      const norm = arr.map((c) => ({
        names: (c.dns_names || String(c.name_value || "").split("\n")).filter(Boolean),
        na: c.not_after || c.notAfter,
        iss: (c.issuer && (c.issuer.friendly_name || c.issuer.name)) || c.issuer_name || "unknown",
      })).filter((c) => c.na).sort((a, b) => new Date(b.na) - new Date(a.na));
      if (!norm.length) continue;
      const c = norm[0];
      const names = c.names.map((s) => s.replace(/^\*\./, ""));
      cert = {
        issuer: c.iss, expires: c.na,
        days_left: Math.floor((new Date(c.na).getTime() - Date.now()) / 86400000),
        san_match: names.includes(domain), names_checked: names.slice(0, 10),
        source: u.split("?")[0],
      };
      break;
    } catch (e) { /* fall through to next source */ }
  }
  // --- Live HTTPS fetch with timing ---
  let https = { ok: false };
  const t0 = Date.now();
  try {
    const r = await fetch(`https://${domain}/`, {
      redirect: "follow", signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "headcheck/1.0" },
    });
    https = { ok: true, status: r.status, ms: Date.now() - t0, final_url: r.url };
  } catch (e) { https = { ok: false, ms: Date.now() - t0, error: String(e.message || e) }; }
  const reasons = [];
  if (!dns.ok) reasons.push("DNS does not resolve (no A records via DoH)");
  if (cert && cert.days_left < 0) reasons.push("newest cert in CT logs is expired");
  if (cert && !cert.san_match) reasons.push("newest cert in CT logs does not cover this hostname");
  if (!https.ok) reasons.push(`HTTPS fetch failed: ${https.error || "unknown"}`);
  const bad = !dns.ok || !https.ok || (cert && (cert.days_left < 0 || !cert.san_match));
  const verdict = bad ? "FAIL" : cert && cert.days_left < 14 ? "WARN" : "OK";
  if (verdict === "WARN") reasons.push("cert expires within 14 days");
  return sendJson({
    service: "headcheck", domain, dns,
    tls: cert
      ? { ...cert, basis: "certificate-transparency log (keyless): newest issued cert found; issuance history, not a live handshake" }
      : { basis: "unavailable — neither keyless cert source (api.certspotter.com, crt.sh) responded; verdict rests on DNS + HTTPS fetch only" },
    https, verdict, reasons,
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
    if (path === "/health") return sendJson({ status: "ok", service: "headcheck", payTo: PAY_TO });
    if (path === "/") return sendJson({
      service: "headcheck — paid endpoint health verdict ($0.01/call)",
      payTo: PAY_TO, network: NETWORK,
      gated: { "/resource": "POST {domain} -> DNS + TLS-cert + HTTPS verdict block" },
      discovery: ["/price", "/.well-known/x402", "/skill.md"],
    });
    if (path === "/price") return sendJson({
      service: "headcheck", resource: origin + "/resource",
      price: { amount_atomic: String(PRICE_ATOMIC), human: PRICE_HUMAN, asset: USDC, network: NETWORK },
      payTo: PAY_TO,
      how_to_pay: "POST /resource -> 402; retry with PAYMENT-SIGNATURE (x402 v2 exact) or X-PAYMENT-TX: <Base tx hash of >= $0.01 USDC to payTo>.",
    });
    if (path === "/.well-known/x402") return sendJson({
      x402Version: 2,
      resources: [{ url: origin + "/resource", method: "POST", description: paymentRequiredBody(origin).resource.description, accepts: [paymentRequirements()] }],
    });
    if (path === "/skill.md") return new Response(
      `# headcheck\n\nPaid endpoint health verdict, pay-per-request via x402 v2.\n\n- Endpoint: \`POST ${origin}/resource\` with JSON \`{"domain": "example.com"}\`\n- Price: $0.01 USDC on Base (eip155:8453), scheme \`exact\`\n- Pay-to: \`${PAY_TO}\`\n- Checks DNS (keyless DoH), TLS cert expiry/issuer/SAN coverage (keyless CT-log APIs: Cert Spotter, crt.sh — if both are unreachable the response says so and rests on DNS + HTTPS fetch), and a live HTTPS fetch with timing. Returns verdict OK/WARN/FAIL with reasons.\n`,
      { status: 200, headers: { "Content-Type": "text/markdown" } });
    if (path === "/resource") return handleResource(request, url, origin);
    return sendJson({ error: "not found" }, 404);
  },
};
