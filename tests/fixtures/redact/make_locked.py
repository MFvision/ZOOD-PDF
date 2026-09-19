#!/usr/bin/env python3
"""A PDF that opens without a password but whose permissions forbid changing
its content — encrypted with an empty user password and an owner password
("owner"), /P granting nothing — as many files handed out by organisations
are. A viewer that honours the permissions refuses redaction marks on it.

The standard security handler, revision 3 (RC4, 128-bit key; PDF 32000-1
§7.6.3), written out here: standard library only. Run from the repository
root: python3 tests/fixtures/redact/make_locked.py

  page 1   "Nadia Haddad signed this" in Helvetica
"""
import hashlib
import struct
from pathlib import Path

HERE = Path(__file__).resolve().parent

PAD = bytes.fromhex("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A")
ID = bytes.fromhex("5761727261714c6f636b6564466978747572650a")[:16]
# Every permission bit off (bits 7-8 and 13-32 are set, as the standard asks).
P = -3904
N = 16


def rc4(key, data):
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) % 256
        s[i], s[j] = s[j], s[i]
    out = bytearray()
    i = j = 0
    for byte in data:
        i = (i + 1) % 256
        j = (j + s[i]) % 256
        s[i], s[j] = s[j], s[i]
        out.append(byte ^ s[(s[i] + s[j]) % 256])
    return bytes(out)


def padded(password):
    return (password + PAD)[:32]


# Algorithm 3: the owner entry.
digest = hashlib.md5(padded(b"owner")).digest()
for _ in range(50):
    digest = hashlib.md5(digest[:N]).digest()
owner_key = digest[:N]
O = rc4(owner_key, padded(b""))
for i in range(1, 20):
    O = rc4(bytes(b ^ i for b in owner_key), O)

# Algorithm 2: the file's key, from the (empty) user password.
digest = hashlib.md5(padded(b"") + O + struct.pack("<i", P) + ID).digest()
for _ in range(50):
    digest = hashlib.md5(digest[:N]).digest()
KEY = digest[:N]

# Algorithm 5: the user entry.
U = rc4(KEY, hashlib.md5(PAD + ID).digest())
for i in range(1, 20):
    U = rc4(bytes(b ^ i for b in KEY), U)
U += bytes(16)


def sealed(number, data):
    """Algorithm 1: `data` of object `number` (generation 0), encrypted."""
    key = hashlib.md5(KEY + struct.pack("<i", number)[:3] + b"\x00\x00").digest()[: N + 5]
    return rc4(key, data)


def hexstr(data):
    return b"<" + data.hex().encode() + b">"


content = b"BT /F1 14 Tf 72 700 Td (Nadia Haddad signed this) Tj ET"
objects = {
    1: b"<< /Type /Catalog /Pages 2 0 R >>",
    2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    4: f"<< /Length {len(content)} >>\nstream\n".encode() + sealed(4, content) + b"\nendstream",
    5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    6: b"<< /Filter /Standard /V 2 /R 3 /Length 128 /O " + hexstr(O) + b" /U " + hexstr(U) + f" /P {P} >>".encode(),
}

out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
offsets = {}
for n in sorted(objects):
    offsets[n] = len(out)
    out += f"{n} 0 obj\n".encode() + objects[n] + b"\nendobj\n"
size = max(objects) + 1
xref = len(out)
out += f"xref\n0 {size}\n0000000000 65535 f \n".encode()
for n in range(1, size):
    out += f"{offsets[n]:010d} 00000 n \n".encode()
out += (f"trailer\n<< /Size {size} /Root 1 0 R /Encrypt 6 0 R /ID [<{ID.hex()}> <{ID.hex()}>] >>\n"
        f"startxref\n{xref}\n%%EOF\n").encode()
(HERE / "locked.pdf").write_bytes(out)
print("locked.pdf", len(out), "bytes")
