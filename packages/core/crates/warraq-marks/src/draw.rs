//! Drawing a mark: tokens expanded per page, text laid out and shaped by warraq-edit's layout
//! (harfrust, UAX #9 visual runs, one `/Span <</ActualText …>> BDC` per word, fill only, never
//! `/Direction`), bundled Amiri/Cairo/Inter subsets embedded once per mark, opacity through an
//! ExtGState, pictures as image XObjects; each page gets a form XObject in its displayed
//! (upright, CropBox-relative) space and a mark stream tagged as a pagination artifact.

use std::collections::{BTreeMap, HashMap};

use lopdf::{Dictionary, Object, ObjectId};
use warraq_edit::content::{fmt_name, fmt_num};
use warraq_edit::fonts::{bundled, embed_face, Bundled, Face, FaceSource, Family, Written};
use warraq_edit::geom::{Matrix, Rect};
use warraq_edit::layout::{layout, Align, Laid, Request};
use warraq_edit::page::{add_resource, new_stream};
use warraq_pdf::pages::PageInfo;
use warraq_pdf::Pdf;

use crate::error::{MarkError, Result};
use crate::geom::{anchor, angle, displayed, place, rotated_size};
use crate::model::{Font, Horizontal, Layer, MarkSpec};
use crate::store::{self, Wrappers, KEY};
use crate::tokens::{expand, Context};

/// Most distinct texts laid out for one mark (each page's own page number counts).
pub const MAX_TEXTS: usize = 200_000;

fn cm(m: &Matrix) -> String {
    let v = m.to_array();
    format!(
        "{} {} {} {} {} {} cm",
        fmt_num(v[0]),
        fmt_num(v[1]),
        fmt_num(v[2]),
        fmt_num(v[3]),
        fmt_num(v[4]),
        fmt_num(v[5])
    )
}

fn preferred(font: Font) -> (Bundled, Family) {
    match font {
        Font::Amiri => (Bundled::AmiriRegular, Family::Serif),
        Font::Cairo => (Bundled::CairoRegular, Family::Sans),
        Font::Inter => (Bundled::InterRegular, Family::Sans),
    }
}

/// The chosen face when it covers every visible character; otherwise the family's fallback chain.
fn face_for(font: Font, text: &str) -> Result<(Option<&'static Face>, Family)> {
    let (b, fam) = preferred(font);
    let f = bundled(b)?;
    let covers = f.shaper().is_some_and(|s| {
        text.chars()
            .filter(|c| !c.is_whitespace())
            .all(|c| s.covers(c))
    });
    Ok((covers.then_some(f), fam))
}

/// One page to draw: index, position among the marked pages, page info.
pub struct Target {
    pub index: usize,
    pub ordinal: usize,
    pub info: PageInfo,
}

/// Picture of a watermark: the image XObject and its size in pixels.
#[derive(Debug, Clone, Copy)]
pub struct PictureRef {
    pub id: ObjectId,
    pub width: f64,
    pub height: f64,
}

/// Read an image XObject's size.
pub fn picture_ref(pdf: &Pdf, id: ObjectId) -> Option<PictureRef> {
    let Some(Object::Stream(s)) = pdf.get(id) else {
        return None;
    };
    let num = |k: &[u8]| match s.dict.get(k).ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::Integer(i)) if *i > 0 => Some(*i as f64),
        _ => None,
    };
    Some(PictureRef {
        id,
        width: num(b"Width")?,
        height: num(b"Height")?,
    })
}

/// Draw `spec` on `targets`. `info` is the mark's info dictionary, `id` its identifier.
pub fn draw(
    pdf: &mut Pdf,
    spec: &MarkSpec,
    id: &str,
    info: ObjectId,
    picture: Option<PictureRef>,
    targets: &[Target],
    total_pages: usize,
) -> Result<()> {
    if targets.is_empty() {
        return Ok(());
    }
    // 1. Texts per page (after tokens).
    let items = spec.items();
    let mut texts: Vec<String> = Vec::new();
    let mut index_of: HashMap<String, usize> = HashMap::new();
    let mut per_page: Vec<Vec<(Horizontal, usize)>> = Vec::with_capacity(targets.len());
    for t in targets {
        let ctx = Context {
            page: t.index + 1,
            pages: total_pages,
            ordinal: t.ordinal,
            now: spec.now,
            file: &spec.file_name,
            bates: spec.bates.as_ref(),
            digits: spec.digits,
            lang: spec.lang,
        };
        let mut mine = Vec::new();
        for (h, tpl) in &items {
            let s = expand(tpl, &ctx);
            if s.trim().is_empty() {
                continue;
            }
            let i = match index_of.get(&s) {
                Some(i) => *i,
                None => {
                    if texts.len() >= MAX_TEXTS {
                        return Err(MarkError::Limit("too many different texts".into()));
                    }
                    texts.push(s.clone());
                    index_of.insert(s, texts.len() - 1);
                    texts.len() - 1
                }
            };
            mine.push((*h, i));
        }
        per_page.push(mine);
    }
    // 2. Layout every distinct text once.
    let mut laid: Vec<Laid<'_>> = Vec::with_capacity(texts.len());
    for s in &texts {
        let (original, family) = face_for(spec.font, s)?;
        laid.push(layout(&Request {
            text: s,
            x0: 0.0,
            top: 0.0,
            width: 100_000.0,
            size: spec.size(),
            line_height: None,
            align: Align::Center,
            rtl: None,
            family,
            bold: false,
            original,
        })?);
    }
    // 3. Embed each face once (subset to every glyph the mark uses).
    // How every word is written (glyph ToUnicode or /ActualText, ADR 0020), per laid text.
    let encoded: Vec<_> = laid.iter().map(|l| l.encode()).collect();
    let mut used: BTreeMap<FaceSource, (&Face, BTreeMap<u16, String>)> = BTreeMap::new();
    for (l, (_, maps)) in laid.iter().zip(&encoded) {
        for (fi, glyphs) in l.used(maps).into_iter().enumerate() {
            let Some(face) = l.faces.get(fi) else {
                continue;
            };
            let e = used
                .entry(face.source.clone())
                .or_insert_with(|| (*face, BTreeMap::new()));
            for (g, t) in glyphs {
                let slot = e.1.entry(g).or_default();
                if slot.is_empty() {
                    *slot = t;
                }
            }
        }
    }
    let mut fonts = Dictionary::new();
    let mut written: BTreeMap<FaceSource, Written> = BTreeMap::new();
    for (n, (src, (face, glyphs))) in used.iter().enumerate() {
        let (font_id, cid) = embed_face(pdf, face, glyphs)?;
        let name = format!("ZF{}", n + 1).into_bytes();
        fonts.set(name.clone(), Object::Reference(font_id));
        written.insert(
            src.clone(),
            Written {
                resource: name,
                cid,
            },
        );
    }
    // 4. Shared resources of the mark's forms.
    let mut res = Dictionary::new();
    if !fonts.is_empty() {
        res.set("Font", Object::Dictionary(fonts));
    }
    let opacity = spec.opacity();
    if opacity < 1.0 {
        let mut gs = Dictionary::new();
        gs.set("Type", Object::Name(b"ExtGState".to_vec()));
        gs.set("ca", Object::Real(opacity as f32));
        gs.set("CA", Object::Real(opacity as f32));
        let mut g = Dictionary::new();
        g.set("ZG1", Object::Dictionary(gs));
        res.set("ExtGState", Object::Dictionary(g));
    }
    if let Some(p) = picture {
        let mut x = Dictionary::new();
        x.set("ZI1", Object::Reference(p.id));
        res.set("XObject", Object::Dictionary(x));
    }
    let res_id = pdf.add(Object::Dictionary(res));
    // 5. One form per distinct drawing; one mark stream per page.
    let fill = spec.color();
    let front = spec.layer() == Layer::Front;
    let subtype = spec.artifact_subtype();
    let mut forms: HashMap<Vec<u8>, ObjectId> = HashMap::new();
    let mut wrappers: Option<(ObjectId, ObjectId)> = None;
    for (t, mine) in targets.iter().zip(&per_page) {
        let d = displayed(&t.info);
        if !(d.width > 0.0 && d.height > 0.0) {
            continue;
        }
        let deg = angle(spec, &d);
        let mut body = String::new();
        if opacity < 1.0 {
            body.push_str("/ZG1 gs\n");
        }
        if let Some(p) = picture {
            let pw = spec.scale() * d.width;
            let ph = pw * p.height / p.width.max(1.0);
            let r = Rect::new(0.0, 0.0, pw, ph);
            let (bw, bh) = rotated_size(&r, deg);
            let c = anchor(spec, &d, spec.horizontal(), spec.vertical(), bw, bh);
            let m = Matrix::scale(pw, ph).then(&place(&r, deg, c));
            body.push_str(&format!("q {} /ZI1 Do Q\n", cm(&m)));
        }
        for (h, ti) in mine {
            let (Some(l), Some((spans, _))) = (laid.get(*ti), encoded.get(*ti)) else {
                continue;
            };
            let w: Vec<Written> = l
                .faces
                .iter()
                .map(|f| {
                    written.get(&f.source).cloned().unwrap_or(Written {
                        resource: b"ZF1".to_vec(),
                        cid: BTreeMap::new(),
                    })
                })
                .collect();
            let (bw, bh) = rotated_size(&l.bbox, deg);
            let c = anchor(spec, &d, *h, spec.vertical(), bw, bh);
            let m = place(&l.bbox, deg, c);
            body.push_str(&format!("q {}\n", cm(&m)));
            body.push_str(&String::from_utf8_lossy(&l.content(&w, fill, spans)));
            body.push_str("Q\n");
        }
        let matrix = d.to_user.to_array();
        let mut key = body.clone().into_bytes();
        key.extend(format!("|{}|{}|{matrix:?}", d.width, d.height).bytes());
        let form = match forms.get(&key) {
            Some(f) => *f,
            None => {
                let mut fd = Dictionary::new();
                fd.set("Type", Object::Name(b"XObject".to_vec()));
                fd.set("Subtype", Object::Name(b"Form".to_vec()));
                fd.set("FormType", 1);
                fd.set(
                    "BBox",
                    Object::Array(
                        [0.0, 0.0, d.width, d.height]
                            .iter()
                            .map(|v| Object::Real(*v as f32))
                            .collect(),
                    ),
                );
                fd.set(
                    "Matrix",
                    Object::Array(matrix.iter().map(|v| Object::Real(*v as f32)).collect()),
                );
                fd.set("Resources", Object::Reference(res_id));
                fd.set(KEY, Object::Reference(info));
                let f = new_stream(pdf, fd, body.as_bytes())?;
                forms.insert(key, f);
                f
            }
        };
        let name = add_resource(pdf, t.info.id, b"XObject", "ZMk", Object::Reference(form))?;
        let stream = format!(
            "q\n/Artifact <</Type /Pagination /Subtype /{subtype} /ZOODMark {}>> BDC\n{} Do\nEMC\nQ\n",
            pdf_string(id),
            fmt_name(&name)
        );
        let mut sd = Dictionary::new();
        sd.set(KEY, Object::Reference(info));
        let mark = new_stream(pdf, sd, stream.as_bytes())?;
        let mut items = store::contents(pdf, t.info.id)?;
        let kinds: Vec<store::Item> = items.iter().map(|o| store::classify(pdf, o)).collect();
        if front && needs_wrappers(&kinds) && wrappers.is_none() {
            let w = Wrappers::new(pdf)?;
            wrappers = Some((w.open, w.close));
        }
        insert(&kinds, &mut items, mark, front, wrappers);
        store::set_contents(pdf, t.info.id, items)?;
    }
    Ok(())
}

fn pdf_string(s: &str) -> String {
    let hex: String = s.bytes().map(|x| format!("{x:02X}")).collect();
    format!("<{hex}>")
}

fn needs_wrappers(kinds: &[store::Item]) -> bool {
    use store::Item;
    kinds.contains(&Item::Original)
        && !(kinds.contains(&Item::WrapOpen) && kinds.contains(&Item::WrapClose))
}

/// Insert a mark stream into `items` (`kinds` classifies them): behind-content marks after the
/// existing behind marks, in-front marks at the end with the original content wrapped.
fn insert(
    kinds: &[store::Item],
    items: &mut Vec<Object>,
    mark: ObjectId,
    front: bool,
    wrappers: Option<(ObjectId, ObjectId)>,
) {
    use store::Item;
    let leading = kinds
        .iter()
        .take_while(|k| matches!(k, Item::Mark(_)))
        .count();
    if !front {
        items.insert(leading, Object::Reference(mark));
        return;
    }
    if needs_wrappers(kinds) {
        if let Some((open, close)) = wrappers {
            if !kinds.contains(&Item::WrapOpen) {
                items.insert(leading, Object::Reference(open));
            }
            if !kinds.contains(&Item::WrapClose) {
                items.push(Object::Reference(close));
            }
        }
    }
    items.push(Object::Reference(mark));
}
