//! Tokens in mark text: `{page}`, `{pages}`, `{date}` (Gregorian), `{hijri}` (Umm al-Qura),
//! `{time}`, `{file}`, `{bates}`. Token values follow the mark's digit style (Latin or
//! Arabic-Indic); the literal text around them is kept exactly as typed. Unknown `{…}` stay as
//! they are.

use serde::{Deserialize, Serialize};

use crate::hijri::{to_hijri, Date};

/// Digits used for token values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Digits {
    #[default]
    Latin,
    /// Arabic-Indic ٠١٢٣٤٥٦٧٨٩.
    Arabic,
}

/// Language of the date words (`هـ` / `AH`) and date order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Lang {
    Ar,
    #[default]
    En,
}

/// Local date and time given by the caller (the engine has no clock of its own).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Now {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    #[serde(default)]
    pub hour: u32,
    #[serde(default)]
    pub minute: u32,
}

/// Bates numbering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bates {
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    /// Number of the first marked page.
    #[serde(default = "one")]
    pub start: u64,
    /// Minimum number of digits (zero padded), 1–12.
    #[serde(default = "six")]
    pub digits: u32,
}

fn one() -> u64 {
    1
}
fn six() -> u32 {
    6
}

/// Values for one page.
#[derive(Debug, Clone)]
pub struct Context<'a> {
    /// 1-based page number.
    pub page: usize,
    pub pages: usize,
    /// 0-based position among the marked pages (Bates numbering).
    pub ordinal: usize,
    pub now: Option<Now>,
    pub file: &'a str,
    pub bates: Option<&'a Bates>,
    pub digits: Digits,
    pub lang: Lang,
}

/// Longest template accepted.
pub const MAX_TEMPLATE_CHARS: usize = 2_000;

/// Latin digits of `s` in the chosen style.
pub fn localize_digits(s: &str, d: Digits) -> String {
    match d {
        Digits::Latin => s.to_string(),
        Digits::Arabic => s
            .chars()
            .map(|c| match c.to_digit(10) {
                Some(v) if c.is_ascii_digit() => char::from_u32(0x0660 + v).unwrap_or(c),
                _ => c,
            })
            .collect(),
    }
}

fn date_text(ctx: &Context) -> String {
    let Some(n) = ctx.now else {
        return String::new();
    };
    let s = match ctx.lang {
        Lang::Ar => format!("{}/{}/{}", n.day, n.month, n.year),
        Lang::En => format!("{:04}-{:02}-{:02}", n.year, n.month, n.day),
    };
    localize_digits(&s, ctx.digits)
}

fn hijri_text(ctx: &Context) -> String {
    let Some(n) = ctx.now else {
        return String::new();
    };
    let Some(h) = to_hijri(Date {
        year: n.year,
        month: n.month,
        day: n.day,
    }) else {
        return String::new();
    };
    let num = localize_digits(&format!("{}/{}/{}", h.year, h.month, h.day), ctx.digits);
    match ctx.lang {
        Lang::Ar => format!("{num} هـ"),
        Lang::En => format!("{num} AH"),
    }
}

fn time_text(ctx: &Context) -> String {
    ctx.now.map_or(String::new(), |n| {
        localize_digits(
            &format!("{:02}:{:02}", n.hour.min(23), n.minute.min(59)),
            ctx.digits,
        )
    })
}

/// The Bates number of a page (`prefix` + zero-padded number + `suffix`).
pub fn bates_text(b: &Bates, ordinal: usize, digits: Digits) -> String {
    let n = b.start.saturating_add(ordinal as u64);
    let width = b.digits.clamp(1, 12) as usize;
    format!(
        "{}{}{}",
        b.prefix,
        localize_digits(&format!("{n:0width$}"), digits),
        b.suffix
    )
}

/// Expand the tokens of `template` for one page.
pub fn expand(template: &str, ctx: &Context) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let (before, after) = rest.split_at(open);
        out.push_str(before);
        let Some(close) = after.find('}') else {
            out.push_str(after);
            return out;
        };
        let name = after.get(1..close).unwrap_or("");
        let value = match name {
            "page" => Some(localize_digits(&ctx.page.to_string(), ctx.digits)),
            "pages" => Some(localize_digits(&ctx.pages.to_string(), ctx.digits)),
            "date" => Some(date_text(ctx)),
            "hijri" => Some(hijri_text(ctx)),
            "time" => Some(time_text(ctx)),
            "file" => Some(ctx.file.to_string()),
            "bates" => Some(
                ctx.bates
                    .map_or(String::new(), |b| bates_text(b, ctx.ordinal, ctx.digits)),
            ),
            _ => None,
        };
        match value {
            Some(v) => {
                out.push_str(&v);
                rest = after.get(close + 1..).unwrap_or("");
            }
            None => {
                out.push('{');
                rest = after.get(1..).unwrap_or("");
            }
        }
    }
    out.push_str(rest);
    out
}

/// True when the template's text differs between pages (so each page needs its own drawing).
pub fn varies_by_page(template: &str) -> bool {
    template.contains("{page}") || template.contains("{bates}")
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn ctx(digits: Digits, lang: Lang) -> Context<'static> {
        Context {
            page: 1,
            pages: 9,
            ordinal: 0,
            now: Some(Now {
                year: 2026,
                month: 9,
                day: 26,
                hour: 9,
                minute: 5,
            }),
            file: "تقرير.pdf",
            bates: None,
            digits,
            lang,
        }
    }

    #[test]
    fn page_of_pages_in_arabic_and_english() {
        assert_eq!(
            expand("صفحة {page} من {pages}", &ctx(Digits::Arabic, Lang::Ar)),
            "صفحة ١ من ٩"
        );
        assert_eq!(
            expand("Page {page} of {pages}", &ctx(Digits::Latin, Lang::En)),
            "Page 1 of 9"
        );
        // Literal digits typed by the person are kept.
        assert_eq!(expand("v2 {page}", &ctx(Digits::Arabic, Lang::Ar)), "v2 ١");
    }

    #[test]
    fn dates_gregorian_hijri_and_time() {
        let ar = ctx(Digits::Arabic, Lang::Ar);
        assert_eq!(expand("{date}", &ar), "٢٦/٩/٢٠٢٦");
        assert_eq!(expand("{hijri}", &ar), "١٤٤٨/٤/١٥ هـ");
        assert_eq!(expand("{time}", &ar), "٠٩:٠٥");
        let en = ctx(Digits::Latin, Lang::En);
        assert_eq!(
            expand("{date} {hijri} {time}", &en),
            "2026-09-26 1448/4/15 AH 09:05"
        );
        // Arabic words with Latin digits.
        assert_eq!(
            expand("{hijri}", &ctx(Digits::Latin, Lang::Ar)),
            "1448/4/15 هـ"
        );
        let mut none = en.clone();
        none.now = None;
        assert_eq!(expand("[{date}]", &none), "[]");
    }

    #[test]
    fn file_bates_and_unknown_tokens() {
        let b = Bates {
            prefix: "ZOOD-".into(),
            suffix: "-A".into(),
            start: 7,
            digits: 5,
        };
        let mut c = ctx(Digits::Latin, Lang::En);
        c.bates = Some(&b);
        c.ordinal = 3;
        assert_eq!(expand("{bates}", &c), "ZOOD-00010-A");
        c.digits = Digits::Arabic;
        assert_eq!(expand("{bates}", &c), "ZOOD-٠٠٠١٠-A");
        assert_eq!(expand("{file} {x} {", &c), "تقرير.pdf {x} {");
        assert_eq!(expand("}{}{page", &c), "}{}{page");
        assert!(varies_by_page("{bates}") && !varies_by_page("{date}"));
    }
}
