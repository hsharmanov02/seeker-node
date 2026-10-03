#!/usr/bin/env python3
"""TurnSeal door-check middleware (Python) — publishable seller snippet.

Drop this next to your endpoint. A call is served ONLY if the buyer
presents: a TurnSeal admission token, the salt, the exact payload, and
a buyer-key signature over the call. The token is one-time and bound to
(entry, payload commitment, buyer key, seller, expiry, nonce): a token
earned for one call cannot be swapped onto another, and a stolen token
is useless without the buyer key.

Claim: "provable order; measured honour" — this check makes queue
jumping visible and rejectable at your door; it does not (and nothing
can) prove a seller ran no private side-door.

Requires: ed25519.py (pure-Python RFC 8032) on the path, or swap
_verify() for your favourite Ed25519 library.
"""
import hashlib
import json
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ed25519  # noqa: E402


def canonical_request(endpoint_id, payload_obj) -> bytes:
    return json.dumps({"endpoint": endpoint_id, "payload": payload_obj},
                      sort_keys=True, separators=(",", ":")).encode()


def _b64u_dec(s):
    import base64
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def door_check(token, salt_hex, payload_obj, buyer_sig_hex,
               service_pubkey_hex, my_seller_id, my_endpoint_id,
               replay_cache, now_ts):
    """Returns (ok, error, token_payload). replay_cache is a set you own
    (persist it across restarts); a nonce is added only on success."""
    try:
        head, sig = token.split(".")
        payload_bytes = _b64u_dec(head)
        payload = json.loads(payload_bytes)
        if not ed25519.verify(bytes.fromhex(service_pubkey_hex),
                              _b64u_dec(sig), payload_bytes):
            return False, "bad token signature", None
    except Exception:
        return False, "malformed token", None
    if payload.get("seller_id") != my_seller_id:
        return False, "token is for a different seller", None
    if payload.get("endpoint_id") != my_endpoint_id:
        return False, "token is for a different endpoint", None
    if now_ts > payload.get("exp", 0):
        return False, "token expired", None
    if payload.get("nonce") in replay_cache:
        return False, "token already used (replay)", None
    commitment = hashlib.sha256(
        b"turnseal/commit/v1" + my_seller_id.encode() + b"|"
        + my_endpoint_id.encode() + b"|"
        + canonical_request(my_endpoint_id, payload_obj)
        + b"|" + bytes.fromhex(salt_hex)).hexdigest()
    if commitment != payload.get("commitment"):
        return False, "payload does not match the committed call", None
    try:
        if not ed25519.verify(
                bytes.fromhex(payload["buyer_pubkey"]),
                bytes.fromhex(buyer_sig_hex),
                canonical_request(my_endpoint_id, payload_obj)):
            return False, "buyer signature does not match token buyer key", None
    except Exception:
        return False, "bad buyer signature", None
    replay_cache.add(payload["nonce"])
    return True, None, payload
