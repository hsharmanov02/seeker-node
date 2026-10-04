// poolprice — paid on-chain price oracle: any Base ERC-20 priced in USDC from live Uniswap V3 slot0 / V2 getReserves (chain state, no wrapped API). Explicit NO_POOL, never an invented price.
// x402 v2 exact on Base; release only after settlement proof to PAY_TO (facilitator PAYMENT-SIGNATURE or on-chain X-PAYMENT-TX via RPC).

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
const V2F = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"; // Uniswap V2 factory (Base), verified on-chain 2026-10-04
const V3F = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD"; // Uniswap V3 factory (Base), verified on-chain 2026-10-04
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
    headers: { "Content-Type": "application/json", "User-Agent": "poolprice/1.0" },
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
// --- minimal EVM helpers (no imports): eth_call + ABI words ---
const pad = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
async function call(to, data) {
  const out = await rpc("eth_call", [{ to, data }, "latest"]);
  if (!out || out === "0x") throw new Error("empty eth_call result");
  return out;
}
const wordAt = (hex, i) => BigInt("0x" + hex.slice(2).slice(i * 64, i * 64 + 64));
const addrAt = (hex, i) => "0x" + hex.slice(2).slice(i * 64 + 24, i * 64 + 64);
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const decCache = new Map();
async function decimals(token) {
  if (token === USDC.toLowerCase()) return 6;
  if (!decCache.has(token)) decCache.set(token, Number(await wordAt(await call(token, "0x313ce567"), 0)));
  return decCache.get(token);
}
// Price of `token` in USDC, computed from live pool state. null => no pool found (explicit NO_POOL, never a made-up price).
async function priceInUsdc(token) {
  token = token.toLowerCase();
  if (token === USDC.toLowerCase()) return { price: 1, src: "identity", pool: USDC };
  const decT = await decimals(token);
  for (const fee of [100, 500, 3000, 10000]) { // V3: discover pool, read slot0 + active liquidity
    const pool = addrAt(await call(V3F, "0x1698ee82" + pad(token) + pad(USDC) + fee.toString(16).padStart(64, "0")), 0);
    if (pool === ZERO_ADDR) continue;
    const t0 = addrAt(await call(pool, "0x0dfe1681"), 0);
    const sqrt = wordAt(await call(pool, "0x3850c7bd"), 0);
    const liq = wordAt(await call(pool, "0x1a686502"), 0).toString();
    const pRaw = Number((sqrt * sqrt * 10n ** 18n) / (2n ** 192n)) / 1e18; // token1 per token0 (raw)
    return { price: (t0 === token ? pRaw : 1 / pRaw) * 10 ** (decT - 6), src: "uniswap-v3", pool, fee, liquidity: liq };
  }
  const pair = addrAt(await call(V2F, "0xe6a43905" + pad(token) + pad(USDC)), 0); // V2 fallback: getReserves
  if (pair !== ZERO_ADDR) {
    const t0 = addrAt(await call(pair, "0x0dfe1681"), 0);
    const res = await call(pair, "0x0902f1ac");
    const r0 = wordAt(res, 0), r1 = wordAt(res, 1);
    if (r0 === 0n || r1 === 0n) return null;
    const ratio = t0 === token ? Number((r1 * 10n ** 18n) / r0) / 1e18 : Number((r0 * 10n ** 18n) / r1) / 1e18;
    return { price: ratio * 10 ** (decT - 6), src: "uniswap-v2", pool: pair,
      usdc_reserve: Number(t0 === token ? r1 : r0) / 1e6 };
  }
  return null;
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
      description: "poolprice: pay $0.01 USDC on Base to price any Base ERC-20 in USDC, computed live from Uniswap V3 slot0 or V2 reserves on-chain (no wrapped price API). Returns price + pool + liquidity/reserve, or an explicit NO_POOL verdict — never an invented price. Released only after settlement to payTo is proven.",
      mimeType: "application/json",
      serviceName: "poolprice",
      tags: ["price", "oracle", "defi", "uniswap", "x402"],
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
  let token = url.searchParams.get("token");
  if (!token && request.method === "POST") {
    try { const j = JSON.parse(await request.text()); token = j && j.token; } catch (e) { /* fall through */ }
  }
  if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) return sendJson({ error: "missing or invalid 'token' (Base ERC-20 address)" }, 400);
  token = token.toLowerCase();
  const block = parseInt(await rpc("eth_blockNumber", []), 16);
  try {
    const p = await priceInUsdc(token);
    if (!p) return sendJson({ service: "poolprice", token, verdict: "NO_POOL", note: "no Uniswap V3 (any fee tier) or V2 USDC pool found on Base for this token", block });
    return sendJson({ service: "poolprice", token, price_usdc: p.price, quote: "USDC", src: p.src, pool: p.pool,
      ...(p.fee !== undefined ? { fee_tier: p.fee } : {}),
      ...(p.liquidity !== undefined ? { active_liquidity: p.liquidity } : {}),
      ...(p.usdc_reserve !== undefined ? { usdc_reserve: p.usdc_reserve } : {}), block });
  } catch (e) {
    return sendJson({ service: "poolprice", token, verdict: "NO_POOL", note: String(e.message || e), block });
  }
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
    if (path === "/health") return sendJson({ status: "ok", service: "poolprice", payTo: PAY_TO });
    if (path === "/") return sendJson({
      service: "poolprice — paid on-chain ERC-20 price in USDC ($0.01/call)",
      payTo: PAY_TO, network: NETWORK,
      gated: { "/resource": "GET ?token=0x… (or POST {token}) -> USDC price computed from live Base Uniswap V3 slot0 / V2 reserves + liquidity, or explicit NO_POOL" },
      discovery: ["/price", "/.well-known/x402", "/skill.md"],
    });
    if (path === "/price") return sendJson({
      service: "poolprice", resource: origin + "/resource",
      price: { amount_atomic: String(PRICE_ATOMIC), human: PRICE_HUMAN, asset: USDC, network: NETWORK },
      payTo: PAY_TO,
      how_to_pay: "GET /resource?token=0x… -> 402; retry with PAYMENT-SIGNATURE (x402 v2 exact) or X-PAYMENT-TX: <Base tx hash of >= $0.01 USDC to payTo>.",
    });
    if (path === "/.well-known/x402") return sendJson({
      x402Version: 2,
      resources: [{ url: origin + "/resource", method: "GET", description: paymentRequiredBody(origin).resource.description, accepts: [paymentRequirements()] }],
    });
    if (path === "/skill.md") return new Response(
      `# poolprice\n\nPaid on-chain price oracle, pay-per-request via x402 v2.\n\n- Endpoint: \`GET ${origin}/resource?token=<Base ERC-20 address>\` (or POST \`{"token": "0x…"}\`)\n- Price: $0.01 USDC on Base (eip155:8453), scheme \`exact\`\n- Pay-to: \`${PAY_TO}\`\n- Returns the token's USDC price computed live from Uniswap V3 slot0 (or V2 getReserves fallback) on Base, with pool address and liquidity. Returns an explicit NO_POOL verdict — never an invented price — when no USDC pool exists.\n`,
      { status: 200, headers: { "Content-Type": "text/markdown" } });
    if (path === "/resource") return handleResource(request, url, origin);
    return sendJson({ error: "not found" }, 404);
  },
};
