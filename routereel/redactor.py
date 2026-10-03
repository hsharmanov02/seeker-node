#!/usr/bin/env python3
"""RouteReel client-side redactor (PUBLIC — this exact file is published on
the registry site so sellers can audit what the tooling does).

A RouteReel tape is derived from ONE real recorded run. Redaction happens
on the SELLER's machine, before anything is listed. RouteReel never
receives a raw trace; there is no raw-trace upload endpoint.

KEEP / DESTROY TABLE (also rendered on the site):

KEPT (adaptation needs it)                DESTROYED / GENERALISED
----------------------------------------  -----------------------------------
step order, parallelism, branches         API keys, cookies, auth headers,
                                          session tokens, signatures
tool/service canonical IDs, op names      raw private/system prompts and
                                          chain-of-thought
request/response FIELD NAMES, types,      customer names, emails, account
  presence, length buckets                  IDs, other personal data
abstract predicates ("quote <= cap")      exact secret thresholds -> typed
                                          buyer-fillable slots or bands
HTTP/status/error classes, retry counts   full URLs with query/fragment;
                                          path IDs -> role aliases
relative timing, token/cost RANGES        wallet private data; addresses ->
                                          roles unless public evidence
                                          requires a link
recovery branches, checkpoint assertions  file contents/proprietary docs ->
                                          hash + media type + synthetic
                                          exemplar only
final artifact type, hash, acceptance     the final artifact itself,
  test                                      by default

Canary mode: plant known secrets in a source trace, run redact_trace(),
then grep the output — zero planted strings may survive. The registry's
dogfood runs this drill and publishes the result. Any canary found in
registry state is a KILL-grade failure for the whole service.
"""
import hashlib
import json
import re

SECRET_KEYS = {"api_key", "apikey", "authorization", "cookie", "token",
               "access_token", "refresh_token", "secret", "password",
               "private_key", "seed", "signature", "session", "bearer"}
PII_KEYS = {"email", "name", "customer", "account_id", "user_id",
            "phone", "address"}
SECRET_VALUE_RES = [
    re.compile(r"sk-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"Bearer\s+\S+"),
    re.compile(r"0x[0-9a-fA-F]{64}"),          # private-key shaped
    re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"),
]


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _len_bucket(n: int) -> str:
    if n == 0:
        return "0"
    if n < 32:
        return "1-31"
    if n < 256:
        return "32-255"
    if n < 4096:
        return "256-4095"
    return "4096+"


def _scrub_value(key, value, slots):
    """Replace a value with a typed slot; return the slot descriptor."""
    lk = str(key).lower()
    if lk in SECRET_KEYS or any(r.search(str(value)) for r in SECRET_VALUE_RES):
        return {"slot": "SECRET_DESTROYED", "type": "destroyed"}
    if lk in PII_KEYS:
        return {"slot": "ROLE_ALIAS", "type": "destroyed"}
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # numbers generalise to bands; exact values become buyer slots
        name = f"slot_{len(slots)}"
        slots.append({"name": name, "type": "number",
                      "band": _len_bucket(int(abs(value)))})
        return {"slot": name, "type": "number"}
    if isinstance(value, str):
        if value.startswith("http"):
            return {"slot": "URL_DESTROYED", "type": "destroyed",
                    "note": "host/path ids replaced by role aliases"}
        name = f"slot_{len(slots)}"
        slots.append({"name": name, "type": "string",
                      "len_bucket": _len_bucket(len(value))})
        return {"slot": name, "type": "string"}
    return {"slot": "VALUE", "type": type(value).__name__}


def redact_step(step, slots):
    """Convert one raw recorded step into a redacted tape step. Keeps the
    structure (order, service, operation, branch, status class, retry
    count, relative offset) and a receipt hash; destroys values."""
    req = step.get("request", {}) or {}
    resp = step.get("response", {}) or {}
    red_req = {k: _scrub_value(k, v, slots) for k, v in req.items()}
    red_resp = {k: _scrub_value(k, v, slots) for k, v in resp.items()}
    return {
        "i": step.get("i"),
        "op": step.get("op"),
        "service": step.get("service"),
        "branch": step.get("branch", "main"),
        "status_class": step.get("status_class"),
        "retries": step.get("retries", 0),
        "offset_s": step.get("offset_s"),
        "request_shape": red_req,
        "response_shape": red_resp,
        "predicate": step.get("predicate"),   # abstract, e.g. "quote <= cap"
        "receipt_hash": _sha(json.dumps(
            {"raw_step": step.get("raw_ref", str(step.get("i"))),
             "service": step.get("service")},
            sort_keys=True).encode()),
    }


def redact_trace(trace):
    """trace: seller-local dict {run_id, steps:[raw steps], ...}.
    Returns (public_manifest_steps, slots). Raw values never leave."""
    slots = []
    steps = [redact_step(s, slots) for s in trace["steps"]]
    return steps, slots


def merkle_root(steps):
    """SHA-256 Merkle root over canonical redacted steps."""
    if not steps:
        return _sha(b"")
    level = [_sha(json.dumps(s, sort_keys=True,
                             separators=(",", ":")).encode())
             for s in steps]
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            a = level[i]
            b = level[i + 1] if i + 1 < len(level) else level[i]
            nxt.append(_sha((a + b).encode()))
        level = nxt
    return level[0]


def contains_secrets(obj):
    """Return list of secret-shaped strings found anywhere in obj."""
    text = json.dumps(obj, sort_keys=True, default=str)
    hits = []
    for r in SECRET_VALUE_RES:
        hits += r.findall(text)
    return hits


if __name__ == "__main__":
    # Self-demo: a raw step full of secrets becomes a clean tape step.
    raw = {"run_id": "demo", "steps": [
        {"i": 0, "op": "POST /quote", "service": "svc-x402-prices",
         "status_class": "402", "offset_s": 0,
         "request": {"api_key": "sk-demo-123456789",
                     "query": "price of SOL",
                     "email": "someone@example.com"},
         "response": {"amount_usdc": 0.01, "payTo": "0xabc"},
         "predicate": "quote <= cap", "raw_ref": "local-only"}]}
    steps, slots = redact_trace(raw)
    out = {"steps": steps, "slots": slots, "root": merkle_root(steps)}
    print(json.dumps(out, indent=1))
    assert not contains_secrets(out), "canary survived redaction!"
    print("redactor self-demo: PASS (no secret-shaped strings survive)")
