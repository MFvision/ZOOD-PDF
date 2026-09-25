//! Parts shared by the OOXML writers.

use crate::model::ExportDoc;
use crate::xml::esc;

/// `docProps/core.xml` (title and language; no dates or user names: nothing identifying).
pub fn core_props(doc: &ExportDoc) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:title>{}</dc:title><dc:language>{}</dc:language></cp:coreProperties>",
        esc(doc.title.as_deref().unwrap_or("")),
        esc(doc.lang.as_deref().unwrap_or("und"))
    )
}

/// `docProps/app.xml`.
pub fn app_props() -> String {
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>ZOOD PDF</Application></Properties>".to_string()
}

/// Parse a cell's text as a number: ASCII, Arabic-Indic or Persian digits, optional sign,
/// thousands separators (`,` `٬`) and one decimal separator (`.` `٫`). `None` for anything else.
pub fn parse_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() || t.chars().count() > 40 {
        return None;
    }
    let mut out = String::with_capacity(t.len());
    let mut digits = 0;
    let mut dot = false;
    for (i, c) in t.chars().enumerate() {
        match c {
            '0'..='9' => {
                out.push(c);
                digits += 1;
            }
            '\u{0660}'..='\u{0669}' => {
                out.push(char::from(b'0' + (u32::from(c) - 0x0660) as u8));
                digits += 1;
            }
            '\u{06F0}'..='\u{06F9}' => {
                out.push(char::from(b'0' + (u32::from(c) - 0x06F0) as u8));
                digits += 1;
            }
            '-' | '\u{2212}' if i == 0 => out.push('-'),
            '+' if i == 0 => {}
            ',' | '\u{066C}' if digits > 0 => {}
            '.' | '\u{066B}' if !dot && digits > 0 => {
                dot = true;
                out.push('.');
            }
            _ => return None,
        }
    }
    if digits == 0 {
        return None;
    }
    // Leading zeros ("007", phone-like) stay text.
    if out.trim_start_matches('-').starts_with('0')
        && out.trim_start_matches('-').len() > 1
        && !out.trim_start_matches('-').starts_with("0.")
    {
        return None;
    }
    out.parse::<f64>().ok().filter(|v| v.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_in_every_digit_system() {
        assert_eq!(parse_number("4500"), Some(4500.0));
        assert_eq!(parse_number("٤٥٠٠"), Some(4500.0));
        assert_eq!(parse_number("۱۲٫۵"), Some(12.5));
        assert_eq!(parse_number("13,500"), Some(13500.0));
        assert_eq!(parse_number("-3.25"), Some(-3.25));
        assert_eq!(parse_number("0.5"), Some(0.5));
        assert_eq!(parse_number("0555"), None);
        assert_eq!(parse_number("12 ريال"), None);
        assert_eq!(parse_number("1.2.3"), None);
        assert_eq!(parse_number(""), None);
    }
}
