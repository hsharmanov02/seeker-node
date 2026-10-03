#!/usr/bin/env python3
"""FixPattern client-side redactor (open source — inspect before you trust).

Builds a STRUCTURAL incident descriptor from a raw failure trace. Nothing
secret leaves the buyer's machine: no free text, no header values, no URLs,
no addresses, no exact amounts, no stack arguments. Only shapes, classes,
versions, buckets and hashes of stack function *names*.

Usage:
    from redactor import redact
    d = redact(raw_incident, buyer_salt="some-per-buyer-secret")
    # d["descriptor"], d["descriptor_hash"] is all that crosses the wire.

Run standalone with --dry-run to print exactly what would be submitted.
"""
import hashlib
import json
import re
import sys

DESCRIPTOR_VERSION = 1

# Fixed error-class vocabulary. Raw error text is matched against tokens and
# then DISCARDED; only the class token is emitted.
ERROR_CLASS_RULES = [
    ("challenge_malformed", ["missing maxamountrequired", "malformed challenge",
                             "no accepts array", "challenge parse", "invalid 402 body"]),
    ("challenge_expired", ["challenge expired", "authorization expired", "validbefore",
                           "deadline passed", "expired authorization"]),
    ("nonce_reused", ["nonce already used", "nonce reused", "invalid nonce",
                      "authorization already fulfilled"]),
    ("ua_forbidden", ["403", "forbidden", "user-agent", "user agent blocked"]),
    ("tunnel_blackhole", ["no tunnel here", "503", "tunnel closed", "bad gateway"]),
    ("rate_limited", ["429", "rate limit", "too many requests", "retry-after"]),
    ("silent_endpoint", ["timed out", "timeout", "no response body", "empty response",
                         "connection reset", "eof"]),
    ("signature_invalid", ["invalid signature", "ecrecover", "signature mismatch",
                           "bad v value"]),
    ("insufficient_funds", ["insufficient funds", "insufficient balance",
                            "transfer amount exceeds"]),
    ("ata_missing", ["associated token account", "ata not found",
                     "account not initialized"]),
    ("port_collision", ["address already in use", "eaddrinuse", "port in use"]),
    ("quorum_mismatch", ["quorum", "version mismatch", "unsupported version",
                         "unknown scheme", "scheme not supported"]),
    ("flock_deadlock", ["flock", "lock held", "do_wait", "watchdog stuck"]),
    ("captcha_wall", ["captcha", "hcaptcha", "are you a robot", "challenge-platform"]),
]

AMOUNT_BUCKETS = [(0, "zero"), (0.01, "dust"), (1, "le1"), (100, "le100"),
                  (float("inf"), "gt100")]

ALLOWED_ROLES = {"self", "counterparty", "contract", "service", "faucet",
                 "unknown"}


def _len_bucket(n):
    if n == 0:
        return "0"
    if n < 16:
        return "s"
    if n < 64:
        return "m"
    return "l"


def _amount_bucket(v):
    try:
        v = abs(float(v))
    except (TypeError, ValueError):
        return "unknown"
    for limit, name in AMOUNT_BUCKETS:
        if v <= limit:
            return name
    return "gt100"


def _error_class(text):
    t = (text or "").lower()
    for cls, tokens in ERROR_CLASS_RULES:
        if any(tok in t for tok in tokens):
            return cls
    return "unknown_error"


def _fn_hash(name):
    # Hash of the function NAME only — arguments never touched.
    base = re.sub(r"[^A-Za-z0-9_.]", "", str(name))[:64]
    return hashlib.sha256(base.encode()).hexdigest()[:12]


def redact(raw, buyer_salt=""):
    """raw: dict with any of rail, protocol, protocol_version, framework,
    framework_version, phase, http_status, error_message, headers (dict of
    real values), url, amounts (list of numbers), roles (dict role->anything,
    values discarded), stack_functions (list of names)."""
    headers = raw.get("headers") or {}
    header_shape = {}
    for k, v in headers.items():
        lk = str(k).lower()
        if lk in ("authorization", "cookie", "x-api-key", "proxy-authorization"):
            # Shape only: presence + length bucket. Value never emitted.
            header_shape[lk] = {"present": True,
                                "len_bucket": _len_bucket(len(str(v)))}
        else:
            header_shape[lk] = {"present": True,
                                "len_bucket": _len_bucket(len(str(v)))}
    amounts = raw.get("amounts") or []
    descriptor = {
        "descriptor_version": DESCRIPTOR_VERSION,
        "rail": str(raw.get("rail", "unknown"))[:24],
        "protocol": str(raw.get("protocol", "unknown"))[:24],
        "protocol_version": str(raw.get("protocol_version", ""))[:16],
        "framework": str(raw.get("framework", ""))[:32],
        "framework_version": str(raw.get("framework_version", ""))[:16],
        "phase": str(raw.get("phase", "unknown"))[:16],
        "error_class": _error_class(raw.get("error_message", "")),
        "http_status": raw.get("http_status") if isinstance(
            raw.get("http_status"), int) else None,
        "header_shape": header_shape,
        "amount_bucket": _amount_bucket(amounts[0]) if amounts else "none",
        "counterparty_role": (str(raw.get("counterparty_role", "unknown"))
                              if raw.get("counterparty_role") in ALLOWED_ROLES
                              else "unknown"),
        "url_has_query": bool(raw.get("url") and "?" in str(raw.get("url"))),
        "stack_fn_hashes": [_fn_hash(f) for f in
                            (raw.get("stack_functions") or [])][:8],
    }
    canon = json.dumps(descriptor, sort_keys=True).encode()
    dhash = hashlib.sha256(str(buyer_salt).encode() + b":" + canon).hexdigest()
    return {"descriptor": descriptor, "descriptor_hash": dhash}


if __name__ == "__main__":
    raw = json.load(sys.stdin)
    out = redact(raw["raw"], raw.get("buyer_salt", ""))
    print(json.dumps(out, indent=2, sort_keys=True))
