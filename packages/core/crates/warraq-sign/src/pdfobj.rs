//! Small helpers over lopdf objects, plus an edit set that collects the objects of one
//! incremental update without mutating the loaded document.

use crate::error::{Result, SignError};
use lopdf::{Dictionary, Object, ObjectId, StringFormat};
use std::collections::{BTreeMap, BTreeSet};
use warraq_pdf::Pdf;

/// PDF text string: PDFDocEncoding-compatible ASCII as-is, everything else UTF-16BE + BOM.
pub fn text_string(s: &str) -> Object {
    if s.bytes().all(|b| (0x20..0x7F).contains(&b)) {
        Object::String(s.as_bytes().to_vec(), StringFormat::Literal)
    } else {
        let mut v = vec![0xFE, 0xFF];
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_be_bytes());
        }
        Object::String(v, StringFormat::Hexadecimal)
    }
}

/// Decode a PDF text string (UTF-16BE with BOM, UTF-8 with BOM, else PDFDocEncoding≈Latin-1).
pub fn decode_text(b: &[u8]) -> String {
    if let Some(rest) = b.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| {
                u16::from_be_bytes([
                    c.first().copied().unwrap_or(0),
                    c.get(1).copied().unwrap_or(0),
                ])
            })
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if let Some(rest) = b.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    b.iter().map(|c| char::from(*c)).collect()
}

/// Name object.
pub fn name(n: &str) -> Object {
    Object::Name(n.as_bytes().to_vec())
}

/// Follow references (bounded) in `pdf`.
pub fn resolve<'a>(pdf: &'a Pdf, o: &'a Object) -> Option<&'a Object> {
    pdf.resolve(o)
}

/// Dictionary behind `o` (direct or referenced, stream dictionaries included).
pub fn dict_of<'a>(pdf: &'a Pdf, o: &'a Object) -> Option<&'a Dictionary> {
    match pdf.resolve(o)? {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

/// `d[key]` resolved.
pub fn get<'a>(pdf: &'a Pdf, d: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    d.get(key).ok().and_then(|o| pdf.resolve(o))
}

/// `d[key]` as a name.
pub fn get_name<'a>(pdf: &'a Pdf, d: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    match get(pdf, d, key)? {
        Object::Name(n) => Some(n.as_slice()),
        _ => None,
    }
}

/// `d[key]` as a number.
pub fn get_num(pdf: &Pdf, d: &Dictionary, key: &[u8]) -> Option<f64> {
    match get(pdf, d, key)? {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
}

/// `d[key]` as a text string.
pub fn get_text(pdf: &Pdf, d: &Dictionary, key: &[u8]) -> Option<String> {
    match get(pdf, d, key)? {
        Object::String(s, _) => Some(decode_text(s)),
        _ => None,
    }
}

/// `d[key]` as raw string bytes.
pub fn get_bytes<'a>(pdf: &'a Pdf, d: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    match get(pdf, d, key)? {
        Object::String(s, _) => Some(s.as_slice()),
        _ => None,
    }
}

/// A rectangle `[x0 y0 x1 y1]`, normalised.
pub fn get_rect(pdf: &Pdf, d: &Dictionary, key: &[u8]) -> Option<[f64; 4]> {
    let Object::Array(a) = get(pdf, d, key)? else {
        return None;
    };
    let mut v = [0f64; 4];
    for (i, slot) in v.iter_mut().enumerate() {
        *slot = match pdf.resolve(a.get(i)?)? {
            Object::Integer(n) => *n as f64,
            Object::Real(r) => f64::from(*r),
            _ => return None,
        };
    }
    Some([
        v[0].min(v[2]),
        v[1].min(v[3]),
        v[0].max(v[2]),
        v[1].max(v[3]),
    ])
}

/// Number object (integer when integral).
pub fn num(v: f64) -> Object {
    if v.fract() == 0.0 && v.abs() < 1e9 {
        Object::Integer(v as i64)
    } else {
        Object::Real(v as f32)
    }
}

/// The objects of one incremental update, layered over a loaded document.
pub struct Edit<'a> {
    /// The loaded document.
    pub pdf: &'a Pdf,
    /// Changed and new objects.
    pub objects: BTreeMap<ObjectId, Object>,
    next: u32,
}

impl<'a> Edit<'a> {
    /// Start an update over `pdf`.
    pub fn new(pdf: &'a Pdf) -> Self {
        Edit {
            pdf,
            objects: BTreeMap::new(),
            next: pdf.next_number(),
        }
    }

    /// Current version of object `id`.
    pub fn get(&self, id: ObjectId) -> Option<&Object> {
        self.objects.get(&id).or_else(|| self.pdf.get(id))
    }

    /// Follow references through the edit set.
    pub fn resolve<'b>(&'b self, mut o: &'b Object) -> Option<&'b Object> {
        for _ in 0..32 {
            match o {
                Object::Reference(id) => o = self.get(*id)?,
                other => return Some(other),
            }
        }
        None
    }

    /// Dictionary of object `id` (cloned, for modification).
    pub fn dict(&self, id: ObjectId) -> Result<Dictionary> {
        match self.get(id) {
            Some(Object::Dictionary(d)) => Ok(d.clone()),
            Some(Object::Stream(s)) => Ok(s.dict.clone()),
            _ => Err(SignError::Pdf(warraq_pdf::PdfError::Structure(format!(
                "object {} {} is not a dictionary",
                id.0, id.1
            )))),
        }
    }

    /// Replace object `id`.
    pub fn set(&mut self, id: ObjectId, o: Object) {
        self.next = self.next.max(id.0.saturating_add(1));
        self.objects.insert(id, o);
    }

    /// Add a new object.
    pub fn add(&mut self, o: Object) -> ObjectId {
        let id = (self.next, 0);
        self.set(id, o);
        id
    }

    /// Reserve a number for an object written later.
    pub fn reserve(&mut self) -> ObjectId {
        let id = (self.next, 0);
        self.next += 1;
        self.objects.insert(id, Object::Null);
        id
    }

    /// Build the update bytes (original bytes are an exact prefix).
    pub fn build(&self) -> Result<Vec<u8>> {
        Ok(self.pdf.build_update(&self.objects, &BTreeSet::new())?)
    }
}

/// A form field found in the AcroForm tree.
#[derive(Debug, Clone)]
pub struct FieldRef {
    /// The terminal field object.
    pub id: ObjectId,
    /// Fully qualified name.
    pub name: String,
    /// Field type (inherited).
    pub ft: Option<Vec<u8>>,
    /// Widget annotations (the field itself when merged).
    pub widgets: Vec<ObjectId>,
}

/// All terminal fields of the AcroForm (bounded walk).
pub fn fields(pdf: &Pdf) -> Vec<FieldRef> {
    let mut out = Vec::new();
    let Ok(cat) = pdf.catalog() else {
        return out;
    };
    let Some(af) = cat.get(b"AcroForm").ok().and_then(|o| dict_of(pdf, o)) else {
        return out;
    };
    let Some(Object::Array(roots)) = get(pdf, af, b"Fields") else {
        return out;
    };
    let mut seen = BTreeSet::new();
    let mut stack: Vec<(ObjectId, String, Option<Vec<u8>>, usize)> = roots
        .iter()
        .rev()
        .filter_map(|o| o.as_reference().ok())
        .map(|id| (id, String::new(), None, 0))
        .collect();
    while let Some((id, prefix, ft_in, depth)) = stack.pop() {
        if depth > 32 || !seen.insert(id) || out.len() > 100_000 {
            continue;
        }
        let Some(d) = pdf.get_dict(id) else { continue };
        let t = get_text(pdf, d, b"T");
        let name = match (&t, prefix.is_empty()) {
            (Some(t), true) => t.clone(),
            (Some(t), false) => format!("{prefix}.{t}"),
            (None, _) => prefix.clone(),
        };
        let ft = get_name(pdf, d, b"FT").map(<[u8]>::to_vec).or(ft_in);
        let kids: Vec<ObjectId> = match get(pdf, d, b"Kids") {
            Some(Object::Array(k)) => k.iter().filter_map(|o| o.as_reference().ok()).collect(),
            _ => Vec::new(),
        };
        // Kids that carry /T are fields; kids without /T are widgets of this field.
        let (field_kids, widget_kids): (Vec<ObjectId>, Vec<ObjectId>) = kids
            .into_iter()
            .partition(|k| pdf.get_dict(*k).is_some_and(|kd| kd.has(b"T")));
        if field_kids.is_empty() {
            let widgets = if widget_kids.is_empty() {
                vec![id]
            } else {
                widget_kids
            };
            out.push(FieldRef {
                id,
                name,
                ft,
                widgets,
            });
        } else {
            for k in field_kids.into_iter().rev() {
                stack.push((k, name.clone(), ft.clone(), depth + 1));
            }
        }
    }
    out
}

/// PDF date string `D:YYYYMMDDHHmmSS+00'00'` for Unix seconds (UTC).
pub fn pdf_date(unix: i64) -> String {
    let (y, mo, d, h, mi, s) = civil(unix);
    format!("D:{y:04}{mo:02}{d:02}{h:02}{mi:02}{s:02}+00'00'")
}

/// ISO 8601 `YYYY-MM-DDTHH:MM:SSZ`.
pub fn iso_date(unix: i64) -> String {
    let (y, mo, d, h, mi, s) = civil(unix);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// UTC civil time from Unix seconds (proleptic Gregorian; Howard Hinnant's algorithm).
pub fn civil(unix: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (
        y,
        m,
        d,
        (secs / 3600) as u32,
        ((secs % 3600) / 60) as u32,
        (secs % 60) as u32,
    )
}

/// Parse a PDF date (`D:YYYYMMDDHHmmSSOHH'mm`) to Unix seconds (lenient; missing parts = 0).
pub fn parse_pdf_date(s: &str) -> Option<i64> {
    let s = s.strip_prefix("D:").unwrap_or(s);
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    let part = |a: usize, b: usize, def: i64| -> i64 {
        digits.get(a..b).and_then(|x| x.parse().ok()).unwrap_or(def)
    };
    if digits.len() < 4 {
        return None;
    }
    let (y, mo, d, h, mi, se) = (
        part(0, 4, 0),
        part(4, 6, 1),
        part(6, 8, 1),
        part(8, 10, 0),
        part(10, 12, 0),
        part(12, 14, 0),
    );
    // days from civil
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let mut t = days * 86_400 + h * 3600 + mi * 60 + se;
    let rest: String = s.chars().skip(digits.len()).collect();
    let mut chars = rest.chars();
    if let Some(sign @ ('+' | '-')) = chars.next() {
        let tz: String = chars.filter(|c| c.is_ascii_digit()).collect();
        let oh: i64 = tz.get(0..2).and_then(|x| x.parse().ok()).unwrap_or(0);
        let om: i64 = tz.get(2..4).and_then(|x| x.parse().ok()).unwrap_or(0);
        let off = oh * 3600 + om * 60;
        t = if sign == '+' { t - off } else { t + off };
    }
    Some(t)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip() {
        let t = 1_790_358_029; // 2026-09-25T17:40:29Z
        assert_eq!(iso_date(t), "2026-09-25T17:40:29Z");
        assert_eq!(pdf_date(t), "D:20260925174029+00'00'");
        assert_eq!(parse_pdf_date(&pdf_date(t)), Some(t));
        assert_eq!(parse_pdf_date("D:20260925204029+03'00'"), Some(t));
        assert_eq!(iso_date(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn text_strings() {
        assert_eq!(decode_text(&[0xFE, 0xFF, 0x06, 0x27]), "ا");
        match text_string("سعيد") {
            Object::String(b, _) => assert_eq!(decode_text(&b), "سعيد"),
            _ => unreachable!(),
        }
    }
}
