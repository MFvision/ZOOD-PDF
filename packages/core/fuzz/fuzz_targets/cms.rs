//! Fuzz every DER/BER/CMS parser of warraq-sign: CMS SignedData (+ signer verification with
//! a fixed digest), RFC 3161 responses and tokens, OCSP responses, CRLs, certificates, the
//! BER→DER normaliser and the PKCS#12 loader.
#![no_main]

use libfuzzer_sys::fuzz_target;
use warraq_sign::cms::{verify_signer, ParsedCms};
use warraq_sign::{ocsp, pkcs12, tlv, tsp, x509};

fuzz_target!(|data: &[u8]| {
    let _ = tlv::ber_to_der(data);
    let _ = tlv::element_len(data);
    if let Ok(cms) = ParsedCms::parse(data) {
        let _ = verify_signer(&cms, &|h| h.digest(b"fuzz"));
        let _ = cms.signer_cert();
        let _ = cms.unsigned_attr(warraq_sign::oids::SIGNATURE_TIMESTAMP_TOKEN);
    }
    let _ = tsp::token_from_response(data);
    let _ = tsp::verify_token(data, &|h| h.digest(b"fuzz"), &[], &[]);
    let _ = ocsp::parse_response(data);
    let _ = ocsp::parse_crl(data);
    let _ = x509::Cert::from_pem_or_der(data);
    // PKCS#12 with a tiny iteration budget would still honour the file's count: only try
    // small files so one input cannot pin the fuzzer on key derivation.
    if data.len() < 4096 {
        let _ = pkcs12::load(data, "test123");
    }
});
