//! `standards.*`: the Standards tool (warraq-standards).
//!
//! * `standards.validate {profile}` → report (findings with rule, ISO clause, object, i18n key).
//! * `standards.convert {profile, now?, tzOffsetMinutes?}` + blobs = bundled fonts the converter may
//!   embed (TrueType) → `blobs[0]` = the NEW file (a whole rewrite); the open document is unchanged.
//! * `standards.preflight` → summary (fonts, images with effective DPI, colour, transparency, …).
//! * `standards.rules {profile?}` → the rule catalogue (independent of the document).

use super::params;
use crate::registry::Registry;
use crate::{CoreError, Document, Reply};
use serde::Deserialize;
use serde_json::Value;
use warraq_standards::convert::{convert, ConvertOptions};
use warraq_standards::xmp::Date;
use warraq_standards::{json, preflight, validate, Profile};

pub fn register(r: &mut Registry) {
    r.doc("standards.validate", validate_m)
        .doc("standards.convert", convert_m)
        .doc("standards.preflight", preflight_m)
        .doc("standards.rules", rules_m);
}

fn profile(s: &str) -> Result<Profile, CoreError> {
    Profile::parse(s).ok_or_else(|| {
        CoreError::params(format!(
            "unknown profile {s:?} (pdfa-1b, pdfa-2b, pdfa-2u, pdfa-3b, pdfx-4)"
        ))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Validate {
    profile: String,
}

fn validate_m(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Validate = params(p)?;
    let prof = profile(&p.profile)?;
    Ok(Reply::json(json::report(&validate(doc.pdf(), prof))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Convert {
    profile: String,
    /// Unix milliseconds (the UI's clock; wasm has none) for ModDate/MetadataDate.
    now: Option<f64>,
    /// Minutes east of UTC.
    #[serde(default)]
    tz_offset_minutes: i32,
}

fn convert_m(doc: &mut Document, p: &Value, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Convert = params(p)?;
    let prof = profile(&p.profile)?;
    if !(-14 * 60..=14 * 60).contains(&p.tz_offset_minutes) {
        return Err(CoreError::params("tzOffsetMinutes out of range"));
    }
    let now = p
        .now
        .filter(|n| n.is_finite() && *n >= 0.0 && *n < 1.0e14)
        .map(|n| Date::from_unix_ms(n as i64, p.tz_offset_minutes));
    let opts = ConvertOptions { fonts: blobs, now };
    let c = convert(doc.pdf(), prof, &opts)?;
    let j = json::converted(&c, prof);
    Ok(Reply::with_blob(j, c.bytes))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoParams {}

fn preflight_m(doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let _: NoParams = params(p)?;
    Ok(Reply::json(preflight(doc.pdf())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rules {
    profile: Option<String>,
}

fn rules_m(_doc: &mut Document, p: &Value, _b: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let p: Rules = params(p)?;
    let prof = p.profile.as_deref().map(profile).transpose()?;
    Ok(Reply::json(json::rules(prof)))
}
