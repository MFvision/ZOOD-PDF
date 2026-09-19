# TEST-ONLY signing certificates

**Nothing in this folder protects anything.** Every private key here is
public, every password is `warraq-test`, and every certificate says TEST in
its name. They exist so the signature code can be tested against real
PKCS#12 files, real certificate chains and real revocation data without
committing anyone's secrets.

`make.sh` regenerates the whole set with the system `openssl` (LibreSSL 3.3
on macOS). Regenerating changes every key, so the tests' expectations that
name serials or dates may need the same update.

| File | What it is |
| --- | --- |
| `root-rsa.cer` / `.pem`, `root-ec.cer` / `.pem` | Two TEST roots: RSA 2048 and EC P-384 |
| `intermediate-rsa.cer`, `intermediate-ec.cer` | An intermediate CA under each (P-256 for the EC one) |
| `signer-rsa.cer`, `signer-ec.cer`, `signer-ec384.cer`, `revoked-rsa.cer` | Signers: RSA 2048 (with an Arabic common name), P-256, P-384, and one that is revoked |
| `signer-rsa-legacy.p12` | PKCS#12 as older tools write it: 3DES key, RC2-40 certificates, SHA-1 MAC |
| `signer-rsa-aes.p12`, `signer-ec.p12`, `revoked-rsa.p12` | PKCS#12 as current tools write it: PBES2/AES-256, SHA-256 MAC |
| `signer-ec384-legacy.p12` | A P-384 key in the legacy encoding |
| `tsa-rsa.p12`, `tsa-rsa.pem`, `tsa-rsa.key` | A TEST timestamp authority (extended key usage timeStamping), for the stand-in authority the tests run |
| `*.crl` | Each CA's revocation list (the intermediate RSA one lists `revoked-rsa`) |
| `*.ocsp` | OCSP answers signed by the issuing CA: `good` for the signers and the RSA intermediate, `revoked` for `revoked-rsa` |
| `real-tsa/` | `hello.txt`, the request made for it (`hello.tsq`), and three public authorities' answers (DigiCert, Sectigo, FreeTSA), fetched once on 2026-09-18, so a real token is checked without the network |

The certificates name OCSP and CRL addresses under `warraq.test`, a name that
never resolves: a test that fetches them fails loudly rather than reaching
anyone.
