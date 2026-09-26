//! XMP metadata: parsing (roxmltree, DTDs refused, node count bounded), the PDF/A identification,
//! extension-schema bookkeeping, dates, and the packet the converter writes.

use std::collections::{BTreeMap, BTreeSet};

/// RDF namespace.
pub const NS_RDF: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
/// Dublin Core.
pub const NS_DC: &str = "http://purl.org/dc/elements/1.1/";
/// XMP basic.
pub const NS_XMP: &str = "http://ns.adobe.com/xap/1.0/";
/// Adobe PDF schema.
pub const NS_PDF: &str = "http://ns.adobe.com/pdf/1.3/";
/// XMP media management.
pub const NS_XMPMM: &str = "http://ns.adobe.com/xap/1.0/mm/";
/// PDF/A identification.
pub const NS_PDFAID: &str = "http://www.aiim.org/pdfa/ns/id/";
/// PDF/X identification.
pub const NS_PDFXID: &str = "http://www.npes.org/pdfx/ns/id/";
/// PDF/A extension schema container.
pub const NS_PDFA_EXT: &str = "http://www.aiim.org/pdfa/ns/extension/";
/// PDF/A schema value type.
pub const NS_PDFA_SCHEMA: &str = "http://www.aiim.org/pdfa/ns/schema#";

/// Namespaces whose properties PDF/A accepts without an extension schema (the XMP 2004/2005
/// schemas of ISO 19005-1 6.7.8 / ISO 19005-2 6.6.2.3.1 plus the PDF/A ones).
pub const PREDEFINED: &[&str] = &[
    NS_DC,
    NS_XMP,
    NS_PDF,
    NS_XMPMM,
    NS_PDFAID,
    NS_PDFA_EXT,
    NS_PDFA_SCHEMA,
    "http://www.aiim.org/pdfa/ns/property#",
    "http://www.aiim.org/pdfa/ns/type#",
    "http://www.aiim.org/pdfa/ns/field#",
    "http://ns.adobe.com/xap/1.0/rights/",
    "http://ns.adobe.com/xap/1.0/bj/",
    "http://ns.adobe.com/xap/1.0/t/pg/",
    "http://ns.adobe.com/xmp/1.0/DynamicMedia/",
    "http://ns.adobe.com/photoshop/1.0/",
    "http://ns.adobe.com/camera-raw-settings/1.0/",
    "http://ns.adobe.com/exif/1.0/",
    "http://ns.adobe.com/exif/1.0/aux/",
    "http://ns.adobe.com/tiff/1.0/",
    "http://ns.adobe.com/xap/1.0/sType/ResourceRef#",
    "http://ns.adobe.com/xap/1.0/sType/ResourceEvent#",
    "http://ns.adobe.com/xap/1.0/sType/Version#",
    "http://ns.adobe.com/xap/1.0/sType/Job#",
    "http://ns.adobe.com/xap/1.0/sType/Dimensions#",
    "http://ns.adobe.com/xap/1.0/sType/Font#",
    "http://ns.adobe.com/xap/1.0/g/",
    "http://ns.adobe.com/xap/1.0/g/img/",
    "http://ns.adobe.com/xmp/Identifier/qual/1.0/",
];

/// A parsed packet.
#[derive(Debug, Clone, Default)]
pub struct Xmp {
    /// Problem with the `<?xpacket begin=…?>` header (bytes/encoding attribute).
    pub header_issue: Option<&'static str>,
    /// Top-level properties: (namespace, local name) → values (Alt: x-default first; Seq/Bag: items).
    pub props: BTreeMap<(String, String), Vec<String>>,
    /// Namespaces of top-level properties.
    pub used_namespaces: BTreeSet<String>,
    /// Namespaces described by PDF/A extension schemas.
    pub declared_extensions: BTreeSet<String>,
}

impl Xmp {
    /// First value of a property.
    pub fn get(&self, ns: &str, local: &str) -> Option<&str> {
        self.props
            .get(&(ns.to_string(), local.to_string()))
            .and_then(|v| v.first())
            .map(String::as_str)
    }

    /// All values of a property.
    pub fn all(&self, ns: &str, local: &str) -> &[String] {
        self.props
            .get(&(ns.to_string(), local.to_string()))
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    /// Namespaces used without being predefined or described by an extension schema.
    pub fn undeclared_namespaces(&self) -> Vec<String> {
        self.used_namespaces
            .iter()
            .filter(|ns| {
                !PREDEFINED.contains(&ns.as_str()) && !self.declared_extensions.contains(*ns)
            })
            .cloned()
            .collect()
    }
}

/// Decode packet bytes (UTF-8, or UTF-16 with a BOM) to text.
pub fn decode(bytes: &[u8]) -> Result<String, String> {
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let u: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| {
                u16::from_be_bytes([
                    c.first().copied().unwrap_or(0),
                    c.get(1).copied().unwrap_or(0),
                ])
            })
            .collect();
        return String::from_utf16(&u).map_err(|_| "invalid UTF-16".into());
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let u: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| {
                u16::from_le_bytes([
                    c.first().copied().unwrap_or(0),
                    c.get(1).copied().unwrap_or(0),
                ])
            })
            .collect();
        return String::from_utf16(&u).map_err(|_| "invalid UTF-16".into());
    }
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    std::str::from_utf8(b)
        .map(str::to_string)
        .map_err(|_| "the packet is not valid UTF-8".into())
}

fn header_issue(text: &str) -> Option<&'static str> {
    let start = text.find("<?xpacket")?;
    let end = text.get(start..)?.find("?>")? + start;
    let head = text.get(start..end)?;
    if head.contains("bytes=") {
        Some("bytes")
    } else if head.contains("encoding=") {
        Some("encoding")
    } else {
        None
    }
}

fn element_values(node: roxmltree::Node<'_, '_>) -> Vec<String> {
    for c in node.children().filter(|c| c.is_element()) {
        if c.tag_name().namespace() == Some(NS_RDF)
            && matches!(c.tag_name().name(), "Alt" | "Seq" | "Bag")
        {
            let mut items: Vec<(bool, String)> = c
                .children()
                .filter(|l| {
                    l.is_element()
                        && l.tag_name().namespace() == Some(NS_RDF)
                        && l.tag_name().name() == "li"
                })
                .map(|l| {
                    let lang = l.attribute(("http://www.w3.org/XML/1998/namespace", "lang"));
                    (
                        lang == Some("x-default"),
                        l.text().unwrap_or("").trim().to_string(),
                    )
                })
                .collect();
            // x-default first.
            items.sort_by_key(|(d, _)| !*d);
            return items.into_iter().map(|(_, t)| t).collect();
        }
    }
    if node.children().any(|c| c.is_element()) {
        return vec![String::new()];
    }
    vec![node.text().unwrap_or("").trim().to_string()]
}

/// Parse a packet (well-formedness + the properties PDF/A cares about).
pub fn parse(bytes: &[u8]) -> Result<Xmp, String> {
    let text = decode(bytes)?;
    let opts = roxmltree::ParsingOptions {
        allow_dtd: false,
        nodes_limit: 200_000,
        ..roxmltree::ParsingOptions::default()
    };
    let doc = roxmltree::Document::parse_with_options(&text, opts).map_err(|e| e.to_string())?;
    let rdf = doc
        .descendants()
        .find(|n| {
            n.is_element()
                && n.tag_name().namespace() == Some(NS_RDF)
                && n.tag_name().name() == "RDF"
        })
        .ok_or_else(|| "no rdf:RDF element".to_string())?;
    let mut x = Xmp {
        header_issue: header_issue(&text),
        ..Xmp::default()
    };
    for desc in rdf.children().filter(|n| {
        n.is_element()
            && n.tag_name().namespace() == Some(NS_RDF)
            && n.tag_name().name() == "Description"
    }) {
        for a in desc.attributes() {
            let Some(ns) = a.namespace() else { continue };
            if ns == NS_RDF || ns == "http://www.w3.org/XML/1998/namespace" {
                continue;
            }
            x.used_namespaces.insert(ns.to_string());
            x.props
                .entry((ns.to_string(), a.name().to_string()))
                .or_default()
                .push(a.value().trim().to_string());
        }
        for p in desc.children().filter(|n| n.is_element()) {
            let Some(ns) = p.tag_name().namespace() else {
                return Err(format!("property {} has no namespace", p.tag_name().name()));
            };
            x.used_namespaces.insert(ns.to_string());
            x.props
                .entry((ns.to_string(), p.tag_name().name().to_string()))
                .or_default()
                .extend(element_values(p));
        }
    }
    for n in doc.descendants().filter(|n| n.is_element()) {
        if n.tag_name().namespace() == Some(NS_PDFA_SCHEMA) && n.tag_name().name() == "namespaceURI"
        {
            if let Some(t) = n.text() {
                x.declared_extensions.insert(t.trim().to_string());
            }
        }
        if let Some(v) = n.attribute((NS_PDFA_SCHEMA, "namespaceURI")) {
            x.declared_extensions.insert(v.trim().to_string());
        }
    }
    Ok(x)
}

// ---------------------------------------------------------------- dates

/// A date as found in `/Info` (PDF date) or XMP (ISO 8601).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Date {
    /// Year.
    pub y: i32,
    /// Month 1–12.
    pub mo: u32,
    /// Day 1–31.
    pub d: u32,
    /// Hour.
    pub h: u32,
    /// Minute.
    pub mi: u32,
    /// Second.
    pub s: u32,
    /// Offset from UTC in minutes (`None` = unknown).
    pub tz: Option<i32>,
}

fn digits(s: &str, from: usize, n: usize) -> Option<u32> {
    let part = s.get(from..from + n)?;
    if !part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    part.parse().ok()
}

impl Date {
    /// Parse a PDF date `D:YYYYMMDDHHmmSSOHH'mm'` (fields after the year optional).
    pub fn parse_pdf(s: &str) -> Option<Date> {
        let s = s.trim();
        let s = s.strip_prefix("D:").unwrap_or(s);
        let y = digits(s, 0, 4)? as i32;
        let field = |i: usize, dflt: u32| digits(s, i, 2).unwrap_or(dflt);
        let mut d = Date {
            y,
            mo: field(4, 1),
            d: field(6, 1),
            h: field(8, 0),
            mi: field(10, 0),
            s: field(12, 0),
            tz: None,
        };
        let digits_len = s.bytes().take_while(u8::is_ascii_digit).count();
        let rest = s.get(digits_len..).unwrap_or("");
        let rest = rest.replace('\'', "");
        if rest.starts_with('Z') {
            d.tz = Some(0);
        } else if let Some(sign) = rest.chars().next().filter(|c| *c == '+' || *c == '-') {
            let hh = digits(&rest, 1, 2).unwrap_or(0) as i32;
            let mm = digits(&rest, 3, 2).unwrap_or(0) as i32;
            let off = hh * 60 + mm;
            d.tz = Some(if sign == '-' { -off } else { off });
        }
        d.valid().then_some(d)
    }

    /// Parse an XMP date `YYYY[-MM[-DD[Thh:mm[:ss[.s]][TZD]]]]`.
    pub fn parse_xmp(s: &str) -> Option<Date> {
        let s = s.trim();
        let y = digits(s, 0, 4)? as i32;
        let mut d = Date {
            y,
            mo: 1,
            d: 1,
            h: 0,
            mi: 0,
            s: 0,
            tz: None,
        };
        if s.len() >= 7 {
            d.mo = digits(s, 5, 2)?;
        }
        if s.len() >= 10 {
            d.d = digits(s, 8, 2)?;
        }
        if s.len() > 10 {
            let t = s.get(11..)?;
            d.h = digits(t, 0, 2)?;
            d.mi = digits(t, 3, 2)?;
            let mut rest = t.get(5..).unwrap_or("");
            if rest.starts_with(':') {
                d.s = digits(rest, 1, 2)?;
                rest = rest.get(3..).unwrap_or("");
                if let Some(frac) = rest.strip_prefix('.') {
                    let n = frac.bytes().take_while(u8::is_ascii_digit).count();
                    rest = frac.get(n..).unwrap_or("");
                }
            }
            if rest.starts_with('Z') {
                d.tz = Some(0);
            } else if let Some(sign) = rest.chars().next().filter(|c| *c == '+' || *c == '-') {
                let hh = digits(rest, 1, 2)? as i32;
                let mm = digits(rest, 4, 2).unwrap_or(0) as i32;
                let off = hh * 60 + mm;
                d.tz = Some(if sign == '-' { -off } else { off });
            }
        }
        d.valid().then_some(d)
    }

    fn valid(&self) -> bool {
        (1..=12).contains(&self.mo)
            && (1..=31).contains(&self.d)
            && self.h < 24
            && self.mi < 60
            && self.s < 61
    }

    /// Seconds since 1970 (UTC; an unknown offset counts as UTC).
    pub fn instant(&self) -> i64 {
        // Days from civil (Howard Hinnant's algorithm).
        let y = i64::from(self.y) - i64::from(self.mo <= 2);
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let mp = (i64::from(self.mo) + 9) % 12;
        let doy = (153 * mp + 2) / 5 + i64::from(self.d) - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        days * 86_400 + i64::from(self.h) * 3600 + i64::from(self.mi) * 60 + i64::from(self.s)
            - i64::from(self.tz.unwrap_or(0)) * 60
    }

    /// From Unix milliseconds and a UTC offset in minutes.
    pub fn from_unix_ms(ms: i64, tz_minutes: i32) -> Date {
        let secs = ms.div_euclid(1000) + i64::from(tz_minutes) * 60;
        let days = secs.div_euclid(86_400);
        let rem = secs.rem_euclid(86_400);
        // Civil from days.
        let z = days + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let mo = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let y = (yoe + era * 400 + i64::from(mo <= 2)) as i32;
        Date {
            y,
            mo,
            d,
            h: (rem / 3600) as u32,
            mi: (rem % 3600 / 60) as u32,
            s: (rem % 60) as u32,
            tz: Some(tz_minutes),
        }
    }

    fn tz_parts(&self) -> Option<(char, i32, i32)> {
        let tz = self.tz?;
        Some((if tz < 0 { '-' } else { '+' }, tz.abs() / 60, tz.abs() % 60))
    }

    /// `2024-05-01T10:20:30+03:00`.
    pub fn to_xmp(&self) -> String {
        let base = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            self.y, self.mo, self.d, self.h, self.mi, self.s
        );
        match self.tz_parts() {
            Some((_, 0, 0)) => format!("{base}Z"),
            Some((s, h, m)) => format!("{base}{s}{h:02}:{m:02}"),
            None => base,
        }
    }

    /// `D:20240501102030+03'00'`.
    pub fn to_pdf(&self) -> String {
        let base = format!(
            "D:{:04}{:02}{:02}{:02}{:02}{:02}",
            self.y, self.mo, self.d, self.h, self.mi, self.s
        );
        match self.tz_parts() {
            Some((_, 0, 0)) => format!("{base}Z"),
            Some((s, h, m)) => format!("{base}{s}{h:02}'{m:02}'"),
            None => base,
        }
    }
}

// ---------------------------------------------------------------- writing

/// What the converter writes.
#[derive(Debug, Clone, Default)]
pub struct Fields {
    /// dc:title (x-default).
    pub title: Option<String>,
    /// dc:creator (one entry).
    pub author: Option<String>,
    /// dc:description (x-default).
    pub subject: Option<String>,
    /// pdf:Keywords.
    pub keywords: Option<String>,
    /// xmp:CreatorTool.
    pub creator_tool: Option<String>,
    /// pdf:Producer.
    pub producer: Option<String>,
    /// xmp:CreateDate.
    pub create_date: Option<Date>,
    /// xmp:ModifyDate (and MetadataDate).
    pub modify_date: Option<Date>,
    /// PDF/A part and conformance letter.
    pub pdfa: Option<(u8, &'static str)>,
    /// pdfxid:GTS_PDFXVersion.
    pub pdfx: Option<&'static str>,
    /// pdf:Trapped (`True`/`False`).
    pub trapped: Option<&'static str>,
    /// xmpMM:DocumentID.
    pub document_id: Option<String>,
    /// xmpMM:InstanceID.
    pub instance_id: Option<String>,
}

/// XML-escape text.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // Characters XML 1.0 forbids are dropped.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            '\u{FFFE}' | '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
    out
}

/// A complete packet (with the xpacket wrapper and padding).
pub fn write(f: &Fields) -> String {
    let mut descs = String::new();
    let mut desc = |ns_decl: &str, body: String| {
        if !body.is_empty() {
            descs.push_str(&format!(
                "  <rdf:Description rdf:about=\"\" {ns_decl}>\n{body}  </rdf:Description>\n"
            ));
        }
    };
    if let Some((part, conf)) = f.pdfa {
        desc(
            "xmlns:pdfaid=\"http://www.aiim.org/pdfa/ns/id/\"",
            format!("   <pdfaid:part>{part}</pdfaid:part>\n   <pdfaid:conformance>{conf}</pdfaid:conformance>\n"),
        );
    }
    let mut dc = String::new();
    if let Some(t) = &f.title {
        dc.push_str(&format!("   <dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:title>\n", esc(t)));
    }
    if let Some(a) = &f.author {
        dc.push_str(&format!(
            "   <dc:creator><rdf:Seq><rdf:li>{}</rdf:li></rdf:Seq></dc:creator>\n",
            esc(a)
        ));
    }
    if let Some(s) = &f.subject {
        dc.push_str(&format!("   <dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:description>\n", esc(s)));
    }
    if !dc.is_empty() {
        dc.push_str("   <dc:format>application/pdf</dc:format>\n");
    }
    desc("xmlns:dc=\"http://purl.org/dc/elements/1.1/\"", dc);
    let mut xmp = String::new();
    if let Some(c) = &f.creator_tool {
        xmp.push_str(&format!(
            "   <xmp:CreatorTool>{}</xmp:CreatorTool>\n",
            esc(c)
        ));
    }
    if let Some(d) = f.create_date {
        xmp.push_str(&format!(
            "   <xmp:CreateDate>{}</xmp:CreateDate>\n",
            d.to_xmp()
        ));
    }
    if let Some(d) = f.modify_date {
        xmp.push_str(&format!(
            "   <xmp:ModifyDate>{}</xmp:ModifyDate>\n   <xmp:MetadataDate>{}</xmp:MetadataDate>\n",
            d.to_xmp(),
            d.to_xmp()
        ));
    }
    desc("xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"", xmp);
    let mut pdf = String::new();
    if let Some(p) = &f.producer {
        pdf.push_str(&format!("   <pdf:Producer>{}</pdf:Producer>\n", esc(p)));
    }
    if let Some(k) = &f.keywords {
        pdf.push_str(&format!("   <pdf:Keywords>{}</pdf:Keywords>\n", esc(k)));
    }
    if let Some(t) = f.trapped {
        pdf.push_str(&format!("   <pdf:Trapped>{t}</pdf:Trapped>\n"));
    }
    desc("xmlns:pdf=\"http://ns.adobe.com/pdf/1.3/\"", pdf);
    let mut mm = String::new();
    if let Some(id) = &f.document_id {
        mm.push_str(&format!(
            "   <xmpMM:DocumentID>{}</xmpMM:DocumentID>\n",
            esc(id)
        ));
    }
    if let Some(id) = &f.instance_id {
        mm.push_str(&format!(
            "   <xmpMM:InstanceID>{}</xmpMM:InstanceID>\n",
            esc(id)
        ));
    }
    desc("xmlns:xmpMM=\"http://ns.adobe.com/xap/1.0/mm/\"", mm);
    if let Some(v) = f.pdfx {
        desc(
            "xmlns:pdfxid=\"http://www.npes.org/pdfx/ns/id/\"",
            format!("   <pdfxid:GTS_PDFXVersion>{v}</pdfxid:GTS_PDFXVersion>\n"),
        );
    }
    let padding = format!("{}\n", " ".repeat(99)).repeat(20);
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n{descs} </rdf:RDF>\n</x:xmpmeta>\n{padding}<?xpacket end=\"w\"?>"
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn written_packet_parses_back() {
        let f = Fields {
            title: Some("تقرير <سنوي> & ملخص".into()),
            author: Some("Ali".into()),
            pdfa: Some((2, "U")),
            create_date: Date::parse_pdf("D:20240102030405+03'00'"),
            modify_date: Date::parse_pdf("D:20240102030405Z"),
            ..Fields::default()
        };
        let x = parse(write(&f).as_bytes()).unwrap();
        assert_eq!(x.get(NS_PDFAID, "part"), Some("2"));
        assert_eq!(x.get(NS_PDFAID, "conformance"), Some("U"));
        assert_eq!(x.get(NS_DC, "title"), Some("تقرير <سنوي> & ملخص"));
        assert_eq!(x.get(NS_DC, "creator"), Some("Ali"));
        assert_eq!(
            x.get(NS_XMP, "CreateDate"),
            Some("2024-01-02T03:04:05+03:00")
        );
        assert!(x.header_issue.is_none());
        assert!(x.undeclared_namespaces().is_empty());
    }

    #[test]
    fn attributes_extensions_and_errors() {
        let s = br#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d" bytes="12"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="1" pdfaid:conformance="B" xmlns:my="http://example.com/my/" my:thing="x"/>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>"#;
        let x = parse(s).unwrap();
        assert_eq!(x.get(NS_PDFAID, "part"), Some("1"));
        assert_eq!(x.header_issue, Some("bytes"));
        assert_eq!(
            x.undeclared_namespaces(),
            vec!["http://example.com/my/".to_string()]
        );
        assert!(parse(b"<x:xmpmeta xmlns:x='adobe:ns:meta/'><unclosed>").is_err());
        assert!(parse(b"<!DOCTYPE x [<!ENTITY a 'b'>]><x/>").is_err());
        assert!(parse(b"<x/>").is_err());
        assert!(parse(&[0xFF, 0x00, 0x41]).is_err());
    }

    #[test]
    fn dates() {
        let a = Date::parse_pdf("D:20240102030405+03'00'").unwrap();
        let b = Date::parse_xmp("2024-01-02T00:04:05Z").unwrap();
        assert_eq!(a.instant(), b.instant());
        assert_eq!(a.to_pdf(), "D:20240102030405+03'00'");
        assert_eq!(Date::parse_xmp(&a.to_xmp()).unwrap(), a);
        assert_eq!(Date::parse_pdf("D:2023").unwrap().mo, 1);
        assert!(Date::parse_pdf("D:2023-1").is_some());
        assert!(Date::parse_pdf("garbage").is_none());
        let d = Date::from_unix_ms(1_700_000_000_000, 180);
        assert_eq!(d.to_xmp(), "2023-11-15T01:13:20+03:00");
        assert_eq!(
            Date::parse_xmp("2024-03-05T10:20:30.123-05:00").unwrap().tz,
            Some(-300)
        );
    }
}
