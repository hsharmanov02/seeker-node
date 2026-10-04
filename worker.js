// agedaddress — reference oracle for the AgedAddress standard v0.1 (see STANDARD.md).
// POST /qualify: pay $0.01 USDC on Base (x402 v2 exact), get an aged-history qualification
// verdict for one address from PUBLIC keyless evidence (chain explorers / public RPCs) —
// we never sign, custody, or hold keys; receive-only to PAY_TO. Self-verification per
// STANDARD.md §5 is always free; this endpoint sells convenience, never permission.
// Honesty note: only the GENESIS COHORT below is attested by an anchored history log
// (fleet witness log, hash-chained from 2026-10-04, OpenTimestamps-anchored weekly).
// All other addresses get labelled chain-observed evidence; the general anchored-log
// verifier is TODO (STANDARD.md §5) and chain-observed age is never sold as conformance.

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
const EVM_RPCS = {
  base: BASE_RPCS,
  ethereum: [
    "https://ethereum.publicnode.com",
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
  ],
};
const EVM_EXPLORERS = {
  base: "https://base.blockscout.com",
  ethereum: "https://eth.blockscout.com",
};
const SOLANA_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
];
const TIERS = [730, 365, 90, 30]; // days, descending
// Genesis cohort — enrolled 2026-10-04; canonical copy: genesis.json (same directory/repo path).
// Fleet anchored history begins 2026-10-04 (witness log); on-chain age is computed live, never asserted.
const GENESIS = {
  "0x48cdadda34816db1f997c3d3b167a4f6af850cb2": { chain: "base", enrolled_on: "2026-10-04", note: "fleet x402 payTo; first settled external receipts 2026-09-29" },
  "0x5aa9d50abefae3becadd9fe2975bbc7f034ac004": { chain: "base", enrolled_on: "2026-10-04", note: "fleet cc0 wallet (canonical case: 0x5AA9d50ABeFaE3BEcADd9fe2975BBC7f034aC004)" },
  "h52hvds6yuyp81ecudunknfmskzyybetsrw6k1pj2vpw": { chain: "solana", enrolled_on: "2026-10-04", note: "fleet Solana wallet" },
};
const RECORDER_SEED = {
  log_started_utc: "2026-10-04T13:19:54Z",
  head_seq_at_build: 37,
  head_ts_at_build_utc: "2026-10-04T22:28:18Z",
  first_ots_stamp_utc: "2026-10-04T20:06:09Z", // CALENDAR-SUBMITTED at stamp time; Bitcoin confirmation completes on ots upgrade
  first_ots_head: "0ff3f3bd062805e9c6d0d066b815e974492bd5c3f03af1503baed60cc8123910",
  canonical: "github.com/hsharmanov02/seeker-node (agedaddress/ + weekly witness-anchor commits)",
};
const consumedTx = new Set(); // in-isolate replay guard (best effort)

function sendJson(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
async function httpJson(url, payload = null, timeoutSec = 20, method = null) {
  const init = {
    method: method || (payload !== null ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", "User-Agent": "agedaddress/0.1" },
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
async function rpcAny(urls, method, params) {
  let last;
  for (const u of urls) {
    try {
      const out = await httpJson(u, { jsonrpc: "2.0", id: 1, method, params }, 15);
      if (out && out.error) { last = new Error(JSON.stringify(out.error)); continue; }
      return out ? out.result ?? null : null;
    } catch (e) { last = e; }
  }
  throw new Error(`all RPCs failed for ${method}: ${last}`);
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
      url: origin + "/qualify",
      description: "agedaddress: pay $0.01 USDC on Base for an AgedAddress v0.1 qualification check of one address (POST {address, chain?}) from public keyless evidence. Genesis-cohort addresses are attested by the fleet anchored history log; others receive labelled chain-observed evidence. Self-verification per STANDARD.md §5 is free. Released only after settlement to payTo is proven.",
      mimeType: "application/json",
      serviceName: "agedaddress",
      tags: ["sybil-resistance", "aged-history", "attestation", "x402"],
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
  try { rc = await rpcAny(BASE_RPCS, "eth_getTransactionReceipt", [tx]); }
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
function tierFor(days) {
  for (const t of TIERS) if (days >= t) return `AA-${t}`;
  return "below-AA-30";
}
function baseVerdict(address, chain) {
  const g = GENESIS[address.toLowerCase()];
  return {
    service: "agedaddress",
    standard: "AgedAddress v0.1 (STANDARD.md, this repo path agedaddress/)",
    address, chain,
    genesis_cohort: !!g,
    ...(g ? { genesis: { enrolled_on: g.enrolled_on, note: g.note } } : {}),
  };
}
async function legacyList(host, action, address, sort) {
  // Blockscout Etherscan-compatible API — keyless on the public instances (verified live
  // 2026-10-04 against the fleet payTo: tokentx asc returns its real first receipt).
  const u = `${host}/api?module=account&action=${action}&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=${sort}`;
  const out = await httpJson(u, null, 20);
  if (out && Array.isArray(out.result) && out.result.length) return out.result[0];
  return null;
}
function tsIso(unixSeconds) {
  const n = Number(unixSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}
async function evmEvidence(address, chain) {
  // Keyless public evidence: explorer legacy API (first/last over BOTH native txs and
  // token transfers — a receive-only address has no native txs, so transfers are its
  // history) with a public-RPC nonce fallback. Exact counts need full-history
  // pagination and are deliberately not probed; first/last-seen are the
  // qualification-relevant facts.
  const ev = { source: null, first_seen_utc: null, last_seen_utc: null, nonce: null, activity: {} };
  const ex = EVM_EXPLORERS[chain];
  const firsts = [], lasts = [];
  try {
    const [txA, txD, tkA, tkD] = await Promise.all([
      legacyList(ex, "txlist", address, "asc"), legacyList(ex, "txlist", address, "desc"),
      legacyList(ex, "tokentx", address, "asc"), legacyList(ex, "tokentx", address, "desc"),
    ]);
    if (txA) { ev.activity.first_transaction_utc = tsIso(txA.timeStamp); firsts.push(ev.activity.first_transaction_utc); }
    if (tkA) { ev.activity.first_token_transfer_utc = tsIso(tkA.timeStamp); firsts.push(ev.activity.first_token_transfer_utc); }
    if (txD) lasts.push(tsIso(txD.timeStamp));
    if (tkD) lasts.push(tsIso(tkD.timeStamp));
    const f = firsts.filter(Boolean).sort(), l = lasts.filter(Boolean).sort();
    if (f.length) ev.first_seen_utc = f[0];
    if (l.length) ev.last_seen_utc = l[l.length - 1];
    if (ev.first_seen_utc) ev.source = `keyless explorer legacy API (${chain} Blockscout)`;
  } catch (e) { /* fall through to RPC nonce */ }
  try {
    const n = await rpcAny(EVM_RPCS[chain], "eth_getTransactionCount", [address, "latest"]);
    if (n != null) ev.nonce = parseInt(n, 16);
  } catch (e) { /* nonce optional when explorer answered */ }
  if (!ev.source && ev.nonce != null) ev.source = `public RPC nonce-only (${chain})`;
  return ev;
}
async function solanaEvidence(address) {
  const ev = { source: null, first_seen_utc: null, last_seen_utc: null, tx_count: null, tx_count_is_lower_bound: false };
  const sigs = await rpcAny(SOLANA_RPCS, "getSignaturesForAddress", [address, { limit: 1000 }]);
  if (Array.isArray(sigs) && sigs.length) {
    const times = sigs.map((s) => s.blockTime).filter((t) => typeof t === "number");
    if (times.length) {
      ev.first_seen_utc = new Date(Math.min(...times) * 1000).toISOString();
      ev.last_seen_utc = new Date(Math.max(...times) * 1000).toISOString();
    }
    ev.tx_count = sigs.length;
    ev.tx_count_is_lower_bound = sigs.length >= 1000;
    ev.source = "public Solana RPC (getSignaturesForAddress, newest 1000)";
  }
  return ev;
}
async function qualify(address, chain) {
  const out = baseVerdict(address, chain);
  let ev = null, evErr = null;
  try { ev = chain === "solana" ? await solanaEvidence(address) : await evmEvidence(address, chain); }
  catch (e) { evErr = e.message || String(e); }
  const now = Date.now();
  out.observed = ev;
  if (!ev || (!ev.first_seen_utc && ev.nonce == null)) {
    out.verdict = "insufficient-keyless-evidence";
    out.detail = "No public keyless evidence source answered for this address right now. " +
      (evErr ? `Last error: ${evErr}. ` : "") +
      "This is an evidence outage, not a finding about the address. Self-verification (STANDARD.md §5) does not depend on this oracle.";
    return out;
  }
  let observedDays = null;
  if (ev.first_seen_utc) {
    observedDays = Math.floor((now - Date.parse(ev.first_seen_utc)) / 86400000);
    out.observed_age_days = observedDays;
    out.observed_tier = tierFor(observedDays);
  }
  if (out.genesis_cohort) {
    const anchoredDays = Math.max(0, Math.floor((now - Date.parse(RECORDER_SEED.log_started_utc)) / 86400000));
    out.attestation = {
      basis: "anchored-history-log",
      log: RECORDER_SEED,
      anchored_history_days: anchoredDays,
      anchored_tier: tierFor(anchoredDays),
      verifier: "anyone — recompute the hash chain and ots-verify the anchored heads (STANDARD.md §5)",
    };
    out.standard_tier = tierFor(anchoredDays) === "below-AA-30" ? null : tierFor(anchoredDays);
    out.verdict = out.standard_tier
      ? `qualifies at ${out.standard_tier} (genesis cohort, anchored log)`
      : "genesis cohort — anchored history is accruing; AA-30 first matures ~2026-11-03";
  } else {
    out.attestation = {
      basis: "chain-observed-only",
      anchored_log: false,
      verifier: "TODO — general anchored-log verifier (STANDARD.md §5); only the genesis cohort is AHL-attested today",
    };
    out.standard_tier = null;
    out.verdict = "observed-only — observed age is evidence, NOT AgedAddress qualification (no public anchored history log attests this address)";
  }
  out.caveats = [
    "AgedAddress proves a history was costly in time; it does not prove uniqueness of person, and aged keys can change hands (STANDARD.md §4, §8).",
    "Observed (explorer/RPC) age is weaker than anchored continuity and is labelled as such; the two are never conflated.",
    "Self-verification per STANDARD.md §5 is always free and trust-free; this fee prices oracle convenience only.",
  ];
  return out;
}
async function paidPayload(request, url) {
  // Runs ONLY after payment is proven; parameter validation lives here, never before the 402.
  let body = {};
  if (request.method === "POST") {
    const t = await request.text();
    if (t) { try { body = JSON.parse(t); } catch (e) { return sendJson({ error: "body must be JSON {address, chain?}" }, 400); } }
  }
  const address = String(body.address || url.searchParams.get("address") || "").trim();
  let chain = String(body.chain || url.searchParams.get("chain") || "").trim().toLowerCase();
  if (!address) return sendJson({ error: "missing 'address'" }, 400);
  if (!chain) chain = address.startsWith("0x") ? "base" : "solana";
  if (chain === "solana") {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return sendJson({ error: "not a valid Solana address (base58)" }, 400);
  } else {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return sendJson({ error: "not a valid EVM address" }, 400);
    if (!EVM_RPCS[chain]) return sendJson({ error: "chain must be 'base', 'ethereum' or 'solana'" }, 400);
  }
  return sendJson(await qualify(address, chain));
}
async function handleQualify(request, url, origin) {
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
    if (path === "/health") return sendJson({ status: "ok", service: "agedaddress", standard: "AgedAddress v0.1", payTo: PAY_TO });
    if (path === "/") return sendJson({
      service: "agedaddress — reference oracle for the AgedAddress standard (aged public history as a sybil filter)",
      standard: "AgedAddress v0.1 — spec: github.com/hsharmanov02/seeker-node/blob/main/agedaddress/STANDARD.md",
      payTo: PAY_TO, network: NETWORK,
      gated: { "/qualify": "POST {address, chain?: base|ethereum|solana} -> qualification verdict from public keyless evidence ($0.01/call; self-verification per STANDARD.md §5 is free)" },
      free: { "/genesis": "genesis cohort registry (mirror of genesis.json)", "/price": "pricing", "/skill.md": "agent instructions" },
      discovery: ["/price", "/.well-known/x402", "/skill.md", "/genesis"],
    });
    if (path === "/genesis") return sendJson({ standard: "AgedAddress v0.1", cohort: "genesis", enrolled_on: "2026-10-04", recorder: RECORDER_SEED, entries: Object.entries(GENESIS).map(([k, v]) => ({ key: k, ...v })) });
    if (path === "/price") return sendJson({
      service: "agedaddress", resource: origin + "/qualify",
      price: { amount_atomic: String(PRICE_ATOMIC), human: PRICE_HUMAN, asset: USDC, network: NETWORK },
      payTo: PAY_TO,
      free_alternative: "Self-verification per STANDARD.md §5 costs nothing and trusts no one; the fee prices multi-chain evidence fetching and uptime only.",
      how_to_pay: "POST /qualify -> 402; retry with PAYMENT-SIGNATURE (x402 v2 exact) or X-PAYMENT-TX: <Base tx hash of >= $0.01 USDC to payTo>.",
    });
    if (path === "/.well-known/x402") return sendJson({
      x402Version: 2,
      resources: [{ url: origin + "/qualify", method: "POST", description: paymentRequiredBody(origin).resource.description, accepts: [paymentRequirements()] }],
    });
    if (path === "/skill.md") return new Response(
      `# agedaddress\n\nReference oracle for the **AgedAddress v0.1** standard: aged, Bitcoin-anchored public history as a sybil filter — qualification with no keys, no name, no stake, no signature at receipt.\n\n- Paid lookup: \`POST ${origin}/qualify\` with JSON \`{"address": "0x…", "chain": "base"}\` (chain: base | ethereum | solana; auto-detected when omitted)\n- Price: $0.01 USDC on Base (eip155:8453), scheme \`exact\`, pay-to \`${PAY_TO}\`\n- Returns observed first-seen age/tier from public keyless evidence. Genesis-cohort addresses are attested by an anchored history log; all others are explicitly labelled \`chain-observed-only\` — observed age is evidence, not standard qualification.\n- **Free alternative:** verify any anchored history log yourself per STANDARD.md §5 (github.com/hsharmanov02/seeker-node/blob/main/agedaddress/STANDARD.md). The fee buys convenience only.\n- Genesis cohort (free): \`GET ${origin}/genesis\`\n`,
      { status: 200, headers: { "Content-Type": "text/markdown" } });
    if (path === "/qualify") return handleQualify(request, url, origin);
    return sendJson({ error: "not found" }, 404);
  },
};
