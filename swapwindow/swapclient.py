#!/usr/bin/env python3
"""SwapWindow reference client (stdlib only).

Usage:
    from swapclient import Client
    c = Client("https://<swapwindow-api>")
    capsule = c.create(ttl_seconds=3600)          # -> {capsule_id, nonce_a, nonce_b, ...}
    c.deposit(capsule_id, "a", nonce_a, sealed_for_counterparty)
    got = c.poll(capsule_id, nonce_a)             # None until BOTH deposited,
                                                  # then counterparty ciphertext, exactly once.

Payloads are sealed client-side to the counterparty's X25519 key
(see sealedbox.py); the server only ever stores opaque ciphertext.
"""
import base64
import json
import time
import urllib.request
import urllib.error

from sealedbox import generate_keypair, seal, open_box  # noqa: F401  (re-exported)


class SwapError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body}")
        self.status = status
        self.body = body


class Client:
    def __init__(self, base, selftest=False, timeout=30):
        self.base = base.rstrip("/")
        self.selftest = selftest
        self.timeout = timeout

    def _req(self, method, path, body=None):
        """Transport failures (dropped tunnel responses etc.) are retried up
        to 3 times; HTTP error statuses are returned, never retried. Note a
        lost deposit response can leave the deposit landed server-side: a
        retry then returns 409 'already deposited', which means success."""
        data = json.dumps(body).encode() if body is not None else None
        last_exc = None
        for attempt in range(3):
            req = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"})
            if self.selftest:
                req.add_header("X-Swapwindow-Selftest", "1")
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return r.status, json.loads(r.read() or b"{}")
            except urllib.error.HTTPError as e:
                raw = e.read().decode("utf-8", "replace")
                try:
                    parsed = json.loads(raw or "{}")
                except Exception:
                    parsed = {"raw": raw}
                return e.code, parsed
            except Exception as e:
                last_exc = e
                time.sleep(1.0 * (attempt + 1))
        raise SwapError(0, {"transport_error": str(last_exc)})

    def create(self, ttl_seconds=3600):
        status, body = self._req("POST", "/v1/capsules", {"ttl_seconds": ttl_seconds})
        if status != 201:
            raise SwapError(status, body)
        return body

    def deposit(self, capsule_id, party, nonce, ciphertext):
        status, body = self._req("POST", f"/v1/capsules/{capsule_id}/deposit", {
            "party": party, "nonce": nonce,
            "ciphertext_b64": base64.b64encode(ciphertext).decode()})
        if status != 202:
            raise SwapError(status, body)
        return body

    def status(self, capsule_id, nonce):
        return self._req("GET", f"/v1/capsules/{capsule_id}/status?nonce={nonce}")

    def poll(self, capsule_id, nonce, timeout_s=300, interval_s=1.0):
        """Return counterparty ciphertext once released, else None on timeout."""
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            status, body = self.status(capsule_id, nonce)
            if status == 200 and body.get("state") == "released":
                return base64.b64decode(body["ciphertext_b64"])
            if status == 410:
                return None
            time.sleep(interval_s)
        return None

    def abort(self, capsule_id, nonce):
        return self._req("POST", f"/v1/capsules/{capsule_id}/abort", {"nonce": nonce})

    def stats(self):
        return self._req("GET", "/v1/stats")
