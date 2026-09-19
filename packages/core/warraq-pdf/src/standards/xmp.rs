//! XMP metadata (ISO 16684-1) as PDF/A, PDF/X and PDF/UA want it: written
//! whole from the document information dictionary, so the two agree
//! (PDF/A-2 §6.6.2.3), and read or changed in place where a whole new
//! packet would throw away what another program wrote.
use crate::document::decode_text_string;

/// What goes into a packet Warraq writes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct XmpFields {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator_tool: Option<String>,
    pub producer: Option<String>,
    /// ISO 8601, with a time zone.
    pub created: Option<String>,
    pub modified: Option<String>,
    /// `pdfaid:part` and `pdfaid:conformance` (`B`, `U`).
    pub pdfa: Option<(u8, String)>,
    /// `pdfxid:GTS_PDFXVersion`, e.g. `PDF/X-4`.
    pub pdfx: Option<String>,
    /// `xmpMM:DocumentID` and `xmpMM:InstanceID`.
    pub document_id: Option<String>,
    pub instance_id: Option<String>,
    /// `pdf:Trapped` (`True` or `False`).
    pub trapped: Option<bool>,
    /// `pdfuaid:part`.
    pub pdfua: Option<u8>,
    /// `dc:language`.
    pub language: Option<String>,
}

/// Text as XML character data.
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // XML 1.0 has no place for these controls.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

/// A complete packet, padded so another program can grow it in place.
pub fn packet(f: &XmpFields) -> Vec<u8> {
    let mut d = String::new();
    let mut ns = String::from(
        " xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n   xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n   xmlns:pdf=\"http://ns.adobe.com/pdf/1.3/\"",
    );
    d.push_str("   <dc:format>application/pdf</dc:format>\n");
    if let Some(t) = &f.title {
        d.push_str(&format!(
            "   <dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:title>\n",
            escape(t)
        ));
    }
    if let Some(a) = &f.author {
        d.push_str(&format!(
            "   <dc:creator><rdf:Seq><rdf:li>{}</rdf:li></rdf:Seq></dc:creator>\n",
            escape(a)
        ));
    }
    if let Some(s) = &f.subject {
        d.push_str(&format!(
            "   <dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:description>\n",
            escape(s)
        ));
    }
    if let Some(l) = &f.language {
        d.push_str(&format!(
            "   <dc:language><rdf:Bag><rdf:li>{}</rdf:li></rdf:Bag></dc:language>\n",
            escape(l)
        ));
    }
    if let Some(k) = &f.keywords {
        d.push_str(&format!("   <pdf:Keywords>{}</pdf:Keywords>\n", escape(k)));
    }
    if let Some(p) = &f.producer {
        d.push_str(&format!("   <pdf:Producer>{}</pdf:Producer>\n", escape(p)));
    }
    if let Some(t) = f.trapped {
        d.push_str(&format!(
            "   <pdf:Trapped>{}</pdf:Trapped>\n",
            if t { "True" } else { "False" }
        ));
    }
    if let Some(c) = &f.creator_tool {
        d.push_str(&format!(
            "   <xmp:CreatorTool>{}</xmp:CreatorTool>\n",
            escape(c)
        ));
    }
    if let Some(c) = &f.created {
        d.push_str(&format!(
            "   <xmp:CreateDate>{}</xmp:CreateDate>\n",
            escape(c)
        ));
    }
    if let Some(m) = &f.modified {
        d.push_str(&format!(
            "   <xmp:ModifyDate>{}</xmp:ModifyDate>\n",
            escape(m)
        ));
        d.push_str(&format!(
            "   <xmp:MetadataDate>{}</xmp:MetadataDate>\n",
            escape(m)
        ));
    }
    if f.document_id.is_some() || f.instance_id.is_some() || f.pdfx.is_some() {
        ns.push_str("\n   xmlns:xmpMM=\"http://ns.adobe.com/xap/1.0/mm/\"");
        if let Some(id) = &f.document_id {
            d.push_str(&format!(
                "   <xmpMM:DocumentID>{}</xmpMM:DocumentID>\n",
                escape(id)
            ));
        }
        if let Some(id) = &f.instance_id {
            d.push_str(&format!(
                "   <xmpMM:InstanceID>{}</xmpMM:InstanceID>\n",
                escape(id)
            ));
        }
        if f.pdfx.is_some() {
            d.push_str("   <xmpMM:VersionID>1</xmpMM:VersionID>\n");
            d.push_str("   <xmpMM:RenditionClass>default</xmpMM:RenditionClass>\n");
        }
    }
    if let Some((part, conformance)) = &f.pdfa {
        ns.push_str("\n   xmlns:pdfaid=\"http://www.aiim.org/pdfa/ns/id/\"");
        d.push_str(&format!("   <pdfaid:part>{part}</pdfaid:part>\n"));
        d.push_str(&format!(
            "   <pdfaid:conformance>{}</pdfaid:conformance>\n",
            escape(conformance)
        ));
    }
    if let Some(v) = &f.pdfx {
        ns.push_str("\n   xmlns:pdfxid=\"http://www.npes.org/pdfx/ns/id/\"");
        d.push_str(&format!(
            "   <pdfxid:GTS_PDFXVersion>{}</pdfxid:GTS_PDFXVersion>\n",
            escape(v)
        ));
    }
    if let Some(part) = f.pdfua {
        ns.push_str("\n   xmlns:pdfuaid=\"http://www.aiim.org/pdfua/ns/id/\"");
        d.push_str(&format!("   <pdfuaid:part>{part}</pdfuaid:part>\n"));
    }
    let mut out = String::from("<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n");
    out.push_str("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n");
    out.push_str(" <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n");
    out.push_str(&format!("  <rdf:Description rdf:about=\"\"{ns}>\n"));
    out.push_str(&d);
    out.push_str("  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n");
    // Padding (ISO 16684-1 §7.3.3): room to edit the packet in place.
    for _ in 0..20 {
        out.push_str(&" ".repeat(99));
        out.push('\n');
    }
    out.push_str("<?xpacket end=\"w\"?>");
    out.into_bytes()
}

/// The text of the first `<tag>…</tag>` (or `tag="…"` attribute) in a
/// packet, with any `rdf:Alt`/`rdf:Seq` wrapping taken off.
pub fn read_property(packet: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    if let Some(start) = packet.find(&open) {
        let after = &packet[start + open.len()..];
        // `<tag/>` or `<tag rdf:resource=…/>`: nothing inside.
        let close_angle = after.find('>')?;
        if after[..close_angle].ends_with('/') {
            return None;
        }
        let body_start = close_angle + 1;
        let end = after.find(&format!("</{tag}>"))?;
        let mut body = &after[body_start..end];
        // Inside an Alt, Seq or Bag: the first item.
        if let Some(li) = body.find("<rdf:li") {
            let rest = &body[li..];
            let open_end = rest.find('>')? + 1;
            let close = rest.find("</rdf:li>")?;
            body = &rest[open_end..close];
        }
        return Some(unescape(body.trim()));
    }
    // As an attribute of rdf:Description: tag="value".
    let attr = format!("{tag}=\"");
    let start = packet.find(&attr)? + attr.len();
    let end = packet[start..].find('"')?;
    Some(unescape(&packet[start..start + end]))
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// The packet with `dc:title` set to `title`: changed where it is, or
/// added to the first `rdf:Description`. `None` when there is no
/// `rdf:Description` to put it in.
pub fn with_title(packet: &str, title: &str) -> Option<String> {
    let value = format!(
        "<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:title>",
        escape(title)
    );
    if let Some(start) = packet.find("<dc:title") {
        let end = packet[start..].find("</dc:title>")? + start + "</dc:title>".len();
        let mut out = packet[..start].to_string();
        out.push_str(&value);
        out.push_str(&packet[end..]);
        return Some(out);
    }
    let desc = packet.find("<rdf:Description")?;
    let tag_end = packet[desc..].find('>')? + desc;
    let self_closing = packet[..tag_end].ends_with('/');
    let dc = if packet[desc..tag_end].contains("xmlns:dc=") || packet.contains("xmlns:dc=") {
        String::new()
    } else {
        " xmlns:dc=\"http://purl.org/dc/elements/1.1/\"".to_string()
    };
    let mut out = String::new();
    if self_closing {
        out.push_str(&packet[..tag_end - 1]);
        out.push_str(&dc);
        out.push('>');
        out.push_str(&value);
        out.push_str("</rdf:Description>");
    } else {
        out.push_str(&packet[..tag_end]);
        out.push_str(&dc);
        out.push('>');
        out.push_str(&value);
    }
    out.push_str(&packet[tag_end + 1..]);
    Some(out)
}

/// A PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`, §7.9.4) as ISO 8601, or `None`
/// when it is not one.
pub fn pdf_date_to_iso(raw: &[u8]) -> Option<String> {
    let s = decode_text_string(raw);
    let s = s.trim();
    let s = s.strip_prefix("D:").unwrap_or(s);
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() < 4 {
        return None;
    }
    let part = |from: usize, len: usize, default: u32| -> u32 {
        digits
            .get(from..from + len)
            .and_then(|p| p.parse().ok())
            .unwrap_or(default)
    };
    let (year, month, day) = (part(0, 4, 0), part(4, 2, 1), part(6, 2, 1));
    let (hour, minute, second) = (part(8, 2, 0), part(10, 2, 0), part(12, 2, 0));
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    let rest = &s[digits.len()..];
    let zone = match rest.chars().next() {
        Some('Z') | None => "Z".to_string(),
        Some(sign @ ('+' | '-')) => {
            let z: String = rest[1..].chars().filter(|c| c.is_ascii_digit()).collect();
            let hh: u32 = z.get(0..2).and_then(|p| p.parse().ok()).unwrap_or(0);
            let mm: u32 = z.get(2..4).and_then(|p| p.parse().ok()).unwrap_or(0);
            if hh > 23 || mm > 59 {
                return None;
            }
            format!("{sign}{hh:02}:{mm:02}")
        }
        _ => return None,
    };
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{:02}{zone}",
        second.min(59)
    ))
}

/// ISO 8601 (as `pdf_date_to_iso` writes it, or as a browser's
/// `toISOString` does) as a PDF date.
pub fn iso_to_pdf_date(iso: &str) -> Option<String> {
    let digits = |r: std::ops::Range<usize>| -> Option<u32> { iso.get(r)?.parse().ok() };
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let (hour, minute, second) = (
        digits(11..13).unwrap_or(0),
        digits(14..16).unwrap_or(0),
        digits(17..19).unwrap_or(0),
    );
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let tail = iso.get(19..).unwrap_or("");
    let tail = tail.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let zone = if tail.starts_with('Z') || tail.is_empty() {
        "Z".to_string()
    } else {
        let sign = &tail[..1];
        let hh = tail.get(1..3).unwrap_or("00");
        let mm = tail.get(4..6).unwrap_or("00");
        format!("{sign}{hh}'{mm}'")
    };
    Some(format!(
        "D:{year:04}{month:02}{day:02}{hour:02}{minute:02}{second:02}{zone}"
    ))
}

/// ISO 8601 as the same instant written with the XMP's precision: no
/// fractions of a second, `Z` for UTC.
pub fn normalise_iso(iso: &str) -> Option<String> {
    pdf_date_to_iso(iso_to_pdf_date(iso)?.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_packet_round_trips_what_it_was_given() {
        let fields = XmpFields {
            title: Some("دليل <وراق> & مثال".into()),
            author: Some("فريق وراق".into()),
            pdfa: Some((2, "B".into())),
            modified: Some("2026-09-19T10:20:30Z".into()),
            ..Default::default()
        };
        let p = String::from_utf8(packet(&fields)).unwrap();
        assert!(p.starts_with("<?xpacket begin="));
        assert!(p.ends_with("<?xpacket end=\"w\"?>"));
        assert_eq!(
            read_property(&p, "dc:title").as_deref(),
            Some("دليل <وراق> & مثال")
        );
        assert_eq!(read_property(&p, "pdfaid:part").as_deref(), Some("2"));
        assert_eq!(
            read_property(&p, "pdfaid:conformance").as_deref(),
            Some("B")
        );
        assert_eq!(
            read_property(&p, "dc:creator").as_deref(),
            Some("فريق وراق")
        );
        assert!(read_property(&p, "pdfuaid:part").is_none());
    }

    #[test]
    fn the_title_is_changed_in_place_or_added() {
        let p = String::from_utf8(packet(&XmpFields {
            title: Some("old".into()),
            ..Default::default()
        }))
        .unwrap();
        let q = with_title(&p, "جديد").unwrap();
        assert_eq!(read_property(&q, "dc:title").as_deref(), Some("جديد"));
        assert_eq!(q.matches("<dc:title").count(), 1);
        let bare = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:pdf=\"http://ns.adobe.com/pdf/1.3/\" pdf:Producer=\"X\"/></rdf:RDF></x:xmpmeta>";
        let r = with_title(bare, "T").unwrap();
        assert_eq!(read_property(&r, "dc:title").as_deref(), Some("T"));
        assert_eq!(read_property(&r, "pdf:Producer").as_deref(), Some("X"));
        assert!(r.contains("xmlns:dc="));
    }

    #[test]
    fn dates_convert_both_ways() {
        assert_eq!(
            pdf_date_to_iso(b"D:20260919102030+03'00'").as_deref(),
            Some("2026-09-19T10:20:30+03:00")
        );
        assert_eq!(
            pdf_date_to_iso(b"D:2026").as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert!(pdf_date_to_iso(b"yesterday").is_none());
        assert!(pdf_date_to_iso(b"D:20261345").is_none());
        assert_eq!(
            iso_to_pdf_date("2026-09-19T10:20:30.123Z").as_deref(),
            Some("D:20260919102030Z")
        );
        assert_eq!(
            iso_to_pdf_date("2026-09-19T10:20:30+03:00").as_deref(),
            Some("D:20260919102030+03'00'")
        );
        assert_eq!(
            normalise_iso("2026-09-19T10:20:30.999Z").as_deref(),
            Some("2026-09-19T10:20:30Z")
        );
    }
}
