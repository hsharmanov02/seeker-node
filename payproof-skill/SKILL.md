---
name: payproof
description: Pre-spend safety checks for agent payments. Run free local Tier-0 checks (402 envelope shape, payTo consistency, TLS, redirect chains, price sanity) before paying any endpoint, and optionally fetch a recorded-history preflight dossier (/bin/bash.05, Base USDC via x402) before a first payment to an unknown origin or payTo, plus hash-chained payment receipts (/bin/bash.01) the payee can present elsewhere. Use whenever an agent is about to pay an endpoint it has not paid before, or wants a presentable proof of a settled payment.
---

# PayProof — check before you pay

PayProof is a two-tier pre-spend check for agent payments (x402 on Base). Tier 0 is free and local, forever. Tier 1 sells recorded history at the exact moment of spending risk.

## Tier 0 — free local checks (run these yourself, no network call to us)

Before paying any endpoint, verify locally:

1. **402 envelope shape** — the 402 response must carry a \`PAYMENT-REQUIRED\` header (base64 JSON) with \`x402Version: 2\`, an \`accepts\` array, and each entry naming \`scheme: "exact"\`, \`network: "eip155:8453"\`, the USDC asset \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\`, a \`payTo\` address, and an \`amount\` in atomic units. Missing or malformed fields: do not pay.
2. **payTo consistency** — the \`payTo\` in the envelope must match the endpoint's published card (\`/.well-known/x402\` / skill file). A payTo that differs between the card and the live 402 is payTo drift: do not pay.
3. **TLS** — the origin must serve valid HTTPS. Plain HTTP or a certificate error: do not pay.
4. **Redirect chains** — follow redirects yourself and re-check the envelope at the final URL. A redirect that changes origin between the card and the 402: do not pay.
5. **Price sanity** — compare \`amount\` against the endpoint's claimed price (card, skill file, listing). An amount larger than claimed, or a price that changed since you last paid this origin: stop and re-check.

Tier 0 is genuinely all some agents will ever need. It is the free value of this skill.

## Tier 1 — paid depth layer (recorded history + receipts)

Base URL: \`https://payproof.hsharmanov02.workers.dev\`

### Preflight dossier — POST /preflight, $0.05 USDC on Base

Call this **before paying a first-seen endpoint** (new origin or new payTo). Body:

\`\`\`json
{"endpoint_url": "https://some-service.example/resource"}
\`\`\`

(or \`{"address": "0x…payTo…"}\`). Pay via the 402 flow (x402 v2 exact; facilitator \`PAYMENT-SIGNATURE\` header, or settle to the payTo yourself and retry with \`X-PAYMENT-TX: <Base tx hash>\`). The dossier returns:

- a **live probe right now**: HTTP status, latency, and — if the endpoint answers 402 — whether its live envelope is valid and consistent;
- a **recorded-history summary** from our Observation Log (continuously recorded since 2026-10-04, hash-chained, Bitcoin-anchored weekly): first/last seen, observed status, payTo drift, observed median price — or an explicit "not yet observed" with the log's own age. History depth grows daily; today it is young, and the dossier says so rather than implying coverage it does not have.

Why pay for this when Tier 0 is free? Tier 0 tells you the endpoint's envelope is well-formed *now*. Only recorded history tells you whether this origin has been alive, stable, and charging the same payTo across time — and history cannot be backfilled by anyone, including us.

### PayProof receipt — POST /receipt, $0.01 USDC on Base

After a payment settles, fetch a receipt the payee can present elsewhere. Body:

\`\`\`json
{"tx_ref": "0x…Base tx hash of the settled payment…", "endpoint": "https://some-service.example/resource"}
\`\`\`

Returns a hash-chained receipt object (tx hash, endpoint, amount, block time, chain position) citable at \`GET /receipt/:id\` (free). Presenting a chain of these receipts is how a worker agent shows a poster a payment history that verifies against our anchored chain heads.

## Prices

- \`POST /preflight\` — $0.05 USDC (Base), x402 v2 exact
- \`POST /receipt\` — $0.01 USDC (Base), x402 v2 exact
- \`GET /receipt/:id\`, \`/price\`, \`/.well-known/x402\`, \`/skill.md\` — free
- Pay-to (all fees): \`0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2\`
