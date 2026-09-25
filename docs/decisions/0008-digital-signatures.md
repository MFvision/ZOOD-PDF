# ADR 0008 — Digital signatures (warraq-sign)

* Status: accepted
* Date: 2026-09-25

## Context
SPEC §3 "Digital signature": PAdES B-B/B-T/B-LT/LTA, PKCS#12 RSA/ECDSA, visible Arabic
appearance, certification levels, FieldMDP; verification with a document-signing EKU policy,
shadow-attack and overlay detection, borrowed-signature rejection, modification listing;
timestamps + LTV desktop only; PKCS#11 untested. BRIEF §7: no smart-card hardware — trait +
software signer. The engine runs in wasm (no network, no clock of its own) and on iOS.

## Decision

### Crates (RustCrypto only)
* The `der 0.7 / x509-cert 0.2 / cms 0.2 / spki 0.7` generation. It is the newest set in which
  `cms`, `x509-tsp 0.1` and `x509-ocsp 0.2` agree on one `der`/`x509-cert`; the 0.8/0.3
  generation is still pre-release for `cms`, `rsa` and `pkcs12`. Consequence: two `sha2`/
  `digest`/`cipher` generations are compiled (warraq-pdf uses 0.11); both are MIT/Apache.
* `rsa 0.9` (PKCS#1 v1.5 signing with **blinding**: randomness from warraq-pdf's getrandom, so no
  `getrandom 0.2` enters the wasm build), `p256`/`p384`/`ecdsa 0.16` (RFC 6979 nonces),
  `pkcs8`, `pkcs5` (PBES2), `pkcs12 0.1` (ASN.1 types + RFC 7292 KDF only), `des`, `rc2`,
  `hmac`, `zeroize`, `x509-tsp`, `x509-ocsp`. No `builder` features: CMS, TSA requests, OCSP
  requests are assembled from the typed structures by our code.
* `webpki-roots` (CDLA-Permissive-2.0 data, a permissive data licence not named in ADR 0002 but
  requested by the owner for exactly this use) is used **only** as the list of anchors that can
  make a *timestamp authority* "trusted". It never contributes to document-signer trust.
* Font shaping for the visible appearance comes from `warraq-text` (`shape` + `actual_text_spans`,
  HarfRust + unicode-bidi); the font is a 250 KB Amiri subset (OFL-1.1, Arabic + Latin, layout
  features kept) behind the default `builtin-font` feature, re-subsetted per signature with
  `subsetter`.

### PKCS#12
Own loader (`pkcs12.rs`) over the `pkcs12`/`cms` ASN.1 types: BER is normalised to DER first
(Windows exports), MAC HMAC-SHA1/256/384/512 with the PKCS#12 KDF (ID 3), PBES2 via `pkcs5`
(UTF-8 password), legacy `pbeWithSHAAnd3-KeyTripleDES-CBC`, `…2-KeyTripleDES-CBC`,
`…128BitRC2-CBC`, `…40BitRC2-CBC` implemented with the KDF (IDs 1/2, BMPString password + NUL)
and `des`/`rc2`. Iteration counts are capped at 3 000 000 (DoS). Public-key-integrity and PBMAC1
files are rejected with `unsupported`. Decrypted buffers are `Zeroizing`; keys zeroize on drop;
the RPC wipes the `.p12` bytes and the password copy right after loading. (The JSON param string
itself lives in the caller's heap and cannot be wiped from Rust.)

### Signer
`trait Signer { certificate, chain, key_algorithm, digest_algorithm, sign_digest(hash, digest) }`.
Digest-level signing maps directly onto PKCS#11 (`CKM_RSA_PKCS` with a DigestInfo prefix,
`CKM_ECDSA` + r‖s→DER), so a token signer can be added without touching the PAdES code. Only
`SoftwareSigner` (PKCS#12) exists; no PKCS#11 implementation was written (no hardware).

### PAdES layout
* Always an incremental update through `warraq_pdf::Pdf::build_update` (original bytes are an
  exact prefix; encrypted documents keep their key, strings are encrypted, `/Contents` of `/Sig`
  and `/DocTimeStamp` dictionaries is never encrypted — enforced by warraq-pdf's writer).
* Signature dictionary: `/Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached`, `/M`, `/Name`,
  `/Reason`, `/Location`, `/ContactInfo`, `/Prop_Build`. `/ByteRange` is written as a fixed-width
  placeholder `[0 9999999999 9999999999 9999999999]` and patched in place (space padded);
  `/Contents` is a zero hex string sized from the certificate chain (+12 KiB for levels ≥ B-T).
* CMS: SignedData v1, detached `id-data`, signed attributes contentType, messageDigest,
  signingCertificateV2 (SHA-256 + IssuerSerial); **no signing-time** (PAdES uses `/M`). RSA
  PKCS#1 v1.5 + SHA-256; ECDSA P-256 + SHA-256, P-384 + SHA-384.
* Certification: `/Reference [<</TransformMethod /DocMDP /TransformParams <</P n /V /1.2>>>>]` and
  catalog `/Perms /DocMDP`; refused unless it is the first signature; P = 1 blocks later signing.
  FieldMDP: `/Reference` FieldMDP (All/Include/Exclude) plus `/Lock` on new fields; an existing
  field's own `/Lock` becomes the signature's FieldMDP.
* Visible appearance: Form XObject with white box, border, lines (name large; date, reason,
  location — Arabic labels when the name is Arabic, or lines supplied by the UI), right-aligned
  RTL paragraphs, per-word `/Span <</ActualText>> BDC … EMC`, Type0/CIDFontType2 Identity-H font
  with ToUnicode. Page `/Rotate` is compensated with the form `/Matrix`.

### Levels without network in the engine
`sign.prepare` produces a complete B-B file and, for B-T and above, the RFC 3161 request DER for
SHA-256(signature value) with a nonce derived from the imprint (so `finish` needs no state).
`sign.finish` accepts the TSA response, checks status, imprint, nonce, token signature and the
timeStamping EKU, adds the token as the `signatureTimeStampToken` unsigned attribute and rewrites
only the `/Contents` hex string (unsigned bytes; the file length does not change).
`sign.revocationRequests` returns OCSP request DER + AIA/CRL-DP URLs for the signer and TSA chains;
`sign.addDss` appends `/DSS` (`/Certs /OCSPs /CRLs` streams, de-duplicated, and `/VRI` keyed by
the uppercase SHA-1 of each signature's `/Contents`), and optionally a `/DocTimeStamp`
(`/SubFilter /ETSI.RFC3161`) placeholder whose request `sign.finish` completes (B-LTA). The host
(desktop app) does the HTTP. A `TsaClient` trait exists for native callers.

### Verification
Per signature, in byte-range order:
1. **Byte range**: `[0 b c d]` must start at 0, not overlap, stay inside the file; the gap must be
   exactly `<hex>` equal to the dictionary's `/Contents`; `c + d` must be the end of a revision
   (`%%EOF`); the signed revision (loaded from that prefix with the document password) must
   contain the very same signature dictionary; the gap must lie inside that object's bytes.
   Failures → `invalid` with `borrowed_signature` / `signature_wrapping` evidence.
2. **CMS**: signed attributes are verified over their received encoding; messageDigest, contentType,
   ESS signingCertificate(V2); `adbe.pkcs7.detached`, `ETSI.CAdES.detached`, `adbe.pkcs7.sha1`,
   `ETSI.RFC3161`; RSA PKCS#1 v1.5, RSA-PSS, ECDSA P-256/P-384 (SHA-1 only with a warning).
3. **Identity**: chain from the CMS/DSS certificates to the **user-supplied roots only** (empty by
   default → `valid_identity_unknown`); CA flag / keyCertSign / validity of issuers; EKU policy:
   documentSigning 1.3.6.1.5.5.7.3.36, Adobe authentic documents 1.2.840.113583.1.1.5,
   emailProtection, anyExtendedKeyUsage or no EKU accepted; anything else (serverAuth-only)
   → `invalid`; key usage must allow digitalSignature/nonRepudiation. Validity is checked at the
   verified timestamp time when there is one, else at the host's "now".
4. **Timestamps**: signature timestamp tokens and document timestamps are fully verified; the TSA
   is "trusted" when it chains to webpki-roots or a user root.
5. **Revocation**: OCSP responses (issuer-signed or delegated OCSPSigning responder) and CRLs from
   the DSS and the Adobe revocation-archival attribute. No online fetching.
6. **Modifications** after the signed revision: object-level semantic diff (warraq_pdf::compare)
   classified by role (page content, page, page tree, annotation, widget/field, appearance, form,
   signature, DSS, metadata, unreferenced, other) and judged against DocMDP P (from the
   certification signature, if it precedes) and the FieldMDP locks in force; DSS and document
   timestamps are always allowed (ISO 32000-2 §12.8.2.2). Approval-only documents allow form fill,
   signatures and annotations; page content, page tree, layers (`/OCProperties`), actions and the
   catalog's page tree are never allowed.
7. **Attack evidence**: `shadow_replace` (content objects redefined), `shadow_hide_and_replace`
   (page switched to content present-but-unused in the signed revision; page tree or layer
   changes), `shadow_hide` (a later xref section re-points an object at signed bytes the signed
   revision did not use), `overlay` (annotations/widgets with appearances added or re-drawn after
   signing), `incremental_saving` (disallowed later updates), `trailing_data` (objects after the
   last `%%EOF`), plus the byte-range findings above.
Status: `invalid` (integrity or identity failure) › `modified` (disallowed changes) › `valid`
(trusted) › `valid_identity_unknown`.

## Consequences
* Signing and verification work the same in wasm, desktop and iOS; only the host touches the
  network, and only on the user's action (desktop, per SPEC).
* Cross-checked independently: `openssl cms -verify` for every produced signature kind, `openssl
  ts -verify` for document timestamps, and pyHanko (MIT, test-only) validates our B-B (RSA,
  P-256 visible Arabic, P-384 certified, two signatures, AES-256 encrypted) and B-LTA files as
  intact/valid/trusted and flags the attack fixtures.
* Not cross-checked with Adobe Acrobat (not available), no real TSA/OCSP over the network, no
  PKCS#11 hardware — see `docs/STATUS.md`.
* `rsa 0.9` carries RUSTSEC-2023-0071 (Marvin timing side channel on decryption/signing); we sign
  with blinding and never decrypt; the risk is limited to local timing observation.
