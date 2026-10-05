//! Applying redaction marks: what lies under them taken out of the file, not
//! covered.
//!
//! Each marked page's content is walked (`walk`) and rewritten without the
//! glyphs, pixels and drawings under its marks; a box is painted over each
//! mark, as a reader expects to see; annotations over a mark go, with the
//! form fields whose last widget they were; marked content and the
//! structure tree lose the replacement text (`/ActualText`, `/Alt`, `/E`)
//! that held what was cut; the page's thumbnail and private data
//! (`/PieceInfo`, where a page mark keeps its words and an OCR layer its
//! text) go too. Then the file is written **whole**: an incremental update
//! would keep every byte that was cut in the revision under it. Nothing
//! unreferenced and no earlier revision is written.
//!
//! A protected file is refused: writing it whole would lose its password,
//! and an update would keep what was cut.
use std::collections::{BTreeMap, BTreeSet, HashSet};

use lopdf::{Dictionary, Object, ObjectId, Stream};

use crate::text_walk::Matrix;
use crate::{Error, PdfDocument, Result};

pub(crate) mod fonts;
mod pixels;
#[rustfmt::skip]
mod standard;
mod walk;

use walk::{Counts, Rect, Walker};

/// Elements of the structure tree visited at most.
const MAX_ELEMENTS: usize = 200_000;
/// A page's content streams together are not read past this.
const MAX_PAGE_CONTENT: usize = 256 * 1024 * 1024;

/// One box to redact: on page `page` (zero-based), `[x, y, width, height]`
/// in points from the top-left of the page as stored — before `/Rotate`,
/// as `redact.find` answers its matches.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RedactMark {
    pub page: usize,
    pub rect: [f32; 4],
}

/// What a redaction took out.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RedactReport {
    /// Pages that had marks.
    pub pages: usize,
    /// Glyphs cut from the text.
    pub glyphs: usize,
    /// Runs of a font whose glyphs could not be placed, taken out whole.
    pub runs: usize,
    /// Pictures whose pixels under a mark were blanked.
    pub images: usize,
    /// Pictures (or forms) that could not be read and are no longer drawn.
    pub images_removed: usize,
    /// Drawings taken out.
    pub paths: usize,
    /// Annotations and form fields over a mark, removed.
    pub annotations: usize,
}

impl RedactReport {
    fn add(&mut self, c: Counts) {
        self.glyphs += c.glyphs;
        self.runs += c.runs;
        self.images += c.images;
        self.images_removed += c.images_removed;
        self.paths += c.paths;
    }
}

fn num(o: &Object) -> Option<f32> {
    match o {
        Object::Integer(i) => Some(*i as f32),
        Object::Real(r) => Some(*r),
        _ => None,
    }
    .filter(|v| v.is_finite())
}

impl PdfDocument {
    /// The file written whole with what lies under `marks` taken out, and a
    /// box of `fill` (RGB, 0–1) painted over each mark (none with `None`).
    pub fn redacted(
        &self,
        marks: &[RedactMark],
        fill: Option<[f32; 3]>,
    ) -> Result<(Vec<u8>, RedactReport)> {
        if self.was_encrypted {
            return Err(Error::Edit(
                "E_PROTECTED: a protected file cannot be redacted without losing its password"
                    .into(),
            ));
        }
        let mut by_page: BTreeMap<usize, Vec<[f32; 4]>> = BTreeMap::new();
        for m in marks {
            if m.page >= self.pages.len() {
                return Err(Error::Page(m.page));
            }
            let [x, y, w, h] = m.rect;
            if !(x.is_finite() && y.is_finite() && w.is_finite() && h.is_finite())
                || w <= 0.0
                || h <= 0.0
            {
                return Err(Error::Edit("a mark has no area".into()));
            }
            by_page.entry(m.page).or_default().push(m.rect);
        }
        let mut copy = self.detached_copy();
        let mut report = RedactReport::default();
        let mut gone: HashSet<ObjectId> = HashSet::new();
        for (page, rects) in by_page {
            let frame = copy.display_frame(page)?;
            let [cx0, _, _, cy1] = frame.crop;
            let user: Vec<Rect> = rects
                .iter()
                .map(|[x, y, w, h]| [cx0 + x, cy1 - (y + h), cx0 + x + w, cy1 - y])
                .collect();
            let page_id = copy.page_id(page)?;
            report.pages += 1;
            copy.redact_page(page_id, &user, fill, &mut report, &mut gone)?;
        }
        report.annotations = gone.len();
        copy.forget_fields_of(&mut gone);
        copy.unreach(&gone);
        for key in [b"Prev".as_slice(), b"XRefStm"] {
            copy.doc.trailer.remove(key);
        }
        copy.prune_unreachable();
        Ok((copy.save_to_vec()?, report))
    }

    fn redact_page(
        &mut self,
        page_id: ObjectId,
        user: &[Rect],
        fill: Option<[f32; 3]>,
        report: &mut RedactReport,
        gone: &mut HashSet<ObjectId>,
    ) -> Result<()> {
        // The page's streams as one: an operation may run from one into the
        // next, and the state certainly does.
        let mut content = Vec::new();
        for id in self.content_ids(page_id) {
            let bytes = self.stream_bytes(id)?;
            if content.len() + bytes.len() > MAX_PAGE_CONTENT {
                return Err(Error::Edit(
                    "a page's content is too long to redact safely".into(),
                ));
            }
            content.extend_from_slice(&bytes);
            content.push(b'\n');
        }
        let resources = self.page_resources(page_id).cloned().unwrap_or_default();
        let mut walker = Walker::new(self, user);
        let outcome = walker.walk(&content, &resources, Matrix::IDENTITY, 0)?;
        report.add(walker.counts);
        let mut content = outcome.content.unwrap_or(content);
        if !outcome.names.is_empty() || !outcome.dropped.is_empty() {
            // The page's own resources, so another page sharing them keeps
            // drawing the originals; the originals no longer drawn here leave
            // them, or they would stay in the file.
            let still = walk::drawn_names(&content);
            self.own_resources(page_id)?;
            let group = self.own_xobjects(page_id)?;
            for name in &outcome.dropped {
                if !still.contains(name) {
                    group.remove(name);
                }
            }
            for (name, id) in outcome.names {
                group.set(name, Object::Reference(id));
            }
        }
        if let Some([r, g, b]) = fill {
            // Back to the page's own space, then a box over each mark.
            content.extend_from_slice("\nQ".repeat(outcome.depth).as_bytes());
            let mut boxes = format!("\nq {r} {g} {b} rg");
            for [x0, y0, x1, y1] in user {
                boxes.push_str(&format!(" {x0} {y0} {} {} re", x1 - x0, y1 - y0));
            }
            boxes.push_str(" f Q\n");
            content.extend_from_slice(boxes.as_bytes());
        }
        let mut stream = Stream::new(Dictionary::new(), content);
        let _ = stream.compress();
        let id = self.doc.add_object(stream);
        self.set_contents(page_id, Object::Reference(id))?;
        if let Ok(page) = self.doc.get_dictionary_mut(page_id) {
            page.remove(b"Thumb");
            page.remove(b"PieceInfo");
        }
        self.drop_annotations_over(page_id, user, gone);
        if !outcome.mcids.is_empty() {
            self.forget_structure_text(page_id, &outcome.mcids);
        }
        Ok(())
    }

    /// Takes off the page every annotation whose box meets a mark, and the
    /// popups of those that go.
    fn drop_annotations_over(
        &mut self,
        page_id: ObjectId,
        user: &[Rect],
        gone: &mut HashSet<ObjectId>,
    ) {
        let Some(annots) = self
            .doc
            .get_dictionary(page_id)
            .ok()
            .and_then(|p| p.get(b"Annots").ok())
            .map(|a| match a {
                Object::Reference(id) => self.doc.get_object(*id).cloned().unwrap_or(Object::Null),
                o => o.clone(),
            })
            .and_then(|a| a.as_array().ok().cloned())
        else {
            return;
        };
        let rect_of = |d: &Dictionary| -> Option<Rect> {
            let r = match d.get(b"Rect").ok()? {
                Object::Reference(id) => self.doc.get_object(*id).ok()?.clone(),
                o => o.clone(),
            };
            let v: Vec<f32> = r.as_array().ok()?.iter().filter_map(num).collect();
            (v.len() == 4).then(|| {
                [
                    v[0].min(v[2]),
                    v[1].min(v[3]),
                    v[0].max(v[2]),
                    v[1].max(v[3]),
                ]
            })
        };
        let meets = |r: &Rect| {
            user.iter()
                .any(|m| m[0] < r[2] && r[0] < m[2] && m[1] < r[3] && r[1] < m[3])
        };
        let dict_of = |a: &Object| match a {
            Object::Reference(id) => self.doc.get_dictionary(*id).ok().cloned(),
            Object::Dictionary(d) => Some(d.clone()),
            _ => None,
        };
        let mut dropped: HashSet<ObjectId> = HashSet::new();
        let mut kept = Vec::new();
        let mut inline_dropped = false;
        for a in &annots {
            let over = dict_of(a)
                .and_then(|d| rect_of(&d))
                .is_some_and(|r| meets(&r));
            if over {
                match a.as_reference() {
                    Ok(id) => {
                        dropped.insert(id);
                    }
                    Err(_) => inline_dropped = true,
                }
            } else {
                kept.push(a.clone());
            }
        }
        // A popup goes with the annotation it belongs to.
        let kept: Vec<Object> = kept
            .into_iter()
            .filter(|a| {
                let parent = dict_of(a)
                    .and_then(|d| d.get(b"Parent").ok().and_then(|p| p.as_reference().ok()));
                let orphan = parent.is_some_and(|p| dropped.contains(&p))
                    && dict_of(a)
                        .and_then(|d| {
                            d.get(b"Subtype")
                                .ok()
                                .and_then(|s| s.as_name().ok().map(<[u8]>::to_vec))
                        })
                        .as_deref()
                        == Some(b"Popup".as_slice());
                if orphan {
                    if let Ok(id) = a.as_reference() {
                        dropped.insert(id);
                    }
                }
                !orphan
            })
            .collect();
        if dropped.is_empty() && !inline_dropped {
            return;
        }
        if let Ok(page) = self.doc.get_dictionary_mut(page_id) {
            if kept.is_empty() {
                page.remove(b"Annots");
            } else {
                page.set("Annots", Object::Array(kept));
            }
        }
        gone.extend(dropped);
    }

    /// A field whose every widget went goes too, up its tree: its value
    /// would otherwise stay in the file with nothing to show it.
    fn forget_fields_of(&self, gone: &mut HashSet<ObjectId>) {
        let mut queue: Vec<ObjectId> = gone.iter().copied().collect();
        let mut steps = 0;
        while let Some(id) = queue.pop() {
            steps += 1;
            if steps > 100_000 {
                break;
            }
            let Some(parent) = self
                .doc
                .get_dictionary(id)
                .ok()
                .and_then(|d| d.get(b"Parent").ok())
                .and_then(|p| p.as_reference().ok())
            else {
                continue;
            };
            if gone.contains(&parent) {
                continue;
            }
            let Ok(dict) = self.doc.get_dictionary(parent) else {
                continue;
            };
            // Only a field: an annotation's /Parent may be its markup's.
            if !dict.has(b"Kids") {
                continue;
            }
            let kids: Vec<ObjectId> = match dict.get(b"Kids") {
                Ok(Object::Array(k)) => k.iter().filter_map(|k| k.as_reference().ok()).collect(),
                Ok(Object::Reference(r)) => self
                    .doc
                    .get_object(*r)
                    .ok()
                    .and_then(|a| a.as_array().ok())
                    .map(|k| k.iter().filter_map(|k| k.as_reference().ok()).collect())
                    .unwrap_or_default(),
                _ => vec![],
            };
            if kids.iter().all(|k| gone.contains(k)) {
                gone.insert(parent);
                queue.push(parent);
            }
        }
    }

    /// Takes `/ActualText`, `/Alt` and `/E` off every structure element that
    /// holds one of `mcids` on the page, and off the elements above it: a
    /// replacement text there would still say what was cut.
    fn forget_structure_text(&mut self, page_id: ObjectId, mcids: &BTreeSet<i64>) {
        let Some(root) = self
            .doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"StructTreeRoot").ok())
            .and_then(|r| r.as_reference().ok())
        else {
            return;
        };
        // (element, its page, the elements above it)
        let mut stack: Vec<(ObjectId, Option<ObjectId>, Vec<ObjectId>)> =
            vec![(root, None, vec![])];
        let mut seen: HashSet<ObjectId> = HashSet::new();
        let mut hit: BTreeSet<ObjectId> = BTreeSet::new();
        while let Some((id, inherited, above)) = stack.pop() {
            if !seen.insert(id) || seen.len() > MAX_ELEMENTS || above.len() > 64 {
                continue;
            }
            let Ok(elem) = self.doc.get_dictionary(id) else {
                continue;
            };
            let page = elem
                .get(b"Pg")
                .ok()
                .and_then(|p| p.as_reference().ok())
                .or(inherited);
            let kids: Vec<Object> = match elem.get(b"K") {
                Ok(Object::Array(k)) => k.clone(),
                Ok(Object::Reference(r)) => match self.doc.get_object(*r) {
                    Ok(Object::Array(k)) => k.clone(),
                    _ => vec![Object::Reference(*r)],
                },
                Ok(k) => vec![k.clone()],
                Err(_) => vec![],
            };
            let mut path = above.clone();
            path.push(id);
            for kid in kids {
                let holds = match &kid {
                    Object::Integer(n) => page == Some(page_id) && mcids.contains(n),
                    Object::Dictionary(d) => {
                        let on = d
                            .get(b"Pg")
                            .ok()
                            .and_then(|p| p.as_reference().ok())
                            .or(page);
                        on == Some(page_id)
                            && d.get(b"MCID")
                                .ok()
                                .and_then(|m| m.as_i64().ok())
                                .is_some_and(|m| mcids.contains(&m))
                    }
                    Object::Reference(r) => {
                        stack.push((*r, page, path.clone()));
                        false
                    }
                    _ => false,
                };
                if holds {
                    hit.extend(path.iter().copied());
                }
            }
        }
        for id in hit {
            if let Ok(d) = self.doc.get_dictionary_mut(id) {
                for key in [b"ActualText".as_slice(), b"Alt", b"E"] {
                    d.remove(key);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
