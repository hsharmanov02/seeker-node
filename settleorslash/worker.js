// SettleOrSlash v1 — canonical escrow-exit primitive (Cloudflare Worker port).
// Port of ~/workspace/build_mode/settleorslash_live/settleorslash.py; concept
// in ~/workspace/build_mode/aquarius5/CONCEPT.md; see LIVE_TEST.md there.
// Code ready to deploy; deployment is a separate step (not deployed here).
//
// Behaviour preserved from the Python daemon:
// - POST /jobs issues the canonical job template (poster, worker,
//   escrow_address, amount_atomic >= $1, deadline_hours <= 24) and its
//   template hash.
// - Funding is proven receive-only: a Base USDC transfer FROM the poster to
//   the job's declared escrow_address, >= job amount, fresh (<= 24h),
//   replay-protected, verified via public Base RPC. We never sign,
//   broadcast, custody keys or funds, or front gas — parties sign their
//   own transactions; we only verify them.
// - The worker submits a deliverable hash; exits are proven by tx(s) FROM
//   the escrow address. BOTH terminal transitions route the 2.5% split to
//   PAY_TO by construction: RELEASED needs main leg (to worker) >= 97.5%
//   AND fee leg (to payTo) >= 2.5%; FORFEITED needs main leg (poster
//   refund) >= 97.5% AND the same fee leg. There is no route, endpoint,
//   or code path that completes a job without the split.
// - Funding-trace accounting (light ChainWard test, as in MeterGate):
//   posters recently funded in USDC by our own address set are flagged
//   loop/self-funded; poster == worker (self-dealing) and fleet addresses
//   among the job parties are flagged too. Flagged jobs NEVER count as
//   arrivals. Unverifiable => not external, never arrival.
// - Discovery mirrors the MeterGate worker: /, /health, /price,
//   /.well-known/x402, /skill.md (plus the Python-native /template,
//   /.well-known/settleorslash, /.well-known/agent.json, /jobs/{id},
//   /stats).
// - Test mode (SOS_TEST_MODE=1) accepts synthetic proofs so the state
//   machine can be verified end-to-end without moving money; test events
//   are never counted as arrivals, and test jobs can never settle live.
//
// STATE TODOs — Workers are stateless: no local disk, no cross-isolate
// memory, no boot hook. Three pieces of Python process/disk state cannot
// be ported 1:1 yet, and this file does NOT pretend otherwise:
//   TODO(KV/D1): job state (Python: durable state.json). Below, jobs live
//     in an in-isolate Map that resets whenever the isolate recycles —
//     created jobs, funding state, deliverable hashes and deadline
//     transitions DO NOT survive. Wire KV (`job:{job_id}`) or a D1 jobs
//     table before treating this as a real template registry; until then
//     a multi-request job flow only works while one isolate stays warm.
//   TODO(KV): replay set (Python: _consumed_tx persisted in state.json).
//     Below is a best-effort in-isolate Set with the same limitation, so
//     replay protection is WEAKER than the Python daemon until KV
//     (`consumed:{txhash}`, ~7d TTL to cover MAX_EXIT_AGE_SEC) is wired.
//   TODO(KV/D1): ledger (Python: ledger.jsonl, one JSON line per event).
//     Here events are emitted via console.log only and are NOT persisted.
// Deadline/auto-release transitions stay lazy (evaluated on read/action),
// exactly as the Python refresh_state; a Workers Cron Trigger could sweep
// them proactively, but that would be new behaviour, not a port.

const NETWORK = "eip155:8453"; // Base mainnet
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // native USDC on Base
const PAY_TO = "0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2"; // fleet receive-only
const FEE_NUM = 25n; // 2.5% hard split, both exits: FEE_NUM / FEE_DEN
const FEE_DEN = 1000n;
const MIN_AMOUNT_ATOMIC = 1000000n; // $1 minimum job
const MAX_DEADLINE_HOURS = 24; // concept's 24h lock cap
const USD_GBP = 0.75489; // ECB ref 2026-09-29 (as Cell 21)
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BASE_RPCS = [
  "https://base.publicnode.com",
  "https://mainnet.base.org",
  "https://1rpc.io/base",
  "https://base-mainnet.public.blastapi.io",
];
// Our own address set for the funding-trace (loop) test: fleet payTo + cc0
// wallet. A poster recently funded in USDC by any of these is not external.
const OUR_ADDRESSES = new Set([
  PAY_TO.toLowerCase(),
  "0x5aa9d50abefaE3BEcADd9fe2975BBC7f034aC004".toLowerCase(),
]);
const TRACE_BLOCK_WINDOW = 2000; // blocks scanned for poster funding
const MAX_FUNDING_AGE_SEC = 24 * 3600; // funding-proof freshness window
const MAX_EXIT_AGE_SEC = 7 * 24 * 3600; // exit-proof freshness window

// NON-DURABLE in-isolate state (see STATE TODOs in the header). Both of
// these reset whenever the isolate recycles; neither is a store.
const jobs = new Map(); // job_id -> job  (TODO(KV/D1): not durable)
const consumedTx = new Set(); // accepted funding/exit txs (TODO(KV): not durable)

// ---------------------------------------------------------------- helpers
function log(msg) {
  console.log(`[${new Date().toISOString().replace(/\.\d+Z$/, "Z")}] ${msg}`);
}

function sendJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function httpJson(url, payload = null, timeoutSec = 25) {
  const init = {
    method: payload !== null ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "User-Agent": "settleorslash/1.0" },
    signal: AbortSignal.timeout(timeoutSec * 1000),
  };
  if (payload !== null) init.body = JSON.stringify(payload);
  const resp = await fetch(url, init);
  return JSON.parse(await resp.text());
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Python str(float) formatting for the canonical template string: integral
// floats render as "24.0" (JS would give "24"); non-integral values use
// the shortest round-trip form in both languages.
function pyFloat(x) {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

// Parse an atomic amount (Python: int(...)): numbers truncate like
// Python's int(float); strings must be plain integers.
function parseAtomic(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("not numeric");
    return BigInt(Math.trunc(v));
  }
  const s = String(v ?? "").trim();
  if (!/^[+-]?\d+$/.test(s)) throw new Error("not numeric");
  return BigInt(s);
}

function isAddress(a) {
  if (!(a.startsWith("0x") && a.length === 42)) return false;
  try {
    BigInt(a);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Base RPC
async function rpc(method, params) {
  let last = null;
  for (const url of BASE_RPCS) {
    try {
      const out = await httpJson(
        url,
        { jsonrpc: "2.0", id: 1, method, params },
        15
      );
      if (out && out.error) {
        last = new Error(JSON.stringify(out.error));
        continue;
      }
      return out ? out.result ?? null : null;
    } catch (e) {
      last = e; // try next RPC
    }
  }
  throw new Error(`all Base RPCs failed for ${method}: ${last}`);
}

async function fundingTrace(payer) {
  // Light ChainWard funding-trace: was this payer recently funded in USDC
  // by one of OUR addresses? Returns [external, note]. Conservative:
  // unverifiable => [false, "unverified..."] so it never counts as arrival.
  payer = payer.toLowerCase();
  try {
    const latest = parseInt(await rpc("eth_blockNumber", []), 16);
    const fromBlock = Math.max(0, latest - TRACE_BLOCK_WINDOW);
    const topicTo = "0x" + "0".repeat(24) + payer.slice(2);
    const logs =
      (await rpc("eth_getLogs", [
        {
          address: USDC,
          topics: [TRANSFER_TOPIC, null, topicTo],
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "0x" + latest.toString(16),
        },
      ])) || [];
    for (const lg of logs) {
      const funder = "0x" + lg.topics[1].slice(-40);
      if (OUR_ADDRESSES.has(funder.toLowerCase())) {
        return [
          false,
          `loop: payer funded by our address ${funder} in tx ${lg.transactionHash}`,
        ];
      }
    }
    return [
      true,
      `no funding from our set in last ${TRACE_BLOCK_WINDOW} blocks (${logs.length} inbound USDC transfers seen)`,
    ];
  } catch (e) {
    return [false, `unverified: ${e.message || e}`];
  }
}

// ---------------------------------------------------------------- template
function feeAtomic(amountAtomic) {
  return (amountAtomic * FEE_NUM) / FEE_DEN;
}

async function templateHash(poster, worker, amountAtomic, deadlineHours) {
  // Canonical string identical to the Python daemon's template_hash.
  const canon =
    `settleorslash/v1|poster=${poster.toLowerCase()}|worker=${worker.toLowerCase()}` +
    `|payTo=${PAY_TO.toLowerCase()}|amount=${amountAtomic.toString()}` +
    `|deadline_h=${pyFloat(deadlineHours)}|fee=25/1000`;
  return "0x" + (await sha256Hex(canon));
}

// ---------------------------------------------------------------- proofs
async function txTransfers(txHashRaw) {
  // USDC Transfer logs of a presented tx. Returns
  // { ok, reason, block, transfers: [[from, to, amountBigInt], ...] }.
  const txHash = String(txHashRaw ?? "").trim().toLowerCase();
  if (!(txHash.startsWith("0x") && txHash.length === 66)) {
    return { ok: false, reason: "malformed tx hash", block: null, transfers: [] };
  }
  try {
    BigInt(txHash);
  } catch {
    return { ok: false, reason: "malformed tx hash", block: null, transfers: [] };
  }
  let receipt;
  try {
    receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  } catch (e) {
    return {
      ok: false,
      reason: `receipt lookup failed: ${e.message || e}`,
      block: null,
      transfers: [],
    };
  }
  if (!receipt) {
    return { ok: false, reason: "tx not found on Base", block: null, transfers: [] };
  }
  if (receipt.status !== "0x1") {
    return { ok: false, reason: "tx reverted on-chain", block: null, transfers: [] };
  }
  const transfers = [];
  for (const lg of receipt.logs || []) {
    if ((lg.address || "").toLowerCase() !== USDC.toLowerCase()) continue;
    const topics = lg.topics || [];
    if (topics.length >= 3 && topics[0].toLowerCase() === TRANSFER_TOPIC) {
      let amount;
      try {
        amount = BigInt(lg.data || "0x0");
      } catch {
        amount = 0n;
      }
      transfers.push([
        "0x" + topics[1].slice(-40),
        "0x" + topics[2].slice(-40),
        amount,
      ]);
    }
  }
  return { ok: true, reason: "ok", block: parseInt(receipt.blockNumber, 16), transfers };
}

async function txAgeSec(blockNumber) {
  try {
    const block = await rpc("eth_getBlockByNumber", [
      "0x" + blockNumber.toString(16),
      false,
    ]);
    return Date.now() / 1000 - parseInt(block.timestamp, 16);
  } catch {
    return 0; // age check best-effort, as in the Python version
  }
}

async function verifyFunding(job, txHashRaw) {
  // Funding proof: a fresh, unreplayed USDC transfer FROM the poster of
  // >= job amount, into the job's declared escrow address.
  // Returns [ok, reason]; on success sets job.funding_block.
  const txh = String(txHashRaw ?? "").trim().toLowerCase();
  if (consumedTx.has(txh)) {
    // TODO(KV): in-isolate set only; see STATE TODOs in the header.
    return [false, "funding tx already consumed (replay rejected)"];
  }
  const res = await txTransfers(txh);
  if (!res.ok) return [false, res.reason];
  const matches = res.transfers.filter(
    ([f, t, a]) =>
      f.toLowerCase() === job.poster &&
      t.toLowerCase() === job.escrow_address &&
      a >= job.amount_atomic
  );
  if (matches.length === 0) {
    return [
      false,
      `no USDC transfer from poster to job escrow address of >= ${job.amount_atomic} atomic in this tx`,
    ];
  }
  if ((await txAgeSec(res.block)) > MAX_FUNDING_AGE_SEC) {
    return [false, "funding tx too old (>24h) - stale proof rejected"];
  }
  job.funding_block = res.block;
  return [true, "ok"];
}

async function verifyExit(job, txHashes, kind) {
  // Exit proof: across the presented txs, transfers FROM the job's escrow
  // address must include the main leg (worker on release / poster on
  // forfeit) of >= amount - fee AND the fee leg to PAY_TO of >= fee. This
  // is the only route into a terminal state — no completion without the
  // split exists.
  if (!txHashes || txHashes.length === 0 || txHashes.length > 4) {
    return { ok: false, reason: "present 1-4 exit tx hashes" };
  }
  const fee = feeAtomic(job.amount_atomic);
  const mainMin = job.amount_atomic - fee;
  const mainTo = kind === "release" ? job.worker : job.poster;
  let mainSum = 0n;
  let feeSum = 0n;
  const seen = [];
  for (const raw of txHashes) {
    const txh = String(raw).trim().toLowerCase();
    if (consumedTx.has(txh)) {
      // TODO(KV): in-isolate set only; see STATE TODOs in the header.
      return {
        ok: false,
        reason: `exit tx ${txh.slice(0, 18)}... already consumed (replay rejected)`,
      };
    }
    const res = await txTransfers(txh);
    if (!res.ok) {
      return { ok: false, reason: `exit tx ${txh.slice(0, 18)}...: ${res.reason}` };
    }
    if (job.funding_block !== null && res.block < job.funding_block) {
      return { ok: false, reason: "exit tx predates funding" };
    }
    if ((await txAgeSec(res.block)) > MAX_EXIT_AGE_SEC) {
      return { ok: false, reason: "exit tx too old (>7d)" };
    }
    for (const [f, t, a] of res.transfers) {
      if (f.toLowerCase() !== job.escrow_address) continue;
      if (t.toLowerCase() === mainTo) mainSum += a;
      if (t.toLowerCase() === PAY_TO.toLowerCase()) feeSum += a;
    }
    seen.push(txh);
  }
  if (mainSum < mainMin) {
    return {
      ok: false,
      reason: `${kind} main leg short: ${mainSum} < ${mainMin} atomic (97.5%)`,
    };
  }
  if (feeSum < fee) {
    return {
      ok: false,
      reason:
        `fee leg missing/short: ${feeSum} < ${fee} atomic (2.5% to payTo) ` +
        "- exit cannot complete without the split",
    };
  }
  return { ok: true, feeAtomic: feeSum, mainAtomic: mainSum, txs: seen };
}

// ---------------------------------------------------------------- state
function refreshState(job) {
  // Lazy deterministic transitions: deadline passing without a deliverable
  // moves FUNDED -> EXPIRED (the forfeit path); 24h poster silence after
  // the deadline on a DELIVERED job opens the release path. No other
  // time-based exits.
  const now = Date.now() / 1000;
  if (job.state === "FUNDED" && now > job.deadline_ts && !job.deliverable_hash) {
    job.state = "EXPIRED";
  } else if (job.state === "DELIVERED" && now > job.deadline_ts + 24 * 3600) {
    job.auto_release_open = true;
  }
  return job;
}

function jobView(job) {
  // amount_atomic / fee_settled_atomic are BigInt internally and are
  // serialised as strings here (JSON-safe at any size; the Python daemon
  // emits ints, which are identical below 2^53).
  const fee = feeAtomic(job.amount_atomic);
  return {
    ...job,
    amount_atomic: job.amount_atomic.toString(),
    fee_settled_atomic: job.fee_settled_atomic.toString(),
    fee_atomic: fee.toString(),
    fee_usd: Number(fee) / 1e6,
    main_leg_min_atomic: (job.amount_atomic - fee).toString(),
  };
}

function ledgerAppend(rec) {
  // TODO(KV/D1): persist this record (the ledger.jsonl analogue) instead
  // of only logging it. Amounts arrive pre-stringified at the call sites.
  log(`ledger ${JSON.stringify({ ...rec, ts: Math.floor(Date.now() / 1000) })}`);
}

// ---------------------------------------------------------------- actions
function isTestRequest(body, testMode) {
  // Test mode: synthetic proofs accepted, never counted as arrival.
  // NOTE (not 1:1 with Python): the daemon also required the client to be
  // loopback (127.0.0.1/::1). A Worker has no loopback clients, so that
  // restriction cannot be replicated; test mode here is gated ONLY by the
  // SOS_TEST_MODE env var. Keep it unset in any public deployment.
  return Boolean(testMode && body && body.test === true);
}

async function createJob(body, testMode) {
  const poster = String(body.poster ?? "").toLowerCase();
  const worker = String(body.worker ?? "").toLowerCase();
  const escrow = String(body.escrow_address ?? "").toLowerCase();
  let amount;
  let deadlineH;
  try {
    amount = parseAtomic(body.amount_atomic);
    deadlineH = Number(body.deadline_hours);
    if (!Number.isFinite(deadlineH)) throw new Error("not numeric");
  } catch {
    return sendJson(
      { error: "amount_atomic/deadline_hours must be numeric" },
      400
    );
  }
  for (const [name, addr] of [
    ["poster", poster],
    ["worker", worker],
    ["escrow_address", escrow],
  ]) {
    if (!isAddress(addr)) {
      return sendJson({ error: `${name} must be a 0x address` }, 400);
    }
  }
  if (amount < MIN_AMOUNT_ATOMIC) {
    return sendJson(
      { error: `amount_atomic below minimum ${MIN_AMOUNT_ATOMIC}` },
      400
    );
  }
  if (!(deadlineH > 0 && deadlineH <= MAX_DEADLINE_HOURS)) {
    return sendJson(
      {
        error: `deadline_hours must be in (0, ${pyFloat(MAX_DEADLINE_HOURS)}]`,
      },
      400
    );
  }
  const now = Date.now() / 1000;
  const th = await templateHash(poster, worker, amount, deadlineH);
  const jobId = "sos-" + th.slice(2, 14);
  if (jobs.has(jobId)) {
    return sendJson(
      { error: "identical template already exists", job_id: jobId },
      409
    );
  }
  const job = {
    job_id: jobId,
    template_hash: th,
    template: "settleorslash/v1",
    poster,
    worker,
    escrow_address: escrow,
    payTo: PAY_TO,
    amount_atomic: amount,
    deadline_hours: deadlineH,
    created_ts: Math.floor(now),
    deadline_ts: now + deadlineH * 3600,
    state: "CREATED",
    deliverable_hash: null,
    funding_tx: null,
    funding_block: null,
    external_funded: false,
    trace_note: null,
    counted_arrival: false,
    fee_settled_atomic: 0n,
    exit_txs: [],
    mode: isTestRequest(body, testMode) ? "test" : "live",
  };
  jobs.set(jobId, job); // TODO(KV/D1): in-isolate only, NOT durable
  ledgerAppend({
    event: "job_created",
    job_id: jobId,
    mode: job.mode,
    poster,
    worker,
    amount_atomic: amount.toString(),
  });
  log(
    `job created ${jobId} amount=${amount} poster=${poster} worker=${worker} mode=${job.mode}`
  );
  return sendJson(jobView(job), 201);
}

async function actFund(job, body, testMode) {
  if (job.state !== "CREATED") {
    return sendJson({ error: `cannot fund from state ${job.state}` }, 409);
  }
  if (isTestRequest(body, testMode)) {
    job.state = "FUNDED";
    job.funding_tx = String(body.tx ?? "0xtestfunding");
    job.mode = "test";
    job.external_funded = false;
    job.trace_note =
      "synthetic test funding - excluded from arrival by construction";
    job.counted_arrival = false;
    ledgerAppend({
      event: "job_funded",
      job_id: job.job_id,
      mode: "test",
      counted_arrival: false,
    });
    log(`TEST funding accepted (not arrival): job=${job.job_id}`);
    return sendJson(jobView(job));
  }
  const txRaw = String(body.tx ?? "");
  if (!txRaw) {
    return sendJson({ error: "missing tx (funding proof)" }, 400);
  }
  const [ok, reason] = await verifyFunding(job, txRaw);
  if (!ok) {
    return sendJson({ error: `funding proof rejected: ${reason}` }, 402);
  }
  let [external, note] = await fundingTrace(job.poster);
  if (job.poster === job.worker) {
    external = false;
    note = "self-dealing: poster == worker";
  } else if (
    OUR_ADDRESSES.has(job.escrow_address) ||
    OUR_ADDRESSES.has(job.poster)
  ) {
    external = false;
    note = "fleet address in job parties";
  }
  job.state = "FUNDED";
  job.funding_tx = txRaw.trim().toLowerCase();
  job.external_funded = Boolean(external);
  job.trace_note = note;
  job.counted_arrival = Boolean(external);
  consumedTx.add(job.funding_tx);
  ledgerAppend({
    event: "job_funded",
    job_id: job.job_id,
    mode: "live",
    tx: job.funding_tx,
    external_funded: Boolean(external),
    trace_note: note,
    counted_arrival: Boolean(external),
  });
  log(
    `job funded ${job.job_id} external=${external} counted_arrival=${external} (${note})`
  );
  return sendJson(jobView(job));
}

function actDeliver(job, body) {
  if (job.state !== "FUNDED") {
    return sendJson({ error: `cannot deliver from state ${job.state}` }, 409);
  }
  const dh = String(body.deliverable_hash ?? "").trim();
  if (!dh) {
    return sendJson({ error: "missing deliverable_hash" }, 400);
  }
  job.deliverable_hash = dh;
  job.state = "DELIVERED";
  job.delivered_ts = Math.floor(Date.now() / 1000);
  ledgerAppend({
    event: "job_delivered",
    job_id: job.job_id,
    deliverable_hash: dh,
    mode: job.mode || "live",
  });
  return sendJson(jobView(job));
}

async function actRelease(job, body, testMode) {
  if (job.state !== "FUNDED" && job.state !== "DELIVERED") {
    return sendJson({ error: `cannot release from state ${job.state}` }, 409);
  }
  if (job.state === "FUNDED" && !job.auto_release_open) {
    return sendJson(
      { error: "no deliverable yet and 24h silence window not open" },
      409
    );
  }
  return settle(job, body, "release", testMode);
}

async function actForfeit(job, body, testMode) {
  if (job.state !== "EXPIRED") {
    return sendJson(
      {
        error:
          `cannot forfeit from state ${job.state} ` +
          "(forfeit needs deadline passed with no deliverable)",
      },
      409
    );
  }
  return settle(job, body, "forfeit", testMode);
}

async function settle(job, body, kind, testMode) {
  // Test path: synthetic exit, both legs shown in the ledger, never arrival.
  if (isTestRequest(body, testMode)) {
    if (job.mode !== "test") {
      return sendJson(
        { error: "test proofs are not accepted for live jobs" },
        402
      );
    }
    const fee = feeAtomic(job.amount_atomic);
    job.state = kind === "release" ? "RELEASED" : "FORFEITED";
    job.fee_settled_atomic = fee;
    job.exit_txs = [String(body.tx ?? "0xtestexit")];
    job.counted_arrival = false;
    ledgerAppend({
      event: `job_${job.state.toLowerCase()}`,
      job_id: job.job_id,
      mode: "test",
      fee_atomic: fee.toString(),
      main_atomic: (job.amount_atomic - fee).toString(),
      counted_arrival: false,
      trace_note:
        "synthetic test exit - excluded from arrival by construction",
    });
    log(`TEST ${kind} settled (not arrival): job=${job.job_id} fee=${fee}`);
    return sendJson(jobView(job));
  }
  // A test-created job can never take the live path either.
  if (job.mode === "test") {
    return sendJson({ error: "test jobs cannot settle on the live path" }, 402);
  }
  const txs = Array.isArray(body.txs)
    ? body.txs
    : body.txs
      ? [body.txs]
      : body.tx
        ? [body.tx]
        : [];
  const res = await verifyExit(job, txs, kind);
  if (!res.ok) {
    return sendJson({ error: `exit proof rejected: ${res.reason}` }, 402);
  }
  job.state = kind === "release" ? "RELEASED" : "FORFEITED";
  job.fee_settled_atomic = res.feeAtomic;
  job.exit_txs = res.txs;
  for (const t of res.txs) consumedTx.add(t);
  ledgerAppend({
    event: `job_${job.state.toLowerCase()}`,
    job_id: job.job_id,
    mode: "live",
    fee_atomic: res.feeAtomic.toString(),
    main_atomic: res.mainAtomic.toString(),
    txs: res.txs,
    counted_arrival: job.counted_arrival,
  });
  log(
    `job ${job.state.toLowerCase()} ${job.job_id} fee=${res.feeAtomic} ` +
      `counted_arrival=${job.counted_arrival}`
  );
  return sendJson(jobView(job));
}

// ---------------------------------------------------------------- docs
function skillMd(origin) {
  return (
    "# SettleOrSlash v1\n\n" +
    "Marketplace-free escrow-exit primitive for subjective agent jobs.\n\n" +
    `- Template: \`POST ${origin}/jobs\` with poster, worker, escrow_address, amount_atomic, deadline_hours (<=24)\n` +
    `- Fee: 2.5% of amount to \`${PAY_TO}\` (Base USDC) on BOTH exits - release and forfeit.\n` +
    "- Fund: poster sends >= amount USDC to escrow_address on Base, then `POST /jobs/{id}/fund` with the tx hash.\n" +
    "- Deliver: worker `POST /jobs/{id}/deliver` with a deliverable hash before the deadline.\n" +
    "- Settle: exit tx(s) from escrow_address must pay the main leg >=97.5% AND the fee leg >=2.5% to payTo; " +
    "the job completes only when both verify. No fee leg, no completion.\n" +
    "- Discovery: `/template`, `/.well-known/settleorslash`, `/price`\n"
  );
}

// ---------------------------------------------------------------- worker
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = url.origin;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const testMode = Boolean(env && env.SOS_TEST_MODE === "1");
    log(`${request.method} ${path}`);

    if (request.method === "GET") {
      if (path === "/health") {
        return sendJson({
          status: "ok",
          service: "settleorslash-v1",
          test_mode: testMode,
          payTo: PAY_TO,
          jobs: jobs.size,
        });
      }
      if (path === "/") {
        return sendJson({
          service:
            "SettleOrSlash v1 - canonical escrow-exit primitive (live test)",
          network: NETWORK,
          asset: "USDC on Base",
          payTo: PAY_TO,
          fee: "2.5% hard split to payTo on BOTH exits (release and forfeit)",
          flow: [
            "POST /jobs (canonical template)",
            "POST /jobs/{id}/fund {tx} - poster funding proof",
            "POST /jobs/{id}/deliver {deliverable_hash} - worker",
            "POST /jobs/{id}/settle-release {txs:[...]} - exit proof w/ fee leg",
            "POST /jobs/{id}/settle-forfeit {txs:[...]} - exit proof w/ fee leg",
          ],
          discovery: [
            "/price",
            "/template",
            "/.well-known/x402",
            "/.well-known/settleorslash",
            "/.well-known/agent.json",
            "/skill.md",
          ],
          test_mode: testMode,
        });
      }
      if (path === "/price") {
        return sendJson({
          service: "SettleOrSlash v1",
          resource: origin + "/jobs",
          price: {
            model:
              "2.5% of the escrowed job amount, hard-split to payTo on " +
              "BOTH exits (release and forfeit); no per-call charge",
            fee_fraction: "25/1000",
            min_amount_atomic: MIN_AMOUNT_ATOMIC.toString(),
            max_deadline_hours: MAX_DEADLINE_HOURS,
            asset: USDC,
            asset_symbol: "USDC",
            network: NETWORK,
          },
          payTo: PAY_TO,
          how_to_use:
            "POST /jobs to create the canonical template; the poster " +
            "funds the job's escrow_address with USDC on Base and proves " +
            "it via POST /jobs/{id}/fund; exits settle only with the " +
            "2.5% fee leg to payTo verified on-chain.",
          discovery: origin + "/.well-known/settleorslash",
        });
      }
      if (path === "/template") {
        return sendJson({
          template: "settleorslash/v1",
          network: NETWORK,
          asset: USDC,
          asset_symbol: "USDC",
          payTo: PAY_TO,
          fee_fraction: "25/1000 (2.5%) on BOTH exits",
          min_amount_atomic: MIN_AMOUNT_ATOMIC.toString(),
          max_deadline_hours: MAX_DEADLINE_HOURS,
          funding:
            "poster transfers >= amount USDC on Base to the job's " +
            "declared escrow_address, then presents the tx hash",
          release:
            "worker submits deliverable_hash before deadline; exit " +
            "tx(s) from escrow_address pay worker >= 97.5% AND payTo " +
            ">= 2.5%; poster confirm or 24h silence after deadline",
          forfeit:
            "no deliverable_hash by deadline (deterministic " +
            "non-delivery); exit tx(s) from escrow_address refund " +
            "poster >= 97.5% AND payTo >= 2.5%",
          guarantee:
            "there is no terminal transition without a verified " +
            "2.5% fee leg to payTo - completion without the " +
            "split does not exist in this state machine",
        });
      }
      if (path === "/.well-known/settleorslash") {
        return sendJson({
          version: "settleorslash/v1",
          origin,
          payTo: PAY_TO,
          fee: "2.5% both exits",
          template: origin + "/template",
        });
      }
      if (path === "/.well-known/x402") {
        return sendJson({
          x402Version: 2,
          resources: [
            {
              url: origin + "/jobs",
              method: "POST",
              description:
                "SettleOrSlash v1 canonical escrow-exit template " +
                "registry: create a job template (poster, worker, " +
                "escrow_address, amount_atomic, deadline_hours <= 24). " +
                "Funding and exits are proven on-chain (Base USDC); " +
                "BOTH exits - release (worker >= 97.5%) and forfeit " +
                "(poster refund >= 97.5%) - hard-split 2.5% to payTo. " +
                "No per-call x402 payment: the fee is taken at exit, " +
                "by construction.",
            },
          ],
        });
      }
      if (path === "/.well-known/agent.json") {
        return sendJson({
          version: "1.3",
          origin: url.host,
          display_name: "SettleOrSlash v1",
          description:
            "Marketplace-free escrow-exit primitive for subjective " +
            "agent jobs on Base: both exits (release and forfeit) " +
            "hard-split 2.5% to the receive-only payTo; no completion " +
            "exists without the split.",
          payout_address: PAY_TO,
          payments: {
            x402: {
              networks: [{ network: "base", asset: "USDC", contract: USDC }],
            },
          },
          intents: [
            {
              name: "create_escrow_job",
              description:
                "Create a canonical escrow job template; the poster " +
                "funds the escrow address on Base, the worker delivers " +
                "by hash, and exits settle with the 2.5% fee leg to " +
                "payTo verified on-chain.",
              endpoint: origin + "/jobs",
              method: "POST",
              price: {
                model: "percentage_of_job",
                fee_fraction: "25/1000",
                currency: "USDC",
              },
            },
          ],
        });
      }
      if (path === "/skill.md") {
        return new Response(skillMd(origin), {
          status: 200,
          headers: { "Content-Type": "text/markdown" },
        });
      }
      const jobParts = path.split("/");
      if (jobParts.length === 3 && jobParts[1] === "jobs") {
        const job = jobs.get(jobParts[2]);
        if (!job) return sendJson({ error: "job not found" }, 404);
        refreshState(job);
        return sendJson(jobView(job));
      }
      if (path === "/stats") {
        const all = [...jobs.values()];
        const funded = all.filter((j) => j.counted_arrival);
        const terminal = all.filter((j) => j.fee_settled_atomic !== 0n);
        const feeTotal = terminal.reduce(
          (sum, j) => sum + j.fee_settled_atomic,
          0n
        );
        return sendJson({
          jobs_total: all.length,
          external_funded_jobs: funded.length,
          terminal_jobs: terminal.length,
          fees_settled_atomic: feeTotal.toString(),
          fees_settled_usd: Number(feeTotal) / 1e6,
          fees_settled_gbp_est:
            Math.round((Number(feeTotal) / 1e6) * USD_GBP * 10000) / 10000,
          test_mode: testMode,
        });
      }
      return sendJson({ error: "not found" }, 404);
    }

    if (request.method === "POST") {
      const text = await request.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        return sendJson({ error: "bad JSON body" }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendJson({ error: "bad JSON body" }, 400);
      }

      if (path === "/jobs") {
        return createJob(body, testMode);
      }

      const parts = path.split("/");
      if (parts.length === 4 && parts[1] === "jobs") {
        const job = jobs.get(parts[2]);
        if (!job) return sendJson({ error: "job not found" }, 404);
        refreshState(job);
        switch (parts[3]) {
          case "fund":
            return actFund(job, body, testMode);
          case "deliver":
            return actDeliver(job, body);
          case "settle-release":
            return actRelease(job, body, testMode);
          case "settle-forfeit":
            return actForfeit(job, body, testMode);
          default:
            return sendJson({ error: "unknown action" }, 404);
        }
      }
      return sendJson({ error: "not found" }, 404);
    }

    return sendJson({ error: "not found" }, 404);
  },
};
