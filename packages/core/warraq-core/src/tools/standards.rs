//! Standards: PDF/A and PDF/X-4 copies of the file, their validators, and a
//! light preflight (see `warraq_pdf::standards`). A conversion is a new
//! file, written whole; the open one is not changed.
//!
//! Faces for fonts a file does not carry come from the interface as blobs
//! after the PDF (the bundled Amiri, Cairo and Inter), each named in
//! `faces` with whether it has serifs; PDF/X takes the printer's ICC
//! profile as the blob before them.
use serde::Deserialize;
use serde_json::{json, Value};
use warraq_pdf::standards::fonts::Face;
use warraq_pdf::standards::pdfa::{self, Level, Refusal};
use warraq_pdf::standards::{icc, pdfx, preflight, Findings};
use warraq_pdf::PdfDocument;

use super::{args, Reply};
use crate::CoreError;

#[derive(Deserialize, Clone)]
struct FaceName {
    name: String,
    #[serde(default)]
    serif: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Convert {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    level: Option<String>,
    /// Now, ISO 8601: the copy's modification date.
    now: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    faces: Vec<FaceName>,
    /// PDF/X: the printing condition's name, and bleed in points.
    #[serde(default)]
    condition: Option<String>,
    #[serde(default)]
    bleed: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    min_ppi: Option<f32>,
    #[serde(default)]
    hairline: Option<f32>,
}

fn level_of(key: Option<&str>) -> Result<Level, CoreError> {
    Level::parse(key.unwrap_or("2b"))
        .ok_or_else(|| CoreError::Args(format!("no PDF/A level {}", key.unwrap_or(""))))
}

fn findings_json(f: &Findings) -> Value {
    json!({
        "total": f.total,
        "passed": f.passed(),
        "items": f.items.iter().map(|i| json!({
            "clause": i.clause,
            "rule": i.rule,
            "detail": i.detail,
            "page": i.page,
            "object": i.object.map(|(n, g)| format!("{n} {g}")),
        })).collect::<Vec<_>>(),
    })
}

fn refusal_json(r: &Refusal) -> Value {
    match r {
        Refusal::Signed => json!({ "refused": "signed" }),
        Refusal::NotForLevel(why) => json!({ "refused": "level", "reasons": why }),
    }
}

/// The PDF, then the faces named in `faces`, from `blobs`.
fn faces<'a>(names: &'a [FaceName], blobs: &'a [Vec<u8>]) -> Vec<Face<'a>> {
    names
        .iter()
        .zip(blobs)
        .map(|(n, data)| Face {
            name: &n.name,
            data,
            serif: n.serif,
        })
        .collect()
}

fn conversion_json(c: &pdfa::Conversion) -> Value {
    json!({
        "findings": findings_json(&c.findings),
        "substituted": c.substituted.iter().map(|s| json!({
            "font": s.font,
            "face": s.face,
            "missing": s.missing.iter().collect::<String>(),
        })).collect::<Vec<_>>(),
        "unicodeAdded": c.unicode_added,
        "changes": c.changes.iter().map(|(k, d)| json!({ "kind": k, "detail": d })).collect::<Vec<_>>(),
        "size": c.bytes.len(),
    })
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    let mut blobs = blobs.into_iter();
    let pdf = || CoreError::Args(format!("standards.{name} takes the PDF"));
    match name {
        "pdfa_validate" => {
            let a: Check = args(json)?;
            let doc = PdfDocument::open(blobs.next().ok_or_else(pdf)?, a.password.as_deref())?;
            let level = level_of(a.level.as_deref())?;
            Reply::of(&json!({
                "level": level.key(),
                "findings": findings_json(&doc.pdfa_validate(level)),
                "rules": pdfa::RULES.iter().map(|(k, _, _)| json!({
                    "rule": k,
                    "clause": pdfa::clause(k, level),
                })).filter(|r| r["clause"] != "-").collect::<Vec<_>>(),
            }))
        }
        "pdfa" => {
            let a: Convert = args(json)?;
            let doc = PdfDocument::open(blobs.next().ok_or_else(pdf)?, a.password.as_deref())?;
            let level = level_of(a.level.as_deref())?;
            if let Some(refusal) = doc.pdfa_refusal(level) {
                return Reply::of(&refusal_json(&refusal));
            }
            let face_bytes: Vec<Vec<u8>> = blobs.collect();
            let out = doc.to_pdfa(&pdfa::Options {
                level,
                faces: faces(&a.faces, &face_bytes),
                now: a.now,
                title: a.title,
            })?;
            let mut answer = conversion_json(&out);
            answer["level"] = json!(level.key());
            Ok(Reply::of(&answer)?.with_blob(out.bytes))
        }
        "pdfx_validate" => {
            let a: Check = args(json)?;
            let doc = PdfDocument::open(blobs.next().ok_or_else(pdf)?, a.password.as_deref())?;
            Reply::of(&json!({
                "findings": findings_json(&doc.pdfx_validate()),
                "rules": pdfx::RULES.iter().map(|(k, part)| json!({ "rule": k, "clause": part })).collect::<Vec<_>>(),
            }))
        }
        "pdfx" => {
            let a: Convert = args(json)?;
            let doc = PdfDocument::open(blobs.next().ok_or_else(pdf)?, a.password.as_deref())?;
            let profile = blobs.next().ok_or_else(|| {
                CoreError::Args("standards.pdfx takes the printer's profile".into())
            })?;
            let face_bytes: Vec<Vec<u8>> = blobs.collect();
            let out = doc.to_pdfx(&pdfx::Options {
                profile: &profile,
                condition: a.condition,
                faces: faces(&a.faces, &face_bytes),
                now: a.now,
                title: a.title,
                bleed: a.bleed.clamp(0.0, 72.0),
            })?;
            Ok(Reply::of(&conversion_json(&out))?.with_blob(out.bytes))
        }
        // What a chosen ICC profile is, before it is used.
        "profile" => {
            let bytes = blobs
                .next()
                .ok_or_else(|| CoreError::Args("standards.profile takes the profile".into()))?;
            match icc::read(&bytes) {
                None => Reply::of(&json!({ "profile": false })),
                Some(info) => Reply::of(&json!({
                    "profile": true,
                    "class": info.class,
                    "space": info.space.trim(),
                    "version": format!("{}.{}", info.major, info.minor),
                    "description": info.description,
                    "press": info.class == "prtr" && info.bidirectional,
                })),
            }
        }
        "preflight" => {
            let a: Check = args(json)?;
            let doc = PdfDocument::open(blobs.next().ok_or_else(pdf)?, a.password.as_deref())?;
            let defaults = preflight::Options::default();
            let report = doc.preflight(preflight::Options {
                min_ppi: a.min_ppi.unwrap_or(defaults.min_ppi).clamp(36.0, 2400.0),
                hairline: a.hairline.unwrap_or(defaults.hairline).clamp(0.0, 4.0),
            });
            Reply::of(&json!({
                "items": report.items.iter().map(|i| json!({
                    "check": i.check,
                    "severity": i.severity.key(),
                    "detail": i.detail,
                    "pages": i.pages,
                })).collect::<Vec<_>>(),
                "sizes": report.sizes.iter().map(|((w, h), pages)| json!({
                    "width": w, "height": h, "pages": pages,
                })).collect::<Vec<_>>(),
                "fonts": report.fonts,
                "images": report.images,
                "truncated": report.truncated,
            }))
        }
        _ => Err(CoreError::UnknownOp(format!("standards.{name}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Document;

    const AMIRI: &[u8] = include_bytes!("../../../../../tests/fonts/Amiri-Regular.ttf");
    const INTER: &[u8] =
        include_bytes!("../../../../../tests/fonts/static/Inter-Regular-static.ttf");

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn answer(reply: &Reply) -> Value {
        serde_json::from_str(&reply.json).unwrap()
    }

    fn convert(pdf: Vec<u8>, level: &str) -> Reply {
        call_static(
            "pdfa",
            &json!({
                "level": level,
                "now": "2026-09-19T10:00:00.000Z",
                "faces": [{ "name": "Inter" }, { "name": "Amiri", "serif": true }],
            })
            .to_string(),
            vec![pdf, INTER.to_vec(), AMIRI.to_vec()],
        )
        .unwrap()
    }

    /// Every page's text, as Warraq reads it.
    fn text(pdf: Vec<u8>) -> Vec<String> {
        let doc = Document::open(pdf, None).unwrap();
        (0..doc.page_count())
            .map(|i| doc.extract_text(i).unwrap())
            .collect()
    }

    #[test]
    fn an_arabic_file_becomes_pdfa_2b_that_validates_and_reads_the_same() {
        for name in [
            "generated/chrome-notonaskh-justified-3pages.pdf",
            "realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf",
        ] {
            let before =
                call_static("pdfa_validate", r#"{"level":"2b"}"#, vec![corpus(name)]).unwrap();
            assert_eq!(answer(&before)["findings"]["passed"], false, "{name}");
            let reply = convert(corpus(name), "2b");
            let a = answer(&reply);
            assert_eq!(a["findings"]["passed"], true, "{name}: {a}");
            let copy = reply.blobs[0].clone();
            let again =
                call_static("pdfa_validate", r#"{"level":"2b"}"#, vec![copy.clone()]).unwrap();
            assert_eq!(answer(&again)["findings"]["total"], 0, "{name}");
            assert_eq!(text(copy), text(corpus(name)), "{name}");
        }
    }

    /// Characters to change to turn `a` into `b` (Levenshtein, by char).
    fn distance(a: &str, b: &str) -> usize {
        let b: Vec<char> = b.chars().collect();
        let mut row: Vec<usize> = (0..=b.len()).collect();
        for (i, ca) in a.chars().enumerate() {
            let mut previous = row[0];
            row[0] = i + 1;
            for (j, cb) in b.iter().enumerate() {
                let here = row[j + 1];
                row[j + 1] = (previous + usize::from(ca != *cb))
                    .min(row[j] + 1)
                    .min(here + 1);
                previous = here;
            }
        }
        row[b.len()]
    }

    fn truth(name: &str) -> Option<String> {
        let stem = name.rsplit('/').next()?.trim_end_matches(".pdf");
        std::fs::read_to_string(format!(
            "{}/../../../tests/corpus/arabic/truth/{stem}.txt",
            env!("CARGO_MANIFEST_DIR")
        ))
        .ok()
    }

    #[test]
    fn pdfa_2u_names_glyphs_a_broken_map_had_lost() {
        let name = "generated/raw-cairo-cid-broken-tounicode.pdf";
        let reply = convert(corpus(name), "2u");
        let a = answer(&reply);
        assert!(!a["unicodeAdded"].as_array().unwrap().is_empty(), "{a}");
        let (before, after) = (
            text(corpus(name)).join("\n"),
            text(reply.blobs[0].clone()).join("\n"),
        );
        let truth = truth(name).unwrap();
        let lost = |t: &str| t.matches('\u{FFFD}').count();
        assert!(
            lost(&after) * 10 < lost(&before),
            "{} -> {}",
            lost(&before),
            lost(&after)
        );
        assert!(distance(&after, &truth) < distance(&before, &truth) / 4);
    }

    #[test]
    fn a_protected_level_is_refused_with_its_reasons() {
        let reply = convert(
            corpus("realworld/B_wmf_welcome_to_wikipedia_arabic_indesign_cs5_p1-5.pdf"),
            "1b",
        );
        let a = answer(&reply);
        assert_eq!(a["refused"], "level");
        assert!(a["reasons"]
            .as_array()
            .unwrap()
            .contains(&json!("transparency")));
        assert!(reply.blobs.is_empty());
    }

    #[test]
    fn pdfx_takes_a_press_profile_and_says_what_a_profile_is() {
        let press =
            include_bytes!("../../../../../tests/fixtures/icc/test-press-cmyk.icc").to_vec();
        let info = answer(&call_static("profile", "{}", vec![press.clone()]).unwrap());
        assert_eq!(
            (info["class"].as_str(), info["press"].as_bool()),
            (Some("prtr"), Some(true))
        );
        let srgb = answer(&call_static("profile", "{}", vec![icc::SRGB.to_vec()]).unwrap());
        assert_eq!(srgb["press"], false);
        let reply = call_static(
            "pdfx",
            &json!({ "now": "2026-09-19T10:00:00Z", "condition": "Test", "bleed": 9, "faces": [{"name": "Amiri", "serif": true}] }).to_string(),
            vec![corpus("generated/chrome-cairo-mixed-invoice.pdf"), press, AMIRI.to_vec()],
        )
        .unwrap();
        assert_eq!(answer(&reply)["findings"]["passed"], true, "{}", reply.json);
        let check = call_static("pdfx_validate", "{}", vec![reply.blobs[0].clone()]).unwrap();
        assert_eq!(answer(&check)["findings"]["total"], 0);
    }

    #[test]
    fn preflight_lists_findings_with_their_pages() {
        let reply = call_static(
            "preflight",
            r#"{"minPpi": 300}"#,
            vec![corpus("generated/scan-arial-200dpi-bilevel.pdf")],
        )
        .unwrap();
        let a = answer(&reply);
        let items = a["items"].as_array().unwrap();
        let low = items
            .iter()
            .find(|i| i["check"] == "lowResolution")
            .unwrap();
        assert_eq!(low["pages"], json!([0]));
        assert_eq!(low["severity"], "warning");
    }

    /// Every corpus file at 2b and 2u: what Warraq reads from the copy is
    /// what it read from the file, or nearer the truth where the corpus has
    /// one (a completed ToUnicode can name what a broken one lost). Slow in
    /// a debug build; run it with
    /// `cargo test --release -p warraq-core reads_as_well -- --ignored`.
    #[test]
    #[ignore]
    fn every_corpus_copy_reads_as_well_as_the_file() {
        let dir = format!(
            "{}/../../../tests/corpus/arabic/",
            env!("CARGO_MANIFEST_DIR")
        );
        let (mut same, mut better, mut spaced) = (0, 0, 0);
        for sub in ["generated", "realworld"] {
            for entry in std::fs::read_dir(format!("{dir}{sub}")).unwrap() {
                let path = entry.unwrap().path();
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                if !name.ends_with(".pdf")
                    || name.contains("encrypted")
                    || name.starts_with("perf-")
                {
                    continue;
                }
                let bytes = std::fs::read(&path).unwrap();
                let original = text(bytes.clone());
                for level in ["2b", "2u"] {
                    let reply = convert(bytes.clone(), level);
                    let copy = text(reply.blobs[0].clone());
                    if copy == original {
                        same += 1;
                        continue;
                    }
                    // A substituted face has its own widths, so the gaps a
                    // reader takes for spaces can move; the letters may not.
                    let letters = |t: &[String]| -> String {
                        t.concat().chars().filter(|c| !c.is_whitespace()).collect()
                    };
                    let substituted = !answer(&reply)["substituted"].as_array().unwrap().is_empty();
                    if substituted && letters(&copy) == letters(&original) {
                        spaced += 1;
                        continue;
                    }
                    let truth =
                        truth(&name).unwrap_or_else(|| panic!("{level} {name} reads differently"));
                    let (was, is) = (
                        distance(&original.join("\n"), &truth),
                        distance(&copy.join("\n"), &truth),
                    );
                    assert!(is < was, "{level} {name}: {was} -> {is}");
                    better += 1;
                }
            }
        }
        println!("{same} copies read the same, {better} nearer the truth, {spaced} the same letters spaced anew");
    }
}
