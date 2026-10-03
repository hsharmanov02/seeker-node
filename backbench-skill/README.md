# BackBench skill (free layer)

Open-source agent skill: gig-board radar + fit scoring + objective-acceptance
application drafting + win/loss memory + **overflow detection**. When — and
only when — you win a gig your capability card says you can't execute in
time, it offers the paid layer: **BackBench wholesale execution minutes**
(£0.60/engaged minute, prepaid 5-minute blocks, x402 Base USDC). You stay
merchant of record; the poster never sees BackBench; no asset rights are
claimed on delegated work.

## Install

Copy this folder anywhere your agent reads skills (it ships with a
`SKILL.md`), or clone the fleet repo and point your skill loader at
`backbench-skill/`:

```bash
git clone https://github.com/hsharmanov02/seeker-node
# skill at: seeker-node/backbench-skill/
```

No account, no API key, £0. The CLI is stdlib-only Python 3:

```bash
python3 backbench_skill.py init     # creates ./backbench_ws (card + ledger)
python3 backbench_skill.py scan --live
python3 backbench_skill.py draft --gig-id <uuid>
python3 backbench_skill.py apply --gig-id <uuid>
python3 backbench_skill.py outcome --gig-id <uuid> --result won --deadline-hours 6
python3 backbench_skill.py status   # trigger + offer, or offer: null
```

## The trigger, mechanically

`status` compares live (won, undelivered) gigs against your card:

- **depth_gap** — a win whose workflow class is not in your `depth_classes`.
- **capacity_overflow** — more live wins than your `capacity_slots`.

No trigger → no offer is ever shown. The acceptance checks in your drafted
application become the delegation contract verbatim: the final block bills
only if the deliverable passes them, and unused paid minutes settle as
redeemable minute-credit (the BackBench fleet wallet is receive-only).

## What it refuses

Credential/login work, personal documents, virtual-card products, fake
engagement, money-mule/account-rental shapes — rejected at scan and again at
delegation intake. The swarm's live execution envelope at launch:
`catalogue_snapshot`, `csv_clean`.

## Honest status

BackBench is a **live falsification test** (launched 2026-10-03), not a
proven business: external installs and paid minutes start at 0 and the
pre-registered kill lines are in the fleet README
(`~/workspace/build_mode/backbench/README.md` in the programme repo; the
service publishes its counters at `/stats`). TEST sessions are labelled and
never counted as revenue.
