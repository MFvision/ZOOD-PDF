#!/usr/bin/env python3
"""Check a protected PDF with an implementation that is not ours.

Warraq writes the standard security handler itself (`warraq-pdf/src/crypt`), so
a round trip through our own reader only proves we are self-consistent. pikepdf
(libqpdf) is the second opinion: it reports the revision, the cipher and the
permissions it read, and decrypts the pages.

    WARRAQ_PROTECT_OUT=/tmp/protected.pdf \
      cargo test -p warraq-pdf --manifest-path packages/core/Cargo.toml \
      -- --ignored writes_a_protected_file_for_an_outside_reader
    python3 tests/tools/check_protection.py /tmp/protected.pdf

The password defaults to the Arabic one the Rust test uses. Exit status is 0
when everything agreed, 1 otherwise, so this can be run from a script.
"""

import sys

import pikepdf

# The password `crypt::tests::ARABIC` writes. Passed as UTF-8, which is what
# revisions 5 and 6 of the standard handler take.
DEFAULT_PASSWORD = "كلمة السر ١٢٣"


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    path = argv[1]
    password = argv[2] if len(argv) > 2 else DEFAULT_PASSWORD

    problems = []

    # A wrong password must not open it, and neither must no password at all.
    for wrong in ["", password + "x", password[:-1]]:
        try:
            pikepdf.open(path, password=wrong)
        except pikepdf.PasswordError:
            pass
        else:
            problems.append(f"opened with the wrong password {wrong!r}")

    with pikepdf.open(path, password=password) as pdf:
        encryption = pdf.encryption
        print(f"file        {path}")
        print(f"revision    R{encryption.R} (/V {encryption.V})")
        print(f"stream      {encryption.stream_method}")
        print(f"string      {encryption.string_method}")
        print(f"key         {len(encryption.encryption_key) * 8} bits")
        print(f"P           {encryption.P}")
        print(f"permissions {pdf.allow}")
        print(f"pages       {len(pdf.pages)}")

        if encryption.R != 6:
            problems.append(f"revision is R{encryption.R}, not R6")
        if len(encryption.encryption_key) != 32:
            problems.append(f"key is {len(encryption.encryption_key)} bytes, not 32")
        # qpdf's name for AES-256 under a /V 5 handler.
        if "aesv3" not in str(encryption.stream_method):
            problems.append(f"streams use {encryption.stream_method}, not AES-256")
        if "aesv3" not in str(encryption.string_method):
            problems.append(f"strings use {encryption.string_method}, not AES-256")
        if not len(pdf.pages):
            problems.append("no pages could be read")
        # The Rust test grants printing and nothing else, so qpdf must read
        # exactly that back: proof that our /P bit layout is the standard's.
        if len(argv) <= 2:
            expected = {
                "accessibility": True,
                "print_lowres": True,
                "print_highres": True,
                "extract": False,
                "modify_annotation": False,
                "modify_assembly": False,
                "modify_form": False,
                "modify_other": False,
            }
            for field, want in expected.items():
                got = getattr(pdf.allow, field)
                if got != want:
                    problems.append(f"permission {field} is {got}, expected {want}")
        # Reading a page's content proves the decryption, not just the password.
        try:
            first = bytes(pdf.pages[0].Contents.read_bytes())
        except Exception as e:  # noqa: BLE001 — any failure here is the answer
            problems.append(f"the first page's content stream could not be read: {e}")
        else:
            if not first.strip():
                problems.append("the first page's content stream decrypted to nothing")

    for problem in problems:
        print(f"PROBLEM: {problem}", file=sys.stderr)
    print("agreed" if not problems else "DISAGREED", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
