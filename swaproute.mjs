/**
 * swap-route — FREE Base swap-calldata tool with a disclosed operator fee.
 *
 * Method (buildtry1): returns ready-to-sign KyberSwap swap calldata for
 * Base. The KyberSwap Aggregator API needs no auth, account, or
 * registration. Every route we build carries KyberSwap's `feeReceiver`
 * mechanism: a 0.25% (25 bps) fee taken from the OUTPUT token inside the
 * swapper's own transaction and sent by the Kyber router directly to the
 * operator address below. If (and only if) a caller executes the calldata,
 * the fee settles on-chain to us in the same transaction — we never sign,
 * spend, custody, or claim anything; we only serve data.
 *
 * Fee parameters are FORCED server-side: callers cannot override
 * feeReceiver/feeAmount, and the fee is disclosed in every response
 * (including the no-params docs response) and in the node index.
 */
const FEE_BPS = 25;
const FEE_RECEIVER = "0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2";
const KYBER_BASE = "https://aggregator-api.kyberswap.com/base/api/v1";
const ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const FEE_DISCLOSURE =
  `FEE DISCLOSURE: this free tool builds KyberSwap swap calldata carrying a ` +
  `${FEE_BPS} bps (0.25%) fee, taken from the output token inside YOUR OWN ` +
  `swap transaction and sent by the KyberSwap router to the tool operator ` +
  `at ${FEE_RECEIVER}. There is no other charge for this tool and no ` +
  `payment is due unless you choose to execute the calldata. Review the ` +
  `quoted amounts before signing anything.`;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function docs(base) {
  return json({
    service: "swap-route",
    description:
      "Free Base (chain 8453) swap calldata builder via the KyberSwap " +
      "Aggregator. Returns a ready-to-execute {to, value, data} transaction. " +
      "We serve data only; you (the caller) sign and submit.",
    usage:
      `GET ${base}/swaproute?sender=0xYourAddress&amountIn=1000000000000000` +
      `&tokenIn=${ETH_SENTINEL}&tokenOut=${BASE_USDC}` +
      `&recipient=0xYourAddress&slippageTolerance=50`,
    params: {
      sender: "required — your address (the swap executor / approval owner)",
      amountIn: "required — input amount in token base units (e.g. wei)",
      tokenIn: `optional, default ${ETH_SENTINEL} (native ETH)`,
      tokenOut: `optional, default ${BASE_USDC} (USDC on Base)`,
      recipient: "optional, default = sender — where output tokens land",
      slippageTolerance: "optional, bps, default 50 (0.5%)",
    },
    fee_disclosure: FEE_DISCLOSURE,
    fee: {
      feeBps: FEE_BPS,
      feePercent: "0.25%",
      chargeFeeBy: "currency_out",
      feeReceiver: FEE_RECEIVER,
      note: "Fee parameters are set by the operator and cannot be overridden by callers.",
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/.well-known/x402")) {
      // Free tool, not an x402 resource: keep out of the merged index.
      return json({ error: "not an x402 resource" }, 404);
    }

    const p = url.searchParams;
    const sender = p.get("sender");
    const amountIn = p.get("amountIn");
    if (!sender && !amountIn) return docs(url.origin + "");

    const recipient = p.get("recipient") || sender;
    const tokenIn = p.get("tokenIn") || ETH_SENTINEL;
    const tokenOut = p.get("tokenOut") || BASE_USDC;
    const slippageRaw = Number(p.get("slippageTolerance") || 50);

    if (!ADDR_RE.test(sender || "")) return json({ error: "sender must be a 0x address", fee_disclosure: FEE_DISCLOSURE }, 400);
    if (!ADDR_RE.test(recipient || "")) return json({ error: "recipient must be a 0x address", fee_disclosure: FEE_DISCLOSURE }, 400);
    if (!ADDR_RE.test(tokenIn) || !ADDR_RE.test(tokenOut)) return json({ error: "tokenIn/tokenOut must be 0x addresses", fee_disclosure: FEE_DISCLOSURE }, 400);
    if (!/^\d+$/.test(amountIn || "") || amountIn === "0") return json({ error: "amountIn must be a positive integer string (base units)", fee_disclosure: FEE_DISCLOSURE }, 400);
    if (!Number.isFinite(slippageRaw) || slippageRaw < 0 || slippageRaw > 5000) return json({ error: "slippageTolerance must be 0..5000 bps", fee_disclosure: FEE_DISCLOSURE }, 400);

    const q = new URLSearchParams({
      tokenIn,
      tokenOut,
      amountIn,
      chargeFeeBy: "currency_out",
      feeReceiver: FEE_RECEIVER,
      feeAmount: String(FEE_BPS),
      isInBps: "true",
      saveGas: "false",
    });
    const headers = { "User-Agent": "liminal-node/1.0 (+swap-route)", Accept: "application/json" };
    try {
      const rRes = await fetch(`${KYBER_BASE}/routes?${q}`, { headers, signal: AbortSignal.timeout(15000) });
      const rJson = await rRes.json();
      if (!rRes.ok || rJson.code !== 0 || !rJson.data?.routeSummary) {
        return json({ error: "no route", detail: rJson.message || `kyber HTTP ${rRes.status}`, fee_disclosure: FEE_DISCLOSURE }, 502);
      }
      const summary = rJson.data.routeSummary;
      // Belt-and-braces: refuse to build if Kyber did not echo our fee.
      const ef = summary.extraFee || {};
      if ((ef.feeReceiver || "").toLowerCase() !== FEE_RECEIVER.toLowerCase()) {
        return json({ error: "fee_receiver_mismatch", fee_disclosure: FEE_DISCLOSURE }, 502);
      }
      const deadline = Math.floor(Date.now() / 1000) + 1200;
      const bRes = await fetch(`${KYBER_BASE}/route/build`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ routeSummary: summary, sender, recipient, slippageTolerance: Math.round(slippageRaw), deadline }),
        signal: AbortSignal.timeout(15000),
      });
      const bJson = await bRes.json();
      if (!bRes.ok || bJson.code !== 0 || !bJson.data?.data) {
        return json({ error: "build_failed", detail: bJson.message || `kyber HTTP ${bRes.status}`, fee_disclosure: FEE_DISCLOSURE }, 502);
      }
      const d = bJson.data;
      return json({
        service: "swap-route",
        chain: "base (eip155:8453)",
        to: d.routerAddress,
        value: d.transactionValue,
        data: d.data,
        amountIn: d.amountIn,
        amountInUsd: d.amountInUsd,
        amountOut: d.amountOut,
        amountOutUsd: d.amountOutUsd,
        gasUsd: d.gasUsd,
        deadline,
        note: "Execute promptly: routes go stale within ~a minute on Base. You sign and submit this transaction yourself; we never touch keys or funds.",
        fee_disclosure: FEE_DISCLOSURE,
        fee: { feeBps: FEE_BPS, feePercent: "0.25%", chargeFeeBy: "currency_out", feeReceiver: FEE_RECEIVER },
      });
    } catch (err) {
      return json({ error: "upstream_error", detail: String(err && err.message || err), fee_disclosure: FEE_DISCLOSURE }, 502);
    }
  },
};
