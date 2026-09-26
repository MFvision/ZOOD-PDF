//! Link target checks: refuse bidi-control spoofing, flag look-alike (mixed-script or
//! whole-script confusable) hostnames, decode Punycode for display, and expose the real host.
//!
//! Verdicts: `ok` (open after the usual confirmation), `warn` (the person must type the hostname
//! to continue), `reject` (never opened or written).

use serde::Serialize;

/// Bidi controls: embeddings/overrides, isolates, marks and the Arabic letter mark.
pub fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}')
}

/// Result of [`check`].
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UrlCheck {
    /// `ok` | `warn` | `reject`.
    pub verdict: &'static str,
    pub scheme: String,
    /// Host as people read it (Unicode, IDN decoded). Empty for `mailto:`/`tel:` without host.
    pub host: String,
    /// Host as sent on the network (lower-case ASCII/Punycode).
    pub ascii_host: String,
    /// The URL to open (trimmed).
    pub url: String,
    /// Machine codes: `bidi_controls`, `control_chars`, `scheme`, `no_host`, `bad_punycode`,
    /// `mixed_script`, `confusable`, `credentials`, `ip_address`, `too_long`.
    pub problems: Vec<&'static str>,
}

/// Maximum URL length accepted.
pub const MAX_URL: usize = 8192;

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let c = b.get(i).copied().unwrap_or(0);
        if c == b'%' {
            let h = |x: Option<&u8>| x.and_then(|v| (*v as char).to_digit(16));
            if let (Some(a), Some(d)) = (h(b.get(i + 1)), h(b.get(i + 2))) {
                out.push((a * 16 + d) as u8);
                i += 3;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// RFC 3492 Punycode decoder (bounded: ≤ 63 output code points).
pub fn punycode_decode(input: &str) -> Option<String> {
    const BASE: u32 = 36;
    const TMIN: u32 = 1;
    const TMAX: u32 = 26;
    const SKEW: u32 = 38;
    const DAMP: u32 = 700;
    if input.len() > 256 || !input.is_ascii() {
        return None;
    }
    let (basic, rest) = match input.rfind('-') {
        Some(p) => (input.get(..p)?, input.get(p + 1..)?),
        None => ("", input),
    };
    let mut out: Vec<char> = basic.chars().collect();
    let (mut n, mut bias, mut i): (u32, u32, u32) = (128, 72, 0);
    let digits: Vec<u8> = rest.bytes().collect();
    let mut pos = 0usize;
    let adapt = |mut delta: u32, num: u32, first: bool| -> u32 {
        delta = if first { delta / DAMP } else { delta / 2 };
        delta += delta / num.max(1);
        let mut k = 0;
        while delta > ((BASE - TMIN) * TMAX) / 2 {
            delta /= BASE - TMIN;
            k += BASE;
        }
        k + (BASE - TMIN + 1) * delta / (delta + SKEW)
    };
    while pos < digits.len() {
        let old = i;
        let mut w: u32 = 1;
        let mut k = BASE;
        loop {
            let c = *digits.get(pos)?;
            pos += 1;
            let d = match c {
                b'a'..=b'z' => u32::from(c - b'a'),
                b'A'..=b'Z' => u32::from(c - b'A'),
                b'0'..=b'9' => u32::from(c - b'0') + 26,
                _ => return None,
            };
            i = i.checked_add(d.checked_mul(w)?)?;
            let t = if k <= bias {
                TMIN
            } else if k >= bias + TMAX {
                TMAX
            } else {
                k - bias
            };
            if d < t {
                break;
            }
            w = w.checked_mul(BASE - t)?;
            k += BASE;
            if k > BASE * 64 {
                return None;
            }
        }
        let len = u32::try_from(out.len()).ok()? + 1;
        bias = adapt(i - old, len, old == 0);
        n = n.checked_add(i / len)?;
        i %= len;
        let ch = char::from_u32(n)?;
        out.insert(usize::try_from(i).ok()?, ch);
        i += 1;
        if out.len() > 63 {
            return None;
        }
    }
    Some(out.into_iter().collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Script {
    Common,
    Latin,
    Greek,
    Cyrillic,
    Armenian,
    Hebrew,
    Arabic,
    Thaana,
    Devanagari,
    Thai,
    Georgian,
    Hangul,
    Kana,
    Han,
    Other,
}

fn script(c: char) -> Script {
    let u = c as u32;
    match u {
        0x30..=0x39 | 0x2D | 0x2E | 0x5F => Script::Common,
        0x41..=0x5A | 0x61..=0x7A | 0xC0..=0x24F | 0x1E00..=0x1EFF => Script::Latin,
        0x370..=0x3FF | 0x1F00..=0x1FFF => Script::Greek,
        0x400..=0x52F => Script::Cyrillic,
        0x530..=0x58F => Script::Armenian,
        0x590..=0x5FF => Script::Hebrew,
        0x660..=0x669 | 0x6F0..=0x6F9 => Script::Common,
        0x600..=0x6FF | 0x750..=0x77F | 0x870..=0x8FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF => {
            Script::Arabic
        }
        0x780..=0x7BF => Script::Thaana,
        0x900..=0x97F => Script::Devanagari,
        0xE00..=0xE7F => Script::Thai,
        0x10A0..=0x10FF => Script::Georgian,
        0x1100..=0x11FF | 0xAC00..=0xD7AF | 0x3130..=0x318F => Script::Hangul,
        0x3040..=0x30FF => Script::Kana,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF => Script::Han,
        0x300..=0x36F | 0x200C | 0x200D => Script::Common,
        _ => Script::Other,
    }
}

/// Mixed scripts in one label (UTS #39 "highly restrictive": CJK combinations allowed).
fn mixed(label: &str) -> bool {
    let mut set: Vec<Script> = label
        .chars()
        .map(script)
        .filter(|s| *s != Script::Common)
        .collect();
    set.sort_by_key(|s| *s as u8);
    set.dedup();
    let allowed = |s: &[Script]| {
        s.iter()
            .all(|x| matches!(x, Script::Han | Script::Kana | Script::Latin))
            || s.iter()
                .all(|x| matches!(x, Script::Han | Script::Hangul | Script::Latin))
    };
    set.len() > 1 && !(set.contains(&Script::Han) && allowed(&set))
}

/// Cyrillic/Greek letters that look like Latin ones.
fn latin_lookalike(c: char) -> bool {
    matches!(
        c,
        'а' | 'е'
            | 'о'
            | 'р'
            | 'с'
            | 'у'
            | 'х'
            | 'і'
            | 'ј'
            | 'ѕ'
            | 'ԁ'
            | 'ӏ'
            | 'һ'
            | 'ԛ'
            | 'ԝ'
            | 'ɡ'
            | 'α'
            | 'ο'
            | 'ρ'
            | 'ν'
            | 'τ'
            | 'κ'
            | 'ι'
            | 'υ'
            | 'ε'
    )
}

/// A label written entirely in look-alike Cyrillic/Greek letters (e.g. "раураl" without the l).
fn whole_script_confusable(label: &str) -> bool {
    let letters: Vec<char> = label
        .chars()
        .filter(|c| script(*c) != Script::Common)
        .collect();
    !letters.is_empty()
        && letters
            .iter()
            .all(|c| matches!(script(*c), Script::Cyrillic | Script::Greek))
        && letters.iter().all(|c| latin_lookalike(*c))
}

/// Check a link target.
pub fn check(raw: &str) -> UrlCheck {
    let url = raw.trim().to_string();
    let mut problems: Vec<&'static str> = Vec::new();
    let mut reject = false;
    if url.len() > MAX_URL {
        problems.push("too_long");
        reject = true;
    }
    let decoded = String::from_utf8_lossy(&percent_decode(&url)).into_owned();
    if url.chars().chain(decoded.chars()).any(is_bidi_control) {
        problems.push("bidi_controls");
        reject = true;
    }
    if url.chars().chain(decoded.chars()).any(|c| c.is_control()) {
        problems.push("control_chars");
        reject = true;
    }
    let (scheme, rest) = match url.split_once(':') {
        Some((s, r))
            if !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) =>
        {
            (s.to_ascii_lowercase(), r)
        }
        _ => (String::new(), url.as_str()),
    };
    let mut host = String::new();
    let mut ascii_host = String::new();
    match scheme.as_str() {
        "http" | "https" => {
            let after = rest.strip_prefix("//").unwrap_or(rest);
            let authority = after.split(['/', '?', '#']).next().unwrap_or("");
            let hostport = match authority.rsplit_once('@') {
                Some((_, h)) => {
                    problems.push("credentials");
                    h
                }
                None => authority,
            };
            let h = if hostport.starts_with('[') {
                hostport
                    .split(']')
                    .next()
                    .map(|s| format!("{s}]"))
                    .unwrap_or_default()
            } else {
                hostport.split(':').next().unwrap_or("").to_string()
            };
            let h = h.trim_end_matches('.').to_lowercase();
            if h.is_empty() {
                problems.push("no_host");
                reject = true;
            }
            let mut uni = Vec::new();
            let mut asc = Vec::new();
            for label in h.split('.') {
                if let Some(p) = label.strip_prefix("xn--") {
                    match punycode_decode(p) {
                        Some(u) => {
                            uni.push(u);
                            asc.push(label.to_string());
                        }
                        None => {
                            problems.push("bad_punycode");
                            uni.push(label.to_string());
                            asc.push(label.to_string());
                        }
                    }
                } else {
                    // ASCII labels, and raw Unicode labels (IRIs) shown as they are.
                    uni.push(label.to_string());
                    asc.push(label.to_string());
                }
            }
            for label in &uni {
                if mixed(label) && !problems.contains(&"mixed_script") {
                    problems.push("mixed_script");
                }
                if whole_script_confusable(label) && !problems.contains(&"confusable") {
                    problems.push("confusable");
                }
            }
            if h.starts_with('[')
                || (!h.is_empty() && h.chars().all(|c| c.is_ascii_digit() || c == '.'))
            {
                problems.push("ip_address");
            }
            host = uni.join(".");
            ascii_host = asc.join(".");
        }
        "mailto" => {
            let addr = rest.split('?').next().unwrap_or("");
            if let Some((_, d)) = addr.rsplit_once('@') {
                host = d.to_lowercase();
                ascii_host = host.clone();
                if host.split('.').any(mixed) {
                    problems.push("mixed_script");
                }
            }
        }
        _ => {
            problems.push("scheme");
            reject = true;
        }
    }
    let warn = problems.iter().any(|p| {
        matches!(
            *p,
            "mixed_script" | "confusable" | "bad_punycode" | "credentials"
        )
    });
    UrlCheck {
        verdict: if reject {
            "reject"
        } else if warn {
            "warn"
        } else {
            "ok"
        },
        scheme,
        host,
        ascii_host,
        url,
        problems,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn plain_urls_are_ok() {
        let c = check("https://zood.sa/docs?q=1");
        assert_eq!(c.verdict, "ok");
        assert_eq!(c.host, "zood.sa");
        assert_eq!(check("mailto:hello@zood.sa").verdict, "ok");
    }

    #[test]
    fn bidi_controls_are_rejected_raw_and_encoded() {
        for u in [
            "https://example.com/\u{202E}fdp.exe",
            "https://exa\u{2067}mple.com",
            "https://example.com/%E2%80%AEgpj.exe",
            "https://example.com/\u{200F}x",
            "https://example.com/\u{061C}x",
        ] {
            let c = check(u);
            assert_eq!(c.verdict, "reject", "{u}");
            assert!(c.problems.contains(&"bidi_controls"));
        }
    }

    #[test]
    fn dangerous_schemes_are_rejected() {
        for u in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,x",
            "no scheme",
        ] {
            assert_eq!(check(u).verdict, "reject", "{u}");
        }
    }

    #[test]
    fn punycode_and_mixed_scripts() {
        assert_eq!(punycode_decode("mgbh0fb").as_deref(), Some("مثال"));
        assert_eq!(punycode_decode("bcher-kva").as_deref(), Some("bücher"));
        // Cyrillic "а" inside a Latin label: xn--pple-43d = "аpple".
        let c = check("https://xn--pple-43d.com/login");
        assert_eq!(c.host, "аpple.com");
        assert_eq!(c.verdict, "warn");
        assert!(c.problems.contains(&"mixed_script"));
        // Arabic IDN is fine.
        let c = check("https://xn--mgbh0fb.xn--mgberp4a5d4ar/");
        assert_eq!(c.verdict, "ok", "{:?}", c.problems);
        assert_eq!(c.host, "مثال.السعودية");
        // Whole-script Cyrillic look-alike.
        let c = check("https://раура.com");
        assert!(c.problems.contains(&"confusable"));
        assert_eq!(c.verdict, "warn");
        // Credentials trick shows the real host.
        let c = check("https://paypal.com@evil.example/");
        assert_eq!(c.host, "evil.example");
        assert_eq!(c.verdict, "warn");
        assert!(punycode_decode("\u{0}").is_none());
        assert!(punycode_decode("99999999999999999").is_none());
    }
}
