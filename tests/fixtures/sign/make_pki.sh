#!/usr/bin/env bash
# Regenerates the TEST-ONLY PKI used by warraq-sign's tests (never shipped, never trusted by
# the app). Requires the OpenSSL 3 CLI (with the legacy provider for RC2/3DES PKCS#12 files).
#
#   root CA (RSA-2048) ─┬─ intermediate CA (RSA-2048) ─┬─ signer-rsa    (RSA-2048,  documentSigning)
#                       │                              ├─ signer-p256   (P-256,     documentSigning, Arabic CN)
#                       │                              ├─ signer-p384   (P-384,     Adobe authentic documents + emailProtection)
#                       │                              ├─ signer-server (P-256,     serverAuth only → must be rejected)
#                       │                              ├─ signer-expired(P-256,     documentSigning, expired 2021)
#                       │                              └─ ocsp          (P-256,     OCSPSigning)
#                       └─ tsa (P-256, timeStamping, critical EKU)
#
# PKCS#12 encodings: modern (PBES2 AES-256-CBC + PBKDF2-HMAC-SHA256, SHA-256 MAC), legacy
# (-legacy: RC2-40 certs + 3DES key, SHA-1 MAC), 3DES everywhere, RC2-40 everywhere.
set -euo pipefail
cd "$(dirname "$0")"
OUT=pki
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$OUT"
PW=test123

mkca() { # dir
  mkdir -p "$1"/newcerts && : > "$1"/index.txt && echo 1000 > "$1"/serial && echo 1000 > "$1"/crlnumber
}

cat > ca.cnf <<'EOF'
[ ca ]
default_ca = CA_default
[ CA_default ]
dir = .
database = $dir/index.txt
new_certs_dir = $dir/newcerts
serial = $dir/serial
crlnumber = $dir/crlnumber
default_md = sha256
policy = policy_any
unique_subject = no
copy_extensions = none
default_crl_days = 36500
[ policy_any ]
commonName = supplied
organizationName = optional
countryName = optional
emailAddress = optional
[ v3_ca ]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[ v3_int ]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[ v3_docsign ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,nonRepudiation
extendedKeyUsage = 1.3.6.1.5.5.7.3.36
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
authorityInfoAccess = OCSP;URI:http://ocsp.test.invalid/,caIssuers;URI:http://ca.test.invalid/int.cer
crlDistributionPoints = URI:http://crl.test.invalid/int.crl
[ v3_adobe ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,nonRepudiation
extendedKeyUsage = 1.2.840.113583.1.1.5,emailProtection
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[ v3_server ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[ v3_tsa ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,timeStamping
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[ v3_ocsp ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,OCSPSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF

mkca root && mkca int
cp ca.cnf root/ && cp ca.cnf int/

# Root (self-signed, 40 years from 2020).
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out root/key.pem 2>/dev/null
openssl req -new -key root/key.pem -subj "/C=SA/O=ZOOD PDF Test/CN=ZOOD Test Root CA" -out root/req.pem
(cd root && openssl ca -batch -config ca.cnf -selfsign -keyfile key.pem -in req.pem -out cert.pem \
  -extensions v3_ca -startdate 20200101000000Z -enddate 20600101000000Z -notext 2>/dev/null)

# Intermediate.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out int/key.pem 2>/dev/null
openssl req -new -key int/key.pem -subj "/C=SA/O=ZOOD PDF Test/CN=ZOOD Test Document CA" -out int/req.pem
(cd root && openssl ca -batch -config ca.cnf -cert cert.pem -keyfile key.pem -in ../int/req.pem \
  -out ../int/cert.pem -extensions v3_int -startdate 20200101000000Z -enddate 20550101000000Z -notext 2>/dev/null)

leaf() { # name keyalg subj ext start end [utf8]
  local name=$1 alg=$2 subj=$3 ext=$4 start=$5 end=$6 issuer=${7:-int}
  case $alg in
    rsa) openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out $name.key 2>/dev/null ;;
    p256) openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out $name.key ;;
    p384) openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-384 -out $name.key ;;
  esac
  openssl req -new -utf8 -key $name.key -subj "$subj" -out $name.req
  (cd $issuer && openssl ca -batch -utf8 -config ca.cnf -cert cert.pem -keyfile key.pem -in ../$name.req \
    -out ../$name.pem -extensions $ext -startdate $start -enddate $end -notext 2>/dev/null)
  rm -f $name.req
}

leaf signer-rsa rsa "/C=SA/O=ZOOD PDF Test/CN=Test Signer RSA/emailAddress=rsa@test.invalid" v3_docsign 20250101000000Z 20450101000000Z
leaf signer-p256 p256 "/C=SA/O=ZOOD PDF Test/CN=أحمد بن سعيد" v3_docsign 20250101000000Z 20450101000000Z
leaf signer-p384 p384 "/C=SA/O=ZOOD PDF Test/CN=Test Signer P-384" v3_adobe 20250101000000Z 20450101000000Z
leaf signer-server p256 "/C=SA/O=ZOOD PDF Test/CN=www.test.invalid" v3_server 20250101000000Z 20450101000000Z
leaf signer-expired p256 "/C=SA/O=ZOOD PDF Test/CN=Expired Signer" v3_docsign 20200101000000Z 20210101000000Z
leaf ocsp p256 "/C=SA/O=ZOOD PDF Test/CN=ZOOD Test OCSP Responder" v3_ocsp 20250101000000Z 20450101000000Z
leaf tsa p256 "/C=SA/O=ZOOD PDF Test/CN=ZOOD Test TSA" v3_tsa 20250101000000Z 20450101000000Z root

# CRL of the intermediate (nothing revoked) in DER.
(cd int && openssl ca -config ca.cnf -gencrl -cert cert.pem -keyfile key.pem -out ../int-crl.pem 2>/dev/null)
openssl crl -in int-crl.pem -outform DER -out int.crl && rm int-crl.pem

cat int/cert.pem root/cert.pem > chain.pem
cp root/cert.pem root.pem && cp int/cert.pem int.pem
openssl x509 -in root.pem -outform DER -out root.der
openssl x509 -in int.pem -outform DER -out int.der

p12() { # name out extra...
  local name=$1 out=$2; shift 2
  openssl pkcs12 -export -inkey $name.key -in $name.pem -certfile chain.pem -name "$name" \
    -passout pass:$PW -out $out "$@"
}
p12 signer-rsa signer-rsa-modern.p12
p12 signer-rsa signer-rsa-legacy.p12 -legacy
p12 signer-rsa signer-rsa-3des.p12 -legacy -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES
p12 signer-rsa signer-rsa-rc2.p12 -legacy -keypbe PBE-SHA1-RC2-40 -certpbe PBE-SHA1-RC2-40
p12 signer-p256 signer-p256-modern.p12
p12 signer-p256 signer-p256-legacy.p12 -legacy
p12 signer-p384 signer-p384-modern.p12
p12 signer-server signer-server.p12
p12 signer-expired signer-expired.p12
# Arabic password (UTF-8 → BMPString inside PKCS#12).
openssl pkcs12 -export -inkey signer-p256.key -in signer-p256.pem -certfile chain.pem \
  -passout "pass:كلمة سر" -out signer-p256-arabic-pw.p12

# The TSA and OCSP responder keys stay as PEM so tests can answer requests with `openssl ts`/`ocsp`.
cat > tsa.cnf <<'EOF'
[ tsa ]
default_tsa = tsa_config
[ tsa_config ]
serial = ./tsaserial
signer_digest = sha256
default_policy = 1.3.6.1.4.1.99999.1
digests = sha256, sha384, sha512
accuracy = secs:1
ordering = no
tsa_name = no
ess_cert_id_chain = no
ess_cert_id_alg = sha256
EOF
echo 01 > tsaserial

rm -rf root/newcerts int/newcerts root/req.pem int/req.pem root/*.old int/*.old root/ca.cnf int/ca.cnf
# Keep only what tests use.
rm -f signer-*.key
echo "ok: $(ls | wc -l) files"
