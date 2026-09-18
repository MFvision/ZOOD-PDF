//! CMS `SignedData` (RFC 5652) as PAdES writes it, and reading one back.
//!
//! Written by hand in DER, not through a builder, so what is signed is
//! exactly what is written: the signed attributes are one DER `SET`, sorted,
//! and the signature is over those bytes. A PAdES baseline signature
//! (ETSI EN 319 142-1) carries `content-type`, `message-digest` and
//! `signing-certificate-v2`, and deliberately no `signing-time`: the claimed
//! time goes in the signature dictionary's `/M`, a trusted one in a timestamp.
//!
//! Reading is by the raw bytes as well — the signed attributes of someone
//! else's signature are checked as they were written, never re-encoded.
use der::{Decode, Encode};

use crate::asn1::{children, read, wrap, Tlv};
use crate::chain::Cert;
use crate::keys::{Padding, SigAlg, Signer};
use crate::time::generalized_unix;
use crate::{cms_err, oids, HashAlg, Result, SignError};

fn oid_der(oid: &const_oid::ObjectIdentifier) -> Result<Vec<u8>> {
    oid.to_der().map_err(cms_err)
}

/// A DER `SET OF`: the elements sorted by their encodings.
pub(crate) fn der_set(tag: u8, mut elements: Vec<Vec<u8>>) -> Vec<u8> {
    elements.sort();
    wrap(tag, &elements.concat())
}

fn attribute(oid: &const_oid::ObjectIdentifier, value: &[u8]) -> Result<Vec<u8>> {
    Ok(wrap(0x30, &[oid_der(oid)?, wrap(0x31, value)].concat()))
}

/// `signing-certificate-v2` (RFC 5035): the signer certificate's digest and
/// its issuer and serial, so the certificate cannot be swapped for another
/// with the same key.
fn signing_certificate_v2(cert: &Cert, hash: HashAlg) -> Result<Vec<u8>> {
    let mut id = Vec::new();
    if hash != HashAlg::Sha256 {
        id.extend(hash.algorithm().to_der().map_err(cms_err)?);
    }
    id.extend(wrap(0x04, &hash.digest(&cert.der)));
    let serial = cert
        .parsed
        .tbs_certificate
        .serial_number
        .to_der()
        .map_err(cms_err)?;
    let general_names = wrap(0x30, &wrap(0xa4, &cert.issuer));
    id.extend(wrap(0x30, &[general_names, serial].concat()));
    Ok(wrap(0x30, &wrap(0x30, &wrap(0x30, &id))))
}

/// What goes into one `SignedData`.
pub struct Content<'a> {
    /// `id-data` for a PDF signature, `id-ct-TSTInfo` for a timestamp.
    pub econtent_type: const_oid::ObjectIdentifier,
    /// Encapsulated content; `None` for a detached signature.
    pub econtent: Option<&'a [u8]>,
    /// The digest of the content, with `hash`.
    pub digest: &'a [u8],
    pub hash: HashAlg,
    pub padding: Padding,
    /// Further signed attributes, each a whole DER `Attribute`.
    pub extra_signed: Vec<Vec<u8>>,
}

/// The signature algorithm a key signs with.
pub fn sig_alg_for(signer: &dyn Signer, hash: HashAlg, padding: Padding) -> SigAlg {
    match signer.key_kind() {
        crate::keys::KeyKind::Rsa { .. } => match padding {
            Padding::Pkcs1v15 => SigAlg::RsaPkcs1(hash),
            Padding::Pss => SigAlg::RsaPss {
                hash,
                salt: hash.len(),
            },
        },
        _ => SigAlg::Ecdsa(hash),
    }
}

/// A `ContentInfo` holding a `SignedData` over `content`, signed by `signer`.
pub fn sign(signer: &dyn Signer, content: &Content) -> Result<Vec<u8>> {
    let cert = Cert::parse(signer.certificate())?;
    let mut attrs = vec![
        attribute(&oids::ATTR_CONTENT_TYPE, &oid_der(&content.econtent_type)?)?,
        attribute(&oids::ATTR_MESSAGE_DIGEST, &wrap(0x04, content.digest))?,
        attribute(
            &oids::ATTR_SIGNING_CERTIFICATE_V2,
            &signing_certificate_v2(&cert, content.hash)?,
        )?,
    ];
    attrs.extend(content.extra_signed.iter().cloned());
    let signed_attrs = der_set(0x31, attrs);
    let attrs_digest = content.hash.digest(&signed_attrs);
    let signature = signer.sign_digest(&attrs_digest, content.hash, content.padding)?;
    let alg = sig_alg_for(signer, content.hash, content.padding);

    let digest_alg = content.hash.algorithm().to_der().map_err(cms_err)?;
    let serial = cert
        .parsed
        .tbs_certificate
        .serial_number
        .to_der()
        .map_err(cms_err)?;
    let signer_info = wrap(
        0x30,
        &[
            vec![0x02, 0x01, 0x01],
            wrap(0x30, &[cert.issuer.clone(), serial].concat()),
            digest_alg.clone(),
            // The same SET, under its implicit [0] tag.
            [&[0xa0][..], &signed_attrs[1..]].concat(),
            alg.algorithm()?.to_der().map_err(cms_err)?,
            wrap(0x04, &signature),
        ]
        .concat(),
    );
    let mut encap = oid_der(&content.econtent_type)?;
    if let Some(econtent) = content.econtent {
        encap.extend(wrap(0xa0, &wrap(0x04, econtent)));
    }
    let certs: Vec<Vec<u8>> = std::iter::once(signer.certificate().to_vec())
        .chain(signer.chain().iter().cloned())
        .collect();
    let version = if content.econtent_type == oids::DATA {
        1
    } else {
        3
    };
    let signed_data = wrap(
        0x30,
        &[
            vec![0x02, 0x01, version],
            wrap(0x31, &digest_alg),
            wrap(0x30, &encap),
            der_set(0xa0, certs),
            wrap(0x31, &signer_info),
        ]
        .concat(),
    );
    Ok(wrap(
        0x30,
        &[oid_der(&oids::SIGNED_DATA)?, wrap(0xa0, &signed_data)].concat(),
    ))
}

/// Who signed: by issuer and serial, or by key identifier.
#[derive(Debug, Clone, PartialEq)]
pub enum SignerId {
    IssuerSerial { issuer: Vec<u8>, serial: Vec<u8> },
    KeyId(Vec<u8>),
}

/// Adobe's archive of revocation data signed with the signature.
#[derive(Debug, Clone, Default)]
pub struct Archived {
    pub crls: Vec<Vec<u8>>,
    pub ocsps: Vec<Vec<u8>>,
}

/// A `SignedData`, read.
#[derive(Debug, Clone)]
pub struct Parsed {
    pub econtent_type: const_oid::ObjectIdentifier,
    pub econtent: Option<Vec<u8>>,
    /// Every certificate it carries, DER.
    pub certs: Vec<Vec<u8>>,
    /// Revocation lists it carries (`crls` field), DER.
    pub crls: Vec<Vec<u8>>,
    pub sid: SignerId,
    pub digest: HashAlg,
    pub sig_alg: SigAlg,
    /// The signed attributes as signed: their raw encoding, tagged as a SET.
    pub signed_attrs: Option<Vec<u8>>,
    pub content_type: Option<const_oid::ObjectIdentifier>,
    pub message_digest: Option<Vec<u8>>,
    pub signing_time: Option<i64>,
    /// The digest a `signing-certificate(-v2)` attribute gives the signer's
    /// certificate.
    pub cert_binding: Option<(HashAlg, Vec<u8>)>,
    pub signature: Vec<u8>,
    /// RFC 3161 tokens in the unsigned attributes (signature timestamps).
    pub timestamps: Vec<Vec<u8>>,
    pub archived: Archived,
}

fn tag_is(tlv: &Tlv, tag: u8, what: &str) -> Result<()> {
    if tlv.tag == tag {
        Ok(())
    } else {
        Err(SignError::Cms(format!(
            "{what}: unexpected tag {:#x}",
            tlv.tag
        )))
    }
}

fn oid_at(tlv: Option<&Tlv>) -> Result<const_oid::ObjectIdentifier> {
    let tlv = tlv.ok_or_else(|| SignError::Cms("missing object identifier".into()))?;
    const_oid::ObjectIdentifier::from_der(tlv.raw).map_err(cms_err)
}

fn algorithm(tlv: &Tlv) -> Result<(const_oid::ObjectIdentifier, Option<Vec<u8>>)> {
    tag_is(tlv, 0x30, "algorithm")?;
    let parts = children(tlv.value)?;
    Ok((oid_at(parts.first())?, parts.get(1).map(|p| p.raw.to_vec())))
}

fn time_value(tlv: &Tlv) -> Option<i64> {
    match tlv.tag {
        0x17 => der::asn1::UtcTime::from_der(tlv.raw)
            .ok()
            .map(|t| t.to_unix_duration().as_secs() as i64),
        0x18 => der::asn1::GeneralizedTime::from_der(tlv.raw)
            .ok()
            .map(|t| generalized_unix(&t)),
        _ => None,
    }
}

/// Reads a `ContentInfo` holding a `SignedData` with one signer (the first
/// is taken if there are more). `der` may be followed by padding.
pub fn parse(der: &[u8]) -> Result<Parsed> {
    let (info, _) = read(der)?;
    tag_is(&info, 0x30, "ContentInfo")?;
    let parts = children(info.value)?;
    if oid_at(parts.first())? != oids::SIGNED_DATA {
        return Err(SignError::Cms("not a SignedData".into()));
    }
    let wrapper = parts
        .get(1)
        .ok_or_else(|| SignError::Cms("no content".into()))?;
    tag_is(wrapper, 0xa0, "content")?;
    let (sd, _) = read(wrapper.value)?;
    tag_is(&sd, 0x30, "SignedData")?;
    let fields = children(sd.value)?;
    if fields.len() < 4 {
        return Err(SignError::Cms("SignedData is incomplete".into()));
    }
    let encap = children(fields[2].value)?;
    let econtent_type = oid_at(encap.first())?;
    let econtent = match encap.get(1) {
        Some(e) if e.tag == 0xa0 => {
            let (octets, _) = read(e.value)?;
            tag_is(&octets, 0x04, "encapsulated content")?;
            Some(octets.value.to_vec())
        }
        _ => None,
    };
    let mut certs = Vec::new();
    let mut crls = Vec::new();
    for field in &fields[3..fields.len() - 1] {
        match field.tag {
            0xa0 => certs.extend(
                children(field.value)?
                    .into_iter()
                    .filter(|c| c.tag == 0x30)
                    .map(|c| c.raw.to_vec()),
            ),
            0xa1 => crls.extend(
                children(field.value)?
                    .into_iter()
                    .filter(|c| c.tag == 0x30)
                    .map(|c| c.raw.to_vec()),
            ),
            _ => {}
        }
    }
    let infos = fields.last().expect("checked above");
    tag_is(infos, 0x31, "signerInfos")?;
    let info = children(infos.value)?
        .into_iter()
        .next()
        .ok_or_else(|| SignError::Cms("no signer".into()))?;
    let f = children(info.value)?;
    if f.len() < 5 {
        return Err(SignError::Cms("SignerInfo is incomplete".into()));
    }
    let sid = match f[1].tag {
        0x30 => {
            let p = children(f[1].value)?;
            let (name, serial) = (
                p.first().ok_or_else(|| SignError::Cms("sid".into()))?,
                p.get(1).ok_or_else(|| SignError::Cms("sid".into()))?,
            );
            SignerId::IssuerSerial {
                issuer: name.raw.to_vec(),
                serial: serial.value.to_vec(),
            }
        }
        0x80 => SignerId::KeyId(f[1].value.to_vec()),
        t => return Err(SignError::Cms(format!("sid tag {t:#x}"))),
    };
    let (digest_oid, _) = algorithm(&f[2])?;
    let digest = HashAlg::from_oid(&digest_oid)
        .ok_or_else(|| SignError::Cms(format!("digest {digest_oid} is not supported")))?;
    let mut i = 3;
    let mut signed_attrs = None;
    let mut parsed = Parsed {
        econtent_type,
        econtent,
        certs,
        crls,
        sid,
        digest,
        sig_alg: SigAlg::RsaPkcs1(digest),
        signed_attrs: None,
        content_type: None,
        message_digest: None,
        signing_time: None,
        cert_binding: None,
        signature: Vec::new(),
        timestamps: Vec::new(),
        archived: Archived::default(),
    };
    if f[i].tag == 0xa0 {
        signed_attrs = Some([&[0x31][..], &f[i].raw[1..]].concat());
        for attr in children(f[i].value)? {
            read_signed_attribute(&attr, &mut parsed)?;
        }
        i += 1;
    }
    let (alg_oid, alg_params) = algorithm(
        f.get(i)
            .ok_or_else(|| SignError::Cms("no algorithm".into()))?,
    )?;
    parsed.sig_alg = SigAlg::from_identifier(&alg_oid, alg_params.as_deref(), Some(digest))?;
    let sig = f
        .get(i + 1)
        .ok_or_else(|| SignError::Cms("no signature".into()))?;
    tag_is(sig, 0x04, "signature")?;
    parsed.signature = sig.value.to_vec();
    if let Some(unsigned) = f.get(i + 2).filter(|u| u.tag == 0xa1) {
        for attr in children(unsigned.value)? {
            let p = children(attr.value)?;
            if oid_at(p.first())? == oids::ATTR_TIMESTAMP_TOKEN {
                if let Some(values) = p.get(1) {
                    parsed
                        .timestamps
                        .extend(children(values.value)?.into_iter().map(|v| v.raw.to_vec()));
                }
            }
        }
    }
    parsed.signed_attrs = signed_attrs;
    Ok(parsed)
}

fn read_signed_attribute(attr: &Tlv, parsed: &mut Parsed) -> Result<()> {
    let p = children(attr.value)?;
    let oid = oid_at(p.first())?;
    let Some(value) = p
        .get(1)
        .map(|v| children(v.value))
        .transpose()?
        .and_then(|v| v.into_iter().next())
    else {
        return Ok(());
    };
    match oid {
        o if o == oids::ATTR_CONTENT_TYPE => parsed.content_type = Some(oid_at(Some(&value))?),
        o if o == oids::ATTR_MESSAGE_DIGEST => {
            tag_is(&value, 0x04, "message-digest")?;
            parsed.message_digest = Some(value.value.to_vec());
        }
        o if o == oids::ATTR_SIGNING_TIME => parsed.signing_time = time_value(&value),
        o if o == oids::ATTR_SIGNING_CERTIFICATE_V2 || o == oids::ATTR_SIGNING_CERTIFICATE => {
            // SigningCertificate(V2) ::= SEQUENCE { certs SEQUENCE OF ESSCertID(v2), .. }
            let first = children(value.value)?
                .into_iter()
                .next()
                .map(|certs| children(certs.value))
                .transpose()?
                .and_then(|ids| ids.into_iter().next());
            if let Some(id) = first {
                let parts = children(id.value)?;
                let (hash, octets) = match (o == oids::ATTR_SIGNING_CERTIFICATE, parts.first()) {
                    (true, Some(h)) => (HashAlg::Sha1, h),
                    (false, Some(alg)) if alg.tag == 0x30 => {
                        let (oid, _) = algorithm(alg)?;
                        let hash = HashAlg::from_oid(&oid)
                            .ok_or_else(|| SignError::Cms(format!("ESS hash {oid}")))?;
                        (
                            hash,
                            parts
                                .get(1)
                                .ok_or_else(|| SignError::Cms("ESS hash".into()))?,
                        )
                    }
                    (false, Some(h)) => (HashAlg::Sha256, h),
                    _ => return Ok(()),
                };
                tag_is(octets, 0x04, "ESS certificate hash")?;
                parsed.cert_binding = Some((hash, octets.value.to_vec()));
            }
        }
        o if o == oids::ATTR_ADBE_REVOCATION => {
            // RevocationInfoArchival ::= SEQUENCE { crl [0] EXPLICIT SEQUENCE OF
            // CRL OPTIONAL, ocsp [1] EXPLICIT SEQUENCE OF OCSPResponse OPTIONAL, .. }
            for part in children(value.value)? {
                let Some(list) = children(part.value)?.into_iter().next() else {
                    continue;
                };
                let items: Vec<Vec<u8>> = children(list.value)?
                    .into_iter()
                    .map(|t| t.raw.to_vec())
                    .collect();
                match part.tag {
                    0xa0 => parsed.archived.crls.extend(items),
                    0xa1 => parsed.archived.ocsps.extend(items),
                    _ => {}
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// The signer's certificate, among `certs`.
pub fn find_signer<'a>(parsed: &Parsed, certs: &'a [Cert]) -> Option<&'a Cert> {
    certs.iter().find(|c| match &parsed.sid {
        SignerId::IssuerSerial { issuer, serial } => {
            c.issuer == *issuer
                && c.parsed.tbs_certificate.serial_number.as_bytes() == serial.as_slice()
        }
        SignerId::KeyId(id) => c
            .parsed
            .tbs_certificate
            .subject_public_key_info
            .subject_public_key
            .as_bytes()
            .map(|k| HashAlg::Sha1.digest(k) == *id)
            .unwrap_or(false),
    })
}

/// What checking a signer found.
#[derive(Debug, Clone, Default)]
pub struct Check {
    /// The `message-digest` attribute matches the content.
    pub digest_ok: bool,
    /// The signature verifies with the signer certificate's key.
    pub signature_ok: bool,
    /// The `signing-certificate(-v2)` attribute names this certificate
    /// (`None`: there is no such attribute).
    pub cert_binding_ok: Option<bool>,
    /// The `content-type` attribute matches the encapsulated content type.
    pub content_type_ok: bool,
    pub problem: Option<String>,
}

/// Checks the signer over `content_digest` (the digest of the content, with
/// the signer's digest algorithm).
pub fn check(parsed: &Parsed, signer: &Cert, content_digest: &[u8]) -> Check {
    let mut out = Check {
        content_type_ok: parsed
            .content_type
            .is_none_or(|t| t == parsed.econtent_type),
        ..Check::default()
    };
    out.cert_binding_ok = parsed
        .cert_binding
        .as_ref()
        .map(|(hash, value)| hash.digest(&signer.der) == *value);
    let verified = match &parsed.signed_attrs {
        Some(attrs) => {
            out.digest_ok = parsed.message_digest.as_deref() == Some(content_digest);
            crate::keys::verify_message(&signer.spki, parsed.sig_alg, attrs, &parsed.signature)
        }
        None => {
            // No signed attributes: the signature is over the content digest.
            let r = crate::keys::verify_digest(
                &signer.spki,
                parsed.sig_alg,
                content_digest,
                &parsed.signature,
            );
            out.digest_ok = r.is_ok();
            r
        }
    };
    match verified {
        Ok(()) => out.signature_ok = true,
        Err(e) => out.problem = Some(e.to_string()),
    }
    out
}

/// The certificates a `SignedData` carries, parsed (unparsable ones skipped).
pub fn certificates(parsed: &Parsed) -> Vec<Cert> {
    parsed
        .certs
        .iter()
        .filter_map(|d| Cert::parse(d).ok())
        .collect()
}

/// `cms` with `token` added to its signer as a signature timestamp
/// (`id-aa-signatureTimeStampToken`, an unsigned attribute). Only for a CMS
/// written by [`sign`]: it is re-assembled from its parts.
pub fn add_timestamp(cms: &[u8], token: &[u8]) -> Result<Vec<u8>> {
    let (info, _) = read(cms)?;
    let parts = children(info.value)?;
    let (sd, _) = read(
        parts
            .get(1)
            .ok_or_else(|| SignError::Cms("no content".into()))?
            .value,
    )?;
    let mut fields: Vec<Vec<u8>> = children(sd.value)?.iter().map(|t| t.raw.to_vec()).collect();
    let infos = fields
        .pop()
        .ok_or_else(|| SignError::Cms("no signers".into()))?;
    let (infos, _) = read(&infos)?;
    let info = children(infos.value)?
        .into_iter()
        .next()
        .ok_or_else(|| SignError::Cms("no signer".into()))?;
    let mut f: Vec<Vec<u8>> = children(info.value)?
        .iter()
        .filter(|t| t.tag != 0xa1)
        .map(|t| t.raw.to_vec())
        .collect();
    let attr = attribute(&oids::ATTR_TIMESTAMP_TOKEN, token)?;
    f.push(wrap(0xa1, &attr));
    fields.push(wrap(0x31, &wrap(0x30, &f.concat())));
    Ok(wrap(
        0x30,
        &[
            parts[0].raw.to_vec(),
            wrap(0xa0, &wrap(0x30, &fields.concat())),
        ]
        .concat(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Signer;
    use crate::pkcs12;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/fixtures/signatures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn a_detached_signature_reads_back_and_verifies_for_every_key_type() {
        let content = b"%PDF-1.7 signed bytes";
        for (file, padding) in [
            ("signer-rsa-aes.p12", Padding::Pkcs1v15),
            ("signer-rsa-legacy.p12", Padding::Pss),
            ("signer-ec.p12", Padding::Pkcs1v15),
            ("signer-ec384-legacy.p12", Padding::Pkcs1v15),
        ] {
            let id = pkcs12::open(&fixture(file), "warraq-test").unwrap();
            let hash = id.signer.key_kind().hash();
            let digest = hash.digest(content);
            let der = sign(
                &id.signer,
                &Content {
                    econtent_type: oids::DATA,
                    econtent: None,
                    digest: &digest,
                    hash,
                    padding,
                    extra_signed: vec![],
                },
            )
            .unwrap();
            let parsed = parse(&der).unwrap();
            assert_eq!(parsed.certs.len(), 3, "{file}");
            assert!(
                parsed.signing_time.is_none(),
                "PAdES: no signing-time attribute"
            );
            let certs = certificates(&parsed);
            let signer = find_signer(&parsed, &certs).expect("signer certificate");
            assert_eq!(signer.der, id.signer.certificate());
            let c = check(&parsed, signer, &digest);
            assert!(c.digest_ok && c.signature_ok, "{file}: {c:?}");
            assert_eq!(c.cert_binding_ok, Some(true), "{file}");
            // One byte of the content changed: the digest no longer matches.
            let other = hash.digest(b"%PDF-1.7 signed byteZ");
            assert!(!check(&parsed, signer, &other).digest_ok, "{file}");

            let stamped = add_timestamp(&der, &wrap(0x30, &[0x05, 0x00])).unwrap();
            let again = parse(&stamped).unwrap();
            assert_eq!(again.timestamps.len(), 1);
            assert!(
                check(&again, signer, &digest).signature_ok,
                "{file}: still verifies"
            );
        }
    }
}
