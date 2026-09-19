//! Links: the link annotations of a page, listed with where they go, and
//! added, changed and removed.
//!
//! A link goes to a web address (`/A << /S /URI >>`) or to a page of this
//! file (`/Dest`, or `/A << /S /GoTo >>`, possibly by name through the
//! catalogue's `/Dests` or `/Names` tree). Only `http`, `https` and `mailto`
//! addresses are written: a link is a click away from running whatever it
//! names, and a PDF is hostile input. Rectangles are given and returned as
//! the page is shown — points from its top-left corner, y down.
use lopdf::{dictionary, Dictionary, Object, ObjectId, StringFormat};

use crate::text_walk::Matrix;
use crate::{Error, PdfDocument, Result};

/// A name tree is not searched deeper, or longer, than this.
const MAX_TREE_DEPTH: usize = 32;
const MAX_TREE_NODES: usize = 10_000;
/// An address longer than this is refused.
const MAX_URI: usize = 4096;

/// Where a link goes.
#[derive(Debug, Clone, PartialEq)]
pub enum LinkTarget {
    Uri(String),
    /// A page of this file, 0-based.
    Page(usize),
    /// Somewhere Warraq does not follow: another file, a script, a named action.
    Other,
}

/// A link on a page.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkInfo {
    /// The annotation's object, `"n.g"`, or its position when it is direct.
    pub id: String,
    /// `[x, y, width, height]` on the page as shown.
    pub rect: [f32; 4],
    pub target: LinkTarget,
}

fn parse_err(e: impl std::fmt::Display) -> Error {
    Error::Parse(e.to_string())
}

/// Percent-encodes what an address may not hold as it is: a PDF URI is
/// 7-bit ASCII (§12.6.4.8), and an Arabic address is typed as letters.
fn ascii_uri(uri: &str) -> String {
    let mut out = String::with_capacity(uri.len());
    for b in uri.bytes() {
        if b.is_ascii_graphic() {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Whether a character changes how an address shows rather than where it
/// goes: a control (Unicode's Cc), an invisible format character (Cf —
/// the bidi embeddings, overrides, isolates and marks, zero-width joiners
/// and spaces, the byte-order mark and the rest), or a line or paragraph
/// separator. `https://www.bank.com` + RLO + `@oi.live/` reads as a bank's
/// address and opens `oi.live`. The interface's `isOpenableUrl` refuses
/// the same characters.
pub fn hides_itself(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{0600}'..='\u{0605}'
                | '\u{061C}'
                | '\u{06DD}'
                | '\u{070F}'
                | '\u{0890}'..='\u{0891}'
                | '\u{08E2}'
                | '\u{180E}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{206F}'
                | '\u{FEFF}'
                | '\u{FFF9}'..='\u{FFFB}'
                | '\u{110BD}'
                | '\u{110CD}'
                | '\u{13430}'..='\u{1343F}'
                | '\u{1BCA0}'..='\u{1BCA3}'
                | '\u{1D173}'..='\u{1D17A}'
                | '\u{E0001}'
                | '\u{E0020}'..='\u{E007F}'
        )
}

/// Whether Warraq will write, or offer to open, this address: web or
/// e-mail, at most `MAX_URI` bytes once trimmed, and nothing in it that
/// hides itself.
pub fn allowed_uri(uri: &str) -> bool {
    let trimmed = uri.trim();
    let lower = trimmed.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
        && trimmed.len() <= MAX_URI
        && !uri.chars().any(hides_itself)
}

/// Where a link is kept: an object of its own, or written straight into
/// the page's `/Annots` at a place.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Held {
    Object(ObjectId),
    Direct(usize),
}

impl PdfDocument {
    fn resolved<'a>(&'a self, o: &'a Object) -> &'a Object {
        match o {
            Object::Reference(id) => self.doc.get_object(*id).unwrap_or(o),
            other => other,
        }
    }

    /// The page's `/Annots` entries, as they are written.
    fn annots(&self, page_id: ObjectId) -> Vec<Object> {
        let Ok(page) = self.doc.get_dictionary(page_id) else {
            return vec![];
        };
        match page.get(b"Annots").map(|a| self.resolved(a)) {
            Ok(Object::Array(a)) => a.clone(),
            _ => vec![],
        }
    }

    fn set_annots(&mut self, page_id: ObjectId, annots: Vec<Object>) -> Result<()> {
        // An indirect array is changed where it is; a direct one in the page.
        let held = self
            .doc
            .get_dictionary(page_id)
            .map_err(parse_err)?
            .get(b"Annots")
            .ok()
            .and_then(|a| a.as_reference().ok());
        match held {
            Some(id) if matches!(self.doc.get_object(id), Ok(Object::Array(_))) => {
                *self.doc.get_object_mut(id).map_err(parse_err)? = Object::Array(annots);
                self.mark_touched(id);
            }
            _ => {
                self.doc
                    .get_dictionary_mut(page_id)
                    .map_err(parse_err)?
                    .set("Annots", Object::Array(annots));
                self.mark_touched(page_id);
            }
        }
        Ok(())
    }

    fn page_index_of(&self, id: ObjectId) -> Option<usize> {
        self.pages.iter().position(|p| *p == id)
    }

    /// A named destination, from the catalogue's `/Dests` or `/Names /Dests`.
    fn named_destination(&self, name: &[u8]) -> Option<Object> {
        let root = self
            .doc
            .trailer
            .get(b"Root")
            .ok()
            .map(|r| self.resolved(r))?
            .as_dict()
            .ok()?;
        if let Some(dests) = root
            .get(b"Dests")
            .ok()
            .and_then(|d| self.resolved(d).as_dict().ok())
        {
            if let Ok(found) = dests.get(name) {
                return Some(self.resolved(found).clone());
            }
        }
        let tree = root
            .get(b"Names")
            .ok()
            .and_then(|n| self.resolved(n).as_dict().ok())?
            .get(b"Dests")
            .ok()
            .and_then(|d| self.resolved(d).as_dict().ok())?;
        let mut budget = MAX_TREE_NODES;
        self.search_names(tree, name, 0, &mut budget)
    }

    fn search_names(
        &self,
        node: &Dictionary,
        name: &[u8],
        depth: usize,
        budget: &mut usize,
    ) -> Option<Object> {
        if depth > MAX_TREE_DEPTH || *budget == 0 {
            return None;
        }
        *budget -= 1;
        if let Ok(Object::Array(pairs)) = node.get(b"Names").map(|n| self.resolved(n)) {
            for pair in pairs.chunks(2) {
                if let [key, value] = pair {
                    if self.resolved(key).as_str().ok() == Some(name) {
                        return Some(self.resolved(value).clone());
                    }
                }
            }
        }
        if let Ok(Object::Array(kids)) = node.get(b"Kids").map(|k| self.resolved(k)) {
            for kid in kids {
                if let Ok(kid) = self.resolved(kid).as_dict() {
                    if let Some(found) = self.search_names(kid, name, depth + 1, budget) {
                        return Some(found);
                    }
                }
            }
        }
        None
    }

    /// The page a destination names.
    fn destination_page(&self, dest: &Object, hops: usize) -> Option<usize> {
        if hops > 4 {
            return None;
        }
        match self.resolved(dest) {
            Object::Array(a) => match a.first()? {
                Object::Reference(id) => self.page_index_of(*id),
                // A page number: used by remote links, and by some writers here.
                Object::Integer(n) => usize::try_from(*n).ok().filter(|n| *n < self.page_count()),
                _ => None,
            },
            Object::Dictionary(d) => self.destination_page(d.get(b"D").ok()?, hops + 1),
            Object::Name(n) | Object::String(n, _) => {
                let found = self.named_destination(n)?;
                self.destination_page(&found, hops + 1)
            }
            _ => None,
        }
    }

    fn link_target(&self, annot: &Dictionary) -> LinkTarget {
        if let Ok(dest) = annot.get(b"Dest") {
            return self
                .destination_page(dest, 0)
                .map_or(LinkTarget::Other, LinkTarget::Page);
        }
        let Some(action) = annot
            .get(b"A")
            .ok()
            .and_then(|a| self.resolved(a).as_dict().ok())
        else {
            return LinkTarget::Other;
        };
        match action.get(b"S").ok().and_then(|s| s.as_name().ok()) {
            Some(b"URI") => action
                .get(b"URI")
                .ok()
                .and_then(|u| self.resolved(u).as_str().ok())
                .map(|u| LinkTarget::Uri(String::from_utf8_lossy(u).into_owned()))
                .unwrap_or(LinkTarget::Other),
            Some(b"GoTo") => action
                .get(b"D")
                .ok()
                .and_then(|d| self.destination_page(d, 0))
                .map_or(LinkTarget::Other, LinkTarget::Page),
            _ => LinkTarget::Other,
        }
    }

    /// A rectangle between the page as shown and user space.
    fn map_rect(m: Matrix, [x0, y0, x1, y1]: [f32; 4]) -> [f32; 4] {
        let corners = [
            m.apply(x0, y0),
            m.apply(x1, y0),
            m.apply(x0, y1),
            m.apply(x1, y1),
        ];
        let xs = corners.iter().map(|c| c.0);
        let ys = corners.iter().map(|c| c.1);
        [
            xs.clone().fold(f32::INFINITY, f32::min),
            ys.clone().fold(f32::INFINITY, f32::min),
            xs.fold(f32::NEG_INFINITY, f32::max),
            ys.fold(f32::NEG_INFINITY, f32::max),
        ]
    }

    /// The links of page `index`, in the page's order.
    pub fn list_links(&self, index: usize) -> Result<Vec<LinkInfo>> {
        let page_id = self.page_id(index)?;
        let to_display = self
            .display_frame(index)?
            .display_to_user()
            .invert()
            .unwrap_or(Matrix::IDENTITY);
        let mut out = Vec::new();
        for (k, entry) in self.annots(page_id).iter().enumerate() {
            let Ok(annot) = self.resolved(entry).as_dict() else {
                continue;
            };
            if annot.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) != Some(b"Link") {
                continue;
            }
            let Some(rect) = self.rect(annot.get(b"Rect").ok()) else {
                continue;
            };
            let [x0, y0, x1, y1] = Self::map_rect(to_display, rect);
            let id = match entry {
                Object::Reference(r) => format!("{}.{}", r.0, r.1),
                _ => format!("#{k}"),
            };
            out.push(LinkInfo {
                id,
                rect: [x0, y0, x1 - x0, y1 - y0],
                target: self.link_target(annot),
            });
        }
        Ok(out)
    }

    fn link_action(&self, target: &LinkTarget) -> Result<(&'static str, Object)> {
        match target {
            LinkTarget::Uri(uri) => {
                if !allowed_uri(uri) {
                    return Err(Error::Edit(
                        "E_LINK: only web (http, https) and e-mail (mailto) addresses can be linked".into(),
                    ));
                }
                Ok((
                    "A",
                    Object::Dictionary(dictionary! {
                        "Type" => "Action",
                        "S" => "URI",
                        "URI" => Object::String(ascii_uri(uri.trim()).into_bytes(), StringFormat::Literal),
                    }),
                ))
            }
            LinkTarget::Page(n) => {
                let page = self.page_id(*n)?;
                Ok((
                    "Dest",
                    Object::Array(vec![Object::Reference(page), Object::Name(b"Fit".to_vec())]),
                ))
            }
            LinkTarget::Other => Err(Error::Edit("E_LINK: a link needs somewhere to go".into())),
        }
    }

    fn user_rect(&self, index: usize, [x, y, w, h]: [f32; 4]) -> Result<Vec<Object>> {
        if !(w.is_finite()
            && h.is_finite()
            && x.is_finite()
            && y.is_finite()
            && w >= 1.0
            && h >= 1.0)
        {
            return Err(Error::Edit("E_LINK: a link needs an area to click".into()));
        }
        let to_user = self.display_frame(index)?.display_to_user();
        let r = Self::map_rect(to_user, [x, y, x + w, y + h]);
        Ok(r.iter().map(|v| Object::Real(*v)).collect())
    }

    /// Adds a link over `rect` on page `index`; returns its id.
    pub fn add_link(
        &mut self,
        index: usize,
        rect: [f32; 4],
        target: &LinkTarget,
    ) -> Result<String> {
        let page_id = self.page_id(index)?;
        let (key, value) = self.link_action(target)?;
        let mut annot = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Link",
            "Rect" => self.user_rect(index, rect)?,
            "Border" => vec![Object::Integer(0), Object::Integer(0), Object::Integer(0)],
            "F" => 4,
            "P" => page_id,
        };
        annot.set(key, value);
        let id = self.doc.add_object(annot);
        let mut annots = self.annots(page_id);
        annots.push(Object::Reference(id));
        self.set_annots(page_id, annots)?;
        Ok(format!("{}.{}", id.0, id.1))
    }

    fn link_object(&self, index: usize, link: &str) -> Result<Held> {
        let page_id = self.page_id(index)?;
        let is_link =
            |d: &Dictionary| d.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) == Some(b"Link");
        if let Some(k) = link.strip_prefix('#') {
            let k: usize = k
                .parse()
                .map_err(|_| Error::Edit(format!("E_LINK: no link {link}")))?;
            return match self.annots(page_id).get(k) {
                Some(Object::Dictionary(d)) if is_link(d) => Ok(Held::Direct(k)),
                _ => Err(Error::Edit(format!(
                    "E_LINK: no link {link} on page {}",
                    index + 1
                ))),
            };
        }
        let (n, g) = link
            .split_once('.')
            .and_then(|(n, g)| Some((n.parse::<u32>().ok()?, g.parse::<u16>().ok()?)))
            .ok_or_else(|| Error::Edit(format!("E_LINK: no link {link}")))?;
        let id = (n, g);
        let on_page = self
            .annots(page_id)
            .iter()
            .any(|a| a.as_reference().ok() == Some(id));
        let is_link = self.doc.get_dictionary(id).is_ok_and(is_link);
        if !(on_page && is_link) {
            return Err(Error::Edit(format!(
                "E_LINK: no link {link} on page {}",
                index + 1
            )));
        }
        Ok(Held::Object(id))
    }

    /// Moves a link, points it somewhere else, or both.
    pub fn update_link(
        &mut self,
        index: usize,
        link: &str,
        rect: Option<[f32; 4]>,
        target: Option<&LinkTarget>,
    ) -> Result<()> {
        let held = self.link_object(index, link)?;
        let rect = rect.map(|r| self.user_rect(index, r)).transpose()?;
        let action = target.map(|t| self.link_action(t)).transpose()?;
        let change = |annot: &mut Dictionary| {
            if let Some(rect) = rect {
                annot.set("Rect", rect);
            }
            if let Some((key, value)) = action {
                annot.remove(b"A");
                annot.remove(b"Dest");
                annot.set(key, value);
            }
        };
        match held {
            Held::Object(id) => {
                change(self.doc.get_dictionary_mut(id).map_err(parse_err)?);
                self.mark_touched(id);
            }
            // Changed where it is written, so it keeps its place and its id.
            Held::Direct(k) => {
                let page_id = self.page_id(index)?;
                let mut annots = self.annots(page_id);
                if let Some(Object::Dictionary(annot)) = annots.get_mut(k) {
                    change(annot);
                }
                self.set_annots(page_id, annots)?;
            }
        }
        Ok(())
    }

    /// Takes a link off the page.
    pub fn remove_link(&mut self, index: usize, link: &str) -> Result<()> {
        let held = self.link_object(index, link)?;
        let page_id = self.page_id(index)?;
        let mut annots = self.annots(page_id);
        match held {
            Held::Object(id) => {
                annots.retain(|a| a.as_reference().ok() != Some(id));
                self.set_annots(page_id, annots)?;
                if self.is_addition(id) {
                    self.doc.objects.remove(&id);
                }
            }
            Held::Direct(k) => {
                annots.remove(k);
                self.set_annots(page_id, annots)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    /// The object a link of page 1 is kept in.
    fn object(doc: &PdfDocument, link: &str) -> ObjectId {
        match doc.link_object(0, link).unwrap() {
            Held::Object(id) => id,
            held => panic!("{held:?}"),
        }
    }

    #[test]
    fn links_to_the_web_and_to_a_page_are_written_and_read_back() {
        let original = corpus("chrome-notonaskh-justified-3pages.pdf");
        let mut doc = PdfDocument::open(original.clone(), None).unwrap();
        let web = doc
            .add_link(
                0,
                [72.0, 100.0, 200.0, 20.0],
                &LinkTarget::Uri("https://example.org/مرحبا".into()),
            )
            .unwrap();
        let page = doc
            .add_link(0, [72.0, 140.0, 120.0, 20.0], &LinkTarget::Page(2))
            .unwrap();
        let saved = doc.save_incremental().unwrap();
        assert!(saved.starts_with(&original));
        let mut doc = PdfDocument::open(saved, None).unwrap();
        let links = doc.list_links(0).unwrap();
        assert_eq!(links.len(), 2);
        assert_eq!(
            links[0].target,
            LinkTarget::Uri("https://example.org/%D9%85%D8%B1%D8%AD%D8%A8%D8%A7".into())
        );
        assert_eq!(links[1].target, LinkTarget::Page(2));
        for (k, want) in [[72.0, 100.0, 200.0, 20.0], [72.0, 140.0, 120.0, 20.0]]
            .iter()
            .enumerate()
        {
            assert!(
                links[k]
                    .rect
                    .iter()
                    .zip(want)
                    .all(|(a, b)| (a - b).abs() < 0.01),
                "{links:?}"
            );
        }
        // In the file: /A /URI and /Dest [page /Fit].
        let annot = doc.doc_ref().get_dictionary(object(&doc, &page)).unwrap();
        let dest = annot.get(b"Dest").unwrap().as_array().unwrap();
        assert_eq!(dest[0].as_reference().unwrap(), doc.page_id(2).unwrap());
        let annot = doc.doc_ref().get_dictionary(object(&doc, &web)).unwrap();
        assert!(annot
            .get(b"A")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"URI")
            .is_ok());

        doc.update_link(
            0,
            &web,
            Some([10.0, 10.0, 50.0, 12.0]),
            Some(&LinkTarget::Page(1)),
        )
        .unwrap();
        let links = doc.list_links(0).unwrap();
        assert_eq!(links[0].target, LinkTarget::Page(1));
        assert!((links[0].rect[0] - 10.0).abs() < 0.01);
        doc.remove_link(0, &page).unwrap();
        assert_eq!(doc.list_links(0).unwrap().len(), 1);
    }

    #[test]
    fn scripts_and_files_are_not_linked_and_nonsense_is_refused() {
        let mut doc =
            PdfDocument::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        for uri in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "ftp://x",
            "https://a\u{7}b",
        ] {
            assert!(doc
                .add_link(0, [0.0, 0.0, 10.0, 10.0], &LinkTarget::Uri(uri.into()))
                .is_err());
        }
        assert!(doc
            .add_link(0, [0.0, 0.0, 10.0, 10.0], &LinkTarget::Page(7))
            .is_err());
        assert!(doc
            .add_link(0, [0.0, 0.0, 0.0, 10.0], &LinkTarget::Page(1))
            .is_err());
        assert!(doc.remove_link(0, "99999.0").is_err());
        assert!(doc.remove_link(0, "nonsense").is_err());
    }

    /// Bidi controls and other invisible format characters reorder what an
    /// address shows without changing where it goes: `https://www.bank.com`,
    /// then RLO, then `@oi.live/`, reads as a bank's address and opens
    /// `oi.live`. Such an address is neither written nor offered to open.
    #[test]
    fn an_address_with_invisible_format_characters_is_refused() {
        for uri in [
            "https://www.bank.com\u{202E}@oi.live/",
            "https://\u{2067}evil.example\u{2069}/",
            "https://a.example/\u{200F}x",
            "https://a.example/\u{061C}x",
            "https://a.example/\u{FEFF}",
            "https://a.example/\u{200B}",
            "https://a.example/\u{2028}",
            "https://a.example/\u{0085}",
        ] {
            assert!(!allowed_uri(uri), "{uri:?}");
        }
        assert!(allowed_uri("https://example.org/دليل"));
        assert!(allowed_uri("mailto:nadia@example.sa"));
        // Measured as the interface measures it: bytes of the trimmed address.
        let long = format!("https://example.org/{}", "د".repeat(2100));
        assert!(!allowed_uri(&long));
        assert!(allowed_uri(&format!(
            "  https://example.org/{}  ",
            "a".repeat(4000)
        )));
    }

    /// A link written straight into `/Annots`, not as an object of its own
    /// (against the spec, but found): listed, it can be changed and removed
    /// too — it is made an object of its own on the first change.
    #[test]
    fn a_link_written_into_the_page_can_be_changed_and_removed() {
        let mut doc =
            PdfDocument::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        let page = doc.page_id(0).unwrap();
        let direct = |x: i64| {
            Object::Dictionary(dictionary! {
                "Type" => "Annot", "Subtype" => "Link",
                "Rect" => vec![x.into(), 700.into(), (x + 100).into(), 720.into()],
                "A" => dictionary! { "S" => "URI", "URI" => Object::string_literal("https://example.org") },
            })
        };
        doc.set_annots(page, vec![direct(50), direct(300)]).unwrap();
        let links = doc.list_links(0).unwrap();
        assert_eq!(links.len(), 2);
        doc.update_link(0, &links[0].id, None, Some(&LinkTarget::Page(1)))
            .unwrap();
        let links = doc.list_links(0).unwrap();
        assert_eq!(links[0].target, LinkTarget::Page(1));
        assert_eq!(
            links[1].target,
            LinkTarget::Uri("https://example.org".into())
        );
        doc.remove_link(0, &links[1].id).unwrap();
        let links = doc.list_links(0).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, LinkTarget::Page(1));
        doc.remove_link(0, &links[0].id).unwrap();
        assert!(doc.list_links(0).unwrap().is_empty());
        // What is not a link is not one to change.
        doc.set_annots(
            page,
            vec![Object::Dictionary(dictionary! { "Subtype" => "Text" })],
        )
        .unwrap();
        assert!(doc.remove_link(0, "#0").is_err());
        assert!(doc.remove_link(0, "#7").is_err());
    }

    #[test]
    fn a_turned_page_takes_its_link_where_the_reader_drew_it() {
        let mut doc =
            PdfDocument::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        doc.rotate_pages(&[1], 1).unwrap();
        let rect = [100.0, 50.0, 80.0, 30.0];
        doc.add_link(1, rect, &LinkTarget::Page(0)).unwrap();
        let back = doc.list_links(1).unwrap()[0].rect;
        assert!(
            back.iter().zip(rect).all(|(a, b)| (a - b).abs() < 0.01),
            "{back:?}"
        );
    }
}
