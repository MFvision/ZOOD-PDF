//! `dc:title` in an XMP packet (read, and set without touching the rest of the packet).

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// The first `rdf:li` of `dc:title`, if any and not empty.
pub fn xmp_title(xmp: &str) -> Option<String> {
    let start = xmp.find("<dc:title")?;
    let rest = xmp.get(start..)?;
    let end = rest.find("</dc:title>")?;
    let block = rest.get(..end)?;
    let li = block.find("<rdf:li")?;
    let after = block.get(li..)?;
    let open_end = after.find('>')?;
    let body = after.get(open_end + 1..)?;
    let close = body.find("</rdf:li>")?;
    let t = xml_unescape(body.get(..close)?.trim());
    (!t.is_empty()).then_some(t)
}

/// The packet with `dc:title` set to `title` (replaced when present, else added in its own
/// `rdf:Description` before `</rdf:RDF>`). A packet without `</rdf:RDF>` is returned unchanged.
pub fn xmp_with_title(xmp: &str, title: &str) -> String {
    let t = xml_escape(title);
    let block = format!(
        "<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">{t}</rdf:li></rdf:Alt></dc:title>"
    );
    if let Some(start) = xmp.find("<dc:title") {
        if let Some(e) = xmp.get(start..).and_then(|r| r.find("</dc:title>")) {
            let end = start + e + "</dc:title>".len();
            if let (Some(a), Some(b)) = (xmp.get(..start), xmp.get(end..)) {
                return format!("{a}{block}{b}");
            }
        }
    }
    if let Some(pos) = xmp.find("</rdf:RDF>") {
        if let (Some(a), Some(b)) = (xmp.get(..pos), xmp.get(pos..)) {
            return format!(
                "{a}<rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">{block}</rdf:Description>{b}"
            );
        }
    }
    xmp.to_string()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn title_roundtrip() {
        let x = "<x:xmpmeta><rdf:RDF xmlns:rdf=\"r\"><rdf:Description rdf:about=\"\"/></rdf:RDF></x:xmpmeta>";
        assert_eq!(xmp_title(x), None);
        let y = xmp_with_title(x, "تقرير & <خاص>");
        assert_eq!(xmp_title(&y).as_deref(), Some("تقرير & <خاص>"));
        let z = xmp_with_title(&y, "New");
        assert_eq!(xmp_title(&z).as_deref(), Some("New"));
        assert_eq!(z.matches("<dc:title>").count(), 1);
        assert_eq!(xmp_with_title("junk", "t"), "junk");
    }
}
