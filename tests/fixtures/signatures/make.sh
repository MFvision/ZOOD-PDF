#!/bin/sh
# Regenerates the TEST-ONLY PKI in this folder with the system `openssl`
# (LibreSSL 3.3 on macOS, OpenSSL on Linux). Nothing here protects anything:
# every key is public, every password is "warraq-test". See README.md.
set -eu
cd "$(dirname "$0")"
rm -rf work && mkdir work
P=warraq-test
DAYS=7300

cat > work/ext.cnf <<'CNF'
[req]
distinguished_name = dn
string_mask = utf8only
[dn]
[root]
basicConstraints = critical, CA:true
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[intermediate]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
crlDistributionPoints = URI:http://crl.warraq.test/root.crl
authorityInfoAccess = OCSP;URI:http://ocsp.warraq.test/root
[signer_rsa]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, nonRepudiation
extendedKeyUsage = emailProtection
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
crlDistributionPoints = URI:http://crl.warraq.test/intermediate-rsa.crl
authorityInfoAccess = OCSP;URI:http://ocsp.warraq.test/intermediate-rsa, caIssuers;URI:http://ca.warraq.test/intermediate-rsa.cer
[signer_ec]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, nonRepudiation
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
crlDistributionPoints = URI:http://crl.warraq.test/intermediate-ec.crl
authorityInfoAccess = OCSP;URI:http://ocsp.warraq.test/intermediate-ec
[tsa]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, timeStamping
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF

key_rsa() { openssl genrsa -out "work/$1.key" 2048 2>/dev/null; }
key_ec() { openssl ecparam -name "$2" -genkey -noout -out "work/$1.raw" && openssl pkcs8 -topk8 -nocrypt -in "work/$1.raw" -out "work/$1.key"; }
root() { openssl req -new -x509 -utf8 -config work/ext.cnf -extensions root -key "work/$1.key" -subj "$2" -days 9000 -set_serial "$3" -sha256 -out "work/$1.pem"; }
issue() { # name issuer section subject serial
  openssl req -new -utf8 -config work/ext.cnf -key "work/$1.key" -subj "$4" -out "work/$1.csr"
  openssl x509 -req -in "work/$1.csr" -CA "work/$2.pem" -CAkey "work/$2.key" -set_serial "$5" -days $DAYS -sha256 -extfile work/ext.cnf -extensions "$3" -out "work/$1.pem" 2>/dev/null
}

key_rsa root-rsa;         root root-rsa "/O=Warraq TEST PKI/CN=Warraq TEST Root CA RSA" 4096
key_rsa intermediate-rsa; issue intermediate-rsa root-rsa intermediate "/O=Warraq TEST PKI/CN=Warraq TEST Intermediate CA RSA" 4097
key_rsa signer-rsa;       issue signer-rsa intermediate-rsa signer_rsa "/C=SA/O=Warraq TEST PKI/CN=محمد التجريبي (TEST)" 4098
key_rsa revoked-rsa;      issue revoked-rsa intermediate-rsa signer_rsa "/O=Warraq TEST PKI/CN=Revoked TEST Signer" 4099
key_rsa tsa-rsa;          issue tsa-rsa root-rsa tsa "/O=Warraq TEST PKI/CN=Warraq TEST Timestamp Authority" 4100
key_ec root-ec secp384r1;          root root-ec "/O=Warraq TEST PKI/CN=Warraq TEST Root CA EC" 8192
key_ec intermediate-ec prime256v1; issue intermediate-ec root-ec intermediate "/O=Warraq TEST PKI/CN=Warraq TEST Intermediate CA EC" 8193
key_ec signer-ec prime256v1;       issue signer-ec intermediate-ec signer_ec "/O=Warraq TEST PKI/CN=EC P-256 TEST Signer" 8194
key_ec signer-ec384 secp384r1;     issue signer-ec384 intermediate-ec signer_ec "/O=Warraq TEST PKI/CN=EC P-384 TEST Signer" 8195

# PKCS#12: the legacy defaults (3DES keys, RC2-40 certificates, SHA-1 MAC)
# and the modern ones (PBES2 with AES-256, SHA-256 MAC).
chain() { cat "work/$1.pem" "work/$2.pem" > "work/$1-chain.pem"; }
chain intermediate-rsa root-rsa; chain intermediate-ec root-ec
openssl pkcs12 -export -in work/signer-rsa.pem -inkey work/signer-rsa.key -certfile work/intermediate-rsa-chain.pem -name "signer-rsa" -passout pass:$P -out signer-rsa-legacy.p12
openssl pkcs12 -export -in work/signer-rsa.pem -inkey work/signer-rsa.key -certfile work/intermediate-rsa-chain.pem -name "signer-rsa" -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 -passout pass:$P -out signer-rsa-aes.p12
openssl pkcs12 -export -in work/signer-ec.pem -inkey work/signer-ec.key -certfile work/intermediate-ec-chain.pem -name "signer-ec" -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 -passout pass:$P -out signer-ec.p12
openssl pkcs12 -export -in work/signer-ec384.pem -inkey work/signer-ec384.key -certfile work/intermediate-ec-chain.pem -name "signer-ec384" -passout pass:$P -out signer-ec384-legacy.p12
openssl pkcs12 -export -in work/revoked-rsa.pem -inkey work/revoked-rsa.key -certfile work/intermediate-rsa-chain.pem -name "revoked" -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 -passout pass:$P -out revoked-rsa.p12
openssl pkcs12 -export -in work/tsa-rsa.pem -inkey work/tsa-rsa.key -certfile work/root-rsa.pem -name "tsa" -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 -passout pass:$P -out tsa-rsa.p12

# Revocation data: empty CRLs, and OCSP answers ("good" for the signers,
# "revoked" for revoked-rsa), each signed by the issuing CA itself.
mkdir -p work/ca
for ca in intermediate-rsa intermediate-ec root-rsa root-ec; do
  : > "work/ca/$ca.idx"
  cat > "work/ca/$ca.cnf" <<CNF
[ca]
default_ca = d
[d]
database = work/ca/$ca.idx
crlnumber = work/ca/$ca.crlnum
default_md = sha256
default_crl_days = $DAYS
CNF
  echo 01 > "work/ca/$ca.crlnum"
done
# The CA databases, written directly (LibreSSL's `ca` has no -valid): one
# line per certificate issued, by serial; the dates only need to be sane.
TAB=$(printf '\t')
known() { # ca leaf [revoked]
  serial=$(openssl x509 -in "work/$2.pem" -noout -serial | sed 's/.*=//')
  if [ "${3:-}" = revoked ]; then
    echo "R${TAB}491231235959Z${TAB}260101000000Z,keyCompromise${TAB}$serial${TAB}unknown${TAB}/CN=$2" >> "work/ca/$1.idx"
  else
    echo "V${TAB}491231235959Z${TAB}${TAB}$serial${TAB}unknown${TAB}/CN=$2" >> "work/ca/$1.idx"
  fi
}
known intermediate-rsa signer-rsa
known intermediate-rsa revoked-rsa revoked
known intermediate-ec signer-ec
known intermediate-ec signer-ec384
known root-rsa intermediate-rsa
known root-rsa tsa-rsa
known root-ec intermediate-ec
for ca in intermediate-rsa intermediate-ec root-rsa root-ec; do
  openssl ca -config "work/ca/$ca.cnf" -cert "work/$ca.pem" -keyfile "work/$ca.key" -gencrl -out "work/$ca.crl.pem" 2>/dev/null
  openssl crl -in "work/$ca.crl.pem" -outform DER -out "$ca.crl"
done
ocsp() { # leaf issuer out
  openssl ocsp -issuer "work/$2.pem" -cert "work/$1.pem" -no_nonce -reqout "work/$1.ocspreq" >/dev/null
  openssl ocsp -index "work/ca/$2.idx" -rsigner "work/$2.pem" -rkey "work/$2.key" -CA "work/$2.pem" -reqin "work/$1.ocspreq" -ndays $DAYS -respout "$3" >/dev/null 2>&1
}
ocsp signer-rsa intermediate-rsa signer-rsa.ocsp
ocsp revoked-rsa intermediate-rsa revoked-rsa.ocsp
ocsp signer-ec intermediate-ec signer-ec.ocsp
ocsp intermediate-rsa root-rsa intermediate-rsa.ocsp

# The certificates, DER, for the trust list and the tests; the TSA's key in
# PEM, for the stand-in timestamp authority the tests run with `openssl ts`.
for c in root-rsa intermediate-rsa signer-rsa revoked-rsa tsa-rsa root-ec intermediate-ec signer-ec signer-ec384; do
  openssl x509 -in "work/$c.pem" -outform DER -out "$c.cer"
done
cp work/tsa-rsa.pem tsa-rsa.pem; cp work/tsa-rsa.key tsa-rsa.key; cp work/root-rsa.pem root-rsa.pem
rm -rf work
echo "TEST PKI regenerated in $(pwd)"
