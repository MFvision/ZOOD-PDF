//! File-name sanitisation for names that come from documents or the web layer
//! (suggested save names, export names). Keeps Arabic, strips anything that could
//! escape the folder, spoof the extension with bidi controls, or be invalid on Windows.

/// Upper bound in bytes (most file systems allow 255; leave room for " (2)" style suffixes).
pub const MAX_NAME_BYTES: usize = 200;
const FALLBACK: &str = "document";

fn is_bidi_control(c: char) -> bool {
    matches!(
        c,
        '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

fn is_forbidden(c: char) -> bool {
    c.is_control() || is_bidi_control(c) || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')
}

fn is_windows_reserved(stem: &str) -> bool {
    let upper = stem.trim_end_matches([' ', '.']).to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.len() == 4
            && upper.as_bytes().get(3).is_some_and(u8::is_ascii_digit))
}

fn truncate_to_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.get(..end).unwrap_or("")
}

/// Returns a safe file name (never a path) for `input`.
pub fn sanitize_file_name(input: &str) -> String {
    // Only the last path component counts: "../../etc/passwd" → "passwd".
    let last = input.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .filter(|c| !is_bidi_control(*c))
        .map(|c| if is_forbidden(c) { '_' } else { c })
        .collect();
    // Windows drops trailing dots/spaces silently; leading dots would hide the file on Unix.
    let trimmed = cleaned
        .trim()
        .trim_end_matches(['.', ' '])
        .trim_start_matches('.');
    if trimmed.is_empty() {
        return FALLBACK.to_owned();
    }

    let (stem, ext) = match trimmed.rfind('.') {
        Some(i) if i > 0 && trimmed.len() - i <= 16 => (
            trimmed.get(..i).unwrap_or(trimmed),
            trimmed.get(i..).unwrap_or(""),
        ),
        _ => (trimmed, ""),
    };
    let stem = if is_windows_reserved(stem) {
        format!("_{stem}")
    } else {
        stem.to_owned()
    };
    let stem = truncate_to_bytes(&stem, MAX_NAME_BYTES.saturating_sub(ext.len()));
    let stem = stem.trim_end_matches(['.', ' ']);
    if stem.is_empty() {
        return format!("{FALLBACK}{ext}");
    }
    format!("{stem}{ext}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_plain_and_arabic_names() {
        assert_eq!(sanitize_file_name("report.pdf"), "report.pdf");
        assert_eq!(
            sanitize_file_name("عقد الإيجار ٢٠٢٦.pdf"),
            "عقد الإيجار ٢٠٢٦.pdf"
        );
    }

    #[test]
    fn strips_directories() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\Windows\\evil.pdf"), "evil.pdf");
        assert_eq!(sanitize_file_name("folder/"), "document");
    }

    #[test]
    fn removes_bidi_spoofing() {
        // "invoice" + RIGHT-TO-LEFT OVERRIDE + "fdp.exe" would render as "invoiceexe.pdf".
        assert_eq!(
            sanitize_file_name("invoice\u{202E}fdp.exe"),
            "invoicefdp.exe"
        );
        assert_eq!(sanitize_file_name("a\u{2067}b\u{2069}.pdf"), "ab.pdf");
    }

    #[test]
    fn replaces_windows_forbidden_and_control_characters() {
        assert_eq!(
            sanitize_file_name("a<b>c:d\"e|f?g*h\u{0}.pdf"),
            "a_b_c_d_e_f_g_h_.pdf"
        );
    }

    #[test]
    fn trims_dots_and_spaces() {
        assert_eq!(sanitize_file_name("  name.pdf . "), "name.pdf");
        assert_eq!(sanitize_file_name(".hidden"), "hidden");
        assert_eq!(sanitize_file_name("..."), "document");
        assert_eq!(sanitize_file_name(""), "document");
    }

    #[test]
    fn prefixes_windows_reserved_names() {
        assert_eq!(sanitize_file_name("CON.pdf"), "_CON.pdf");
        assert_eq!(sanitize_file_name("lpt1.txt"), "_lpt1.txt");
        assert_eq!(sanitize_file_name("COM10.pdf"), "COM10.pdf");
        assert_eq!(sanitize_file_name("console.pdf"), "console.pdf");
    }

    #[test]
    fn bounds_length_on_a_char_boundary_and_keeps_the_extension() {
        let long = format!("{}.pdf", "ز".repeat(500));
        let out = sanitize_file_name(&long);
        assert!(out.len() <= MAX_NAME_BYTES, "{}", out.len());
        assert!(out.ends_with(".pdf"));
        assert!(out.starts_with('ز'));
    }
}
