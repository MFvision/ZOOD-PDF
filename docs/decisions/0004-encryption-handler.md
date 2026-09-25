# ADR 0004 — Own Standard security handler

* Status: accepted
* Date: 2026-09-25

## Context
lopdf 0.45 can decrypt some files, but silently drops or garbles objects it cannot decrypt, does not tell us
whether the user or the owner password matched, and does not let us re-encrypt appended objects with the
original key. SPEC §3 Protect: "open password, AES-256, permissions; core keeps protection on appended updates".

## Decision
* `warraq_pdf::crypt::SecurityHandler` implements ISO 32000-2 §7.6.4 ourselves with RustCrypto primitives
  (`aes`, `cbc`, `rc4`, `md-5`, `sha2`; randomness from `getrandom`): V1/R2 RC4-40, V2/R3 RC4 40–128,
  V4/R4 crypt filters (`/V2` RC4, `/AESV2`, `/Identity`, `/None`), V5/R5 (Adobe ext. 3) and V5/R6 AES-256
  with hash algorithm 2.B; `/StmF`, `/StrF`, `/EFF`, per-stream `/Crypt` filters, `/EncryptMetadata false`.
* Authentication tries the owner password first (Algorithm 7 / 3.2a), then the user password
  (Algorithms 6 / 11). `matched` = `owner` | `user`; effective permissions are "all" for the owner and `/P`
  otherwise. Empty user passwords open without a prompt.
* lopdf is used only as a parser: the loader renames the trailer's `/Encrypt` name to a same-length name
  before handing the bytes to lopdf (so lopdf loads raw ciphertext), and hides encrypted object streams from
  it with a load filter. We then decrypt every string and stream of every object ourselves — except the
  encryption dictionary, xref streams and signature `/Contents` — and expand the decrypted object streams.
  If the masked name turns out not to be in any trailer, the file is reloaded untouched.
* Writing: `SecurityHandler::new_aes256(user, owner, perms)` creates V5/R6 (random 32-byte file key, salts,
  `/UE`, `/OE`, `/Perms`), adds the ADBE extension level 8 to the catalog. Incremental updates of encrypted
  files encrypt new objects with the loaded handler (same key, fresh AES IVs) and keep the `/Encrypt`
  reference, so protection is never lost on save. `new_legacy` (R2–R4) exists only to generate fixtures.
* Passwords: R5/R6 use UTF-8 truncated to 127 bytes (SASLprep is not applied — it only changes passwords with
  compatibility characters; Arabic and ASCII passwords are unaffected). R2–R4 use PDFDocEncoding≈Latin-1;
  characters outside Latin-1 fall back to UTF-8 bytes (not portable to other readers — new protection is
  always R6, so this only matters for reading legacy files).
* An empty owner password on `protect.set` means "same as the user password" (pypdf/qpdf behaviour).
* Public-key (`/Adobe.PubSec`) handlers are rejected with `unsupported_encryption`.

## Verification
* Fixtures made by two independent implementations — qpdf (via pikepdf, MPL; generator only, never shipped)
  and pypdf (BSD) — for R2, R3, R4-RC4, R4-AES (with and without object streams, with
  `EncryptMetadata false`), R6 (with/without object streams, empty user password with restrictions): all
  decrypt with user and owner passwords; wrong/missing passwords give `wrong_password`/`password_required`.
* pypdf decrypts files we encrypt (R2, R3, R4-RC4, R4-AES, R6) and reads our incremental updates of
  encrypted files. R5/R6 hash known answers come from pypdf's implementation.

## Consequences
* One place owns keys; hayro (rendering) receives decrypted in-memory rewrites instead of passwords.
* RC4/AES-128 are only ever written for test fixtures.
