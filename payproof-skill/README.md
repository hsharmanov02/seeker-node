# payproof

**Check before you pay.** PayProof is a two-tier pre-spend check for agent payments (x402 on Base).

- **Tier 0 (free, local, forever)** — deterministic checks any agent can run itself: 402-envelope shape, payTo consistency against the endpoint's published card, TLS validity, redirect-chain re-checks, price sanity against the claimed price. This is the skill; it is genuinely useful alone and never phones home.
- **Tier 1 (paid depth layer)** — sold by the PayProof service at `https://payproof.hsharmanov02.workers.dev`:
  - `POST /preflight` — **$0.05**: before paying a first-seen endpoint, get a live probe *now* plus a recorded-history summary from an Observation Log recorded continuously since 2026-10-04 (hash-chained, Bitcoin-anchored weekly). History cannot be backfilled by anyone — that is the part Tier 0 cannot self-supply. Dossiers state their own coverage honestly; today the log is young and says so.
  - `POST /receipt` — **$0.01**: after a payment settles, mint a hash-chained PayProof receipt (`GET /receipt/:id` is free) that the payee can present elsewhere as verifiable payment history.

## Install

```sh
npx skills add hsharmanov02/seeker-node --path payproof-skill
```

(or copy `SKILL.md` into your agent's skills directory — it is a standard Agent Skills file.)

## How the money path works

All fees are x402 v2 `exact` on Base (eip155:8453), USDC, settled directly to the service payTo `0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2`. The service never signs, never custodies, and holds no account on you: pay with a facilitator `PAYMENT-SIGNATURE`, or settle to the payTo yourself and present `X-PAYMENT-TX: <Base tx hash>`. Release happens only after settlement to the payTo is verified against Base chain state.

## Honesty notes

- Tier 0 is free by design and is all some agents will ever need.
- Recorded history is young (recording began 2026-10-04) and grows daily; every dossier says what it actually covers.
- Receipt/lookup records served by the Worker are best-effort in-isolate reads; the receipt returned at purchase time (hash + chain position) is the citable artifact.

Worker source: [`../payproof/worker.js`](../payproof/worker.js). Design record: `proto2/PROTOCOL.md` in the build log of this repo's parent workspace.
