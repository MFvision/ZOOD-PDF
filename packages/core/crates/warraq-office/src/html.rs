//! HTML and Markdown writers.
//!
//! HTML: one self-contained UTF-8 file, `lang`/`dir` on the root and on every paragraph whose
//! direction or language differs, semantic `h1`–`h3`, `strong`/`em`, tables with `colspan`/
//! `rowspan`, one `<section>` per page. No scripts, no external resources.

use warraq_text::bidi::Dir;

use crate::model::{ExportDoc, Item, Para, Run, Table};
use crate::xml::esc;

fn dir_attr(d: Dir) -> &'static str {
    match d {
        Dir::Rtl => "rtl",
        Dir::Ltr => "ltr",
    }
}

fn runs_html(runs: &[Run]) -> String {
    let mut s = String::new();
    for r in runs {
        let t = esc(&r.text);
        match (r.bold, r.italic) {
            (true, true) => s.push_str(&format!("<strong><em>{t}</em></strong>")),
            (true, false) => s.push_str(&format!("<strong>{t}</strong>")),
            (false, true) => s.push_str(&format!("<em>{t}</em>")),
            (false, false) => s.push_str(&t),
        }
    }
    s
}

fn para_html(p: &Para, doc_lang: Option<&str>) -> String {
    let tag = match p.heading {
        1 => "h1",
        2 => "h2",
        3 => "h3",
        _ => "p",
    };
    let lang = match (&p.lang, doc_lang) {
        (Some(l), Some(d)) if l == d => String::new(),
        (Some(l), _) => format!(" lang=\"{}\"", esc(l)),
        _ => String::new(),
    };
    format!(
        "<{tag} dir=\"{}\"{lang}>{}</{tag}>\n",
        dir_attr(p.dir),
        runs_html(&p.runs)
    )
}

fn table_html(t: &Table) -> String {
    let mut s = format!("<table dir=\"{}\">\n", dir_attr(t.dir));
    for r in 0..t.rows {
        s.push_str("<tr>");
        for c in 0..t.cols {
            if let Some(cell) = t.cell(r, c) {
                let tag = if r == 0 { "th" } else { "td" };
                let mut attrs = String::new();
                if cell.colspan > 1 {
                    attrs.push_str(&format!(" colspan=\"{}\"", cell.colspan));
                }
                if cell.rowspan > 1 {
                    attrs.push_str(&format!(" rowspan=\"{}\"", cell.rowspan));
                }
                if cell.dir != t.dir && !cell.text.is_empty() {
                    attrs.push_str(&format!(" dir=\"{}\"", dir_attr(cell.dir)));
                }
                s.push_str(&format!("<{tag}{attrs}>{}</{tag}>", esc(&cell.text)));
            } else if t.covered(r, c).is_none() {
                s.push_str("<td></td>");
            }
        }
        s.push_str("</tr>\n");
    }
    s.push_str("</table>\n");
    s
}

const CSS: &str = "body{font-family:system-ui,-apple-system,\"Segoe UI\",\"Noto Naskh Arabic\",\"Noto Sans Arabic\",Tahoma,sans-serif;line-height:1.7;max-inline-size:52rem;margin-block:2rem;margin-inline:auto;padding-inline:1rem;color:#1d1d1f;background:#fff}section.page{padding-block-end:1.5rem;border-block-end:1px solid #d2d2d7;margin-block-end:1.5rem}section.page:last-child{border:0}table{border-collapse:collapse;margin-block:1rem}th,td{border:1px solid #c7c7cc;padding-block:.3rem;padding-inline:.6rem;text-align:start;vertical-align:top}th{background:#f2f2f7}@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}th{background:#2c2c2e}th,td{border-color:#48484a}}";

/// Write the HTML export.
pub fn write(doc: &ExportDoc) -> Vec<u8> {
    let lang = doc.lang.as_deref().unwrap_or("und");
    let mut s = format!(
        "<!DOCTYPE html>\n<html lang=\"{}\" dir=\"{}\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"generator\" content=\"ZOOD PDF\">\n<title>{}</title>\n<style>{CSS}</style>\n</head>\n<body>\n",
        esc(lang),
        dir_attr(doc.dir),
        esc(doc.title.as_deref().unwrap_or(""))
    );
    for p in &doc.pages {
        s.push_str(&format!(
            "<section class=\"page\" id=\"page-{}\">\n",
            p.index + 1
        ));
        for it in &p.items {
            match it {
                Item::Para(para) => s.push_str(&para_html(para, doc.lang.as_deref())),
                Item::Table(t) => s.push_str(&table_html(t)),
            }
        }
        s.push_str("</section>\n");
    }
    s.push_str("</body>\n</html>\n");
    s.into_bytes()
}

/// Escape Markdown syntax characters in inline text.
fn md_esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(
            c,
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '#'
        ) {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

fn md_runs(runs: &[Run]) -> String {
    let mut s = String::new();
    for r in runs {
        let t = md_esc(&r.text);
        let (lead, core, trail) = {
            let core = t.trim();
            let lead = t.get(..t.len() - t.trim_start().len()).unwrap_or("");
            let trail = t.get(t.trim_end().len()..).unwrap_or("");
            (lead.to_string(), core.to_string(), trail.to_string())
        };
        if core.is_empty() {
            s.push_str(&t);
            continue;
        }
        let mark = match (r.bold, r.italic) {
            (true, true) => "***",
            (true, false) => "**",
            (false, true) => "*",
            (false, false) => "",
        };
        s.push_str(&format!("{lead}{mark}{core}{mark}{trail}"));
    }
    s
}

/// Write GitHub-flavoured Markdown (tables as pipe tables; spans leave the covered cells empty).
pub fn markdown(doc: &ExportDoc) -> Vec<u8> {
    let mut s = String::new();
    for (i, p) in doc.pages.iter().enumerate() {
        if i > 0 {
            s.push_str("\n---\n\n");
        }
        for it in &p.items {
            match it {
                Item::Para(para) => {
                    if para.heading > 0 {
                        s.push_str(&"#".repeat(usize::from(para.heading.min(3))));
                        s.push(' ');
                    }
                    let mut line = md_runs(&para.runs);
                    // A paragraph starting like a list or rule would change meaning.
                    if para.heading == 0
                        && (line.starts_with("- ")
                            || line.starts_with("+ ")
                            || line.starts_with("---"))
                    {
                        line.insert(0, '\\');
                    }
                    s.push_str(&line);
                    s.push_str("\n\n");
                }
                Item::Table(t) => {
                    for r in 0..t.rows {
                        s.push('|');
                        for c in 0..t.cols {
                            let text = t.cell(r, c).map_or(String::new(), |k| md_esc(&k.text));
                            s.push(' ');
                            s.push_str(&text.replace('\n', " "));
                            s.push_str(" |");
                        }
                        s.push('\n');
                        if r == 0 {
                            s.push('|');
                            for _ in 0..t.cols {
                                s.push_str(" --- |");
                            }
                            s.push('\n');
                        }
                    }
                    s.push('\n');
                }
            }
        }
    }
    s.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_escapes_and_bold_runs() {
        let r = vec![
            Run {
                text: "عنوان ".into(),
                bold: true,
                italic: false,
            },
            Run {
                text: "a*b|c".into(),
                bold: false,
                italic: false,
            },
        ];
        assert_eq!(md_runs(&r), "**عنوان** a\\*b\\|c");
    }
}
