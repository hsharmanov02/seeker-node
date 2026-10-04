// paylink — paid payment-link minter: pay $0.01, get a ready-to-share Base (ERC-681) or Solana Pay URL + checkout summary. Funds never touch us.
// x402 v2 exact on Base; release only after settlement proof to PAY_TO (facilitator PAYMENT-SIGNATURE or on-chain X-PAYMENT-TX via RPC).
// Stateless: nothing is stored; the returned URL is the deliverable.

const FACILITATOR = "https://facilitator.xpay.sh";
const NETWORK = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2";
const SOL_ADDR = "H52Hvds6YUyp81eCUDuNknfmSKzYyBETSRW6k1Pj2VPw";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ORDER_PAGE = "https://rawcdn.githack.com/hsharmanov02/seeker-node/main/demos/order/index.html";
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
    headers: { "Content-Type": "application/json", "User-Agent": "paylink/1.0" },
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
      description: "paylink: pay $0.01 USDC on Base to mint a ready-to-share payment link — POST {chain: base|solana, amount, label}; base returns an ERC-681 ethereum: URL plus an x402 order-page checkout URL, solana returns a solana: Pay URL. Payment funds move payer->recipient directly; paylink only forms the link.",
      mimeType: "application/json",
      serviceName: "paylink",
      tags: ["payment-link", "checkout", "x402", "solana-pay"],
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
  const chain = String(j.chain ?? url.searchParams.get("chain") ?? "base").toLowerCase();
  const amount = j.amount ?? url.searchParams.get("amount");
  const label = String(j.label ?? url.searchParams.get("label") ?? "").slice(0, 80);
  const amt = Number(amount);
  if (!(amt > 0) || !isFinite(amt)) return sendJson({ error: "amount must be a positive number (USDC)" }, 400);
  if (amt > 1000000) return sendJson({ error: "amount too large (max 1000000)" }, 400);
  if (chain === "base") {
    const atomic = BigInt(Math.round(amt * 1e6)).toString();
    const paymentUrl = `ethereum:${USDC}@8453/transfer?address=${PAY_TO}&uint256=${atomic}`;
    const checkoutUrl = `${ORDER_PAGE}?chain=base&amount=${amt}&label=${encodeURIComponent(label)}`;
    return sendJson({
      service: "paylink", chain, amount_usdc: amt, recipient: PAY_TO, asset: USDC, network: NETWORK,
      payment_url: paymentUrl, checkout_url: checkoutUrl,
      summary: `Pay $${amt.toFixed(2)} USDC on Base to ${PAY_TO}${label ? ` for "${label}"` : ""}. Open payment_url in any ERC-681 wallet, or share checkout_url. Funds move payer->recipient directly; paylink never touches them.`,
    });
  }
  if (chain === "solana") {
    const p = new URLSearchParams();
    p.set("amount", String(amt));
    p.set("spl-token", SOL_USDC);
    if (label) { p.set("label", label); p.set("message", label); }
    return sendJson({
      service: "paylink", chain, amount_usdc: amt, recipient: SOL_ADDR, asset: SOL_USDC, network: "solana-mainnet",
      payment_url: `solana:${SOL_ADDR}?${p.toString()}`,
      summary: `Pay $${amt.toFixed(2)} USDC on Solana to ${SOL_ADDR}${label ? ` for "${label}"` : ""}. Open payment_url in any Solana Pay wallet. Funds move payer->recipient directly; paylink never touches them.`,
    });
  }
  return sendJson({ error: "chain must be 'base' or 'solana'" }, 400);
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
    if (path === "/health") return sendJson({ status: "ok", service: "paylink", payTo: PAY_TO });
    if (path === "/") return sendJson({
      service: "paylink — paid payment-link minter ($0.01/call)",
      payTo: PAY_TO, network: NETWORK,
      gated: { "/resource": "POST {chain: base|solana, amount, label} -> ready-to-share payment URL + checkout summary" },
      discovery: ["/price", "/.well-known/x402", "/skill.md"],
    });
    if (path === "/price") return sendJson({
      service: "paylink", resource: origin + "/resource",
      price: { amount_atomic: String(PRICE_ATOMIC), human: PRICE_HUMAN, asset: USDC, network: NETWORK },
      payTo: PAY_TO,
      how_to_pay: "POST /resource -> 402; retry with PAYMENT-SIGNATURE (x402 v2 exact) or X-PAYMENT-TX: <Base tx hash of >= $0.01 USDC to payTo>.",
    });
    if (path === "/.well-known/x402") return sendJson({
      x402Version: 2,
      resources: [{ url: origin + "/resource", method: "POST", description: paymentRequiredBody(origin).resource.description, accepts: [paymentRequirements()] }],
    });
    if (path === "/skill.md") return new Response(
      `# paylink\n\nPaid payment-link minter, pay-per-request via x402 v2.\n\n- Endpoint: \`POST ${origin}/resource\` with JSON \`{"chain": "base"|"solana", "amount": 12.50, "label": "invoice 7"}\`\n- Price: $0.01 USDC on Base (eip155:8453), scheme \`exact\`\n- Pay-to: \`${PAY_TO}\`\n- Base returns an ERC-681 \`ethereum:\` URL + an x402 order-page checkout URL; solana returns a \`solana:\` Pay URL. Funds always move payer->recipient directly.\n`,
      { status: 200, headers: { "Content-Type": "text/markdown" } });
    if (path === "/resource") return handleResource(request, url, origin);
    return sendJson({ error: "not found" }, 404);
  },
};
