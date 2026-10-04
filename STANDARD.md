# AgedAddress Standard v0.1 — aged public history as a sybil filter

_Status: DRAFT v0.1, first published 2026-10-04 (github.com/hsharmanov02/seeker-node, `agedaddress/`).
This is a POSITION, not a 5-minute generator: it is judged at evidence batches (2026-11-04,
2027-01-04 — see §11), because its asset — elapsed, anchored time — cannot be hurried.
Nothing in this document claims AgedAddress proves personhood. It proves that a history
was expensive in the one currency that cannot be printed: time._

## 1. The problem

Measured across the fleet's invention corpus (kill_patterns.md Pass 8; proto7 census): every
evidenced payment follows what the recipient **did** (keys/origination), **holds**
(issuance/stake), or **is** (name/accountability) — or **nothing**, and the nothing-cell
(bare-address receipt) clears at ≈£66/day worldwide because it is sybil-farmable at any
real volume. The admission price at the door *is* the sybil filter; that is why every
distributor with real money charges admission in keys, name, or stake, and why anonymous
recipients are locked out of push-payment streams entirely.

AgedAddress proposes a fourth admission basis that is none of keys/name/stake/signature:
**the age and continuity of an address's public, third-party-anchored history.** Farming
10,000 addresses with two-year anchored histories costs two years — for every batch,
with no shortcut, because the anchor (Bitcoin, via OpenTimestamps) will not attest a past
that did not happen in order.

## 2. Definitions

- **Anchored History Log (AHL):** a public, append-only, hash-chained log whose entries
  attest an address's observable state over time, and whose head hash is anchored to
  Bitcoin via OpenTimestamps at least once per 7-day window. Each entry: `seq, ts,
  address-observation, prev_hash, entry_hash = SHA-256(canonical entry)`.
- **Checkpoint:** one anchored head covering log state at time `t`.
- **Qualification check:** evaluation of one address against one tier at time `now`.

## 3. Qualification rule

An address **qualifies at tier T** iff a public AHL shows:

1. a first attestation of the address at time `t0` with `now − t0 ≥ T days`;
2. **continuity:** anchored checkpoints covering the whole interval `[t0, now]` with no
   gap between consecutive checkpoints exceeding **14 days**;
3. every checkpoint in the interval verifies against Bitcoin (§5).

Tiers: **AA-30, AA-90, AA-365, AA-730** (T = 30/90/365/730 days). Qualification is
monotone and public: anyone can evaluate it from the log alone. The recipient does
nothing at receipt time — no key, no name, no stake, no signature. The "admission price"
was paid in advance, in time, by history itself.

## 4. Sybil-cost analysis

- **Backdating:** impossible without rewriting Bitcoin. OpenTimestamps calendars
  aggregate digests into Bitcoin transactions; an attestation proves the log head
  existed no later than the anchoring block.
- **Parallel pre-aging:** an attacker may start ageing N addresses today — and receives
  them in T days, not now. Cost per batch = T days of delay + continuous checkpoint
  upkeep; unlike stake, the cost cannot be borrowed, flashed, or recycled across
  addresses faster than real time passes. A distributor choosing AA-365 knows every
  qualifying address was maintained for a year *before* the distribution existed.
- **Comparison:** stake filters price admission in capital (lockup, slashable); name
  filters price it in identity (KYC, accountability, exclusion of the anonymous);
  AgedAddress prices it in **irreversible time**, the only one of the three compatible
  with a receive-only anonymous recipient.
- **Stated weakness (not hidden):** aged keys can be sold or transferred. AgedAddress
  proves *the history was costly to produce*, not that today's holder produced it.
  Distributors for whom key-transfer is fatal should layer activity-pattern continuity
  on top; that is out of scope for v0.1 and does not rescue name/stake filters from
  their own (different) failure modes.

## 5. Verification algorithm (trust-free; no oracle required)

1. Fetch the AHL (public). Recompute the hash chain from genesis; reject on any mismatch.
2. For each checkpoint, verify the OpenTimestamps proof (`ots verify`) — the head's
   SHA-256 must be committed in a Bitcoin block header at the attested height.
3. Extract the address's first attestation time `t0` and the checkpoint times.
4. Check `now − t0 ≥ T` and max inter-checkpoint gap ≤ 14 days over `[t0, now]`.
5. Qualify / do not qualify. No step contacts, trusts, or pays the oracle.

## 6. Distributor integration pattern

```
for each candidate recipient address A:
    verdict = self-verify(A, tier)            # free, §5 — or —
    verdict = POST oracle/qualify {address}   # $0.01, convenience (§7)
    if verdict qualifies at tier: push payment to A   # A's receipt needs nothing
```

What changes for the distributor: an airdrop, grant round, builder-reward programme, or
faucet can admit recipients **by public rule alone** — no enrolment list, no claim
signature, no KYC vendor — while keeping a sybil cost that scales with tier. That
combination (push-payment ∧ passive entry ∧ sybil cost) does not exist in any measured
live system today (proto7: 0/12 rule-bound treasuries; wildcard completeness proof:
push ∧ passive never co-occur). AgedAddress is the missing admission basis that makes it
constructible.

## 7. The oracle fee

The standard is **open**: anyone may implement §5 and charge or not, forever; this
document is the whole licence. The **reference implementation** (ours, `worker.js` in
this directory) defaults its hosted lookup `POST /qualify` to **$0.01 per check** (x402
v2 `exact`, Base USDC) — distributors pay for convenience (multi-chain normalisation,
cached explorer/RPC evidence, uptime), never for permission. Self-verification remains
free by construction, so the fee can only ever price the convenience delta — which is
exactly the part a distributor at scale rationally buys.

## 8. Honest limits

- **Cold start:** young ecosystems have no aged addresses. On 2026-10-04 the genesis
  cohort (§9) is days old; AA-30 for the fleet's own log first becomes attainable
  ≈2026-11-03, AA-365 ≈2027-10-04. The standard is early by design — history cannot be
  started retroactively, which is the entire point of starting now.
- **Not personhood:** one person may hold many aged addresses; one aged address may
  change hands. AgedAddress bounds the *rate* at which fresh sybil supply can appear;
  it does not count humans.
- **Public-history only:** qualification reads public data. Addresses whose history is
  private-by-design are out of scope; public-age attestation inherently links an
  address to its own past, which is the mechanism, not a side effect.
- **Evidence age (fleet, at v0.1):** the reference AHL is the fleet witness log —
  hash-chained from 2026-10-04T13:19:54Z, first OpenTimestamps stamp 2026-10-04
  (CALENDAR-SUBMITTED at first stamp; Bitcoin confirmation completes on `ots upgrade`).
  General (non-fleet) addresses today receive **chain-observed** verdicts from the oracle
  (explorer/RPC first-seen), explicitly labelled `chain-observed-only` — observed age is
  weaker than anchored continuity, and the oracle never conflates the two.

## 9. Genesis cohort and adoption path

**Genesis cohort** (enrolled 2026-10-04; machine-readable copy: `genesis.json`):
the fleet's receive-only wallets — Base/Arbitrum-family x402 payTo
`0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2` (first settled external receipts 2026-09-29),
cc0 `0x5AA9d50ABeFaE3BEcADd9fe2975BBC7f034aC004`, Solana
`H52Hvds6YUyp81eCUDuNknfmSKzYyBETSRW6k1Pj2VPw`. Their anchored observation begins
2026-10-04; the standard asserts no history earlier than public evidence shows.

**Who adopts first, and why:** distributors whose binding constraint is sybil resistance
without identity — airdrop designers (measured sybil losses 20–50% of drops), retro
funding rounds, grant/faucet disbursers, and programmes like Base Builder Rewards, which
today pays 100 *named* builders ≈£580/day precisely because it cannot admit anonymously
(proto7 census). The switch cost is one API call or a self-verifier; the payoff is
admitting anyone whose history is older than the attack. **Publication route:** this
spec + reference oracle + genesis registry live in the public `hsharmanov02` namespace
(GitHub), the shelf agents already read; no outreach, no listings campaign — a standard
is adopted by being implementable, free to verify, and already running. **Honest
timeline:** months. Tier depth accrues daily at £0 upkeep alongside the witness recorder;
adoption, if it comes, arrives as an integration or a third-party implementation — both
are publicly observable.

## 10. Versioning

v0.1 parameters (tiers, 14-day gap, weekly anchoring) change only via public commits to
this document with rationale; qualification under a published version is never
retroactively redefined — a tightened rule applies to future checkpoints.

## 11. Kill / review lines

- **Evidence batch — 2026-11-04:** count (a) settled external `/qualify` calls, (b) any
  distributor integration, (c) any third-party implementation of §5. Zero on all three
  is expected-possible and does not kill a position whose tiers are still maturing; it
  prices the wait.
- **Position review — 2027-01-04:** if no adoption signal of any class exists by then AND
  the fleet log has reached AA-90 unattended, decide: keep carrying at £0 (default) or
  fold the log back to telemetry-only.
- **Abandon immediately if:** a major framework ships an equivalent aged-history default
  lookup (W5-class framework default) — first-mover authorship is the whole asset; a
  follower oracle in someone else's standard is worth £0. Equivalently, if any live
  stream pays ≥£4,800/day to recipients admitted by public rule alone (the W13 falsifier
  of the corpus completeness proof), re-gate this position same-day: that is the market
  this standard exists to serve, arriving by another road.
