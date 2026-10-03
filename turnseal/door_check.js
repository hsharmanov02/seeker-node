/**
 * TurnSeal door-check middleware (Node) — publishable seller snippet.
 *
 * Serve the call ONLY if the buyer presents: a TurnSeal admission token,
 * the salt, the exact payload, and a buyer-key signature over the call.
 * The token is one-time and bound to (entry, payload commitment, buyer
 * key, seller, expiry, nonce): a token earned for one call cannot be
 * swapped onto another, and a stolen token is useless without the key.
 *
 * Claim: "provable order; measured honour" — this makes queue jumping
 * visible and rejectable at your door; nothing can prove a seller ran
 * no private side-door, and we never claim otherwise.
 */
import crypto from "node:crypto";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort()
    .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

export function canonicalRequest(endpointId, payloadObj) {
  // canonical JSON: recursively sorted keys, no whitespace (as TurnSeal)
  return Buffer.from(stableStringify({ endpoint: endpointId, payload: payloadObj }));
}

function edPub(hex) {
  // wrap a raw 32-byte Ed25519 public key as SPKI DER for node:crypto
  return crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"),
                        Buffer.from(hex, "hex")]),
    format: "der", type: "spki",
  });
}

/** replayCache: a Set you own (persist nonces across restarts). */
export function doorCheck({ token, saltHex, payloadObj, buyerSigHex,
                            servicePubkeyHex, sellerId, endpointId,
                            replayCache, nowTs }) {
  let payload, payloadBytes, sig;
  try {
    const [head, s] = token.split(".");
    payloadBytes = Buffer.from(head, "base64url");
    sig = Buffer.from(s, "base64url");
    payload = JSON.parse(payloadBytes.toString());
    if (!crypto.verify(null, payloadBytes, edPub(servicePubkeyHex), sig))
      return { ok: false, error: "bad token signature" };
  } catch { return { ok: false, error: "malformed token" }; }
  if (payload.seller_id !== sellerId)
    return { ok: false, error: "token is for a different seller" };
  if (payload.endpoint_id !== endpointId)
    return { ok: false, error: "token is for a different endpoint" };
  if (nowTs > payload.exp) return { ok: false, error: "token expired" };
  if (replayCache.has(payload.nonce))
    return { ok: false, error: "token already used (replay)" };
  const commitment = crypto.createHash("sha256").update(Buffer.concat([
    Buffer.from("turnseal/commit/v1"), Buffer.from(sellerId), Buffer.from("|"),
    Buffer.from(endpointId), Buffer.from("|"),
    canonicalRequest(endpointId, payloadObj), Buffer.from("|"),
    Buffer.from(saltHex, "hex"),
  ])).digest("hex");
  if (commitment !== payload.commitment)
    return { ok: false, error: "payload does not match the committed call" };
  try {
    if (!crypto.verify(null, canonicalRequest(endpointId, payloadObj),
                       edPub(payload.buyer_pubkey),
                       Buffer.from(buyerSigHex, "hex")))
      return { ok: false, error: "buyer signature does not match token buyer key" };
  } catch { return { ok: false, error: "bad buyer signature" }; }
  replayCache.add(payload.nonce);
  return { ok: true, payload };
}
