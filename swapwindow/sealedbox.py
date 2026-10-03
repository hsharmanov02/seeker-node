#!/usr/bin/env python3
"""Stdlib-only sealed box for SwapWindow reference clients.

Construction: ephemeral X25519 (RFC 7748) key agreement, HKDF-SHA256
(RFC 5869) key derivation, ChaCha20-Poly1305 AEAD (RFC 8439).
Wire format: ephemeral_pub(32) || nonce(12) || ciphertext||tag.

Only the intended recipient (holder of the X25519 private key) can open
a box. The SwapWindow server never sees keys or plaintext: it stores
these opaque byte strings, capped at 4096 bytes.
"""
import hashlib
import hmac as _hmac
import os
import struct

# ---------------- X25519 (RFC 7748) ----------------
_P = 2 ** 255 - 19
_A24 = 121665
_BASE = (9).to_bytes(32, "little")


def _decode_u(b):
    return int.from_bytes(b, "little") & ((1 << 255) - 1)


def _x25519(scalar_bytes, u_bytes):
    kb = bytearray(scalar_bytes)
    kb[0] &= 248
    kb[31] &= 127
    kb[31] |= 64
    k = int.from_bytes(kb, "little")
    x1 = _decode_u(u_bytes)
    x2, z2, x3, z3, swap = 1, 0, x1, 1, 0
    for t in range(254, -1, -1):
        kt = (k >> t) & 1
        swap ^= kt
        if swap:
            x2, x3 = x3, x2
            z2, z3 = z3, z2
        swap = kt
        a = (x2 + z2) % _P
        aa = a * a % _P
        b = (x2 - z2) % _P
        bb = b * b % _P
        e = (aa - bb) % _P
        c = (x3 + z3) % _P
        d = (x3 - z3) % _P
        da = d * a % _P
        cb = c * b % _P
        x3 = (da + cb) ** 2 % _P
        z3 = x1 * ((da - cb) ** 2 % _P) % _P
        x2 = aa * bb % _P
        z2 = e * ((aa + _A24 * e) % _P) % _P
    if swap:
        x2, x3 = x3, x2
        z2, z3 = z3, z2
    return (x2 * pow(z2, _P - 2, _P) % _P).to_bytes(32, "little")


def generate_keypair():
    priv = os.urandom(32)
    return priv, _x25519(priv, _BASE)


def agree(priv, peer_pub):
    return _x25519(priv, peer_pub)


# ---------------- HKDF-SHA256 (RFC 5869) ----------------
def hkdf(ikm, salt, info, length=32):
    if salt is None:
        salt = b"\x00" * 32
    prk = _hmac.new(salt, ikm, hashlib.sha256).digest()
    okm, t, counter = b"", b"", 1
    while len(okm) < length:
        t = _hmac.new(prk, t + info + bytes([counter]), hashlib.sha256).digest()
        okm += t
        counter += 1
    return okm[:length]


# ---------------- ChaCha20-Poly1305 (RFC 8439) ----------------
def _rotl32(v, n):
    return ((v << n) | (v >> (32 - n))) & 0xFFFFFFFF


def _quarter(x, a, b, c, d):
    x[a] = (x[a] + x[b]) & 0xFFFFFFFF
    x[d] = _rotl32(x[d] ^ x[a], 16)
    x[c] = (x[c] + x[d]) & 0xFFFFFFFF
    x[b] = _rotl32(x[b] ^ x[c], 12)
    x[a] = (x[a] + x[b]) & 0xFFFFFFFF
    x[d] = _rotl32(x[d] ^ x[a], 8)
    x[c] = (x[c] + x[d]) & 0xFFFFFFFF
    x[b] = _rotl32(x[b] ^ x[c], 7)


def _chacha_block(key, counter, nonce):
    consts = struct.unpack("<4I", b"expand 32-byte k")
    state = list(consts + struct.unpack("<8I", key) + (counter,) + struct.unpack("<3I", nonce))
    work = state[:]
    for _ in range(10):
        _quarter(work, 0, 4, 8, 12)
        _quarter(work, 1, 5, 9, 13)
        _quarter(work, 2, 6, 10, 14)
        _quarter(work, 3, 7, 11, 15)
        _quarter(work, 0, 5, 10, 15)
        _quarter(work, 1, 6, 11, 12)
        _quarter(work, 2, 7, 8, 13)
        _quarter(work, 3, 4, 9, 14)
    return struct.pack("<16I", *[((work[i] + state[i]) & 0xFFFFFFFF) for i in range(16)])


def _chacha_xor(key, counter, nonce, data):
    out = bytearray()
    ctr = counter
    for off in range(0, len(data), 64):
        block = _chacha_block(key, ctr, nonce)
        chunk = data[off:off + 64]
        out.extend(bytes(x ^ y for x, y in zip(chunk, block)))
        ctr += 1
    return bytes(out)


def _poly1305(msg, key):
    r = int.from_bytes(key[:16], "little") & 0x0FFFFFFC0FFFFFFC0FFFFFFC0FFFFFFF
    s = int.from_bytes(key[16:], "little")
    p = (1 << 130) - 5
    acc = 0
    for off in range(0, len(msg), 16):
        block = msg[off:off + 16]
        n = int.from_bytes(block, "little") + (1 << (8 * len(block)))
        acc = ((acc + n) * r) % p
    return ((acc + s) % (1 << 128)).to_bytes(16, "little")


def _pad16(x):
    return b"" if len(x) % 16 == 0 else b"\x00" * (16 - len(x) % 16)


def aead_encrypt(key, nonce, plaintext, aad=b""):
    poly_key = _chacha_block(key, 0, nonce)[:32]
    ciphertext = _chacha_xor(key, 1, nonce, plaintext)
    mac_data = aad + _pad16(aad) + ciphertext + _pad16(ciphertext) + struct.pack("<QQ", len(aad), len(ciphertext))
    return ciphertext + _poly1305(mac_data, poly_key)


def aead_decrypt(key, nonce, sealed, aad=b""):
    if len(sealed) < 16:
        raise ValueError("sealed box too short")
    ciphertext, tag = sealed[:-16], sealed[-16:]
    poly_key = _chacha_block(key, 0, nonce)[:32]
    mac_data = aad + _pad16(aad) + ciphertext + _pad16(ciphertext) + struct.pack("<QQ", len(aad), len(ciphertext))
    if not _hmac.compare_digest(_poly1305(mac_data, poly_key), tag):
        raise ValueError("AEAD tag mismatch")
    return _chacha_xor(key, 1, nonce, ciphertext)


# ---------------- Sealed box ----------------
_INFO = b"swapwindow-sealedbox-v1"


def seal(recipient_pub, plaintext):
    eph_priv, eph_pub = generate_keypair()
    shared = agree(eph_priv, recipient_pub)
    key = hkdf(shared, salt=eph_pub + recipient_pub, info=_INFO)
    nonce = os.urandom(12)
    return eph_pub + nonce + aead_encrypt(key, nonce, plaintext)


def open_box(recipient_priv, sealed):
    if len(sealed) < 32 + 12 + 16:
        raise ValueError("sealed box too short")
    eph_pub, nonce, body = sealed[:32], sealed[32:44], sealed[44:]
    recipient_pub = _x25519(recipient_priv, _BASE)
    shared = agree(recipient_priv, eph_pub)
    key = hkdf(shared, salt=eph_pub + recipient_pub, info=_INFO)
    return aead_decrypt(key, nonce, body)


if __name__ == "__main__":
    # X25519 is verified against the Node/OpenSSL oracle in test_vectors.py.
    # RFC 8439 section A.5 AEAD test vector:
    key = bytes.fromhex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
    nonce = bytes.fromhex("070000004041424344454647")
    aad = bytes.fromhex("50515253c0c1c2c3c4c5c6c7")
    pt = (b"Ladies and Gentlemen of the class of '99: If I could offer you "
          b"only one tip for the future, sunscreen would be it.")
    ct = aead_encrypt(key, nonce, pt, aad)
    assert ct[-16:].hex() == "1ae10b594f09e26a7e902ecbd0600691", ct[-16:].hex()
    assert aead_decrypt(key, nonce, ct, aad) == pt
    # round trip
    priv, pub = generate_keypair()
    box = seal(pub, b"swapwindow self-test")
    assert open_box(priv, box) == b"swapwindow self-test"
    print("sealedbox self-test OK (RFC 7748 + RFC 8439 vectors + round trip)")
