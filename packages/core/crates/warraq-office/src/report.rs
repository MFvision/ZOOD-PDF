//! Self-contained HTML comparison report: summary counts, a side-by-side table of text changes
//! and visual-difference thumbnails embedded as `data:` URIs. Inline CSS, no scripts, no external
//! resources; `lang`/`dir` follow the caller's locale. Labels come from the caller (the UI's
//! en/ar strings) with English defaults.

use serde::Deserialize;

use crate::compare::{ChangeKind, TextDiff};
use crate::png::data_uri;
use crate::xml::{dir_of, esc};

/// Report labels (localised by the UI).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Labels {
    pub title: String,
    pub original: String,
    pub revised: String,
    pub summary: String,
    pub inserted: String,
    pub deleted: String,
    pub changed: String,
    pub page: String,
    pub before: String,
    pub after: String,
    pub no_changes: String,
    pub text_changes: String,
    pub visual_changes: String,
    pub truncated: String,
}

impl Default for Labels {
    fn default() -> Self {
        Labels {
            title: "Comparison report".into(),
            original: "Original".into(),
            revised: "Revised".into(),
            summary: "Summary".into(),
            inserted: "Inserted".into(),
            deleted: "Deleted".into(),
            changed: "Changed".into(),
            page: "Page".into(),
            before: "Before".into(),
            after: "After".into(),
            no_changes: "No differences found.".into(),
            text_changes: "Text changes".into(),
            visual_changes: "Visual changes".into(),
            truncated: "Only the first changes are listed.".into(),
        }
    }
}

/// Report options.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReportInput {
    /// `en`, `ar`, … (sets `lang`; `ar`/`fa`/`ur`/`he` → `dir=rtl`).
    pub locale: String,
    pub name_a: String,
    pub name_b: String,
    pub labels: Labels,
    pub text: TextDiff,
    /// Visual results: page (0-based) and the index of its overlay PNG in the blobs.
    pub visual: Vec<VisualEntry>,
}

impl Default for ReportInput {
    fn default() -> Self {
        ReportInput {
            locale: "en".into(),
            name_a: String::new(),
            name_b: String::new(),
            labels: Labels::default(),
            text: TextDiff::default(),
            visual: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualEntry {
    pub page: usize,
    pub blob: usize,
    #[serde(default)]
    pub regions: usize,
}

/// Format an integer with the locale's digits (Arabic-Indic for `ar`).
pub fn num(n: usize, locale: &str) -> String {
    let s = n.to_string();
    if locale.starts_with("ar") {
        s.chars()
            .map(|c| {
                c.to_digit(10)
                    .and_then(|d| char::from_u32(0x0660 + d))
                    .unwrap_or(c)
            })
            .collect()
    } else if locale.starts_with("fa") || locale.starts_with("ur") {
        s.chars()
            .map(|c| {
                c.to_digit(10)
                    .and_then(|d| char::from_u32(0x06F0 + d))
                    .unwrap_or(c)
            })
            .collect()
    } else {
        s
    }
}

const CSS: &str = "body{font-family:system-ui,-apple-system,\"Segoe UI\",\"Noto Naskh Arabic\",\"Noto Sans Arabic\",Tahoma,sans-serif;margin:0;padding-block:2rem;padding-inline:1.5rem;color:#1d1d1f;background:#f5f5f7;line-height:1.6}main{max-inline-size:72rem;margin-inline:auto}h1{font-size:1.6rem;margin-block:0 .25rem}.files{color:#6e6e73;margin-block:0 1.5rem}.cards{display:flex;flex-wrap:wrap;gap:.75rem;margin-block:1rem}.card{background:#fff;border-radius:14px;padding-block:.75rem;padding-inline:1rem;min-inline-size:9rem;box-shadow:0 1px 3px rgba(0,0,0,.08)}.card b{display:block;font-size:1.6rem}.ins b{color:#248a3d}.del b{color:#d70015}.chg b{color:#b25000}table{inline-size:100%;border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden}th,td{padding-block:.5rem;padding-inline:.75rem;border-block-end:1px solid #e5e5ea;text-align:start;vertical-align:top}th{background:#fafafa;font-weight:600}del{background:#ffe5e7;color:#a1000f;text-decoration:line-through}ins{background:#e3f9e7;color:#1b6b2f;text-decoration:none}.kind{white-space:nowrap;font-size:.85rem}.shots{display:flex;flex-wrap:wrap;gap:1rem}figure{margin:0;background:#fff;border-radius:14px;padding:.5rem}figure img{max-inline-size:18rem;display:block}figcaption{font-size:.85rem;color:#6e6e73;padding-block-start:.25rem}@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}.card,table,figure{background:#2c2c2e}th{background:#3a3a3c}th,td{border-color:#48484a}}";

/// Render the report. `images` are the PNG blobs referenced by `input.visual`.
pub fn render(input: &ReportInput, images: &[Vec<u8>]) -> Vec<u8> {
    let l = &input.labels;
    let loc = input.locale.as_str();
    let rtl = ["ar", "fa", "ur", "he"].iter().any(|p| loc.starts_with(p));
    let dir = if rtl { "rtl" } else { "ltr" };
    let s = &input.text.summary;
    let mut h = format!(
        "<!DOCTYPE html>\n<html lang=\"{}\" dir=\"{dir}\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"generator\" content=\"ZOOD PDF\">\n<title>{}</title>\n<style>{CSS}</style>\n</head>\n<body><main>\n<h1>{}</h1>\n<p class=\"files\"><bdi>{}</bdi>: <bdi>{}</bdi> · <bdi>{}</bdi>: <bdi>{}</bdi></p>\n",
        esc(loc),
        esc(&l.title),
        esc(&l.title),
        esc(&l.original),
        esc(&input.name_a),
        esc(&l.revised),
        esc(&input.name_b)
    );
    h.push_str(&format!(
        "<section aria-label=\"{}\"><div class=\"cards\"><div class=\"card ins\" data-kind=\"inserted\"><b>{}</b>{}</div><div class=\"card del\" data-kind=\"deleted\"><b>{}</b>{}</div><div class=\"card chg\" data-kind=\"changed\"><b>{}</b>{}</div></div></section>\n",
        esc(&l.summary),
        num(s.inserted, loc),
        esc(&l.inserted),
        num(s.deleted, loc),
        esc(&l.deleted),
        num(s.changed, loc),
        esc(&l.changed)
    ));
    h.push_str(&format!("<h2>{}</h2>\n", esc(&l.text_changes)));
    if input.text.changes.is_empty() {
        h.push_str(&format!("<p>{}</p>\n", esc(&l.no_changes)));
    } else {
        h.push_str(&format!(
            "<table>\n<thead><tr><th>#</th><th>{}</th><th>{}</th><th>{}</th></tr></thead>\n<tbody>\n",
            esc(&l.page),
            esc(&l.before),
            esc(&l.after)
        ));
        for (i, c) in input.text.changes.iter().enumerate() {
            let kind = match c.kind {
                ChangeKind::Inserted => &l.inserted,
                ChangeKind::Deleted => &l.deleted,
                ChangeKind::Changed => &l.changed,
            };
            let side = |t: &str, tag: &str| -> String {
                if t.is_empty() {
                    String::new()
                } else {
                    let d = match dir_of(t) {
                        warraq_text::bidi::Dir::Rtl => "rtl",
                        warraq_text::bidi::Dir::Ltr => "ltr",
                    };
                    format!("<{tag} dir=\"{d}\">{}</{tag}>", esc(t))
                }
            };
            h.push_str(&format!(
                "<tr class=\"change\" data-kind=\"{}\"><td>{}<div class=\"kind\">{}</div></td><td>{} / {}</td><td>{}</td><td>{}</td></tr>\n",
                match c.kind {
                    ChangeKind::Inserted => "inserted",
                    ChangeKind::Deleted => "deleted",
                    ChangeKind::Changed => "changed",
                },
                num(i + 1, loc),
                esc(kind),
                num(c.page_a + 1, loc),
                num(c.page_b + 1, loc),
                side(&c.old, "del"),
                side(&c.new, "ins")
            ));
        }
        h.push_str("</tbody></table>\n");
        if s.truncated {
            h.push_str(&format!("<p>{}</p>\n", esc(&l.truncated)));
        }
    }
    let shots: Vec<String> = input
        .visual
        .iter()
        .filter_map(|v| {
            let png = images.get(v.blob).filter(|b| b.starts_with(b"\x89PNG"))?;
            Some(format!(
                "<figure><img src=\"{}\" alt=\"{} {}\"><figcaption>{} {}</figcaption></figure>",
                data_uri(png),
                esc(&l.page),
                num(v.page + 1, loc),
                esc(&l.page),
                num(v.page + 1, loc)
            ))
        })
        .collect();
    if !shots.is_empty() {
        h.push_str(&format!(
            "<h2>{}</h2>\n<div class=\"shots\">{}</div>\n",
            esc(&l.visual_changes),
            shots.join("")
        ));
    }
    h.push_str("</main></body>\n</html>\n");
    h.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arabic_digits_for_arabic_locale() {
        assert_eq!(num(2026, "ar"), "٢٠٢٦");
        assert_eq!(num(15, "fa"), "۱۵");
        assert_eq!(num(15, "en"), "15");
    }
}
