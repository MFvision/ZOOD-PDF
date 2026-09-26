//! The document model the rules work on: one bounded walk over pages, resources, content streams,
//! form XObjects, patterns, Type 3 glyph procedures and annotation appearances. It records every
//! font, graphics state, image, form, colour-space use, text string, unknown operator and image
//! placement (for the effective resolution), keyed by the indirect object that holds it.

use crate::content::{self, Op};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use warraq_pdf::limits::decode_stream;
use warraq_pdf::lopdf::{Dictionary, Object, ObjectId, Stream};
use warraq_pdf::pages::{self, PageInfo};
use warraq_pdf::Pdf;

/// Deepest form XObject nesting followed from content.
const MAX_FORM_DEPTH: usize = 16;
/// Text bytes kept per font (for .notdef / ToUnicode checks).
const MAX_TEXT_PER_FONT: usize = 256 * 1024;

// ---------------------------------------------------------------- small helpers

/// Follow references (bounded).
pub fn res<'a>(pdf: &'a Pdf, o: &'a Object) -> &'a Object {
    pdf.resolve(o).unwrap_or(&Object::Null)
}

/// Dictionary (or stream dictionary) behind `o`.
pub fn dict<'a>(pdf: &'a Pdf, o: &'a Object) -> Option<&'a Dictionary> {
    match pdf.resolve(o)? {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

/// Stream behind `o`.
pub fn stream<'a>(pdf: &'a Pdf, o: &'a Object) -> Option<&'a Stream> {
    match pdf.resolve(o)? {
        Object::Stream(s) => Some(s),
        _ => None,
    }
}

/// `d[key]` resolved.
pub fn get<'a>(pdf: &'a Pdf, d: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    d.get(key).ok().and_then(|o| pdf.resolve(o))
}

/// `d[key]` as a dictionary.
pub fn get_dict<'a>(pdf: &'a Pdf, d: &'a Dictionary, key: &[u8]) -> Option<&'a Dictionary> {
    d.get(key).ok().and_then(|o| dict(pdf, o))
}

/// `d[key]` as a name.
pub fn get_name<'a>(pdf: &'a Pdf, d: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    match get(pdf, d, key)? {
        Object::Name(n) => Some(n),
        _ => None,
    }
}

/// `d[key]` as a number.
pub fn get_num(pdf: &Pdf, d: &Dictionary, key: &[u8]) -> Option<f64> {
    num(get(pdf, d, key)?)
}

/// A number.
pub fn num(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
}

/// The reference id if `o` is a reference.
pub fn ref_id(o: &Object) -> Option<ObjectId> {
    match o {
        Object::Reference(id) => Some(*id),
        _ => None,
    }
}

/// Lossy text of a name.
pub fn name_str(n: &[u8]) -> String {
    String::from_utf8_lossy(n).into_owned()
}

/// Decoded stream content (bounded by the zip-bomb caps).
pub fn decoded(pdf: &Pdf, s: &Stream) -> Option<Vec<u8>> {
    decode_stream(s, pdf.limits()).ok()
}

/// Effective resources of a page (walks /Parent, bounded).
pub fn page_resources(pdf: &Pdf, page: ObjectId) -> Option<&Dictionary> {
    let mut id = page;
    for _ in 0..64 {
        let d = pdf.get_dict(id)?;
        if let Some(r) = get_dict(pdf, d, b"Resources") {
            return Some(r);
        }
        id = d.get(b"Parent").ok().and_then(ref_id)?;
    }
    None
}

// ---------------------------------------------------------------- records

/// Identity of a resource object: its object id, or (holder, resource name) for direct objects.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Key {
    /// Indirect object.
    Obj(ObjectId),
    /// Direct dictionary inside `holder` under resource name `name`.
    Direct(ObjectId, Vec<u8>),
}

impl Key {
    /// The indirect object that holds it.
    pub fn holder(&self) -> ObjectId {
        match self {
            Key::Obj(id) | Key::Direct(id, _) => *id,
        }
    }
}

/// Device colour families.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Device {
    /// DeviceRGB.
    Rgb,
    /// DeviceCMYK.
    Cmyk,
    /// DeviceGray.
    Gray,
}

impl Device {
    /// PDF name.
    pub fn name(self) -> &'static str {
        match self {
            Device::Rgb => "DeviceRGB",
            Device::Cmyk => "DeviceCMYK",
            Device::Gray => "DeviceGray",
        }
    }
}

/// One use of a device colour space.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ColourUse {
    /// Which device space.
    pub device: Device,
    /// Object holding the use (page, form, image, …).
    pub holder: ObjectId,
    /// Page, if known.
    pub page: Option<usize>,
    /// A default colour space (/DefaultRGB …) of the enclosing resources remaps it.
    pub defaulted: bool,
}

/// A resource with where it was found.
#[derive(Debug, Clone)]
pub struct Site {
    /// Identity.
    pub key: Key,
    /// First page that uses it (if any).
    pub page: Option<usize>,
}

/// An image placement (for effective resolution).
#[derive(Debug, Clone, Copy)]
pub struct Placement {
    /// Page.
    pub page: Option<usize>,
    /// Pixels per inch horizontally / vertically.
    pub dpi: (f64, f64),
}

/// An inline image found in content.
#[derive(Debug, Clone)]
pub struct Inline {
    /// Content stream holder.
    pub holder: ObjectId,
    /// Page.
    pub page: Option<usize>,
    /// The inline dictionary.
    pub dict: Dictionary,
}

/// A problem found while interpreting content.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ContentIssue {
    /// Holder of the content stream.
    pub holder: ObjectId,
    /// Page.
    pub page: Option<usize>,
    /// Operator / value involved.
    pub what: String,
}

/// An annotation.
#[derive(Debug, Clone)]
pub struct Annot {
    /// Indirect id (annotations are almost always indirect); `None` for direct dictionaries.
    pub id: Option<ObjectId>,
    /// Page index.
    pub page: usize,
    /// Page object.
    pub page_id: ObjectId,
    /// Index in the page's /Annots.
    pub index: usize,
}

/// Everything the walk found.
#[derive(Debug, Default)]
pub struct Model {
    /// Pages in order.
    pub pages: Vec<PageInfo>,
    /// Fonts (keyed), first page of use.
    pub fonts: BTreeMap<Key, Option<usize>>,
    /// Graphics state dictionaries.
    pub extgstates: BTreeMap<Key, Option<usize>>,
    /// Image XObjects.
    pub images: BTreeMap<ObjectId, Option<usize>>,
    /// Form XObjects (including annotation appearances and tiling patterns' streams are separate).
    pub forms: BTreeMap<ObjectId, Option<usize>>,
    /// PostScript XObjects.
    pub ps_xobjects: BTreeMap<ObjectId, Option<usize>>,
    /// Colour-space objects found in resources, images, shadings, groups (keyed by holder).
    pub colour_spaces: Vec<(ObjectId, Option<usize>, Object)>,
    /// Device colour uses (deduplicated).
    pub colour_uses: BTreeSet<ColourUse>,
    /// Inline images.
    pub inline_images: Vec<Inline>,
    /// Undefined operators.
    pub unknown_ops: BTreeSet<ContentIssue>,
    /// Streams whose q nesting exceeds 28.
    pub deep_q: BTreeSet<ContentIssue>,
    /// `ri` operators with a non-standard intent.
    pub bad_ri: BTreeSet<ContentIssue>,
    /// Text strings shown with each font.
    pub text: HashMap<Key, Vec<Vec<u8>>>,
    /// Image placements.
    pub placements: HashMap<ObjectId, Vec<Placement>>,
    /// Annotations.
    pub annots: Vec<Annot>,
    /// Operator budget ran out.
    pub incomplete: bool,
    /// Streams that could not be decoded (holder, page).
    pub undecodable: BTreeSet<ContentIssue>,
}

/// Standard rendering intents.
pub const INTENTS: &[&[u8]] = &[
    b"RelativeColorimetric",
    b"AbsoluteColorimetric",
    b"Perceptual",
    b"Saturation",
];

type Matrix = [f64; 6];

fn mul(a: &Matrix, b: &Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

fn matrix_of(pdf: &Pdf, o: Option<&Object>) -> Matrix {
    let id = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    let Some(Object::Array(a)) = o.and_then(|o| pdf.resolve(o)) else {
        return id;
    };
    let v: Vec<f64> = a
        .iter()
        .filter_map(|x| pdf.resolve(x).and_then(num))
        .collect();
    match v.as_slice() {
        [a, b, c, d, e, f] if [a, b, c, d, e, f].iter().all(|x| x.is_finite()) => {
            [*a, *b, *c, *d, *e, *f]
        }
        _ => id,
    }
}

/// Device families a colour-space object (name or array) uses, looked up in `res`.
pub fn devices_of(pdf: &Pdf, cs: &Object, res: Option<&Dictionary>, depth: usize) -> Vec<Device> {
    if depth > 8 {
        return Vec::new();
    }
    match pdf.resolve(cs) {
        Some(Object::Name(n)) => match n.as_slice() {
            b"DeviceRGB" | b"RGB" => vec![Device::Rgb],
            b"DeviceCMYK" | b"CMYK" => vec![Device::Cmyk],
            b"DeviceGray" | b"G" => vec![Device::Gray],
            b"Pattern" => Vec::new(),
            other => match res
                .and_then(|r| get_dict(pdf, r, b"ColorSpace"))
                .and_then(|c| c.get(other).ok())
            {
                Some(o) => devices_of(pdf, o, res, depth + 1),
                None => Vec::new(),
            },
        },
        Some(Object::Array(a)) => {
            let family = a
                .first()
                .and_then(|o| pdf.resolve(o))
                .and_then(|o| o.as_name().ok())
                .unwrap_or_default();
            match family {
                b"Indexed" | b"I" => a
                    .get(1)
                    .map(|b| devices_of(pdf, b, res, depth + 1))
                    .unwrap_or_default(),
                b"Separation" => a
                    .get(2)
                    .map(|b| devices_of(pdf, b, res, depth + 1))
                    .unwrap_or_default(),
                b"DeviceN" => a
                    .get(2)
                    .map(|b| devices_of(pdf, b, res, depth + 1))
                    .unwrap_or_default(),
                b"Pattern" => a
                    .get(1)
                    .map(|b| devices_of(pdf, b, res, depth + 1))
                    .unwrap_or_default(),
                b"DeviceRGB" => vec![Device::Rgb],
                b"DeviceCMYK" => vec![Device::Cmyk],
                b"DeviceGray" => vec![Device::Gray],
                _ => Vec::new(), // ICCBased, CalRGB, CalGray, Lab: device independent
            }
        }
        _ => Vec::new(),
    }
}

fn has_default(pdf: &Pdf, res: Option<&Dictionary>, d: Device) -> bool {
    let key: &[u8] = match d {
        Device::Rgb => b"DefaultRGB",
        Device::Cmyk => b"DefaultCMYK",
        Device::Gray => b"DefaultGray",
    };
    res.and_then(|r| get_dict(pdf, r, b"ColorSpace"))
        .is_some_and(|c| c.has(key))
}

struct Walker<'a> {
    pdf: &'a Pdf,
    m: Model,
    budget: usize,
    scanned_res: HashSet<*const Dictionary>,
    scanned_streams: HashSet<ObjectId>,
}

struct Scope<'a> {
    res: Option<&'a Dictionary>,
    holder: ObjectId,
    page: Option<usize>,
}

impl<'a> Walker<'a> {
    fn colour(&mut self, devs: Vec<Device>, sc: &Scope<'_>) {
        for d in devs {
            let defaulted = has_default(self.pdf, sc.res, d);
            self.m.colour_uses.insert(ColourUse {
                device: d,
                holder: sc.holder,
                page: sc.page,
                defaulted,
            });
        }
    }

    fn content_of(
        &mut self,
        contents: Option<&Object>,
        holder: ObjectId,
        page: Option<usize>,
    ) -> Vec<u8> {
        let pdf = self.pdf;
        let mut out = Vec::new();
        let mut one = |o: &Object, this: &mut Self| {
            if let Some(Object::Stream(s)) = pdf.resolve(o) {
                match decoded(pdf, s) {
                    Some(b) => {
                        out.extend_from_slice(&b);
                        out.push(b'\n');
                    }
                    None => {
                        this.m.undecodable.insert(ContentIssue {
                            holder: ref_id(o).unwrap_or(holder),
                            page,
                            what: "content".into(),
                        });
                    }
                }
            }
        };
        match contents.and_then(|c| pdf.resolve(c)) {
            Some(Object::Array(a)) => {
                for o in a.iter().take(10_000) {
                    one(o, self);
                }
            }
            Some(_) => {
                if let Some(c) = contents {
                    one(c, self);
                }
            }
            None => {}
        }
        out
    }

    /// Record every resource of `res` (once per dictionary) and recurse into forms, patterns
    /// and Type 3 fonts.
    fn resources(
        &mut self,
        res: Option<&'a Dictionary>,
        holder: ObjectId,
        page: Option<usize>,
        depth: usize,
    ) {
        let Some(r) = res else { return };
        if depth > MAX_FORM_DEPTH || !self.scanned_res.insert(r as *const Dictionary) {
            return;
        }
        let pdf = self.pdf;
        let sc = Scope { res, holder, page };
        let key_of = |o: &Object, name: &[u8]| match o {
            Object::Reference(id) => Key::Obj(*id),
            _ => Key::Direct(holder, name.to_vec()),
        };
        if let Some(fonts) = get_dict(pdf, r, b"Font") {
            for (name, o) in fonts.iter() {
                let k = key_of(o, name);
                if self.m.fonts.contains_key(&k) {
                    continue;
                }
                self.m.fonts.insert(k.clone(), page);
                if let Some(fd) = dict(pdf, o) {
                    if get_name(pdf, fd, b"Subtype") == Some(b"Type3") {
                        let fres = get_dict(pdf, fd, b"Resources").or(res);
                        let fholder = k.holder();
                        self.resources(fres, fholder, page, depth + 1);
                        if let Some(procs) = get_dict(pdf, fd, b"CharProcs") {
                            for (_, p) in procs.iter().take(4096) {
                                if let Some(s) = stream(pdf, p) {
                                    let h = ref_id(p).unwrap_or(fholder);
                                    if let Some(bytes) = decoded(pdf, s) {
                                        let sc2 = Scope {
                                            res: fres,
                                            holder: h,
                                            page,
                                        };
                                        self.run(
                                            &bytes,
                                            &sc2,
                                            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                                            depth + 1,
                                            &mut Vec::new(),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Some(gs) = get_dict(pdf, r, b"ExtGState") {
            for (name, o) in gs.iter() {
                self.m.extgstates.entry(key_of(o, name)).or_insert(page);
            }
        }
        if let Some(cs) = get_dict(pdf, r, b"ColorSpace") {
            for (name, o) in cs.iter() {
                if name.starts_with(b"Default") {
                    continue;
                }
                self.m
                    .colour_spaces
                    .push((ref_id(o).unwrap_or(holder), page, o.clone()));
                let d = devices_of(pdf, o, res, 0);
                self.colour(d, &sc);
            }
        }
        if let Some(sh) = get_dict(pdf, r, b"Shading") {
            for (_, o) in sh.iter() {
                self.shading(o, &sc);
            }
        }
        if let Some(pats) = get_dict(pdf, r, b"Pattern") {
            for (_, o) in pats.iter().take(4096) {
                self.pattern(o, &sc, depth);
            }
        }
        if let Some(xo) = get_dict(pdf, r, b"XObject") {
            for (_, o) in xo.iter().take(65_536) {
                let Some(id) = ref_id(o) else { continue };
                self.xobject_record(id, &sc, depth);
            }
        }
    }

    fn shading(&mut self, o: &Object, sc: &Scope<'_>) {
        let pdf = self.pdf;
        if let Some(d) = dict(pdf, o) {
            if let Ok(cs) = d.get(b"ColorSpace") {
                let holder = ref_id(o).unwrap_or(sc.holder);
                self.m.colour_spaces.push((holder, sc.page, cs.clone()));
                let devs = devices_of(pdf, cs, sc.res, 0);
                self.colour(
                    devs,
                    &Scope {
                        res: sc.res,
                        holder,
                        page: sc.page,
                    },
                );
            }
        }
    }

    fn pattern(&mut self, o: &'a Object, sc: &Scope<'a>, depth: usize) {
        let pdf = self.pdf;
        let Some(pd) = dict(pdf, o) else { return };
        let holder = ref_id(o).unwrap_or(sc.holder);
        match get_num(pdf, pd, b"PatternType").map(|n| n as i64) {
            Some(1) => {
                let pres = get_dict(pdf, pd, b"Resources");
                self.resources(pres, holder, sc.page, depth + 1);
                if let Some(s) = stream(pdf, o) {
                    if self.scanned_streams.insert(holder) {
                        if let Some(bytes) = decoded(pdf, s) {
                            let sc2 = Scope {
                                res: pres.or(sc.res),
                                holder,
                                page: sc.page,
                            };
                            self.run(
                                &bytes,
                                &sc2,
                                [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                                depth + 1,
                                &mut Vec::new(),
                            );
                        }
                    }
                }
            }
            Some(2) => {
                if let Ok(sh) = pd.get(b"Shading") {
                    self.shading(
                        sh,
                        &Scope {
                            res: sc.res,
                            holder,
                            page: sc.page,
                        },
                    );
                }
            }
            _ => {}
        }
    }

    fn xobject_record(&mut self, id: ObjectId, sc: &Scope<'a>, depth: usize) {
        let pdf = self.pdf;
        let Some(Object::Stream(s)) = pdf.get(id) else {
            return;
        };
        match get_name(pdf, &s.dict, b"Subtype") {
            Some(b"Image") => {
                if self.m.images.contains_key(&id) {
                    return;
                }
                self.m.images.insert(id, sc.page);
                let is_mask =
                    matches!(get(pdf, &s.dict, b"ImageMask"), Some(Object::Boolean(true)));
                if !is_mask {
                    if let Ok(cs) = s.dict.get(b"ColorSpace") {
                        self.m.colour_spaces.push((id, sc.page, cs.clone()));
                        let devs = devices_of(pdf, cs, sc.res, 0);
                        self.colour(
                            devs,
                            &Scope {
                                res: sc.res,
                                holder: id,
                                page: sc.page,
                            },
                        );
                    }
                }
                // Soft-mask images are images too.
                if let Ok(Object::Reference(sm)) = s.dict.get(b"SMask") {
                    let sm = *sm;
                    self.m.images.entry(sm).or_insert(sc.page);
                }
            }
            Some(b"Form") => {
                if self.m.forms.contains_key(&id) {
                    return;
                }
                self.m.forms.insert(id, sc.page);
                let fres = get_dict(pdf, &s.dict, b"Resources");
                if let Some(g) = get_dict(pdf, &s.dict, b"Group") {
                    if let Ok(cs) = g.get(b"CS") {
                        let devs = devices_of(pdf, cs, fres.or(sc.res), 0);
                        self.colour(
                            devs,
                            &Scope {
                                res: fres.or(sc.res),
                                holder: id,
                                page: sc.page,
                            },
                        );
                    }
                }
                self.resources(fres, id, sc.page, depth + 1);
            }
            Some(b"PS") => {
                self.m.ps_xobjects.entry(id).or_insert(sc.page);
            }
            _ => {}
        }
    }

    /// Interpret a content stream.
    fn run(
        &mut self,
        bytes: &[u8],
        sc: &Scope<'a>,
        ctm0: Matrix,
        depth: usize,
        stack: &mut Vec<ObjectId>,
    ) {
        let pdf = self.pdf;
        let mut ctm = ctm0;
        let mut saved: Vec<(Matrix, Option<Key>)> = Vec::new();
        let mut font: Option<Key> = None;
        let mut compat = 0usize;
        let mut deep_reported = false;
        let mut budget = self.budget;
        let mut deferred_forms: Vec<(ObjectId, Matrix)> = Vec::new();
        let ok = content::parse(bytes, &mut budget, |op: Op<'_>| {
            let a = &op.operands;
            match op.op {
                b"q" => {
                    saved.push((ctm, font.clone()));
                    if saved.len() > 28 && !deep_reported {
                        deep_reported = true;
                        self.m.deep_q.insert(ContentIssue {
                            holder: sc.holder,
                            page: sc.page,
                            what: saved.len().to_string(),
                        });
                    }
                    if saved.len() > 10_000 {
                        saved.remove(0);
                    }
                }
                b"Q" => {
                    if let Some((m, f)) = saved.pop() {
                        ctm = m;
                        font = f;
                    }
                }
                b"cm" => {
                    let v: Vec<f64> = a.iter().filter_map(num).collect();
                    if let [x0, x1, x2, x3, x4, x5] = v.as_slice() {
                        ctm = mul(&[*x0, *x1, *x2, *x3, *x4, *x5], &ctm);
                    }
                }
                b"Tf" => {
                    font = a.first().and_then(|n| n.as_name().ok()).and_then(|n| {
                        let fonts = sc.res.and_then(|r| get_dict(pdf, r, b"Font"))?;
                        let o = fonts.get(n).ok()?;
                        Some(match o {
                            Object::Reference(id) => Key::Obj(*id),
                            _ => Key::Direct(sc.holder, n.to_vec()),
                        })
                    });
                }
                b"Tj" | b"'" | b"\"" | b"TJ" => {
                    if let Some(k) = &font {
                        let entry = self.m.text.entry(k.clone()).or_default();
                        let used: usize = entry.iter().map(Vec::len).sum();
                        if used < MAX_TEXT_PER_FONT {
                            for o in a {
                                match o {
                                    Object::String(s, _) => entry.push(s.clone()),
                                    Object::Array(items) => {
                                        for i in items {
                                            if let Object::String(s, _) = i {
                                                entry.push(s.clone());
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
                b"rg" | b"RG" => self.colour(vec![Device::Rgb], sc),
                b"k" | b"K" => self.colour(vec![Device::Cmyk], sc),
                b"g" | b"G" => self.colour(vec![Device::Gray], sc),
                b"cs" | b"CS" => {
                    if let Some(n) = a.first() {
                        let d = devices_of(pdf, n, sc.res, 0);
                        self.colour(d, sc);
                    }
                }
                b"ri" => {
                    if let Some(Object::Name(n)) = a.first() {
                        if !INTENTS.contains(&n.as_slice()) {
                            self.m.bad_ri.insert(ContentIssue {
                                holder: sc.holder,
                                page: sc.page,
                                what: name_str(n),
                            });
                        }
                    }
                }
                b"sh" => {
                    if let Some(Object::Name(n)) = a.first() {
                        if let Some(o) = sc
                            .res
                            .and_then(|r| get_dict(pdf, r, b"Shading"))
                            .and_then(|d| d.get(n).ok())
                        {
                            self.shading(o, sc);
                        }
                    }
                }
                b"Do" => {
                    if let Some(Object::Name(n)) = a.first() {
                        let target = sc
                            .res
                            .and_then(|r| get_dict(pdf, r, b"XObject"))
                            .and_then(|d| d.get(n).ok())
                            .and_then(ref_id);
                        if let Some(id) = target {
                            if let Some(Object::Stream(s)) = pdf.get(id) {
                                match get_name(pdf, &s.dict, b"Subtype") {
                                    Some(b"Image") => {
                                        let w = get_num(pdf, &s.dict, b"Width").unwrap_or(0.0);
                                        let h = get_num(pdf, &s.dict, b"Height").unwrap_or(0.0);
                                        let sx = (ctm[0] * ctm[0] + ctm[1] * ctm[1]).sqrt();
                                        let sy = (ctm[2] * ctm[2] + ctm[3] * ctm[3]).sqrt();
                                        if sx > 1e-6 && sy > 1e-6 {
                                            let p = self.m.placements.entry(id).or_default();
                                            if p.len() < 64 {
                                                p.push(Placement {
                                                    page: sc.page,
                                                    dpi: (w * 72.0 / sx, h * 72.0 / sy),
                                                });
                                            }
                                        }
                                    }
                                    Some(b"Form") => deferred_forms.push((id, ctm)),
                                    _ => {}
                                }
                            }
                        }
                    }
                }
                b"BI" => {
                    if let Some(img) = &op.inline {
                        let d = &img.dict;
                        let is_mask = matches!(
                            d.get(b"IM").or_else(|_| d.get(b"ImageMask")),
                            Ok(Object::Boolean(true))
                        );
                        if !is_mask {
                            if let Ok(cs) = d.get(b"CS").or_else(|_| d.get(b"ColorSpace")) {
                                let devs = devices_of(pdf, cs, sc.res, 0);
                                self.colour(devs, sc);
                            }
                        }
                        if self.m.inline_images.len() < 10_000 {
                            self.m.inline_images.push(Inline {
                                holder: sc.holder,
                                page: sc.page,
                                dict: d.clone(),
                            });
                        }
                    }
                }
                b"BX" => compat += 1,
                b"EX" => compat = compat.saturating_sub(1),
                other => {
                    if compat == 0 && !content::is_defined(other) && self.m.unknown_ops.len() < 1000
                    {
                        self.m.unknown_ops.insert(ContentIssue {
                            holder: sc.holder,
                            page: sc.page,
                            what: String::from_utf8_lossy(other).chars().take(32).collect(),
                        });
                    }
                }
            }
            true
        });
        self.budget = budget;
        if !ok {
            self.m.incomplete = true;
            return;
        }
        // Forms drawn by this stream (after the borrow of the closure ends).
        for (id, at) in deferred_forms {
            if depth >= MAX_FORM_DEPTH || stack.contains(&id) || self.budget == 0 {
                continue;
            }
            let Some(Object::Stream(s)) = pdf.get(id) else {
                continue;
            };
            self.xobject_record(id, sc, depth);
            let fres = get_dict(pdf, &s.dict, b"Resources").or(sc.res);
            let m = matrix_of(pdf, s.dict.get(b"Matrix").ok());
            let Some(bytes) = decoded(pdf, s) else {
                self.m.undecodable.insert(ContentIssue {
                    holder: id,
                    page: sc.page,
                    what: "form".into(),
                });
                continue;
            };
            stack.push(id);
            let sc2 = Scope {
                res: fres,
                holder: id,
                page: sc.page,
            };
            self.run(&bytes, &sc2, mul(&m, &at), depth + 1, stack);
            stack.pop();
        }
    }

    fn appearance_streams(&mut self, ap: &'a Dictionary, holder: ObjectId, page: usize) {
        let pdf = self.pdf;
        for key in [b"N".as_slice(), b"R", b"D"] {
            let Ok(o) = ap.get(key) else { continue };
            let mut streams: Vec<&Object> = Vec::new();
            match pdf.resolve(o) {
                Some(Object::Stream(_)) => streams.push(o),
                Some(Object::Dictionary(states)) => {
                    streams.extend(states.iter().map(|(_, v)| v).take(64))
                }
                _ => {}
            }
            for so in streams {
                let Some(s) = stream(pdf, so) else { continue };
                let id = ref_id(so).unwrap_or(holder);
                if !self.scanned_streams.insert(id) && ref_id(so).is_some() {
                    continue;
                }
                let sc = Scope {
                    res: None,
                    holder: id,
                    page: Some(page),
                };
                if let Some(id) = ref_id(so) {
                    self.xobject_record(id, &sc, 0);
                }
                let fres = get_dict(pdf, &s.dict, b"Resources");
                if let Some(bytes) = decoded(pdf, s) {
                    let sc = Scope {
                        res: fres,
                        holder: id,
                        page: Some(page),
                    };
                    self.run(
                        &bytes,
                        &sc,
                        [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                        1,
                        &mut vec![id],
                    );
                }
            }
        }
    }
}

/// Walk the document.
pub fn build(pdf: &Pdf) -> Model {
    let mut w = Walker {
        pdf,
        m: Model::default(),
        budget: pdf.limits().max_content_ops,
        scanned_res: HashSet::new(),
        scanned_streams: HashSet::new(),
    };
    let pages = pages::flatten(pdf).unwrap_or_default();
    for (i, p) in pages.iter().enumerate() {
        let Some(pd) = pdf.get_dict(p.id) else {
            continue;
        };
        let res = page_resources(pdf, p.id);
        let sc = Scope {
            res,
            holder: p.id,
            page: Some(i),
        };
        if let Some(g) = get_dict(pdf, pd, b"Group") {
            if let Ok(cs) = g.get(b"CS") {
                let devs = devices_of(pdf, cs, res, 0);
                w.colour(devs, &sc);
            }
        }
        let bytes = w.content_of(pd.get(b"Contents").ok(), p.id, Some(i));
        if w.budget > 0 {
            w.run(
                &bytes,
                &sc,
                [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                0,
                &mut Vec::new(),
            );
        } else {
            w.m.incomplete = true;
        }
        w.resources(res, p.id, Some(i), 0);
        if let Some(Object::Array(annots)) = get(pdf, pd, b"Annots") {
            for (idx, a) in annots.iter().enumerate().take(100_000) {
                let id = ref_id(a);
                w.m.annots.push(Annot {
                    id,
                    page: i,
                    page_id: p.id,
                    index: idx,
                });
                if let Some(ad) = dict(pdf, a) {
                    if let Some(ap) = get_dict(pdf, ad, b"AP") {
                        w.appearance_streams(ap, id.unwrap_or(p.id), i);
                    }
                }
            }
        }
    }
    // AcroForm default resources hold fonts too.
    if let Ok(cat) = pdf.catalog() {
        if let Some(af) = get_dict(pdf, cat, b"AcroForm") {
            let holder = cat
                .get(b"AcroForm")
                .ok()
                .and_then(ref_id)
                .or_else(|| pdf.root_id().ok())
                .unwrap_or((0, 0));
            w.resources(get_dict(pdf, af, b"DR"), holder, None, 0);
        }
    }
    w.m.pages = pages;
    w.m
}

/// Annotation dictionary.
pub fn annot_dict<'a>(pdf: &'a Pdf, a: &Annot) -> Option<&'a Dictionary> {
    match a.id {
        Some(id) => pdf.get_dict(id),
        None => {
            let pd = pdf.get_dict(a.page_id)?;
            match get(pdf, pd, b"Annots")? {
                Object::Array(arr) => arr.get(a.index).and_then(|o| dict(pdf, o)),
                _ => None,
            }
        }
    }
}

/// Font dictionary for a key.
pub fn font_dict<'a>(pdf: &'a Pdf, k: &Key, res_lookup: bool) -> Option<&'a Dictionary> {
    match k {
        Key::Obj(id) => pdf.get_dict(*id),
        Key::Direct(holder, name) => {
            if !res_lookup {
                return None;
            }
            // Search the holder's resources (page or form) for the direct font.
            let hd = pdf.get_dict(*holder)?;
            let res = get_dict(pdf, hd, b"Resources").or_else(|| page_resources(pdf, *holder))?;
            let fonts = get_dict(pdf, res, b"Font")?;
            fonts.get(name).ok().and_then(|o| dict(pdf, o))
        }
    }
}
