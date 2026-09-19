//! Pictures on a page: found where they are drawn, then moved, resized,
//! turned, cropped, replaced, deleted — or new ones placed.
//!
//! A picture is drawn by `/Name Do` (an image XObject) or an inline image
//! (`BI … ID … EI`), under whatever transform the content set up before it.
//! The walker below follows that transform through `q`, `Q` and `cm`, into
//! the form XObjects the page draws, and reports where each picture lands:
//! the matrix that takes its unit square onto the page.
//!
//! An edit rewrites only the bytes of the one operation, in the one stream
//! that holds it (see `lex`). The picture is put in a small wrapper of
//! Warraq's,
//!
//! ```text
//! /WarraqImage BMC q <X> cm [<clip> re W n] <the picture, as it was> Q EMC
//! ```
//!
//! with `X` chosen so the picture lands where it was asked to. The next edit
//! finds the wrapper and replaces it whole, so edits do not pile up.
//!
//! Page marks are Warraq's own forms and are not listed here: the Page
//! marks tool looks after them.
use std::collections::HashMap;
use std::ops::Range;

use lopdf::{Dictionary, Object, ObjectId};

use crate::lex::{lex, Op, Operand};
use crate::pagework::{cm, name as name_text, num};
use crate::picture::add_picture;
use crate::text_walk::Matrix;
use crate::{Error, PdfDocument, Result};

const WRAPPER: &[u8] = b"WarraqImage";
/// Forms inside forms are followed this deep, no deeper.
const MAX_FORM_DEPTH: usize = 8;
/// A graphics-state stack deeper than this stops being tracked.
const MAX_STACK: usize = 1024;
/// No page reports more pictures than this.
const MAX_IMAGES: usize = 2000;
const FULL: [f32; 4] = [0.0, 0.0, 1.0, 1.0];

/// A picture on a page, as the interface is told about it.
#[derive(Debug, Clone, PartialEq)]
pub struct PlacedImage {
    /// Names this drawing of the picture until the page changes.
    pub id: String,
    /// The unit square onto the page as shown: points from its top-left
    /// corner, y down.
    pub matrix: [f32; 6],
    /// The part of the unit square that shows, `[u0, v0, u1, v1]`.
    pub clip: [f32; 4],
    /// Its size in pixels.
    pub pixels: (u32, u32),
    pub inline: bool,
    /// Drawn inside a form XObject.
    pub in_form: bool,
    /// The same bytes draw it more than once (a form used twice): an edit
    /// would change every one, so the interface does not offer it.
    pub shared: bool,
}

/// Where a picture is drawn, for an edit.
#[derive(Debug, Clone)]
struct Found {
    stream: ObjectId,
    /// What the edit replaces: the operation, or Warraq's wrapper round it.
    range: Range<usize>,
    /// The picture's own operation, as it is written.
    op: Vec<u8>,
    /// The transform before the wrapper (or at the operation, unwrapped).
    base: Matrix,
    /// The unit square onto user space.
    placement: Matrix,
    clip: [f32; 4],
    pixels: (u32, u32),
    inline: bool,
    /// Resources the operation's names are looked up in: the page's, or a form's.
    holder: Holder,
    shared: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Holder {
    Page,
    Form(ObjectId),
}

impl Found {
    fn id(&self) -> String {
        format!("{}.{}@{}", self.stream.0, self.stream.1, self.range.start)
    }
}

fn resolve<'a>(pdf: &'a PdfDocument, o: &'a Object) -> &'a Object {
    match o {
        Object::Reference(id) => pdf.doc.get_object(*id).unwrap_or(o),
        other => other,
    }
}

fn int(o: Option<&Object>) -> u32 {
    o.and_then(|v| v.as_float().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map_or(0, |v| v.min(1.0e6) as u32)
}

struct Walker<'a> {
    pdf: &'a PdfDocument,
    found: Vec<Found>,
    seen: HashMap<(ObjectId, usize), usize>,
}

/// The graphics state the walker keeps: the transform, and its saved copies.
struct State {
    ctm: Matrix,
    stack: Vec<Matrix>,
}

impl<'a> Walker<'a> {
    fn lookup(
        &self,
        resources: &[&'a Dictionary],
        name: &[u8],
    ) -> Option<(ObjectId, &'a lopdf::Stream)> {
        resources.iter().find_map(|dict| {
            let group = resolve(self.pdf, dict.get(b"XObject").ok()?)
                .as_dict()
                .ok()?;
            let id = group.get(name).ok()?.as_reference().ok()?;
            let stream = self.pdf.doc.get_object(id).ok()?.as_stream().ok()?;
            Some((id, stream))
        })
    }

    fn record(&mut self, mut found: Found) {
        let key = (found.stream, found.range.start);
        if let Some(k) = self.seen.get(&key) {
            self.found[*k].shared = true;
            return;
        }
        if self.found.len() >= MAX_IMAGES {
            return;
        }
        found.shared = false;
        self.seen.insert(key, self.found.len());
        self.found.push(found);
    }

    /// One content stream, carrying the state across from the one before.
    #[allow(clippy::too_many_arguments)]
    fn stream(
        &mut self,
        id: ObjectId,
        resources: &[&'a Dictionary],
        state: &mut State,
        depth: usize,
        holder: Holder,
    ) {
        let Ok(bytes) = self.pdf.stream_bytes(id) else {
            return;
        };
        let ops = lex(&bytes);
        let mut k = 0;
        while k < ops.len() {
            let op = &ops[k];
            if op.is("BMC") && op.name(0) == Some(WRAPPER) {
                if let Some((end, found)) =
                    self.wrapper(&bytes, &ops, k, id, resources, state.ctm, holder)
                {
                    self.record(found);
                    k = end + 1;
                    continue;
                }
            }
            match op.operator.as_slice() {
                b"q" => {
                    if state.stack.len() < MAX_STACK {
                        state.stack.push(state.ctm);
                    }
                }
                b"Q" => {
                    if let Some(m) = state.stack.pop() {
                        state.ctm = m;
                    }
                }
                b"cm" => {
                    if let Some(m) = op.matrix() {
                        state.ctm = Matrix(m).then(state.ctm);
                    }
                }
                b"Do" => {
                    if let Some(name) = op.name(0) {
                        self.draw(&bytes, op, name, id, resources, state.ctm, depth, holder);
                    }
                }
                b"BI" => {
                    self.record(Found {
                        stream: id,
                        range: op.range.clone(),
                        op: bytes[op.range.clone()].to_vec(),
                        base: state.ctm,
                        placement: state.ctm,
                        clip: FULL,
                        pixels: inline_size(op),
                        inline: true,
                        holder,
                        shared: false,
                    });
                }
                _ => {}
            }
            k += 1;
        }
    }

    /// `/Name Do`: a picture is recorded, a form is walked into.
    #[allow(clippy::too_many_arguments)]
    fn draw(
        &mut self,
        bytes: &[u8],
        op: &Op,
        name: &[u8],
        id: ObjectId,
        resources: &[&'a Dictionary],
        ctm: Matrix,
        depth: usize,
        holder: Holder,
    ) {
        let Some((xobject, stream)) = self.lookup(resources, name) else {
            return;
        };
        match stream
            .dict
            .get(b"Subtype")
            .ok()
            .and_then(|s| s.as_name().ok())
        {
            Some(b"Image") => self.record(Found {
                stream: id,
                range: op.range.clone(),
                op: bytes[op.range.clone()].to_vec(),
                base: ctm,
                placement: ctm,
                clip: FULL,
                pixels: (
                    int(stream.dict.get(b"Width").ok()),
                    int(stream.dict.get(b"Height").ok()),
                ),
                inline: false,
                holder,
                shared: false,
            }),
            Some(b"Form") if depth < MAX_FORM_DEPTH => {
                // Page marks are Warraq's own, and their tool's business.
                if stream.dict.has(b"PieceInfo") {
                    let piece = resolve(
                        self.pdf,
                        stream.dict.get(b"PieceInfo").unwrap_or(&Object::Null),
                    );
                    if piece.as_dict().is_ok_and(|p| p.has(b"Warraq")) {
                        return;
                    }
                }
                let matrix = stream
                    .dict
                    .get(b"Matrix")
                    .ok()
                    .and_then(|m| resolve(self.pdf, m).as_array().ok())
                    .and_then(|a| {
                        let v: Vec<f32> = a.iter().filter_map(|n| n.as_float().ok()).collect();
                        (v.len() == 6 && v.iter().all(|n| n.is_finite()))
                            .then(|| Matrix([v[0], v[1], v[2], v[3], v[4], v[5]]))
                    })
                    .unwrap_or(Matrix::IDENTITY);
                let own = stream
                    .dict
                    .get(b"Resources")
                    .ok()
                    .and_then(|r| resolve(self.pdf, r).as_dict().ok());
                let inner: Vec<&Dictionary> = match own {
                    Some(own) => std::iter::once(own)
                        .chain(resources.iter().copied())
                        .collect(),
                    None => resources.to_vec(),
                };
                let mut state = State {
                    ctm: matrix.then(ctm),
                    stack: Vec::new(),
                };
                self.stream(
                    xobject,
                    &inner,
                    &mut state,
                    depth + 1,
                    Holder::Form(xobject),
                );
            }
            _ => {}
        }
    }

    /// `/WarraqImage BMC q X cm [x y w h re W n] <picture> Q EMC`, at `k`.
    #[allow(clippy::too_many_arguments)]
    fn wrapper(
        &self,
        bytes: &[u8],
        ops: &[Op],
        k: usize,
        id: ObjectId,
        resources: &[&'a Dictionary],
        base: Matrix,
        holder: Holder,
    ) -> Option<(usize, Found)> {
        let at = |j: usize| ops.get(k + j);
        if !at(1)?.is("q") {
            return None;
        }
        let x = Matrix(at(2)?.matrix()?);
        let mut j = 3;
        let mut clip = FULL;
        if at(j)?.is("re") {
            let r = at(j)?;
            let (u, v, w, h) = (r.number(0)?, r.number(1)?, r.number(2)?, r.number(3)?);
            clip = [u, v, u + w, v + h];
            if !(at(j + 1)?.is("W") && at(j + 2)?.is("n")) {
                return None;
            }
            j += 3;
        }
        let picture = at(j)?;
        let (inline, pixels) = if picture.is("BI") {
            (true, inline_size(picture))
        } else if picture.is("Do") {
            let (_, stream) = self.lookup(resources, picture.name(0)?)?;
            if stream.dict.get(b"Subtype").ok()?.as_name().ok()? != b"Image" {
                return None;
            }
            (
                false,
                (
                    int(stream.dict.get(b"Width").ok()),
                    int(stream.dict.get(b"Height").ok()),
                ),
            )
        } else {
            return None;
        };
        if !(at(j + 1)?.is("Q") && at(j + 2)?.is("EMC")) {
            return None;
        }
        let end = k + j + 2;
        Some((
            end,
            Found {
                stream: id,
                range: ops[k].range.start..ops[end].range.end,
                op: bytes[picture.range.clone()].to_vec(),
                base,
                placement: x.then(base),
                clip,
                pixels,
                inline,
                holder,
                shared: false,
            },
        ))
    }
}

fn inline_size(op: &Op) -> (u32, u32) {
    let get = |short: &[u8], long: &[u8]| {
        op.operands
            .windows(2)
            .find_map(|w| match (&w[0].0, &w[1].0) {
                (Operand::Name(k), Operand::Number(v)) if k == short || k == long => Some(*v),
                _ => None,
            })
    };
    let n = |v: Option<f32>| {
        v.filter(|v| v.is_finite() && *v >= 0.0)
            .map_or(0, |v| v.min(1.0e6) as u32)
    };
    (n(get(b"W", b"Width")), n(get(b"H", b"Height")))
}

/// Warraq's wrapper round a picture, landing it at `placement`.
fn wrap(op: &[u8], base: Matrix, placement: Matrix, clip: [f32; 4]) -> Result<Vec<u8>> {
    let x = placement.then(
        base.invert()
            .ok_or_else(|| Error::Edit("the picture's transform cannot be undone".into()))?,
    );
    let mut out = format!("/WarraqImage BMC q {}\n", cm(x.0)).into_bytes();
    if clip != FULL {
        let [u0, v0, u1, v1] = clip;
        out.extend_from_slice(
            format!(
                "{} {} {} {} re W n\n",
                num(u0),
                num(v0),
                num(u1 - u0),
                num(v1 - v0)
            )
            .as_bytes(),
        );
    }
    out.extend_from_slice(op);
    out.extend_from_slice(b"\nQ EMC");
    Ok(out)
}

/// A matrix that is finite and not flat.
fn usable(m: Matrix) -> bool {
    m.0.iter().all(|v| v.is_finite()) && m.invert().is_some()
}

impl PdfDocument {
    fn find_images(&self, index: usize) -> Result<(Vec<Found>, Matrix)> {
        self.walk_images(index, None)
    }

    /// The pictures of the page's first `streams` content streams (all of
    /// them when `None`), and the transform in effect after them.
    fn walk_images(&self, index: usize, streams: Option<usize>) -> Result<(Vec<Found>, Matrix)> {
        let page_id = self.page_id(index)?;
        let resources: Vec<&Dictionary> = self.page_resources(page_id).into_iter().collect();
        let mut walker = Walker {
            pdf: self,
            found: Vec::new(),
            seen: HashMap::new(),
        };
        let mut state = State {
            ctm: Matrix::IDENTITY,
            stack: Vec::new(),
        };
        let ids = self.content_ids(page_id);
        for id in ids.iter().take(streams.unwrap_or(ids.len())) {
            walker.stream(*id, &resources, &mut state, 0, Holder::Page);
        }
        Ok((walker.found, state.ctm))
    }

    /// The pictures on page `index`, in drawing order.
    pub fn list_images(&self, index: usize) -> Result<Vec<PlacedImage>> {
        let to_display = self
            .display_frame(index)?
            .display_to_user()
            .invert()
            .unwrap_or(Matrix::IDENTITY);
        Ok(self
            .find_images(index)?
            .0
            .into_iter()
            .map(|f| PlacedImage {
                id: f.id(),
                matrix: f.placement.then(to_display).0,
                clip: f.clip,
                pixels: f.pixels,
                inline: f.inline,
                in_form: f.holder != Holder::Page,
                shared: f.shared,
            })
            .collect())
    }

    fn found(&self, index: usize, id: &str) -> Result<Found> {
        let found = self
            .find_images(index)?
            .0
            .into_iter()
            .find(|f| f.id() == id)
            .ok_or_else(|| Error::Edit(format!("no picture {id} on page {}", index + 1)))?;
        if found.shared {
            return Err(Error::Edit(
                "this picture is drawn in several places at once and cannot be changed alone"
                    .into(),
            ));
        }
        Ok(found)
    }

    fn splice(&mut self, found: &Found, with: &[u8]) -> Result<()> {
        let mut bytes = self.stream_bytes(found.stream)?;
        if found.range.end > bytes.len() {
            return Err(Error::Edit("the page changed under the edit".into()));
        }
        bytes.splice(found.range.clone(), with.iter().copied());
        self.set_stream_bytes(found.stream, bytes)
    }

    /// Moves, resizes or turns a picture: `matrix` is where its unit square
    /// should land on the page as shown (points from the top-left, y down),
    /// and `clip` the part of it that shows (`None` keeps the crop it has).
    pub fn transform_image(
        &mut self,
        index: usize,
        id: &str,
        matrix: [f32; 6],
        clip: Option<[f32; 4]>,
    ) -> Result<()> {
        let found = self.found(index, id)?;
        let to_user = self.display_frame(index)?.display_to_user();
        let placement = Matrix(matrix).then(to_user);
        if !usable(placement) {
            return Err(Error::Edit("a picture cannot be made that shape".into()));
        }
        let clip = clip.unwrap_or(found.clip);
        let clip = [
            clip[0].clamp(0.0, 1.0),
            clip[1].clamp(0.0, 1.0),
            clip[2].clamp(0.0, 1.0),
            clip[3].clamp(0.0, 1.0),
        ];
        if clip[2] - clip[0] < 0.01 || clip[3] - clip[1] < 0.01 {
            return Err(Error::Edit("the crop leaves nothing of the picture".into()));
        }
        let bytes = wrap(&found.op, found.base, placement, clip)?;
        self.splice(&found, &bytes)
    }

    /// Takes a picture off the page.
    pub fn delete_image(&mut self, index: usize, id: &str) -> Result<()> {
        let found = self.found(index, id)?;
        self.splice(&found, b"")
    }

    /// Puts another picture (PNG or JPEG bytes) where one is, fitted inside
    /// the part of it that showed and keeping its own proportions.
    pub fn replace_image(&mut self, index: usize, id: &str, picture: &[u8]) -> Result<()> {
        let found = self.found(index, id)?;
        let added = add_picture(&mut self.doc, picture)?;
        let name = match found.holder {
            Holder::Page => {
                let page_id = self.page_id(index)?;
                self.own_resources(page_id)?;
                self.add_xobject(page_id, "WqImg", added.id)?
            }
            Holder::Form(form) => self.add_form_xobject(form, added.id)?,
        };
        // The part that showed, as its own unit square.
        let [u0, v0, u1, v1] = found.clip;
        let shown = Matrix([u1 - u0, 0.0, 0.0, v1 - v0, u0, v0]).then(found.placement);
        let m = shown.0;
        let (w, h) = (
            (m[0] * m[0] + m[1] * m[1]).sqrt(),
            (m[2] * m[2] + m[3] * m[3]).sqrt(),
        );
        let want = added.width as f32 / added.height.max(1) as f32;
        let fit = if w / h.max(1e-6) > want {
            let s = (h * want / w.max(1e-6)).clamp(0.0, 1.0);
            Matrix([s, 0.0, 0.0, 1.0, (1.0 - s) / 2.0, 0.0])
        } else {
            let s = (w / want / h.max(1e-6)).clamp(0.0, 1.0);
            Matrix([1.0, 0.0, 0.0, s, 0.0, (1.0 - s) / 2.0])
        };
        let op = format!("{} Do", name_text(&name)).into_bytes();
        let bytes = wrap(&op, found.base, fit.then(shown), FULL)?;
        self.splice(&found, &bytes)
    }

    /// Places a new picture on page `index`, its unit square landing at
    /// `matrix` on the page as shown. Returns its id.
    pub fn add_image(&mut self, index: usize, matrix: [f32; 6], picture: &[u8]) -> Result<String> {
        let to_user = self.display_frame(index)?.display_to_user();
        let placement = Matrix(matrix).then(to_user);
        if !usable(placement) {
            return Err(Error::Edit("a picture cannot be made that shape".into()));
        }
        let page_id = self.page_id(index)?;
        let added = add_picture(&mut self.doc, picture)?;
        self.own_resources(page_id)?;
        let name = self.add_xobject(page_id, "WqImg", added.id)?;
        // Drawn after the page's own content, before any page mark in front.
        let ids = self.content_ids(page_id);
        let after_marks = ids.iter().position(|id| {
            self.doc
                .get_object(*id)
                .and_then(Object::as_stream)
                .is_ok_and(|s| {
                    s.dict.get(b"WarraqMarks").and_then(Object::as_name).ok() == Some(b"After")
                })
        });
        // The transform in effect where the new stream goes: after the
        // page's content, before the marks' closing stream.
        let (_, base) = self.walk_images(index, after_marks)?;
        let base = if usable(base) { base } else { Matrix::IDENTITY };
        let op = format!("{} Do", name_text(&name)).into_bytes();
        let stream = self.new_stream(Dictionary::new(), wrap(&op, base, placement, FULL)?);
        let mut ids = ids;
        match after_marks {
            Some(k) => ids.insert(k, stream),
            None => ids.push(stream),
        }
        self.set_contents(
            page_id,
            Object::Array(ids.into_iter().map(Object::Reference).collect()),
        )?;
        let found = self
            .find_images(index)?
            .0
            .into_iter()
            .find(|f| f.stream == stream)
            .ok_or_else(|| Error::Edit("the new picture was not found on its page".into()))?;
        Ok(found.id())
    }

    /// Registers a picture in a form's own resources.
    fn add_form_xobject(&mut self, form: ObjectId, id: ObjectId) -> Result<Vec<u8>> {
        let dict = &self
            .doc
            .get_object(form)
            .and_then(Object::as_stream)
            .map_err(|e| Error::Parse(e.to_string()))?
            .dict;
        let (holder, mut resources) = match dict.get(b"Resources") {
            Ok(Object::Reference(r)) => (
                Some(*r),
                self.doc.get_dictionary(*r).cloned().unwrap_or_default(),
            ),
            Ok(Object::Dictionary(d)) => (None, d.clone()),
            _ => (None, Dictionary::new()),
        };
        let mut group = match resources.get(b"XObject") {
            Ok(Object::Reference(r)) => self.doc.get_dictionary(*r).cloned().unwrap_or_default(),
            Ok(Object::Dictionary(d)) => d.clone(),
            _ => Dictionary::new(),
        };
        let mut n = 1;
        while group.has(format!("WqImg{n}").as_bytes()) {
            n += 1;
        }
        let name = format!("WqImg{n}").into_bytes();
        group.set(name.clone(), Object::Reference(id));
        resources.set("XObject", Object::Dictionary(group));
        match holder {
            Some(r) => {
                *self
                    .doc
                    .get_dictionary_mut(r)
                    .map_err(|e| Error::Parse(e.to_string()))? = resources;
                self.mark_touched(r);
            }
            None => {
                self.doc
                    .get_object_mut(form)
                    .and_then(Object::as_stream_mut)
                    .map_err(|e| Error::Parse(e.to_string()))?
                    .dict
                    .set("Resources", Object::Dictionary(resources));
                self.mark_touched(form);
            }
        }
        Ok(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::picture::tests::{jpeg, png};
    use lopdf::dictionary;

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn close(a: [f32; 6], b: [f32; 6]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 0.05)
    }

    #[test]
    fn a_scans_picture_is_found_where_it_covers_the_page() {
        let doc = PdfDocument::open(corpus("scan-arial-200dpi-bilevel.pdf"), None).unwrap();
        let images = doc.list_images(0).unwrap();
        assert_eq!(images.len(), 1, "{images:?}");
        let (w, h) = doc.page_size(0).unwrap();
        let m = images[0].matrix;
        // Upright, covering the page: x from 0 to w, y down from h to 0.
        assert!(close(m, [w, 0.0, 0.0, -h, 0.0, h]), "{m:?}");
        assert!(images[0].pixels.0 > 1000);
    }

    #[test]
    fn a_placed_picture_moves_resizes_turns_crops_and_goes_with_the_expected_transform() {
        let original = corpus("chrome-notonaskh-justified-3pages.pdf");
        let mut doc = PdfDocument::open(original.clone(), None).unwrap();
        let page = doc.page_id(0).unwrap();
        let own: Vec<(ObjectId, Vec<u8>)> = doc
            .content_ids(page)
            .into_iter()
            .map(|id| (id, doc.stream_bytes(id).unwrap()))
            .collect();
        // 100×50 points, its top-left 72 points in and down.
        let at = [100.0, 0.0, 0.0, -50.0, 72.0, 122.0];
        let id = doc.add_image(0, at, &png(40, 20)).unwrap();
        let listed = doc.list_images(0).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(close(listed[0].matrix, at), "{:?}", listed[0].matrix);
        // In user space (A4, no crop offset): y up from the bottom.
        let (_, height) = doc.page_size(0).unwrap();
        let user = doc.find_images(0).unwrap().0[0].placement.0;
        assert!(
            close(user, [100.0, 0.0, 0.0, 50.0, 72.0, height - 122.0]),
            "{user:?}"
        );

        // Moved and doubled.
        let moved = [200.0, 0.0, 0.0, -100.0, 150.0, 400.0];
        doc.transform_image(0, &id, moved, None).unwrap();
        let listed = doc.list_images(0).unwrap();
        assert_eq!(
            listed.len(),
            1,
            "the edit replaced the wrapper, it did not nest"
        );
        assert!(close(listed[0].matrix, moved));
        let id = listed[0].id.clone();

        // Turned a quarter clockwise about its centre (x' = -y, y' = x on screen).
        let turned = [0.0, 200.0, 100.0, 0.0, 200.0, 250.0];
        doc.transform_image(0, &id, turned, Some([0.25, 0.0, 1.0, 1.0]))
            .unwrap();
        let listed = doc.list_images(0).unwrap();
        assert!(close(listed[0].matrix, turned));
        assert_eq!(listed[0].clip, [0.25, 0.0, 1.0, 1.0]);

        // Replaced: a square picture fits inside the part that showed.
        let id = listed[0].id.clone();
        doc.replace_image(0, &id, &jpeg(30, 30)).unwrap();
        let listed = doc.list_images(0).unwrap();
        assert_eq!(listed[0].pixels, (30, 30));
        assert_eq!(listed[0].clip, FULL);

        // The page's own streams were never touched, and survive a save.
        for (sid, bytes) in &own {
            assert_eq!(&doc.stream_bytes(*sid).unwrap(), bytes);
        }
        let saved = doc.save_incremental().unwrap();
        assert!(saved.starts_with(&original));
        let mut doc = PdfDocument::open(saved, None).unwrap();
        let id = doc.list_images(0).unwrap()[0].id.clone();
        doc.delete_image(0, &id).unwrap();
        assert!(doc.list_images(0).unwrap().is_empty());
    }

    #[test]
    fn an_existing_picture_is_rewritten_in_its_own_stream_only() {
        let original = corpus("scan-arial-200dpi-bilevel.pdf");
        let mut doc = PdfDocument::open(original, None).unwrap();
        let image = doc.list_images(0).unwrap().remove(0);
        let half = [
            image.matrix[0] / 2.0,
            0.0,
            0.0,
            image.matrix[3] / 2.0,
            image.matrix[4] + 10.0,
            image.matrix[5] - 10.0,
        ];
        doc.transform_image(0, &image.id, half, None).unwrap();
        let after = doc.list_images(0).unwrap();
        assert!(close(after[0].matrix, half), "{:?}", after[0].matrix);
        // Nothing else in the stream moved: the text layer, if any, reads as before.
        assert!(doc
            .transform_image(0, "no-such-picture", half, None)
            .is_err());
        assert!(doc
            .transform_image(0, &after[0].id, [0.0, 0.0, 0.0, 0.0, 1.0, 1.0], None)
            .is_err());
    }

    #[test]
    fn inline_images_and_forms_are_found_and_edited_too() {
        let mut doc =
            PdfDocument::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        let page = doc.page_id(0).unwrap();
        // An inline 2×2 grey picture, and a form that draws it again, moved.
        let inline =
            b"q 50 0 0 50 300 300 cm BI /W 2 /H 2 /BPC 8 /CS /G ID \x00\xff\xff\x00 EI Q".to_vec();
        let form = doc.new_stream(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form",
                "BBox" => [0, 0, 100, 100].map(Object::Integer).to_vec(),
                "Matrix" => [1, 0, 0, 1, 20, 30].map(Object::Integer).to_vec(),
            },
            b"q 10 0 0 10 0 0 cm BI /W 1 /H 1 /BPC 8 /CS /G ID \x80 EI Q".to_vec(),
        );
        doc.own_resources(page).unwrap();
        let name = doc.add_xobject(page, "Fm", form).unwrap();
        let mut extra = inline.clone();
        extra.extend_from_slice(format!(" {} Do", name_text(&name)).as_bytes());
        let s = doc.new_stream(Dictionary::new(), extra);
        let mut ids = doc.content_ids(page);
        ids.push(s);
        doc.set_contents(
            page,
            Object::Array(ids.into_iter().map(Object::Reference).collect()),
        )
        .unwrap();

        let images = doc.list_images(0).unwrap();
        assert_eq!(images.len(), 2, "{images:?}");
        assert!(images[0].inline && !images[0].in_form);
        assert_eq!(images[0].pixels, (2, 2));
        assert!(images[1].in_form);
        // Chrome leaves a transform in effect after its content; both
        // pictures are drawn under it.
        let first = doc.find_images(0).unwrap().0[0].placement;
        let after = Matrix([50.0, 0.0, 0.0, 50.0, 300.0, 300.0])
            .invert()
            .unwrap()
            .then(first);
        let to_display = doc
            .display_frame(0)
            .unwrap()
            .display_to_user()
            .invert()
            .unwrap();
        let want = Matrix([10.0, 0.0, 0.0, 10.0, 20.0, 30.0])
            .then(after)
            .then(to_display)
            .0;
        assert!(close(images[1].matrix, want), "{:?}", images[1].matrix);

        let moved = [80.0, 0.0, 0.0, -80.0, 10.0, 100.0];
        doc.transform_image(0, &images[0].id.clone(), moved, None)
            .unwrap();
        doc.transform_image(0, &images[1].id.clone(), moved, None)
            .unwrap();
        let images = doc.list_images(0).unwrap();
        assert!(
            close(images[0].matrix, moved) && close(images[1].matrix, moved),
            "{images:?}"
        );
        // Replacing the one in the form puts the new picture in the form's resources.
        doc.replace_image(0, &images[1].id.clone(), &png(8, 8))
            .unwrap();
        assert_eq!(doc.list_images(0).unwrap()[1].pixels, (8, 8));
    }

    /// Chrome leaves a transform in effect after its content, and page marks
    /// close the page's state again after it: a picture placed on such a
    /// page goes between the two, under the page's transform, and still
    /// lands where it was asked to — in front of the page, behind the marks.
    #[test]
    fn a_picture_placed_on_a_marked_page_lands_where_it_was_asked() {
        const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
        let mut doc =
            PdfDocument::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        let mark = crate::marks::tests::mark(
            crate::MarkKind::Footer,
            crate::MarkContent::Band {
                slots: ["x".into(), String::new(), String::new()],
                direction: crate::SlotDirection::Ltr,
            },
        );
        doc.add_mark(&mark, &[0], Some(AMIRI), true).unwrap();
        let at = [100.0, 0.0, 0.0, -50.0, 72.0, 122.0];
        doc.add_image(0, at, &png(4, 2)).unwrap();
        let listed = doc.list_images(0).unwrap();
        assert!(close(listed[0].matrix, at), "{:?}", listed[0].matrix);
        let page = doc.page_id(0).unwrap();
        let ids = doc.content_ids(page);
        let last = doc
            .doc
            .get_object(*ids.last().unwrap())
            .unwrap()
            .as_stream()
            .unwrap();
        assert!(
            last.dict.has(b"WarraqMarks"),
            "the marks still close the page"
        );
        // Taking the mark off keeps the picture.
        doc.remove_marks(&[], &[]).unwrap();
        assert!(close(doc.list_images(0).unwrap()[0].matrix, at));
    }
}
