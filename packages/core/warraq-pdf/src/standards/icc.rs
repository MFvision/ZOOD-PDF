//! ICC profiles: the two Warraq bundles (see `assets/icc/README.md`, both
//! CC0) and a reader for the header fields the standards check.
use lopdf::{dictionary, Document, Object, ObjectId, Stream};

/// sRGB IEC 61966-2.1, ICC v2 (monitor class): the PDF/A output intent.
pub const SRGB: &[u8] = include_bytes!("../../assets/icc/sRGB-v2-magic.icc");
/// CGATS TR 001 (SWOP) CMYK, ICC v2, device to connection space only: what
/// device CMYK means in a file whose output intent is RGB.
pub const CMYK_SWOP: &[u8] = include_bytes!("../../assets/icc/CGATS001Compat-v2-micro.icc");

/// What the standards need to know about a profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IccInfo {
    /// `mntr`, `prtr`, `scnr`, `spac`, …
    pub class: String,
    /// `RGB `, `CMYK`, `GRAY`, `Lab `, …
    pub space: String,
    pub major: u8,
    pub minor: u8,
    /// Components of its colour space.
    pub components: i64,
    /// Its own description (`desc`), when it has one.
    pub description: Option<String>,
    /// It converts both ways (an output profile a press can use).
    pub bidirectional: bool,
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// Reads a profile's header and tag table; `None` when it is not one.
pub fn read(profile: &[u8]) -> Option<IccInfo> {
    if profile.len() < 132 || profile.get(36..40)? != b"acsp" {
        return None;
    }
    let size = be32(profile, 0)? as usize;
    if size > profile.len() || size < 132 {
        return None;
    }
    let text = |r: std::ops::Range<usize>| String::from_utf8_lossy(&profile[r]).into_owned();
    let space = text(16..20);
    let components = match space.as_str() {
        "GRAY" => 1,
        "RGB " | "Lab " | "XYZ " | "YCbr" | "HSV " | "HLS " | "CMY " | "Luv " | "Yxy " => 3,
        "CMYK" => 4,
        s if s.ends_with("CLR") => i64::from_str_radix(&s[..1], 16).unwrap_or(0),
        _ => 0,
    };
    let count = be32(profile, 128)? as usize;
    let mut description = None;
    let mut tags = vec![];
    for k in 0..count.min(256) {
        let at = 132 + 12 * k;
        let (Some(sig), Some(offset), Some(len)) = (
            profile.get(at..at + 4),
            be32(profile, at + 4),
            be32(profile, at + 8),
        ) else {
            break;
        };
        tags.push(sig.to_vec());
        let (offset, len) = (offset as usize, len as usize);
        if sig == b"desc" && offset.checked_add(len).is_some_and(|e| e <= profile.len()) {
            let tag = &profile[offset..offset + len];
            description = match tag.get(0..4) {
                // v2 textDescriptionType: an ASCII count, then the text.
                Some(b"desc") => be32(tag, 8).and_then(|n| {
                    let n = (n as usize).min(tag.len().saturating_sub(12));
                    let s: String = tag[12..12 + n]
                        .iter()
                        .take_while(|b| **b != 0)
                        .map(|b| *b as char)
                        .collect();
                    (!s.trim().is_empty()).then(|| s.trim().to_string())
                }),
                // v4 multiLocalizedUnicodeType: the first record, UTF-16BE.
                Some(b"mluc") => {
                    let len = be32(tag, 20)? as usize;
                    let off = be32(tag, 24)? as usize;
                    let raw = tag.get(off..off + len)?;
                    let units: Vec<u16> = raw
                        .chunks(2)
                        .map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]))
                        .collect();
                    let s = String::from_utf16_lossy(&units);
                    (!s.trim().is_empty()).then(|| s.trim().to_string())
                }
                _ => None,
            };
        }
    }
    let has = |t: &[u8]| tags.iter().any(|x| x == t);
    Some(IccInfo {
        class: text(12..16),
        space,
        major: profile[8],
        minor: profile[9] >> 4,
        components,
        description,
        bidirectional: (has(b"A2B0") && has(b"B2A0"))
            || (has(b"rXYZ") && has(b"rTRC"))
            || has(b"kTRC"),
    })
}

/// A profile as a stream object, with its component count.
pub fn add_profile(doc: &mut Document, profile: &[u8], components: i64) -> ObjectId {
    let mut stream = Stream::new(dictionary! { "N" => components }, profile.to_vec());
    let _ = stream.compress();
    doc.add_object(stream)
}

/// `[/ICCBased <profile>]`.
pub fn icc_space(profile: ObjectId) -> Object {
    Object::Array(vec![
        Object::Name(b"ICCBased".to_vec()),
        Object::Reference(profile),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_profiles_are_what_they_say() {
        let srgb = read(SRGB).unwrap();
        assert_eq!(
            (srgb.class.as_str(), srgb.space.as_str(), srgb.major),
            ("mntr", "RGB ", 2)
        );
        assert_eq!(srgb.components, 3);
        assert!(srgb.bidirectional);
        assert_eq!(srgb.description.as_deref(), Some("sRGB"));
        let cmyk = read(CMYK_SWOP).unwrap();
        assert_eq!((cmyk.space.as_str(), cmyk.components), ("CMYK", 4));
        assert!(!cmyk.bidirectional, "device to PCS only");
        assert!(read(b"not a profile").is_none());
        let mut short = SRGB.to_vec();
        short.truncate(200);
        assert!(read(&short).is_none(), "a size past the end is refused");
    }
}
