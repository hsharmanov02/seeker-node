// fiatdock-gateway — ONE MCP endpoint exposing the fleet's paid services as tools.
// Built for Pass 20 (2026-10-05): FiatDock accepts only MCP endpoints; these services
// were built as plain x402 Workers. This gateway re-implements each tool's computation
// directly from the same public data sources (Base public RPCs, registry APIs, DoH/CT
// logs, keyless fetches) — it never proxies to a paid backend and never holds keys.
//
//   POST /mcp  (MCP Streamable HTTP, JSON-RPC 2.0)
//     initialize / ping / tools/list                     -> FREE
//     tools/call <tool>                                  -> per-tool price, x402 v2 exact
//        Unpaid calls get HTTP 402 with a base64 PAYMENT-REQUIRED header (canonical v2
//        envelope, per-tool amount) AND a JSON-RPC error body.
//        Paid calls: PAYMENT-SIGNATURE header (facilitator.xpay.sh /verify + /settle,
//        gas sponsored, funds to PAY_TO) OR X-PAYMENT-TX header (Base tx hash proven
//        on-chain via public RPCs, >= tool price to PAY_TO, replay-guarded).
//   GET /, /health, /price, /.well-known/x402, /skill.md -> free discovery.
//
// The server NEVER signs, never custodies, never sees a private key. Receive-only.
// Prices: tools are $0.01 USDC on Base (eip155:8453); payproof_preflight is $0.05,
// matching PayProof's evidenced POST /preflight price.

const FACILITATOR = "https://facilitator.xpay.sh";
const NETWORK = "eip155:8453"; // Base mainnet
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // native USDC on Base
const PAY_TO = "0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2"; // receive-only
const MAX_TIMEOUT = 300;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BASE_RPCS = [
  "https://base.publicnode.com",
  "https://mainnet.base.org",
  "https://1rpc.io/base",
];
const consumedTx = new Set(); // in-isolate replay guard (best effort, non-durable)

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
};

// Cheap in-memory per-IP guard (120 req/min/IP), mirrors the threat-reputation wrapper.
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

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}
function b64(o) {
  const bytes = new TextEncoder().encode(JSON.stringify(o));
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}
function b64decode(s) {
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function httpJson(url, payload = null, timeoutSec = 20) {
  const init = {
    method: payload !== null ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "User-Agent": "fiatdock-gateway/1.0" },
    signal: AbortSignal.timeout(timeoutSec * 1000),
  };
  if (payload !== null) init.body = JSON.stringify(payload);
  const r = await fetch(url, init);
  return JSON.parse(await r.text());
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

// ---------------------------------------------------------------------------
// x402 v2 payment plumbing (per-tool price)
// ---------------------------------------------------------------------------
function paymentRequirements(amountAtomic) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: String(amountAtomic),
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT,
    extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
  };
}
function paymentRequiredBody(base, tool) {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: base + "/mcp",
      description: `MCP tool ${tool.name}: ${tool.blurb} Price: ${tool.human} USDC on Base per call.`,
      mimeType: "application/json",
      serviceName: "FiatDock Gateway",
      tags: ["mcp", "x402", tool.tag],
    },
    accepts: [paymentRequirements(tool.atomic)],
  };
}
function mcpFail402(reason, base, rpcId, tool) {
  const body = {
    jsonrpc: "2.0",
    ...(rpcId !== undefined ? { id: rpcId } : {}),
    error: {
      code: 402,
      message:
        `Payment required: ${tool.human} USDC on Base (${NETWORK}) via x402 v2 for tool ${tool.name}. ` +
        "Sign an EIP-3009 TransferWithAuthorization and retry this tools/call " +
        "with a PAYMENT-SIGNATURE header carrying the base64 payment payload, " +
        "or settle to the payTo yourself and retry with an X-PAYMENT-TX header. " +
        `Settlement is sponsored (no gas needed); funds go to ${PAY_TO}.`,
      data: {
        x402Version: 2,
        reason,
        accepts: [paymentRequirements(tool.atomic)],
        facilitator: FACILITATOR,
      },
    },
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": b64(paymentRequiredBody(base, tool)),
    },
  });
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
async function verifyTxProof(raw, minAtomic) {
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
      if (BigInt(lg.data || "0x0") < BigInt(minAtomic)) return [false, "underpaid for this tool"];
      consumedTx.add(tx);
      return [true, "0x" + t[1].slice(-40)];
    }
  }
  return [false, "no USDC transfer to payTo in this tx"];
}

// ---------------------------------------------------------------------------
// Tool computations — re-implemented from the fleet's live Workers, same
// public sources, same "never invent a value" discipline.
// ---------------------------------------------------------------------------

// --- feescout (rapid_g1): live Base fee conditions ---
async function toolFeescout() {
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  const fees = [];
  for (let i = 0; i < 8; i++) {
    const b = await rpc("eth_getBlockByNumber", ["0x" + (latest - i).toString(16), false]);
    fees.push({
      block: latest - i,
      baseFeeGwei: Number(BigInt(b.baseFeePerGas)) / 1e9,
      gasUsedRatio: Number(BigInt(b.gasUsed)) / Number(BigInt(b.gasLimit)),
    });
  }
  fees.reverse();
  const cur = fees[fees.length - 1].baseFeeGwei;
  const prev = fees.slice(0, 4).reduce((a, f) => a + f.baseFeeGwei, 0) / 4;
  const trendPct = prev > 0 ? ((cur - prev) / prev) * 100 : 0;
  const hint = trendPct < -10
    ? "fees falling fast — delaying settlement a few blocks is likely cheaper"
    : trendPct > 10
      ? "fees rising — settle now rather than later"
      : "fees flat — no timing edge; settle whenever ready";
  return {
    service: "feescout", chain: "base", as_of_block: latest,
    current_base_fee_gwei: cur, trend_pct_vs_prev4: Number(trendPct.toFixed(2)),
    recent_blocks: fees, cheapest_settlement_hint: hint,
    note: "Base blocks ~2s; base fee only, excludes priority fee and L1 data fee.",
  };
}

// --- addrage (rapid_g2): Base wallet due-diligence snack ---
async function toolAddrage(args) {
  const address = typeof args.address === "string" ? args.address.trim() : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw { code: -32602, message: "argument 'address' required (0x + 40 hex)" };
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  const txCount = parseInt(await rpc("eth_getTransactionCount", [address, "latest"]), 16);
  const ethWei = BigInt(await rpc("eth_getBalance", [address, "latest"]));
  const balCall = "0x70a08231" + "0".repeat(24) + address.slice(2).toLowerCase();
  const usdcAtomic = BigInt(await rpc("eth_call", [{ to: USDC, data: balCall }, "latest"]));
  let firstSeenBlock = null;
  if (txCount > 0) {
    let lo = 0, hi = latest;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const c = parseInt(await rpc("eth_getTransactionCount", [address, "0x" + mid.toString(16)]), 16);
      if (c > 0) hi = mid; else lo = mid + 1;
    }
    firstSeenBlock = lo;
  }
  return {
    service: "addrage", chain: "base", address,
    as_of_block: latest,
    outbound_tx_count: txCount,
    first_seen_block: firstSeenBlock,
    age_blocks: firstSeenBlock === null ? 0 : latest - firstSeenBlock,
    eth_balance: Number(ethWei) / 1e18,
    usdc_balance: Number(usdcAtomic) / 1e6,
    note: "Age is by first outbound tx on Base; contracts funded but never sending show first_seen_block null. Balances are latest-block snapshots.",
  };
}

// --- slotcheck (rapid_g3): handle availability across public registries ---
async function httpStatus(url) {
  const r = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": "fiatdock-gateway/1.0 (slotcheck)" },
    signal: AbortSignal.timeout(10000),
  });
  try { await r.text(); } catch (e) { /* status only */ }
  return r.status;
}
async function slotCheckOne(source, url) {
  try {
    const st = await httpStatus(url);
    return { source, status: st === 404 ? "available" : st === 200 ? "taken" : "unknown", http: st };
  } catch (e) {
    return { source, status: "unreachable", error: String(e.message || e).slice(0, 120) };
  }
}
async function toolSlotcheck(args) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) throw { code: -32602, message: "argument 'name' required (letters, digits, . _ -, max 63 chars)" };
  const n = encodeURIComponent(name);
  const results = await Promise.all([
    slotCheckOne("github_user", `https://api.github.com/users/${n}`),
    slotCheckOne("npm_package", `https://registry.npmjs.org/${n}`),
    slotCheckOne("pypi_package", `https://pypi.org/pypi/${n}/json`),
    slotCheckOne("huggingface_user", `https://huggingface.co/api/users/${n}`),
  ]);
  const checked = results.filter((r) => r.status !== "unreachable").map((r) => r.source);
  const down = results.filter((r) => r.status === "unreachable").map((r) => r.source);
  return {
    service: "slotcheck", name,
    sources_checked: checked,
    sources_unreachable: down,
    results,
    note: down.length === results.length
      ? "No source was reachable from this Worker at call time; availability is unknown, not invented."
      : "available = exact name not registered at that source; taken = registered; unknown = source answered unexpectedly (often rate limits).",
  };
}

// --- relayproof (rapid_g5): paid fetch receipt, SSRF-guarded ---
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
async function toolRelayproof(args) {
  const target = typeof args.url === "string" ? args.url : null;
  if (!target) throw { code: -32602, message: "argument 'url' required (http/https target to fetch once)" };
  let payload = null;
  if (args.payload !== undefined) payload = typeof args.payload === "string" ? args.payload : JSON.stringify(args.payload);
  let u;
  try { u = new URL(target); } catch (e) { throw { code: -32602, message: "invalid url" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw { code: -32602, message: "only http(s) targets allowed" };
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal"))
    throw { code: -32602, message: "target refused (local hostname)" };
  const ips = (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) ? [host] : await dohIps(host);
  if (!ips.length) throw { code: -32602, message: "target hostname did not resolve" };
  if (ips.some(ipBlocked)) throw { code: -32602, message: "target refused (private/loopback address)" };
  const init = {
    method: payload !== null ? "POST" : "GET",
    redirect: "manual", signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "fiatdock-gateway/1.0 (relayproof)" },
  };
  if (init.method === "POST") { init.body = payload; init.headers["Content-Type"] = "application/json"; }
  let resp, text;
  try { resp = await fetch(u.toString(), init); text = await resp.text(); }
  catch (e) { return { service: "relayproof", target: u.toString(), delivered: false, error: `fetch failed: ${e.message || e}` }; }
  return {
    service: "relayproof", target: u.toString(), delivered: true,
    status: resp.status, response_bytes: new TextEncoder().encode(text).length,
    response_sha256: await sha256hex(text), resolved_ips: ips,
    fetched_at: new Date().toISOString(),
    note: "Receipt proves this Worker fetched the target once and observed this status/body hash. Redirects are not followed.",
  };
}

// --- schemaseal (rapid_g8): JSON-Schema conformance with citable receipt ---
function schemaTypeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
function schemaCheck(schema, value, path, errs) {
  if (!schema || typeof schema !== "object") return;
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    errs.push(`${path}: value not in enum`);
  if (schema.type !== undefined) {
    const t = schemaTypeOf(value);
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
  if (schemaTypeOf(value) === "object") {
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${path}.${r}: required but missing`);
    const props = schema.properties || {};
    for (const k of Object.keys(props)) if (k in value) schemaCheck(props[k], value[k], `${path}.${k}`, errs);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => schemaCheck(schema.items, v, `${path}[${i}]`, errs));
}
function canon(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
}
async function toolSchemaseal(args) {
  if (!args || typeof args !== "object" || !("schema" in args) || !("payload" in args))
    throw { code: -32602, message: "arguments {schema, payload} required (schema = JSON Schema subset)" };
  if (JSON.stringify(args).length > 50000) throw { code: -32602, message: "input too large (max 50KB)" };
  const errs = [];
  schemaCheck(args.schema, args.payload, "$", errs);
  const verdict = errs.length ? "FAIL" : "PASS";
  const receipt = await sha256hex(canon({ schema: args.schema, payload: args.payload, verdict }));
  return { service: "schemaseal", verdict, failing_paths: errs, receipt_sha256: receipt };
}

// --- headcheck (rapid_g9): endpoint health verdict from keyless sources ---
async function toolHeadcheck(args) {
  const domain = String(typeof args.domain === "string" ? args.domain : "")
    .trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain))
    throw { code: -32602, message: "argument 'domain' must be a bare hostname like example.com" };
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
  let cert = null;
  const certUrls = [
    `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=false&expand=dns_names&expand=issuer`,
    `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`,
  ];
  for (const u of certUrls) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": "fiatdock-gateway/1.0 (headcheck)" }, signal: AbortSignal.timeout(12000) });
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
  let https = { ok: false };
  const t0 = Date.now();
  try {
    const r = await fetch(`https://${domain}/`, {
      redirect: "follow", signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "fiatdock-gateway/1.0 (headcheck)" },
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
  return {
    service: "headcheck", domain, dns,
    tls: cert
      ? { ...cert, basis: "certificate-transparency log (keyless): newest issued cert found; issuance history, not a live handshake" }
      : { basis: "unavailable — neither keyless cert source (api.certspotter.com, crt.sh) responded; verdict rests on DNS + HTTPS fetch only" },
    https, verdict, reasons,
  };
}

// --- pool pricing shared by pegwatch (rapid_g10) and poolprice (rapid_g11) ---
const V2F = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"; // Uniswap V2 factory (Base)
const V3F = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD"; // Uniswap V3 factory (Base)
const padAddr = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
async function ethCall(to, data) {
  const out = await rpc("eth_call", [{ to, data }, "latest"]);
  if (!out || out === "0x") throw new Error("empty eth_call result");
  return out;
}
const wordAt = (hex, i) => BigInt("0x" + hex.slice(2).slice(i * 64, i * 64 + 64));
const addrAt = (hex, i) => "0x" + hex.slice(2).slice(i * 64 + 24, i * 64 + 64);
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const decCache = new Map();
async function tokenDecimals(token) {
  if (token === USDC.toLowerCase()) return 6;
  if (!decCache.has(token)) decCache.set(token, Number(wordAt(await ethCall(token, "0x313ce567"), 0)));
  return decCache.get(token);
}
// Price of `token` in USDC from live pool state. null => NO_POOL (never an invented price).
async function priceInUsdc(tokenRaw) {
  const token = tokenRaw.toLowerCase();
  if (token === USDC.toLowerCase()) return { price: 1, src: "identity", pool: USDC };
  const decT = await tokenDecimals(token);
  for (const fee of [100, 500, 3000, 10000]) {
    const pool = addrAt(await ethCall(V3F, "0x1698ee82" + padAddr(token) + padAddr(USDC) + fee.toString(16).padStart(64, "0")), 0);
    if (pool === ZERO_ADDR) continue;
    const t0 = addrAt(await ethCall(pool, "0x0dfe1681"), 0);
    const sqrt = wordAt(await ethCall(pool, "0x3850c7bd"), 0);
    const liq = wordAt(await ethCall(pool, "0x1a686502"), 0).toString();
    const pRaw = Number((sqrt * sqrt * 10n ** 18n) / (2n ** 192n)) / 1e18; // token1 per token0 (raw)
    return { price: (t0 === token ? pRaw : 1 / pRaw) * 10 ** (decT - 6), src: "uniswap-v3", pool, fee, liquidity: liq };
  }
  const pair = addrAt(await ethCall(V2F, "0xe6a43905" + padAddr(token) + padAddr(USDC)), 0);
  if (pair !== ZERO_ADDR) {
    const t0 = addrAt(await ethCall(pair, "0x0dfe1681"), 0);
    const res = await ethCall(pair, "0x0902f1ac");
    const r0 = wordAt(res, 0), r1 = wordAt(res, 1);
    if (r0 === 0n || r1 === 0n) return null;
    const ratio = t0 === token ? Number((r1 * 10n ** 18n) / r0) / 1e18 : Number((r0 * 10n ** 18n) / r1) / 1e18;
    return { price: ratio * 10 ** (decT - 6), src: "uniswap-v2", pool: pair,
      usdc_reserve: Number(t0 === token ? r1 : r0) / 1e6 };
  }
  return null;
}

// --- pegwatch (rapid_g10): stablecoin peg verdict ---
const USDT_ADDR = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"; // Base USDT, 6dp
const DAI_ADDR = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"; // Base DAI, 18dp
async function toolPegwatch() {
  const block = parseInt(await rpc("eth_blockNumber", []), 16);
  const stables = [];
  for (const [symbol, addr] of [["USDT", USDT_ADDR], ["DAI", DAI_ADDR]]) {
    try {
      const p = await priceInUsdc(addr);
      if (!p) { stables.push({ symbol, address: addr, verdict: "NO_POOL" }); continue; }
      const dev = Math.round((p.price - 1) * 10000);
      stables.push({ symbol, address: addr, price_usdc: p.price, deviation_bps: dev, src: p.src, pool: p.pool,
        verdict: Math.abs(dev) <= 10 ? "PEG OK" : Math.abs(dev) <= 50 ? "DRIFT" : "BREAK" });
    } catch (e) { stables.push({ symbol, address: addr, verdict: "NO_POOL", note: String(e.message || e) }); }
  }
  const vs = stables.map((s) => s.verdict);
  const overall = vs.includes("BREAK") ? "BREAK" : vs.includes("DRIFT") ? "DRIFT" : vs.includes("PEG OK") ? "PEG OK" : "NO_POOL";
  return { service: "pegwatch", quote: "USDC", block, stables, overall_verdict: overall };
}

// --- poolprice (rapid_g11): any Base ERC-20 priced in USDC ---
async function toolPoolprice(args) {
  const token = typeof args.token === "string" ? args.token.trim() : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw { code: -32602, message: "argument 'token' required (Base ERC-20 address)" };
  const block = parseInt(await rpc("eth_blockNumber", []), 16);
  try {
    const p = await priceInUsdc(token);
    if (!p) return { service: "poolprice", token, verdict: "NO_POOL", note: "no Uniswap V3 (any fee tier) or V2 USDC pool found on Base for this token", block };
    return { service: "poolprice", token, price_usdc: p.price, quote: "USDC", src: p.src, pool: p.pool,
      ...(p.fee !== undefined ? { fee_tier: p.fee } : {}),
      ...(p.liquidity !== undefined ? { active_liquidity: p.liquidity } : {}),
      ...(p.usdc_reserve !== undefined ? { usdc_reserve: p.usdc_reserve } : {}), block };
  } catch (e) {
    return { service: "poolprice", token, verdict: "NO_POOL", note: String(e.message || e), block };
  }
}

// --- payproof_preflight (payproof POST /preflight): live probe + recorded history ---
// History seed embedded honestly, exactly as the PayProof Worker carries it: the
// Observation Log has recorded since 2026-10-04; depth is young and stated, not implied.
const PP_LOG_META = {
  started: "2026-10-04",
  entries_at_seed: "24+",
  anchored: "weekly, Bitcoin (OpenTimestamps) via git-anchored heads",
  note: "History depth grows daily; today it is young. Dossiers state their own coverage — absence of history is reported, not hidden.",
};
const PP_HISTORY_SEED = {
  "threat-reputation-mcp.hsharmanov02.workers.dev": {
    first_seen: "2026-10-04", observations: "fleet origin (seeded)",
    last_status: 402, payto_drift: false, median_price_usdc: 0.01, settled_payments_observed: "fleet",
  },
};
function b64decText(s) {
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function envelopeCheck(resp) {
  const hdr = resp.headers.get("PAYMENT-REQUIRED");
  if (!hdr) return { present: false, valid: false, issues: ["no PAYMENT-REQUIRED header"] };
  let env;
  try { env = JSON.parse(b64decText(hdr)); } catch (e) { return { present: true, valid: false, issues: [`unparseable PAYMENT-REQUIRED: ${e.message}`] }; }
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
      headers: { "User-Agent": "fiatdock-gateway/1.0 (payproof_preflight)" },
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
async function toolPayproofPreflight(args) {
  const endpointUrl = typeof args.endpoint_url === "string" ? args.endpoint_url : null;
  const address = typeof args.address === "string" ? args.address : null;
  if (!endpointUrl && !address) throw { code: -32602, message: "provide argument 'endpoint_url' or 'address'" };
  const dossier = {
    service: "payproof", kind: "preflight", via: "fiatdock-gateway",
    observation_log: PP_LOG_META,
    history: { observed: false, note: "not yet observed by our census poller — this dossier is live-probe only; recorded history for this endpoint does not exist yet and we do not imply otherwise." },
  };
  if (endpointUrl) {
    dossier.endpoint_url = endpointUrl;
    dossier.live_probe = await probeEndpoint(endpointUrl);
    let host = null;
    try { host = new URL(endpointUrl).host; } catch (e) { /* leave null */ }
    const seed = host ? PP_HISTORY_SEED[host] : null;
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
    const seed = PP_HISTORY_SEED[address.toLowerCase()];
    if (seed) dossier.history = { observed: true, ...seed };
  }
  return dossier;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "feescout", atomic: 10000, human: "$0.01", tag: "gas",
    title: "Base fee conditions",
    blurb: "live Base fee conditions — current base fee, 8-block fee trend, cheapest-settlement hint.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: toolFeescout,
  },
  {
    name: "addrage", atomic: 10000, human: "$0.01", tag: "wallet",
    title: "Base wallet due-diligence snack",
    blurb: "first-seen block age, outbound tx count, current ETH and USDC balance for a Base address.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "Base address, 0x + 40 hex" } },
      required: ["address"],
    },
    run: toolAddrage,
  },
  {
    name: "slotcheck", atomic: 10000, human: "$0.01", tag: "names",
    title: "Handle availability across registries",
    blurb: "handle/name availability across GitHub, npm, PyPI and Hugging Face in one call; unreachable sources are reported, never guessed.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Handle to check (letters, digits, . _ -, max 63 chars)" } },
      required: ["name"],
    },
    run: toolSlotcheck,
  },
  {
    name: "relayproof", atomic: 10000, human: "$0.01", tag: "fetch",
    title: "Paid fetch with delivery receipt",
    blurb: "we fetch your target URL once (SSRF-guarded) and return its HTTP status, response byte count and response-body SHA-256 as a delivery receipt.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL to fetch once" },
        payload: { description: "Optional JSON payload; its presence makes the fetch a POST" },
      },
      required: ["url"],
    },
    run: toolRelayproof,
  },
  {
    name: "schemaseal", atomic: 10000, human: "$0.01", tag: "validation",
    title: "JSON-Schema conformance check",
    blurb: "validate a JSON payload against a JSON Schema subset (type/required/properties/enum/minimum/maximum) — PASS/FAIL with exact failing paths plus a SHA-256 receipt of (schema,payload,verdict) you can cite.",
    inputSchema: {
      type: "object",
      properties: {
        schema: { type: "object", description: "JSON Schema subset to validate against" },
        payload: { description: "JSON value to validate" },
      },
      required: ["schema", "payload"],
    },
    run: toolSchemaseal,
  },
  {
    name: "headcheck", atomic: 10000, human: "$0.01", tag: "health",
    title: "Endpoint health verdict",
    blurb: "live endpoint health verdict for a domain — DNS via keyless DoH, TLS cert expiry/issuer/SAN from keyless certificate-transparency APIs, and a real HTTPS fetch with timing; one OK/WARN/FAIL verdict block with reasons.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", description: "Bare hostname, e.g. example.com" } },
      required: ["domain"],
    },
    run: toolHeadcheck,
  },
  {
    name: "pegwatch", atomic: 10000, human: "$0.01", tag: "defi",
    title: "Stablecoin peg verdict",
    blurb: "USDT and DAI priced in USDC from live Base Uniswap pool state, deviation in bps, verdict PEG OK / DRIFT / BREAK (or NO_POOL, never an invented price).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: toolPegwatch,
  },
  {
    name: "poolprice", atomic: 10000, human: "$0.01", tag: "defi",
    title: "Base token price from live pool state",
    blurb: "price any Base ERC-20 in USDC, computed live from Uniswap V3 slot0 or V2 reserves on-chain (no wrapped price API); returns price + pool + liquidity/reserve, or an explicit NO_POOL verdict.",
    inputSchema: {
      type: "object",
      properties: { token: { type: "string", description: "Base ERC-20 contract address, 0x + 40 hex" } },
      required: ["token"],
    },
    run: toolPoolprice,
  },
  {
    name: "payproof_preflight", atomic: 50000, human: "$0.05", tag: "trust",
    title: "PayProof pre-spend dossier",
    blurb: "pre-spend dossier for an x402 endpoint or payTo address: a live probe right now (status, latency, 402-envelope validity) plus its recorded-history summary from an Observation Log recording since 2026-10-04 (hash-chained, Bitcoin-anchored weekly; depth grows daily and the dossier states its own coverage).",
    inputSchema: {
      type: "object",
      properties: {
        endpoint_url: { type: "string", description: "Endpoint URL to probe, e.g. https://some-service.example/resource" },
        address: { type: "string", description: "payTo address (0x…) to look up in recorded history" },
      },
      minProperties: 1,
      anyOf: [{ required: ["endpoint_url"] }, { required: ["address"] }],
    },
    run: toolPayproofPreflight,
  },
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

function toolDefinition(t) {
  return {
    name: t.name,
    title: t.title,
    description:
      `${t.blurb} ` +
      `PRICE: ${t.human} USDC on Base (${NETWORK}) per call, paid via x402 v2: ` +
      "call without payment to receive HTTP 402 with payment instructions, then retry " +
      "with a PAYMENT-SIGNATURE header (signed EIP-3009 authorization) or an X-PAYMENT-TX " +
      "header (Base tx hash of the fee settled to the payTo). No API key needed.",
    inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: {
      "x402/payment": {
        price: t.human,
        atomicAmount: String(t.atomic),
        asset: "USDC",
        assetContract: USDC,
        network: NETWORK,
        scheme: "exact",
        payTo: PAY_TO,
        facilitator: FACILITATOR,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// MCP (Streamable HTTP) — JSON-RPC 2.0 over POST /mcp
// ---------------------------------------------------------------------------
const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "fiatdock-gateway", title: "FiatDock Gateway", version: "1.0.0" };

function rpcResult(id, result) { return json({ jsonrpc: "2.0", id, result }); }
function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return json({ jsonrpc: "2.0", id, error: err });
}

async function handleToolsCall(id, params, request, base) {
  const name = params && params.name;
  const tool = name ? TOOL_BY_NAME[name] : null;
  if (!tool) return rpcError(id, -32602, `unknown tool: ${name || "(missing)"}`);
  const args = (params && params.arguments) || {};

  // --- x402 gate: payment proven BEFORE any computation or arg validation ---
  let payerInfo = null;
  const txProof = request.headers.get("X-PAYMENT-TX");
  if (txProof) {
    const [ok, res] = await verifyTxProof(txProof, tool.atomic);
    if (!ok) return mcpFail402(`settlement proof rejected: ${res}`, base, id, tool);
    payerInfo = { method: "x-payment-tx", tx: txProof.trim().toLowerCase(), from: res };
  } else {
    const sigHeader = request.headers.get("PAYMENT-SIGNATURE");
    if (!sigHeader) return mcpFail402("payment required", base, id, tool);
    let payload;
    try { payload = b64decode(sigHeader); }
    catch (e) { return mcpFail402(`bad PAYMENT-SIGNATURE: ${e.message || e}`, base, id, tool); }
    const accepted = (payload && payload.accepted) || {};
    const scheme = payload && (payload.scheme || accepted.scheme);
    const network = payload && (payload.network || accepted.network);
    if (!payload || payload.x402Version !== 2 || scheme !== "exact") {
      return mcpFail402("unsupported payment scheme/version", base, id, tool);
    }
    if (network !== NETWORK) return mcpFail402(`wrong network: ${network}`, base, id, tool);
    const [ok, info] = await settleViaFacilitator(payload, tool.atomic);
    if (!ok) return mcpFail402(info, base, id, tool);
    payerInfo = { method: "facilitator", transaction: info.transaction, payer: info.payer, network: info.network || NETWORK };
  }

  // --- paid: run the tool ---
  let out;
  try {
    out = await tool.run(args);
  } catch (err) {
    if (err && err.code === -32602) return rpcError(id, -32602, err.message);
    return rpcError(id, -32603, `tool ${tool.name} failed: ${String((err && err.message) || err).slice(0, 200)}`);
  }
  const paymentResponse = b64({ success: true, ...payerInfo });
  return json(
    {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(out) }],
        isError: false,
      },
    },
    200,
    { "PAYMENT-RESPONSE": paymentResponse }
  );
}

async function handleMcpMessage(msg, request, base) {
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
          `Fleet services for AI agents, one MCP endpoint. tools/list is free. tools/call costs ` +
          `$0.01 USDC on Base per call via x402 v2 (payproof_preflight $0.05). Call unpaid to ` +
          "receive payment instructions (HTTP 402).",
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "tools/list":
      return rpcResult(id, { tools: TOOLS.map(toolDefinition) });
    case "tools/call":
      return handleToolsCall(id, msg.params, request, base);
    case "ping":
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

async function handleMcp(request, base) {
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
      const r = await handleMcpMessage(m, request, base);
      if (r.status !== 202) out.push(await r.json());
    }
    return json(out.length ? out : null, out.length ? 200 : 202);
  }
  return handleMcpMessage(body, request, base);
}

// ---------------------------------------------------------------------------
// Machine-discovery documents
// ---------------------------------------------------------------------------
function bazaarExtension(t) {
  return {
    info: {
      input: {
        type: "mcp",
        protocol: "Streamable HTTP (JSON-RPC 2.0)",
        method: "tools/call",
        tool: t.name,
        argsSchema: t.inputSchema,
      },
      output: { type: "json" },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["input", "output"],
      properties: {
        input: { type: "object", additionalProperties: true },
        output: { type: "object", additionalProperties: true },
      },
      additionalProperties: true,
    },
  };
}
function x402WellKnown(base) {
  return {
    x402Version: 2,
    resources: TOOLS.map((t) => ({
      url: base + "/mcp",
      method: "POST",
      protocol: "MCP Streamable HTTP (JSON-RPC 2.0)",
      description: `MCP tool ${t.name}: ${t.blurb} Price: ${t.human} USDC on Base per call.`,
      mimeType: "application/json",
      serviceName: "FiatDock Gateway",
      tags: ["mcp", "x402", t.tag],
      accepts: [paymentRequirements(t.atomic)],
      extensions: { bazaar: bazaarExtension(t) },
    })),
  };
}
function skillMd(base) {
  const lines = TOOLS.map(
    (t) => `- \`${t.name}\` — ${t.human}/call. ${t.blurb}`
  );
  return (
    "# FiatDock Gateway — fleet services, one MCP endpoint\n\n" +
    "Nine pay-per-call services for AI agents behind a single MCP server, paid via x402 v2.\n\n" +
    `- MCP endpoint (Streamable HTTP): \`POST ${base}/mcp\`\n` +
    `- Pay-to: \`${PAY_TO}\` (receive-only; server never signs)\n` +
    `- Facilitator: ${FACILITATOR} (sponsors settlement gas — buyer needs no ETH)\n` +
    "- Flow: `initialize` → `tools/list` (free) → `tools/call` unpaid → HTTP 402 " +
    "with base64 `PAYMENT-REQUIRED` header → retry with `PAYMENT-SIGNATURE` header " +
    "(signed EIP-3009 authorization), or settle to the payTo yourself and retry with " +
    "an `X-PAYMENT-TX` header carrying the Base tx hash.\n" +
    "- Discovery: `/.well-known/x402` (every tool listed as a resource), `/price`, `/health`.\n\n" +
    "## Tools\n\n" +
    lines.join("\n") + "\n"
  );
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const base = `${url.protocol}//${url.host}`;
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }
    if (path === "/health" && request.method === "GET") {
      return json({ status: "ok", service: "fiatdock-gateway", tools: TOOLS.length, time: new Date().toISOString() });
    }
    if (path === "/mcp") return handleMcp(request, base);
    if (path === "/.well-known/x402" && request.method === "GET") return json(x402WellKnown(base));
    if (path === "/skill.md" && request.method === "GET") {
      return new Response(skillMd(base), { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    if (path === "/price" && request.method === "GET") {
      return json({
        service: "fiatdock-gateway",
        mcp_endpoint: base + "/mcp",
        asset: USDC,
        network: NETWORK,
        payTo: PAY_TO,
        prices: Object.fromEntries(TOOLS.map((t) => [t.name, { amount_atomic: String(t.atomic), human: t.human }])),
        how_to_pay: "POST /mcp tools/call -> 402; retry with PAYMENT-SIGNATURE (x402 v2 exact) or X-PAYMENT-TX: <Base tx hash of the fee to payTo>.",
      });
    }
    if (path === "/" && request.method === "GET") {
      return json({
        service: "fiatdock-gateway — fleet services behind one MCP endpoint",
        mcp_endpoint: base + "/mcp",
        protocol: "MCP Streamable HTTP + x402 v2, scheme exact (EIP-3009)",
        asset: "USDC on Base",
        payTo: PAY_TO,
        tools: TOOLS.map((t) => ({ name: t.name, title: t.title, price: t.human })),
        discovery: ["/price", "/.well-known/x402", "/skill.md", "/health"],
      });
    }
    return json({ error: "not_found", hint: "POST /mcp (MCP Streamable HTTP) — tools/list is free" }, 404);
  },
};
