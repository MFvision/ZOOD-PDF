# ADR 0002 — Permissive licences only

* Status: accepted

Allowed: MIT, Apache-2.0, BSD-2/3, ISC, Zlib, Unicode-3.0/DFS, OFL-1.1 (fonts), CC0. Forbidden: GPL, AGPL, LGPL, MPL
file-level copyleft in bundled code, and any "source-available" licence. Consequences: no veraPDF (own PDF/A
validator), no paperless-ngx (own Library), no LibreOffice (own Office readers/writers and layout engine),
no Ghostscript/MuPDF/qpdf. `scripts/licenses.sh` checks `cargo metadata` and `pnpm licenses` and fails on anything else.
