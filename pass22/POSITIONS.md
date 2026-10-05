# Pass 22 — Aging Positions Batch 2 + Volume-Creation Mechanism Screen

**Date:** 2026-10-05 (BST). **Posture:** positions are judged at evidence batches, NOT by the 5-minute rule. All £0, no signing, no keys, no ID. Standing laws held throughout.

---

## Positions STARTED (verified live 2026-10-05)

### 1. Witness-B — Bitcoin-clock second witness chain
- **What:** A second append-only hash chain, anchored differently from the OTS witness chain: every 10 minutes it fetches the live Bitcoin tip (height + block hash from mempool.space) and hash-chains an entry containing it. Bitcoin's own clock is the external anchor — entries cannot be backdated without rewriting Bitcoin.
- **Where:** `pass22_positions/witness_b/` (`witness_b.py`, `chain.jsonl`, `witness_b.log`, `witness_b.pid`).
- **Verification:** genesis seq=1 at BTC height 969930 (2026-10-05T00:56:17Z), `--verify` OK; daemon (PID 15479, PPID 1) wrote seq=2 itself at 00:57:12Z — chain advancing unattended.
- **What ages:** an independently-anchored witnessed history for the fleet, redundant with the OTS chain (no single point of failure).
- **Future payer/reader:** anyone pricing aged/continuous history (AgedAddress-class readers) who discounts a single-anchor chain; also our own future proofs that observations predate events.
- **Matures / check:** 30-day evidence batch **2026-11-04** (with census refresh); 90-day **2027-01-04**.

### 2. x402 Endpoint Observatory — dated public data series
- **What:** A recorder nobody else is running: every 15 minutes it probes 13 public x402 endpoints (`/health` + `/.well-known/x402`) and appends status, latency, and a SHA-256 of the response body. Endpoint prices, liveness, and payload drift decay daily; a continuous dated series cannot be backfilled after the fact.
- **Where:** `pass22_positions/observatory/` (`observatory.py`, `observations.jsonl`, `observatory.log`, `observatory.pid`). Hosts: threat-reputation-mcp, threat-reputation-api, fiatdock-gateway, payproof, agedaddress, feescout, addrage, slotcheck, relayproof, schemaseal, headcheck, pegwatch, poolprice.
- **Verification:** first two batches 26/26 probes HTTP 200 (2026-10-05T00:56–00:57Z); daemon (PID 15481, PPID 1) running detached.
- **What ages:** the only continuous reliability/price-drift history for this endpoint set.
- **Future payer/reader:** agent-marketplace operators, facilitators, or insurers pricing endpoint reliability who need historical uptime/price evidence they did not record themselves; also feeds AgedAddress/SettleOrSlash revival evidence (documented liveness over time).
- **Matures / check:** first value review **2026-11-04** (30 days, ~2,900 batches); series-value review **2027-01-04**.

### 3. Public positions registry in the GitHub namespace
- **What:** This registry's public copy, committed to `hsharmanov02/seeker-node@main` at `pass22/POSITIONS.md` — a permanent, timestamped public URL in our existing namespace. GitHub's commit history is the age proof; the namespace itself is one of the original arrival-by-inheritance assets.
- **Public URL:** https://raw.githubusercontent.com/hsharmanov02/seeker-node/main/pass22/POSITIONS.md
- **Verification:** pushed via Git Data API (commit recorded below once pushed).
- **What ages:** public, citable provenance for every position in this batch — claims made now, verifiable later.
- **Future payer/reader:** any counterparty diligence process that pays premiums for aged, publicly-committed track records.
- **Matures / check:** reviewed with the **2026-11-04** batch.

---

## Evaluated, NOT started (with reason)

- **(b) Agent/protocol registries (ERC-8004-style, on-chain agent IDs):** registration is a signed on-chain transaction from our wallet — signing is Harsh's hands only. Skipped, not a defect we can route around.
- **(d) Free handles on emerging agent platforms (MCPize-class shelves):** signup is email-only at best. Per instructions, account creation is **FLAGGED FOR PARENT** — no accounts created by this pass. If parent approves email-only signups, these become claimable in minutes and start aging the same day.
- **Second OTS-style timestamp chain via a different calendar:** same trust shape as the existing OTS anchor; Witness-B's Bitcoin-tip anchor is the genuinely different route, so no third chain started (avoid idle duplicates).

---

## Part 2 — Volume-creation mechanism: **ExpirySweep** — KILLED at the gate (not built)

**Mechanism (invented):** Agent platforms sell prepaid, expiring capacity (inference credits, API plans). Holders who won't burn theirs list soon-to-expire credits; buyers who can consume capacity immediately pay 60–80% of face in USDC on Base; the mechanism takes 5%. Volume is manufactured from expiry pressure — sellers are endogenous (they lose 100% at expiry without it), buyers get compute below face they cannot self-supply at that price.

**Gate screen (promising-only):**
1. **Precedent leg — FAIL.** Zero evidenced settled secondary transfers of expiring agent credits in the trailing 30 days. Credits on the relevant platforms are non-transferable by terms, so the "volume" would have to be manufactured against platform rules — that is not lawful volume creation, and there is no rule-compelled first payer (no platform pays anyone to clear expiry).
2. **Receive-only leg — FAIL.** Collecting, holding, or reselling platform credits requires named platform accounts and signed sessions — the seat is priced in name/signature (Pass 21 law).
3. **Economics — FAIL.** No evidenced pool size at all: **£0.00/min evidenced vs the £3.33/min bar.**

**Verdict:** KILLED pre-build. **Falsifier (reopens same-day):** any major agent platform ships *transferable* expiring credits with a settled secondary market evidencing ≥£48K/day, or a platform itself pays a clearing fee by rule — then re-run the gate with live numbers.

---

*Carrying cost of everything above: £0. Next review: 2026-11-04 evidence batch.*
