#!/usr/bin/env python3
"""Encrypted variants of the Cairo invoice (pikepdf/qpdf), one per revision and
cipher of the standard security handler, so that warraq-pdf's own crypt module
can be exercised against files produced by an independent implementation:

    variant-encrypted-rc4-40.pdf           R2, RC4 40-bit
    variant-encrypted-rc4-128.pdf          R3, RC4 128-bit
    variant-encrypted-aes128.pdf           R4, /AESV2, /EncryptMetadata false
    variant-encrypted-aes256-owner-only.pdf R6, /AESV3, EMPTY user password

The user password is "warraq" and the owner password "warraq-owner" everywhere
except the owner-only file, which opens with no password at all (so that the
"encrypted but no password needed" path is covered too).

variant-encrypted-aes256.pdf (R6, user password "warraq") is written by
gen_variants.py from the 3-page Noto Naskh file; it is not repeated here.

Usage: python3 gen_encrypted.py <repo-root>
Then:  python3 build_manifest.py <repo-root>
"""
import shutil
import sys
from pathlib import Path

import pikepdf
from pikepdf import Encryption, Pdf

REPO = Path(sys.argv[1]).resolve()
GEN = REPO / "tests/corpus/arabic/generated"
TRUTH = REPO / "tests/corpus/arabic/truth"
SRC = GEN / "chrome-cairo-mixed-invoice.pdf"
SRC_TRUTH = TRUTH / "chrome-cairo-mixed-invoice.txt"

USER = "warraq"
OWNER = "warraq-owner"

# (stem, Encryption kwargs, password that must open the file)
VARIANTS = [
    # R2/R3 have no /EncryptMetadata entry at all (metadata is always covered);
    # pikepdf rejects metadata=True there, so pass False and let qpdf omit it.
    (
        "variant-encrypted-rc4-40",
        dict(user=USER, owner=OWNER, R=2, aes=False, metadata=False),
        USER,
    ),
    (
        "variant-encrypted-rc4-128",
        dict(user=USER, owner=OWNER, R=3, aes=False, metadata=False),
        USER,
    ),
    # /EncryptMetadata false changes algorithm 2's key derivation (the extra
    # 0xFFFFFFFF), so it is worth having exactly one corpus file that uses it.
    (
        "variant-encrypted-aes128",
        dict(user=USER, owner=OWNER, R=4, aes=True, metadata=False),
        USER,
    ),
    (
        "variant-encrypted-aes256-owner-only",
        dict(user="", owner=OWNER, R=6, aes=True),
        "",
    ),
]

# The owner-only file is also written with object streams and a cross-reference
# stream, so that "encrypted container, plaintext strings inside it" is covered:
# the members of an /ObjStm are decrypted with the container, never on their own.
OBJECT_STREAMS = {"variant-encrypted-aes256-owner-only"}


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"missing source: {SRC} (run gen_chrome.py first)")
    for stem, kwargs, password in VARIANTS:
        out = GEN / f"{stem}.pdf"
        mode = (
            pikepdf.ObjectStreamMode.generate
            if stem in OBJECT_STREAMS
            else pikepdf.ObjectStreamMode.preserve
        )
        with Pdf.open(SRC) as pdf:
            pdf.save(out, encryption=Encryption(**kwargs), object_stream_mode=mode)
        shutil.copyfile(SRC_TRUTH, TRUTH / f"{stem}.txt")
        # Re-open through qpdf with the password that the Rust tests use, so a
        # file that only this script can read never reaches the corpus.
        with Pdf.open(out, password=password) as check:
            enc = check.encryption
            print(
                f"ok  {out.name:40s} {out.stat().st_size:7d} bytes  "
                f"R={enc.R} V={enc.V} stm={enc.stream_method} str={enc.string_method} "
                f"bits={enc.bits} pages={len(check.pages)}"
            )
        # An empty password must NOT open the files that have a user password,
        # and a wrong password must open none of them.
        for bad in ({"", "wrong"} - {password}):
            try:
                Pdf.open(out, password=bad).close()
            except pikepdf.PasswordError:
                pass
            else:
                raise SystemExit(f"{out.name} opened with the wrong password {bad!r}")


if __name__ == "__main__":
    main()
