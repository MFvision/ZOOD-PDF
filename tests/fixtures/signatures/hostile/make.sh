#!/bin/sh
# Regenerates the TEST-ONLY "hostile" certificates in this folder with the
# system `openssl` (LibreSSL 3.3 on macOS, OpenSSL on Linux): certificates a
# verifier must NOT accept as a trusted document signer, under a root of
# their own. Nothing here protects anything: every key is public, every
# password is "warraq-test". See README.md.
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
# A web-site issuing CA, as Mozilla's policy has them: its purpose is serverAuth.
[web_ca]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
extendedKeyUsage = serverAuth, clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
# A domain-validated web-server certificate (what anyone gets for free).
[web_server]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = DNS:attacker.warraq.test
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
# A document-signing CA: its purposes allow signing documents.
[docs_ca]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
extendedKeyUsage = emailProtection, 1.3.6.1.5.5.7.3.36
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[docs_signer]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, nonRepudiation
extendedKeyUsage = 1.3.6.1.5.5.7.3.36
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
# A document signer whose key may only encrypt.
[keyenc_signer]
basicConstraints = critical, CA:false
keyUsage = critical, keyEncipherment
extendedKeyUsage = emailProtection
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
# A CA below the pathlen:0 document CA, which may not issue CAs.
[nested_ca]
basicConstraints = critical, CA:true
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
# A leaf issued by the web-server certificate, which is not a CA.
[forged]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, nonRepudiation
extendedKeyUsage = emailProtection
subjectKeyIdentifier = hash
CNF

key_ec() { openssl ecparam -name prime256v1 -genkey -noout -out "work/$1.raw" && openssl pkcs8 -topk8 -nocrypt -in "work/$1.raw" -out "work/$1.key"; }
root() { openssl req -new -x509 -utf8 -config work/ext.cnf -extensions root -key "work/$1.key" -subj "$2" -days 9000 -set_serial "$3" -sha256 -out "work/$1.pem"; }
issue() { # name issuer section subject serial
  openssl req -new -utf8 -config work/ext.cnf -key "work/$1.key" -subj "$4" -out "work/$1.csr"
  openssl x509 -req -in "work/$1.csr" -CA "work/$2.pem" -CAkey "work/$2.key" -set_serial "$5" -days $DAYS -sha256 -extfile work/ext.cnf -extensions "$3" -out "work/$1.pem" 2>/dev/null
}
p12() { # name chain...
  name=$1; shift
  cat /dev/null > "work/$name-chain.pem"
  for c in "$@"; do cat "work/$c.pem" >> "work/$name-chain.pem"; done
  openssl pkcs12 -export -in "work/$name.pem" -inkey "work/$name.key" -certfile "work/$name-chain.pem" -name "$name" -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256 -passout pass:$P -out "$name.p12"
}

key_ec hostile-root;  root hostile-root "/O=Warraq TEST PKI/CN=Warraq TEST Hostile Root" 12288
key_ec web-ca;        issue web-ca hostile-root web_ca "/O=Warraq TEST PKI/CN=Warraq TEST Web Server CA" 12289
key_ec web-server;    issue web-server web-ca web_server "/CN=attacker.warraq.test" 12290
key_ec docs-ca;       issue docs-ca hostile-root docs_ca "/O=Warraq TEST PKI/CN=Warraq TEST Document Signing CA" 12291
key_ec docs-signer;   issue docs-signer docs-ca docs_signer "/O=Warraq TEST PKI/CN=Document TEST Signer" 12292
key_ec keyenc-signer; issue keyenc-signer docs-ca keyenc_signer "/O=Warraq TEST PKI/CN=Encryption-only TEST Key" 12293
key_ec nested-ca;     issue nested-ca docs-ca nested_ca "/O=Warraq TEST PKI/CN=Warraq TEST Nested CA" 12294
key_ec nested-signer; issue nested-signer nested-ca docs_signer "/O=Warraq TEST PKI/CN=Nested TEST Signer" 12295
# The web-server certificate's key "issues" a certificate in a ministry's name.
key_ec forged;        issue forged web-server forged "/C=SA/CN=وزارة المالية" 12296

p12 web-server web-ca
p12 docs-signer docs-ca
p12 keyenc-signer docs-ca
p12 nested-signer nested-ca docs-ca
p12 forged web-server web-ca

for c in hostile-root web-ca web-server docs-ca docs-signer; do
  openssl x509 -in "work/$c.pem" -outform DER -out "$c.cer"
done
rm -rf work
echo "hostile TEST certificates regenerated in $(pwd)"
