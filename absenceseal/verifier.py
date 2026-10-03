#!/usr/bin/env python3
"""AbsenceSeal open verifier — trust nothing, recompute everything.

Usage: python3 verifier.py cert.json [--rpc URL] [--key PUBKEY_HEX]

Recomputes, from the public Base chain alone: (1) the Ed25519 service
signature, (2) every window's events/pairs Merkle roots by re-fetching all
USDC Transfer/Approval logs chunk-by-chunk, (3) the sorted-Merkle
non-membership proofs (neighbour adjacency), and (4) the exact subject x
counterparty events inside the certified range. Prints VALID-ABSENT /
VALID-FOUND / INVALID with the reason. Stdlib only. ~170 lines.
"""
import hashlib, json, sys, time, urllib.request

TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"
CHUNK = 100

# ---- Ed25519 verify (RFC 8032, verify-only) ----
q = 2**255 - 19
l = 2**252 + 27742317777372353535851937790883648493
d = (-121665 * pow(121666, q - 2, q)) % q
I = pow(2, (q - 1) // 4, q)

def xrecover(y):
    xx = (y * y - 1) * pow(d * y * y + 1, q - 2, q) % q
    x = pow(xx, (q + 3) // 8, q)
    if (x * x - xx) % q != 0:
        x = (x * I) % q
    if x % 2 != 0:
        x = q - x
    return x

By = (4 * pow(5, q - 2, q)) % q
B = (xrecover(By), By)

def add(P, Q):
    (x1, y1), (x2, y2) = P, Q
    t = d * x1 * x2 * y1 * y2 % q
    return ((x1 * y2 + x2 * y1) * pow(1 + t, q - 2, q) % q,
            (y1 * y2 + x1 * x2) * pow(1 - t, q - 2, q) % q)

def mul(P, e):
    Q = (0, 1)
    while e:
        if e & 1:
            Q = add(Q, P)
        P = add(P, P)
        e >>= 1
    return Q

def decode_pt(s):
    y = int.from_bytes(s, "little") & (2**255 - 1)
    x = xrecover(y)
    if (x & 1) != (s[31] >> 7):
        x = q - x
    return (x, y)

def ed_verify(pk, sig, msg):
    if len(pk) != 32 or len(sig) != 64:
        return False
    A = decode_pt(pk)
    R = decode_pt(sig[:32])
    S = int.from_bytes(sig[32:], "little")
    if S >= l:
        return False
    h = int.from_bytes(hashlib.sha512(sig[:32] + pk + msg).digest(),
                       "little") % l
    return mul(B, S) == add(R, mul(A, h))

# ---- Merkle (sorted leaves; odd node duplicated upward) ----
def root(leaves):
    if not leaves:
        return hashlib.sha256(b"as-empty").digest()
    lvl = list(leaves)
    while len(lvl) > 1:
        lvl = [hashlib.sha256(lvl[i] + (lvl[i + 1] if i + 1 < len(lvl)
               else lvl[i])).digest() for i in range(0, len(lvl), 2)]
    return lvl[0]

def incl_ok(leaf, idx, proof, root_hex):
    h, i = leaf, idx
    for sib, side in proof:
        s = bytes.fromhex(sib)
        h = (hashlib.sha256(s + h) if side == "L"
             else hashlib.sha256(h + s)).digest()
        i //= 2
    return h.hex() == root_hex

# ---- Base RPC via stdlib (UA header required by public RPC) ----
RPC = "https://mainnet.base.org"

def rpc(method, params, tries=6):
    for i in range(tries):
        try:
            req = urllib.request.Request(RPC, data=json.dumps(
                {"jsonrpc": "2.0", "id": 1, "method": method,
                 "params": params}).encode(),
                headers={"Content-Type": "application/json",
                         "User-Agent": "Mozilla/5.0 (absenceseal-verifier)"})
            with urllib.request.urlopen(req, timeout=90) as r:
                out = json.loads(r.read())
            if "error" in out:
                raise RuntimeError(str(out["error"]))
            return out["result"]
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))

def chunk_events(usdc, a, b):
    leaves, pairs = [], set()
    for t0, kind in ((TRANSFER, 0), (APPROVAL, 1)):
        for lg in rpc("eth_getLogs", [{"fromBlock": hex(a), "toBlock": hex(b),
                                       "address": usdc, "topics": [t0]}]):
            f = bytes.fromhex(lg["topics"][1][-40:])
            t = bytes.fromhex(lg["topics"][2][-40:])
            leaf = hashlib.sha256(
                b"as-evt\x00" + f + t + bytes([kind])
                + int(lg["data"], 16).to_bytes(32, "big")
                + int(lg["blockNumber"], 16).to_bytes(8, "big")
                + bytes.fromhex(lg["transactionHash"][2:])
                + int(lg["logIndex"], 16).to_bytes(4, "big")).digest()
            leaves.append(leaf)
            pairs.add(hashlib.sha256(
                b"as-pair\x00" + min(f, t) + max(f, t)).digest())
    return leaves, pairs

def pair_events(usdc, subj, cp, a, b):
    n = 0
    st = "0x" + "0" * 24 + subj[2:].lower()
    ct = "0x" + "0" * 24 + cp[2:].lower()
    for t0 in (TRANSFER, APPROVAL):
        for t1, t2 in ((st, ct), (ct, st)):
            x = a
            while x <= b:
                y = min(b, x + 499)
                n += len(rpc("eth_getLogs", [{
                    "fromBlock": hex(x), "toBlock": hex(y), "address": usdc,
                    "topics": [t0, t1, t2]}]))
                x = y + 1
    return n

def main():
    argv = sys.argv[1:]
    cert = json.load(open(argv[0])) if not argv[0].startswith("http") else \
        json.loads(urllib.request.urlopen(argv[0], timeout=30).read())
    if "--rpc" in argv:
        globals()["RPC"] = argv[argv.index("--rpc") + 1]
    pk_hex = (argv[argv.index("--key") + 1] if "--key" in argv
              else cert["service_public_key_ed25519"])
    canon = lambda o: json.dumps(o, sort_keys=True, separators=(",", ":"))
    core = {k: v for k, v in cert.items() if k != "signature_ed25519"}
    if not ed_verify(bytes.fromhex(pk_hex),
                     bytes.fromhex(cert["signature_ed25519"]),
                     canon(core).encode()):
        print("INVALID: bad Ed25519 service signature"); return 1
    print("signature: OK (service key", pk_hex[:16] + "...)")
    usdc = cert["universe"]["token_contract"]
    a, b = cert["range"]["from_block"], cert["range"]["to_block"]
    for w in cert["windows"]:
        rec = {
            "prev": w["prev_chain"], "from": w["from"], "to": w["to"],
            "events_root": w["events_root"], "pairs_root": w["pairs_root"],
            "event_count": w["event_count"], "pair_count": w["pair_count"],
            "first_hash": w["first_hash"], "last_hash": w["last_hash"]}
        if hashlib.sha256(canon(rec).encode()).hexdigest() != w["chain_hash"]:
            print(f"INVALID: window {w['from']} chain hash broken"); return 1
        leaves, pairs = [], set()
        x = w["from"]
        while x <= w["to"]:
            y = min(w["to"], x + CHUNK - 1)
            lv, pk2 = chunk_events(usdc, x, y)
            leaves += lv; pairs |= pk2
            x = y + 1
        leaves.sort()
        if root(leaves).hex() != w["events_root"]:
            print(f"INVALID: window {w['from']} events_root mismatch "
                  "(recomputed chain disagrees)"); return 1
        if root(sorted(pairs)).hex() != w["pairs_root"]:
            print(f"INVALID: window {w['from']} pairs_root mismatch"); return 1
        print(f"window {w['from']}-{w['to']}: roots recomputed OK "
              f"({w['event_count']} events, {w['pair_count']} pairs)")
        for p in w["proofs"]:
            pk = bytes.fromhex(p["pair_key"])
            if p["result"] == "ABSENT":
                for side in ("predecessor", "successor"):
                    if side in p and not incl_ok(
                            bytes.fromhex(p[side]["leaf"]), p[side]["index"],
                            p[side]["proof"], w["pairs_root"]):
                        print("INVALID: bad neighbour proof"); return 1
                if "predecessor" in p and "successor" in p and \
                        p["successor"]["index"] != p["predecessor"]["index"] + 1:
                    print("INVALID: neighbours not adjacent"); return 1
            elif not incl_ok(pk, p["leaf_index"], p["inclusion_proof"],
                             w["pairs_root"]):
                print("INVALID: bad inclusion proof"); return 1
    hits = sum(pair_events(usdc, cert["subject"], cp, a, b)
               for cp in cert["counterparty_set"]["addresses"])
    if cert["result"] == "ABSENT" and hits:
        print(f"INVALID: FALSE CERTIFICATE — {hits} event(s) found in "
              "range that the cert claims absent"); return 1
    if cert["result"] == "INTERACTION_FOUND" and not hits:
        print("INVALID: cert claims interaction, recompute found none")
        return 1
    print("VALID-" + ("ABSENT — the negative is proven" if hits == 0
                      else f"FOUND — {hits} event(s) confirmed"))
    print("scope: USDC Transfer/Approval on Base, blocks "
          f"{a}-{b}, pinned set sha256 "
          + cert["counterparty_set"]["set_hash"][:16] + "...")
    return 0

if __name__ == "__main__":
    sys.exit(main())
