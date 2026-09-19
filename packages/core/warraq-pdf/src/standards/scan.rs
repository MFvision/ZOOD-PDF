//! What a document's content actually uses, read once for every standard
//! that asks: PDF/A (fonts, colour, transparency, operators), PDF/X and
//! preflight (image resolution, spot colours, hairlines), and the
//! accessibility checker (content that is neither tagged nor an artifact).
//!
//! The walk follows each page's content, the forms it draws, the tiling
//! patterns and Type 3 glyphs it paints with, soft masks, and the
//! appearances of its annotations, with the graphics state a renderer keeps:
//! the transform, the line width, the font and its render mode, the colour
//! spaces, and the marked-content sequences open. It never renders: it only
//! reads what the operators say.
//!
//! The file is hostile: forms are followed to a bounded depth and never in a
//! cycle, the graphics-state stack is bounded, every stream is decoded
//! against a size limit, and the whole walk stops after a budget of
//! operators (and says so, `truncated`).
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};

use crate::text_walk::Matrix;
use crate::PdfDocument;

/// Forms inside forms deeper than this are not followed.
const MAX_DEPTH: usize = 16;
/// Operators read over the whole document before the walk gives up.
const MAX_OPS: usize = 6_000_000;
/// A content stream is not decoded past this many bytes.
const MAX_STREAM: usize = 64 << 20;
/// The graphics-state stack a hostile stream can build.
const MAX_SAVES: usize = 4096;
/// Distinct unknown operators remembered.
const MAX_UNKNOWN: usize = 32;

/// Operators ISO 32000-1 defines (Annex A), `PS` included: it is defined,
/// and forbidden by PDF/A on its own account.
const KNOWN: &[&str] = &[
    "b", "B", "b*", "B*", "BDC", "BI", "BMC", "BT", "BX", "c", "cm", "CS", "cs", "d", "d0", "d1",
    "Do", "DP", "EI", "EMC", "ET", "EX", "f", "F", "f*", "G", "g", "gs", "h", "i", "ID", "j", "J",
    "K", "k", "l", "m", "M", "MP", "n", "q", "Q", "re", "RG", "rg", "ri", "s", "S", "SC", "sc",
    "SCN", "scn", "sh", "T*", "Tc", "Td", "TD", "Tf", "Tj", "TJ", "TL", "Tm", "Tr", "Ts", "Tw",
    "Tz", "v", "w", "W", "W*", "y", "'", "\"", "PS",
];

/// Colour spaces a piece of content uses.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Colours {
    /// Device spaces used directly: by operators (`g`, `rg`, `k`, `cs`),
    /// images, shadings and transparency groups.
    pub gray: bool,
    pub rgb: bool,
    pub cmyk: bool,
    /// Device spaces named as the alternate of a Separation or DeviceN.
    pub alt_gray: bool,
    pub alt_rgb: bool,
    pub alt_cmyk: bool,
    /// ICC profiles used, by the id of their stream (or none, when inline).
    pub icc: BTreeSet<ObjectId>,
    /// CalGray, CalRGB or Lab.
    pub calibrated: bool,
    /// Separation colourants (spot colours), `All` and `None` excepted.
    pub spots: BTreeSet<String>,
    /// DeviceN colourants.
    pub device_n: BTreeSet<String>,
    /// A device space used, directly or as an alternate, where no default
    /// colour space (`DefaultGray`, `DefaultRGB`, `DefaultCMYK`) stands in
    /// for it: what PDF/A and PDF/X check against the output intent.
    pub bare_gray: bool,
    pub bare_rgb: bool,
    pub bare_cmyk: bool,
}

impl Colours {
    fn merge(&mut self, other: &Colours) {
        self.gray |= other.gray;
        self.rgb |= other.rgb;
        self.cmyk |= other.cmyk;
        self.alt_gray |= other.alt_gray;
        self.alt_rgb |= other.alt_rgb;
        self.alt_cmyk |= other.alt_cmyk;
        self.calibrated |= other.calibrated;
        self.bare_gray |= other.bare_gray;
        self.bare_rgb |= other.bare_rgb;
        self.bare_cmyk |= other.bare_cmyk;
        self.icc.extend(other.icc.iter().copied());
        self.spots.extend(other.spots.iter().cloned());
        self.device_n.extend(other.device_n.iter().cloned());
    }
}

/// One font as the content uses it.
#[derive(Debug, Clone)]
pub struct FontUse {
    /// The font dictionary's own object, when it is one.
    pub id: Option<ObjectId>,
    pub dict: Dictionary,
    /// Character codes shown with it.
    pub codes: BTreeSet<u32>,
    /// Used with a render mode that paints (anything but 3, invisible).
    pub visible: bool,
    /// Pages it is shown on (0-based).
    pub pages: BTreeSet<usize>,
}

/// One image as it is drawn.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageUse {
    pub page: usize,
    pub id: Option<ObjectId>,
    pub inline: bool,
    pub width: u32,
    pub height: u32,
    /// Pixels per inch as placed, the lower of the two directions.
    pub ppi: f32,
    /// Where it is drawn, in the page's user space: `[x0, y0, x1, y1]`.
    pub bbox: [f32; 4],
    pub bits: i64,
    pub filters: Vec<String>,
    pub soft_mask: bool,
    pub interpolate: bool,
    pub alternates: bool,
    pub opi: bool,
    pub mask: bool,
    /// Drawn inside an annotation's appearance, not the page's content.
    pub in_annotation: bool,
}

/// What one page's content, and its annotations' appearances, use.
#[derive(Debug, Clone, Default)]
pub struct PageScan {
    pub colours: Colours,
    /// Kinds of transparency met: `opacity`, `softMask`, `blendMode`,
    /// `group`, `imageSoftMask`.
    pub transparency: BTreeSet<&'static str>,
    /// Blend modes other than Normal and Compatible.
    pub blend_modes: BTreeSet<String>,
    /// Strokes thinner than the hairline threshold, and the thinnest one.
    pub hairlines: usize,
    pub thinnest: Option<f32>,
    /// Painting operators outside any tagged (MCID) or artifact sequence.
    pub untagged: usize,
    /// Painting operators in all.
    pub painted: usize,
    /// Text-showing operators in the page's content.
    pub text_ops: usize,
    /// Images and paths drawn in each marked-content sequence with an
    /// MCID, as boxes in user space (text is placed by the renderer).
    pub mcid_boxes: BTreeMap<i64, [f32; 4]>,
    /// Operators ISO 32000-1 does not define.
    pub unknown_ops: BTreeSet<String>,
    /// The `PS` operator, or a PostScript XObject.
    pub postscript: bool,
    /// Deepest `q` nesting.
    pub max_saves: usize,
    /// Rendering intents named (`ri`, `/RI`, `/Intent`).
    pub intents: BTreeSet<String>,
    /// A transfer function, halftone or overprint setting PDF/A limits.
    pub transfer: bool,
    pub halftone_bad: bool,
    pub overprint_mode_1: bool,
    /// Reference XObjects, OPI, and form XObjects with a PostScript part.
    pub reference_xobject: bool,
    /// Some content stream could not be read.
    pub unreadable: bool,
}

/// What the document's content uses, page by page.
#[derive(Debug, Clone, Default)]
pub struct Scan {
    pub pages: Vec<PageScan>,
    pub fonts: Vec<FontUse>,
    pub images: Vec<ImageUse>,
    /// The operator budget ran out: what is reported is what was read.
    pub truncated: bool,
}

/// What to count as a hairline: strokes thinner than this, in points.
#[derive(Debug, Clone, Copy)]
pub struct ScanOptions {
    pub hairline: f32,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self { hairline: 0.25 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Mark {
    Mcid(i64),
    Artifact,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// The page's own content: counted for tagging.
    Page,
    /// An annotation's appearance, a pattern cell, a glyph, a soft mask.
    Aside,
    /// An annotation's appearance: images in it are listed as such.
    Annotation,
}

#[derive(Debug, Clone)]
struct GState {
    ctm: Matrix,
    line_width: f32,
    font: Option<usize>,
    render_mode: i64,
}

/// How a font's text strings split into codes.
#[derive(Debug, Clone)]
enum Codes {
    One,
    Two,
    /// Byte lengths from a CMap's code space: (length, low, high).
    Ranges(Vec<(usize, u32, u32)>),
}

impl Codes {
    fn split(&self, bytes: &[u8], out: &mut BTreeSet<u32>) {
        match self {
            Codes::One => out.extend(bytes.iter().map(|b| u32::from(*b))),
            Codes::Two => {
                for pair in bytes.chunks(2) {
                    let hi = u32::from(pair[0]);
                    let lo = pair.get(1).map(|b| u32::from(*b)).unwrap_or(0);
                    out.insert(hi << 8 | lo);
                }
            }
            Codes::Ranges(ranges) => {
                let mut i = 0;
                while i < bytes.len() {
                    let mut taken = 0;
                    for len in 1..=4usize {
                        if i + len > bytes.len() {
                            break;
                        }
                        let code = bytes[i..i + len]
                            .iter()
                            .fold(0u32, |acc, b| acc << 8 | u32::from(*b));
                        if ranges
                            .iter()
                            .any(|(l, lo, hi)| *l == len && (*lo..=*hi).contains(&code))
                        {
                            out.insert(code);
                            taken = len;
                            break;
                        }
                    }
                    // Not in any range: one byte, as a reader skips it.
                    i += taken.max(1);
                }
            }
        }
    }
}

/// The code space of a CMap stream: each range's byte length and bounds.
pub(crate) fn codespace_ranges(cmap: &[u8]) -> Vec<(usize, u32, u32)> {
    let text = String::from_utf8_lossy(cmap);
    let mut out = vec![];
    let mut rest = text.as_ref();
    while let Some(start) = rest.find("begincodespacerange") {
        let after = &rest[start + "begincodespacerange".len()..];
        let end = after.find("endcodespacerange").unwrap_or(after.len());
        let hexes: Vec<&str> = after[..end]
            .split(['<', '>'])
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit()))
            .collect();
        for pair in hexes.chunks(2) {
            if let [lo, hi] = pair {
                if let (Ok(l), Ok(h)) = (u32::from_str_radix(lo, 16), u32::from_str_radix(hi, 16)) {
                    out.push((lo.len().div_ceil(2).clamp(1, 4), l, h));
                }
            }
            if out.len() > 64 {
                return out;
            }
        }
        rest = &after[end..];
    }
    out
}

fn resolve<'a>(doc: &'a Document, object: &'a Object) -> &'a Object {
    let mut current = object;
    for _ in 0..8 {
        match current {
            Object::Reference(id) => match doc.get_object(*id) {
                Ok(next) => current = next,
                Err(_) => return current,
            },
            _ => return current,
        }
    }
    current
}

fn number(o: &Object) -> Option<f32> {
    match o {
        Object::Integer(i) => Some(*i as f32),
        Object::Real(r) if r.is_finite() => Some(*r),
        _ => None,
    }
}

fn name_str(o: &Object) -> Option<String> {
    o.as_name()
        .ok()
        .map(|n| String::from_utf8_lossy(n).into_owned())
}

/// A colour space, as far as the standards care.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Space {
    Gray,
    Rgb,
    Cmyk,
    Calibrated,
    Icc(Option<ObjectId>, i64),
    Indexed(Box<Space>),
    Pattern,
    Separation(String, Box<Space>),
    DeviceN(Vec<String>, Box<Space>),
    Unknown,
}

/// Reads a colour space: a name (device, or one of `resources`), or an array.
pub(crate) fn read_space(
    doc: &Document,
    object: &Object,
    resources: Option<&Dictionary>,
    depth: usize,
) -> Space {
    if depth > 8 {
        return Space::Unknown;
    }
    let object = resolve(doc, object);
    match object {
        Object::Name(n) => match n.as_slice() {
            b"DeviceGray" | b"G" => Space::Gray,
            b"DeviceRGB" | b"RGB" => Space::Rgb,
            b"DeviceCMYK" | b"CMYK" => Space::Cmyk,
            b"Pattern" => Space::Pattern,
            other => {
                let found = resources
                    .and_then(|r| r.get(b"ColorSpace").ok())
                    .and_then(|c| resolve(doc, c).as_dict().ok())
                    .and_then(|c| c.get(other).ok());
                match found {
                    Some(space) => read_space(doc, space, None, depth + 1),
                    None => Space::Unknown,
                }
            }
        },
        Object::Array(items) => {
            let family = items.first().and_then(|f| f.as_name().ok()).unwrap_or(b"");
            match family {
                b"DeviceGray" | b"G" => Space::Gray,
                b"DeviceRGB" | b"RGB" => Space::Rgb,
                b"DeviceCMYK" | b"CMYK" => Space::Cmyk,
                b"CalGray" | b"CalRGB" | b"Lab" => Space::Calibrated,
                b"ICCBased" => {
                    let id = items.get(1).and_then(|o| o.as_reference().ok());
                    let n = items
                        .get(1)
                        .map(|o| resolve(doc, o))
                        .and_then(|o| o.as_stream().ok())
                        .and_then(|s| s.dict.get(b"N").ok())
                        .and_then(|n| n.as_i64().ok())
                        .unwrap_or(0);
                    Space::Icc(id, n)
                }
                b"Indexed" | b"I" => Space::Indexed(Box::new(
                    items
                        .get(1)
                        .map(|b| read_space(doc, b, resources, depth + 1))
                        .unwrap_or(Space::Unknown),
                )),
                b"Pattern" => Space::Pattern,
                b"Separation" => Space::Separation(
                    items.get(1).and_then(name_str).unwrap_or_default(),
                    Box::new(
                        items
                            .get(2)
                            .map(|a| read_space(doc, a, resources, depth + 1))
                            .unwrap_or(Space::Unknown),
                    ),
                ),
                b"DeviceN" => Space::DeviceN(
                    items
                        .get(1)
                        .map(|o| resolve(doc, o))
                        .and_then(|o| o.as_array().ok())
                        .map(|names| names.iter().filter_map(name_str).collect())
                        .unwrap_or_default(),
                    Box::new(
                        items
                            .get(2)
                            .map(|a| read_space(doc, a, resources, depth + 1))
                            .unwrap_or(Space::Unknown),
                    ),
                ),
                _ => Space::Unknown,
            }
        }
        _ => Space::Unknown,
    }
}

/// Which default colour spaces a resource dictionary sets.
#[derive(Debug, Clone, Copy, Default)]
struct Defaults {
    gray: bool,
    rgb: bool,
    cmyk: bool,
}

fn defaults_of(doc: &Document, resources: Option<&Dictionary>) -> Defaults {
    let spaces = resources
        .and_then(|r| r.get(b"ColorSpace").ok())
        .and_then(|c| resolve(doc, c).as_dict().ok());
    let has = |k: &[u8]| spaces.is_some_and(|s| s.has(k));
    Defaults {
        gray: has(b"DefaultGray"),
        rgb: has(b"DefaultRGB"),
        cmyk: has(b"DefaultCMYK"),
    }
}

/// Records a colour space's use; `alternate` when it stands in for a
/// colourant.
fn record_space(space: &Space, colours: &mut Colours, alternate: bool, defaults: Defaults) {
    match space {
        Space::Gray | Space::Rgb | Space::Cmyk => {
            match space {
                Space::Gray => colours.bare_gray |= !defaults.gray,
                Space::Rgb => colours.bare_rgb |= !defaults.rgb,
                _ => colours.bare_cmyk |= !defaults.cmyk,
            }
            record_device(space, colours, alternate);
        }
        other => record_other(other, colours, alternate, defaults),
    }
}

fn record_device(space: &Space, colours: &mut Colours, alternate: bool) {
    match space {
        Space::Gray if alternate => colours.alt_gray = true,
        Space::Rgb if alternate => colours.alt_rgb = true,
        Space::Cmyk if alternate => colours.alt_cmyk = true,
        Space::Gray => colours.gray = true,
        Space::Rgb => colours.rgb = true,
        Space::Cmyk => colours.cmyk = true,
        _ => {}
    }
}

fn record_other(space: &Space, colours: &mut Colours, alternate: bool, defaults: Defaults) {
    match space {
        Space::Calibrated => colours.calibrated = true,
        Space::Icc(id, _) => {
            if let Some(id) = id {
                colours.icc.insert(*id);
            }
        }
        Space::Indexed(base) => record_space(base, colours, alternate, defaults),
        Space::Separation(name, alt) => {
            if name != "All" && name != "None" {
                colours.spots.insert(name.clone());
            }
            record_space(alt, colours, true, defaults);
        }
        Space::DeviceN(names, alt) => {
            for n in names {
                if n != "None" {
                    colours.device_n.insert(n.clone());
                }
            }
            record_space(alt, colours, true, defaults);
        }
        Space::Pattern | Space::Unknown | Space::Gray | Space::Rgb | Space::Cmyk => {}
    }
}

fn union(a: Option<[f32; 4]>, b: [f32; 4]) -> [f32; 4] {
    match a {
        None => b,
        Some(a) => [
            a[0].min(b[0]),
            a[1].min(b[1]),
            a[2].max(b[2]),
            a[3].max(b[3]),
        ],
    }
}

fn transformed_box(m: Matrix, r: [f32; 4]) -> [f32; 4] {
    let pts = [
        m.apply(r[0], r[1]),
        m.apply(r[2], r[1]),
        m.apply(r[0], r[3]),
        m.apply(r[2], r[3]),
    ];
    let mut out = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    for (x, y) in pts {
        out[0] = out[0].min(x);
        out[1] = out[1].min(y);
        out[2] = out[2].max(x);
        out[3] = out[3].max(y);
    }
    out
}

fn filters_of(dict: &Dictionary, doc: &Document) -> Vec<String> {
    let f = dict.get(b"Filter").or_else(|_| dict.get(b"F"));
    match f.map(|o| resolve(doc, o)) {
        Ok(Object::Name(n)) => vec![String::from_utf8_lossy(n).into_owned()],
        Ok(Object::Array(a)) => a.iter().filter_map(name_str).collect(),
        _ => vec![],
    }
}

struct Walker<'a> {
    doc: &'a Document,
    scan: &'a mut Scan,
    options: ScanOptions,
    page: usize,
    font_index: HashMap<ObjectId, usize>,
    /// Forms being drawn right now: a form that draws itself is a cycle.
    drawing: Vec<ObjectId>,
    marks: Vec<Mark>,
    patterns_walked: HashSet<ObjectId>,
    type3_walked: HashSet<ObjectId>,
    ops: usize,
    path_box: Option<[f32; 4]>,
}

impl<'a> Walker<'a> {
    fn page_scan(&mut self) -> &mut PageScan {
        let page = self.page;
        &mut self.scan.pages[page]
    }

    fn device(&mut self, space: Space, resources: Option<&Dictionary>) {
        let defaults = defaults_of(self.doc, resources);
        let page = self.page;
        record_space(&space, &mut self.scan.pages[page].colours, false, defaults);
    }

    fn inside_mcid(&self) -> Option<i64> {
        self.marks.iter().rev().find_map(|m| match m {
            Mark::Mcid(n) => Some(*n),
            _ => None,
        })
    }

    fn tagged_or_artifact(&self) -> bool {
        self.marks
            .iter()
            .any(|m| matches!(m, Mark::Mcid(_) | Mark::Artifact))
    }

    /// A painting operator: counted, checked for tagging, placed.
    fn painted(&mut self, kind: Kind, bbox: Option<[f32; 4]>) {
        if kind != Kind::Page {
            return;
        }
        let tagged = self.tagged_or_artifact();
        let mcid = self.inside_mcid();
        let scan = self.page_scan();
        scan.painted += 1;
        if !tagged {
            scan.untagged += 1;
        }
        if let (Some(mcid), Some(b)) = (mcid, bbox) {
            let old = scan.mcid_boxes.get(&mcid).copied();
            scan.mcid_boxes.insert(mcid, union(old, b));
        }
    }

    fn font_slot(&mut self, object: &Object) -> Option<usize> {
        let id = object.as_reference().ok();
        if let Some(id) = id {
            if let Some(k) = self.font_index.get(&id) {
                return Some(*k);
            }
        }
        let dict = resolve(self.doc, object).as_dict().ok()?.clone();
        self.scan.fonts.push(FontUse {
            id,
            dict,
            codes: BTreeSet::new(),
            visible: false,
            pages: BTreeSet::new(),
        });
        let k = self.scan.fonts.len() - 1;
        if let Some(id) = id {
            self.font_index.insert(id, k);
        }
        Some(k)
    }

    fn codes_of(&self, font: &Dictionary) -> Codes {
        if font.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) != Some(b"Type0") {
            return Codes::One;
        }
        match font.get(b"Encoding").map(|e| resolve(self.doc, e)) {
            Ok(Object::Stream(s)) => {
                let bytes = s
                    .decompressed_content_with_limit(1 << 20)
                    .unwrap_or_else(|_| s.content.clone());
                let ranges = codespace_ranges(&bytes);
                if ranges.is_empty() {
                    Codes::Two
                } else {
                    Codes::Ranges(ranges)
                }
            }
            _ => Codes::Two,
        }
    }

    fn show(&mut self, gs: &GState, strings: Vec<&[u8]>, resources: Option<&'a Dictionary>) {
        let Some(k) = gs.font else {
            return;
        };
        let codes = self.codes_of(&self.scan.fonts[k].dict.clone());
        let page = self.page;
        let entry = &mut self.scan.fonts[k];
        for s in strings {
            codes.split(s, &mut entry.codes);
        }
        entry.pages.insert(page);
        if gs.render_mode != 3 && gs.render_mode != 7 {
            entry.visible = true;
        }
        // A Type 3 font paints with its glyphs' own content: read it once.
        let Some(id) = self.scan.fonts[k].id else {
            return;
        };
        let doc = self.doc;
        let Ok(dict) = doc.get_dictionary(id) else {
            return;
        };
        if dict.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) != Some(b"Type3")
            || !self.type3_walked.insert(id)
        {
            return;
        }
        let own = dict
            .get(b"Resources")
            .ok()
            .and_then(|r| resolve(doc, r).as_dict().ok());
        let procs = dict
            .get(b"CharProcs")
            .ok()
            .and_then(|c| resolve(doc, c).as_dict().ok());
        for (_, proc) in procs.into_iter().flatten() {
            if let Ok(stream) = resolve(doc, proc).as_stream() {
                let saved = self.marks.clone();
                self.walk_stream(stream, own.or(resources), gs, Kind::Aside, 1);
                self.marks = saved;
            }
        }
    }

    fn lookup(
        &self,
        resources: Option<&'a Dictionary>,
        category: &[u8],
        name: &[u8],
    ) -> Option<&'a Object> {
        let group = resolve(self.doc, resources?.get(category).ok()?)
            .as_dict()
            .ok()?;
        group.get(name).ok()
    }

    fn walk_stream(
        &mut self,
        stream: &'a Stream,
        resources: Option<&'a Dictionary>,
        gs: &GState,
        kind: Kind,
        depth: usize,
    ) {
        let bytes = if stream.dict.get(b"Filter").is_ok() {
            match stream.decompressed_content_with_limit(MAX_STREAM) {
                Ok(b) => b,
                Err(_) => {
                    self.page_scan().unreadable = true;
                    return;
                }
            }
        } else {
            stream.content.clone()
        };
        self.walk_bytes(&bytes, resources, gs, kind, depth);
    }

    fn walk_bytes(
        &mut self,
        bytes: &[u8],
        resources: Option<&'a Dictionary>,
        start: &GState,
        kind: Kind,
        depth: usize,
    ) {
        let Ok(content) = Content::decode(bytes) else {
            self.page_scan().unreadable = true;
            return;
        };
        self.walk_ops(&content.operations, resources, start, kind, depth);
    }

    fn walk_ops(
        &mut self,
        ops: &[Operation],
        resources: Option<&'a Dictionary>,
        start: &GState,
        kind: Kind,
        depth: usize,
    ) {
        let doc = self.doc;
        let mut gs = start.clone();
        let mut stack: Vec<GState> = vec![];
        let mut text_matrix_known = false;
        let base_marks = self.marks.len();
        for op in ops {
            self.ops += 1;
            if self.ops > MAX_OPS {
                self.scan.truncated = true;
                return;
            }
            let a = &op.operands;
            let operator = op.operator.as_str();
            match operator {
                "q" => {
                    if stack.len() < MAX_SAVES {
                        stack.push(gs.clone());
                    }
                    let depth_now = stack.len();
                    let scan = self.page_scan();
                    scan.max_saves = scan.max_saves.max(depth_now);
                }
                "Q" => {
                    if let Some(saved) = stack.pop() {
                        gs = saved;
                    }
                }
                "cm" if a.len() == 6 => {
                    let v: Vec<f32> = a.iter().map(|o| number(o).unwrap_or(0.0)).collect();
                    gs.ctm = Matrix([v[0], v[1], v[2], v[3], v[4], v[5]]).then(gs.ctm);
                }
                "w" => {
                    if let Some(w) = a.first().and_then(number) {
                        gs.line_width = w;
                    }
                }
                "ri" => {
                    if let Some(n) = a.first().and_then(name_str) {
                        self.page_scan().intents.insert(n);
                    }
                }
                "gs" => {
                    let Some(name) = a.first().and_then(|o| o.as_name().ok()) else {
                        continue;
                    };
                    let Some(ext) = self
                        .lookup(resources, b"ExtGState", name)
                        .and_then(|e| resolve(doc, e).as_dict().ok())
                    else {
                        continue;
                    };
                    self.ext_gstate(ext, &mut gs, resources, depth);
                }
                "CS" | "cs" => {
                    if let Some(o) = a.first() {
                        let space = read_space(doc, o, resources, 0);
                        let page = self.page;
                        record_space(
                            &space,
                            &mut self.scan.pages[page].colours,
                            false,
                            defaults_of(self.doc, resources),
                        );
                    }
                }
                "G" | "g" => self.device(Space::Gray, resources),
                "RG" | "rg" => self.device(Space::Rgb, resources),
                "K" | "k" => self.device(Space::Cmyk, resources),
                "SC" | "sc" | "SCN" | "scn" => {
                    if let Some(name) = a.last().and_then(|o| o.as_name().ok()) {
                        self.use_pattern(name, resources, &gs, depth);
                    }
                }
                "sh" => {
                    if let Some(name) = a.first().and_then(|o| o.as_name().ok()) {
                        if let Some(sh) = self.lookup(resources, b"Shading", name) {
                            self.use_shading(resolve(doc, sh), resources);
                        }
                    }
                    self.painted(kind, None);
                }
                "BT" => text_matrix_known = true,
                "ET" => text_matrix_known = false,
                "Tf" => {
                    let font = a
                        .first()
                        .and_then(|o| o.as_name().ok())
                        .and_then(|name| self.lookup(resources, b"Font", name));
                    gs.font = font.and_then(|f| self.font_slot(f));
                }
                "Tr" => {
                    if let Some(m) = a.first().and_then(|o| o.as_i64().ok()) {
                        gs.render_mode = m;
                    }
                }
                "Tj" | "'" | "\"" | "TJ" => {
                    let strings: Vec<&[u8]> = match operator {
                        "TJ" => a
                            .first()
                            .and_then(|o| o.as_array().ok())
                            .map(|items| items.iter().filter_map(|i| i.as_str().ok()).collect())
                            .unwrap_or_default(),
                        _ => a.last().and_then(|o| o.as_str().ok()).into_iter().collect(),
                    };
                    self.show(&gs, strings, resources);
                    if kind == Kind::Page {
                        self.page_scan().text_ops += 1;
                    }
                    let _ = text_matrix_known;
                    self.painted(kind, None);
                }
                "m" | "l" if a.len() >= 2 => {
                    let (x, y) = (number(&a[0]).unwrap_or(0.0), number(&a[1]).unwrap_or(0.0));
                    let p = gs.ctm.apply(x, y);
                    self.path_box = Some(union(self.path_box, [p.0, p.1, p.0, p.1]));
                }
                "c" | "v" | "y" => {
                    for pair in a.chunks(2) {
                        if let [x, y] = pair {
                            let p = gs
                                .ctm
                                .apply(number(x).unwrap_or(0.0), number(y).unwrap_or(0.0));
                            self.path_box = Some(union(self.path_box, [p.0, p.1, p.0, p.1]));
                        }
                    }
                }
                "re" if a.len() == 4 => {
                    let v: Vec<f32> = a.iter().map(|o| number(o).unwrap_or(0.0)).collect();
                    let b = transformed_box(gs.ctm, [v[0], v[1], v[0] + v[2], v[1] + v[3]]);
                    self.path_box = Some(union(self.path_box, b));
                }
                "S" | "s" | "B" | "B*" | "b" | "b*" | "f" | "F" | "f*" => {
                    if matches!(operator, "S" | "s" | "B" | "B*" | "b" | "b*") {
                        let det = gs.ctm.0[0] * gs.ctm.0[3] - gs.ctm.0[1] * gs.ctm.0[2];
                        let width = gs.line_width.abs() * det.abs().sqrt();
                        if width < self.options.hairline {
                            let scan = self.page_scan();
                            scan.hairlines += 1;
                            scan.thinnest = Some(scan.thinnest.map_or(width, |t| t.min(width)));
                        }
                    }
                    let b = self.path_box.take();
                    self.painted(kind, b);
                }
                "n" => self.path_box = None,
                "Do" => {
                    let Some(name) = a.first().and_then(|o| o.as_name().ok()) else {
                        continue;
                    };
                    let Some(object) = self.lookup(resources, b"XObject", name) else {
                        continue;
                    };
                    let id = object.as_reference().ok();
                    let Ok(stream) = resolve(doc, object).as_stream() else {
                        continue;
                    };
                    self.draw_xobject(id, stream, resources, &gs, kind, depth);
                }
                "BI" => {
                    if let Some(Object::Stream(inline)) = a.first() {
                        self.inline_image(&inline.dict, resources, &gs, kind);
                    }
                    let b = transformed_box(gs.ctm, [0.0, 0.0, 1.0, 1.0]);
                    self.painted(kind, Some(b));
                }
                "BMC" | "BDC" => {
                    let tag = a.first().and_then(|o| o.as_name().ok()).unwrap_or(b"");
                    let mcid = if operator == "BDC" {
                        let props = match a.get(1) {
                            Some(Object::Name(n)) => self
                                .lookup(resources, b"Properties", n)
                                .and_then(|p| resolve(doc, p).as_dict().ok()),
                            Some(other) => resolve(doc, other).as_dict().ok(),
                            None => None,
                        };
                        props
                            .and_then(|p| p.get(b"MCID").ok())
                            .and_then(|m| m.as_i64().ok())
                    } else {
                        None
                    };
                    self.marks.push(match (tag, mcid) {
                        (b"Artifact", _) => Mark::Artifact,
                        (_, Some(m)) => Mark::Mcid(m),
                        _ => Mark::Other,
                    });
                }
                "EMC" => {
                    if self.marks.len() > base_marks {
                        self.marks.pop();
                    }
                }
                "PS" => self.page_scan().postscript = true,
                _ => {
                    if !KNOWN.contains(&operator) {
                        let scan = self.page_scan();
                        if scan.unknown_ops.len() < MAX_UNKNOWN {
                            scan.unknown_ops.insert(operator.to_string());
                        }
                    }
                }
            }
        }
        // A stream leaves its own marked content; what it left open closes.
        self.marks.truncate(base_marks);
    }

    fn ext_gstate(
        &mut self,
        ext: &'a Dictionary,
        gs: &mut GState,
        resources: Option<&'a Dictionary>,
        depth: usize,
    ) {
        let doc = self.doc;
        if let Some(w) = ext.get(b"LW").ok().and_then(number) {
            gs.line_width = w;
        }
        for key in [b"CA".as_slice(), b"ca"] {
            if ext
                .get(key)
                .ok()
                .and_then(|v| number(resolve(doc, v)))
                .is_some_and(|v| v < 1.0)
            {
                self.page_scan().transparency.insert("opacity");
            }
        }
        if let Ok(bm) = ext.get(b"BM") {
            let modes: Vec<String> = match resolve(doc, bm) {
                Object::Name(n) => vec![String::from_utf8_lossy(n).into_owned()],
                Object::Array(a) => a.iter().filter_map(name_str).collect(),
                _ => vec![],
            };
            for m in modes {
                if m != "Normal" && m != "Compatible" {
                    let scan = self.page_scan();
                    scan.transparency.insert("blendMode");
                    scan.blend_modes.insert(m);
                }
            }
        }
        match ext.get(b"SMask").map(|s| resolve(doc, s)) {
            Ok(Object::Dictionary(mask)) => {
                self.page_scan().transparency.insert("softMask");
                if let Some(Ok(group)) = mask.get(b"G").ok().map(|g| resolve(doc, g).as_stream()) {
                    if depth < MAX_DEPTH {
                        let own = group
                            .dict
                            .get(b"Resources")
                            .ok()
                            .and_then(|r| resolve(doc, r).as_dict().ok());
                        let saved = self.marks.clone();
                        let inner = GState {
                            ctm: gs.ctm,
                            ..gs.clone()
                        };
                        self.walk_stream(group, own.or(resources), &inner, Kind::Aside, depth + 1);
                        self.marks = saved;
                    }
                }
            }
            Ok(Object::Name(n)) if n != b"None" => {
                self.page_scan().transparency.insert("softMask");
            }
            _ => {}
        }
        if ext.has(b"TR") {
            self.page_scan().transfer = true;
        }
        if let Ok(tr2) = ext.get(b"TR2") {
            if resolve(doc, tr2).as_name().ok() != Some(b"Default") {
                self.page_scan().transfer = true;
            }
        }
        if let Ok(ht) = ext.get(b"HT") {
            let ht = resolve(doc, ht);
            let kind = ht
                .as_dict()
                .ok()
                .or_else(|| ht.as_stream().ok().map(|s| &s.dict))
                .and_then(|d| d.get(b"HalftoneType").ok())
                .and_then(|t| t.as_i64().ok());
            let has_name = ht
                .as_dict()
                .ok()
                .or_else(|| ht.as_stream().ok().map(|s| &s.dict))
                .is_some_and(|d| d.has(b"HalftoneName"));
            if matches!(kind, Some(k) if k != 1 && k != 5) || has_name {
                self.page_scan().halftone_bad = true;
            }
        }
        if let Some(ri) = ext.get(b"RI").ok().and_then(name_str) {
            self.page_scan().intents.insert(ri);
        }
        let op = ext
            .get(b"OP")
            .ok()
            .and_then(|v| v.as_bool().ok())
            .unwrap_or(false);
        let opm = ext.get(b"OPM").ok().and_then(|v| v.as_i64().ok());
        if op && opm == Some(1) {
            self.page_scan().overprint_mode_1 = true;
        }
    }

    fn use_pattern(
        &mut self,
        name: &[u8],
        resources: Option<&'a Dictionary>,
        gs: &GState,
        depth: usize,
    ) {
        let doc = self.doc;
        let Some(object) = self.lookup(resources, b"Pattern", name) else {
            return;
        };
        let id = object.as_reference().ok();
        match resolve(doc, object) {
            // Tiling: a cell of content, read once.
            Object::Stream(cell) => {
                if depth >= MAX_DEPTH {
                    return;
                }
                if let Some(id) = id {
                    if !self.patterns_walked.insert(id) {
                        return;
                    }
                }
                let own = cell
                    .dict
                    .get(b"Resources")
                    .ok()
                    .and_then(|r| resolve(doc, r).as_dict().ok());
                let saved = self.marks.clone();
                self.walk_stream(cell, own.or(resources), gs, Kind::Aside, depth + 1);
                self.marks = saved;
            }
            // Shading pattern.
            Object::Dictionary(d) => {
                if let Ok(sh) = d.get(b"Shading") {
                    self.use_shading(resolve(doc, sh), resources);
                }
                if let Some(ext) = d
                    .get(b"ExtGState")
                    .ok()
                    .and_then(|e| resolve(doc, e).as_dict().ok())
                {
                    let mut inner = gs.clone();
                    self.ext_gstate(ext, &mut inner, resources, depth);
                }
            }
            _ => {}
        }
    }

    fn use_shading(&mut self, shading: &Object, resources: Option<&'a Dictionary>) {
        let dict = shading
            .as_dict()
            .ok()
            .or_else(|| shading.as_stream().ok().map(|s| &s.dict));
        if let Some(cs) = dict.and_then(|d| d.get(b"ColorSpace").ok()) {
            let space = read_space(self.doc, cs, resources, 0);
            let page = self.page;
            record_space(
                &space,
                &mut self.scan.pages[page].colours,
                false,
                defaults_of(self.doc, resources),
            );
        }
    }

    fn draw_xobject(
        &mut self,
        id: Option<ObjectId>,
        stream: &'a Stream,
        resources: Option<&'a Dictionary>,
        gs: &GState,
        kind: Kind,
        depth: usize,
    ) {
        let doc = self.doc;
        let subtype = stream
            .dict
            .get(b"Subtype")
            .ok()
            .and_then(|s| s.as_name().ok());
        match subtype {
            Some(b"Image") => {
                let bbox = transformed_box(gs.ctm, [0.0, 0.0, 1.0, 1.0]);
                self.image(id, &stream.dict, resources, gs, kind, false);
                self.painted(kind, Some(bbox));
            }
            Some(b"Form") => {
                if stream.dict.has(b"Ref") || stream.dict.has(b"OPI") {
                    self.page_scan().reference_xobject = true;
                }
                if stream
                    .dict
                    .get(b"Subtype2")
                    .ok()
                    .and_then(|s| s.as_name().ok())
                    == Some(b"PS")
                {
                    self.page_scan().postscript = true;
                }
                if depth >= MAX_DEPTH {
                    return;
                }
                if let Some(id) = id {
                    if self.drawing.contains(&id) {
                        return;
                    }
                    self.drawing.push(id);
                }
                if let Some(group) = stream
                    .dict
                    .get(b"Group")
                    .ok()
                    .and_then(|g| resolve(doc, g).as_dict().ok())
                {
                    if group.get(b"S").ok().and_then(|s| s.as_name().ok()) == Some(b"Transparency")
                    {
                        self.page_scan().transparency.insert("group");
                        if let Ok(cs) = group.get(b"CS") {
                            let space = read_space(doc, cs, resources, 0);
                            let page = self.page;
                            record_space(
                                &space,
                                &mut self.scan.pages[page].colours,
                                false,
                                defaults_of(self.doc, resources),
                            );
                        }
                    }
                }
                let matrix = stream
                    .dict
                    .get(b"Matrix")
                    .ok()
                    .and_then(|m| resolve(doc, m).as_array().ok())
                    .filter(|m| m.len() == 6)
                    .map(|m| {
                        let v: Vec<f32> = m.iter().map(|o| number(o).unwrap_or(0.0)).collect();
                        Matrix([v[0], v[1], v[2], v[3], v[4], v[5]])
                    })
                    .unwrap_or(Matrix::IDENTITY);
                let own = stream
                    .dict
                    .get(b"Resources")
                    .ok()
                    .and_then(|r| resolve(doc, r).as_dict().ok());
                let inner = GState {
                    ctm: matrix.then(gs.ctm),
                    ..gs.clone()
                };
                self.walk_stream(stream, own.or(resources), &inner, kind, depth + 1);
                if id.is_some() {
                    self.drawing.pop();
                }
            }
            Some(b"PS") => self.page_scan().postscript = true,
            _ => {}
        }
    }

    fn image(
        &mut self,
        id: Option<ObjectId>,
        dict: &Dictionary,
        resources: Option<&'a Dictionary>,
        gs: &GState,
        kind: Kind,
        inline: bool,
    ) {
        let doc = self.doc;
        let get = |long: &[u8], short: &[u8]| {
            dict.get(long)
                .or_else(|_| dict.get(short))
                .ok()
                .map(|o| resolve(doc, o))
        };
        let width = get(b"Width", b"W")
            .and_then(|w| w.as_i64().ok())
            .unwrap_or(0)
            .clamp(0, u32::MAX as i64) as u32;
        let height = get(b"Height", b"H")
            .and_then(|w| w.as_i64().ok())
            .unwrap_or(0)
            .clamp(0, u32::MAX as i64) as u32;
        let mask = get(b"ImageMask", b"IM")
            .and_then(|m| m.as_bool().ok())
            .unwrap_or(false);
        let filters = filters_of(dict, doc);
        let page = self.page;
        if let Some(cs) = get(b"ColorSpace", b"CS") {
            let space = read_space(doc, cs, resources, 0);
            record_space(
                &space,
                &mut self.scan.pages[page].colours,
                false,
                defaults_of(self.doc, resources),
            );
        }
        if let Some(intent) = dict.get(b"Intent").ok().and_then(name_str) {
            self.scan.pages[page].intents.insert(intent);
        }
        let smask = dict.has(b"SMask")
            || dict
                .get(b"SMaskInData")
                .ok()
                .and_then(|v| v.as_i64().ok())
                .is_some_and(|v| v > 0);
        if smask {
            self.scan.pages[page].transparency.insert("imageSoftMask");
        }
        let m = gs.ctm.0;
        let w_pt = (m[0] * m[0] + m[1] * m[1]).sqrt();
        let h_pt = (m[2] * m[2] + m[3] * m[3]).sqrt();
        let ppi = |px: u32, pt: f32| {
            if pt > 1e-3 {
                px as f32 / (pt / 72.0)
            } else {
                f32::INFINITY
            }
        };
        let use_ = ImageUse {
            page,
            id,
            inline,
            width,
            height,
            ppi: ppi(width, w_pt).min(ppi(height, h_pt)),
            bbox: transformed_box(gs.ctm, [0.0, 0.0, 1.0, 1.0]),
            bits: get(b"BitsPerComponent", b"BPC")
                .and_then(|b| b.as_i64().ok())
                .unwrap_or(if mask { 1 } else { 0 }),
            filters,
            soft_mask: smask,
            interpolate: get(b"Interpolate", b"I")
                .and_then(|i| i.as_bool().ok())
                .unwrap_or(false),
            alternates: dict.has(b"Alternates"),
            opi: dict.has(b"OPI"),
            mask,
            in_annotation: kind == Kind::Annotation,
        };
        if self.scan.images.len() < 100_000 {
            self.scan.images.push(use_);
        }
    }

    fn inline_image(
        &mut self,
        dict: &Dictionary,
        resources: Option<&'a Dictionary>,
        gs: &GState,
        kind: Kind,
    ) {
        self.image(None, dict, resources, gs, kind, true);
    }
}

impl PdfDocument {
    /// Reads what every page's content uses; see the module documentation.
    pub fn scan_content(&self, options: ScanOptions) -> Scan {
        let doc = &self.doc;
        let mut scan = Scan {
            pages: vec![PageScan::default(); self.pages.len()],
            ..Default::default()
        };
        let mut walker = Walker {
            doc,
            scan: &mut scan,
            options,
            page: 0,
            font_index: HashMap::new(),
            drawing: vec![],
            marks: vec![],
            patterns_walked: HashSet::new(),
            type3_walked: HashSet::new(),
            ops: 0,
            path_box: None,
        };
        let start = GState {
            ctm: Matrix::IDENTITY,
            line_width: 1.0,
            font: None,
            render_mode: 0,
        };
        for (index, page_id) in self.pages.iter().enumerate() {
            walker.page = index;
            walker.marks.clear();
            walker.patterns_walked.clear();
            let Ok(page) = doc.get_dictionary(*page_id) else {
                continue;
            };
            let resources = self.inherited(page, b"Resources").and_then(|r| match r {
                Object::Reference(id) => doc.get_dictionary(*id).ok(),
                Object::Dictionary(d) => Some(d),
                _ => None,
            });
            if let Some(group) = page
                .get(b"Group")
                .ok()
                .and_then(|g| resolve(doc, g).as_dict().ok())
            {
                if let Ok(cs) = group.get(b"CS") {
                    let space = read_space(doc, cs, resources, 0);
                    record_space(
                        &space,
                        &mut walker.scan.pages[index].colours,
                        false,
                        defaults_of(doc, resources),
                    );
                }
            }
            match doc.get_page_content_with_limit(*page_id, MAX_STREAM) {
                Ok(bytes) => walker.walk_bytes(&bytes, resources, &start, Kind::Page, 0),
                Err(_) => walker.scan.pages[index].unreadable = true,
            }
            // Annotations draw their own appearances.
            let annots: &[Object] = page
                .get(b"Annots")
                .ok()
                .and_then(|a| resolve(doc, a).as_array().ok())
                .map(|a| a.as_slice())
                .unwrap_or(&[]);
            for annot in annots.iter().take(10_000) {
                let Ok(annot) = resolve(doc, annot).as_dict() else {
                    continue;
                };
                let normal = annot
                    .get(b"AP")
                    .ok()
                    .and_then(|ap| resolve(doc, ap).as_dict().ok())
                    .and_then(|ap| ap.get(b"N").ok())
                    .map(|n| resolve(doc, n));
                let streams: Vec<(Option<ObjectId>, &Stream)> = match normal {
                    Some(Object::Stream(s)) => {
                        let id = annot
                            .get(b"AP")
                            .ok()
                            .and_then(|ap| resolve(doc, ap).as_dict().ok())
                            .and_then(|ap| ap.get(b"N").ok())
                            .and_then(|n| n.as_reference().ok());
                        vec![(id, s)]
                    }
                    Some(Object::Dictionary(states)) => states
                        .iter()
                        .filter_map(|(_, s)| {
                            let id = s.as_reference().ok();
                            resolve(doc, s).as_stream().ok().map(|s| (id, s))
                        })
                        .collect(),
                    _ => vec![],
                };
                for (id, stream) in streams {
                    walker.draw_xobject(id, stream, resources, &start, Kind::Annotation, 1);
                }
            }
            if walker.scan.truncated {
                break;
            }
        }
        scan
    }
}

/// Every colour the document uses, all pages together.
pub fn all_colours(scan: &Scan) -> Colours {
    let mut out = Colours::default();
    for p in &scan.pages {
        out.merge(&p.colours);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn a_chrome_page_shows_its_fonts_and_rgb() {
        let doc = PdfDocument::open(
            corpus("generated/chrome-notonaskh-justified-3pages.pdf"),
            None,
        )
        .unwrap();
        let scan = doc.scan_content(ScanOptions::default());
        assert_eq!(scan.pages.len(), 3);
        assert!(!scan.truncated);
        assert!(!scan.fonts.is_empty());
        assert!(scan.fonts.iter().all(|f| !f.codes.is_empty()));
        assert!(scan.pages[0].text_ops > 0);
        assert!(all_colours(&scan).rgb || all_colours(&scan).gray);
    }

    #[test]
    fn a_scan_lists_its_image_and_its_resolution() {
        let doc = PdfDocument::open(
            corpus("generated/scan-notonaskh-300dpi-skewed-jpeg.pdf"),
            None,
        )
        .unwrap();
        let scan = doc.scan_content(ScanOptions::default());
        assert!(!scan.images.is_empty());
        let image = &scan.images[0];
        assert!(
            (image.ppi - 300.0).abs() < 5.0,
            "{} ppi from {}x{}",
            image.ppi,
            image.width,
            image.height
        );
        assert_eq!(image.filters, vec!["DCTDecode".to_string()]);
    }

    #[test]
    fn codes_split_by_a_cmap_code_space() {
        let ranges =
            codespace_ranges(b"2 begincodespacerange <00> <80> <8140> <9FFC> endcodespacerange");
        assert_eq!(ranges, vec![(1, 0, 0x80), (2, 0x8140, 0x9FFC)]);
        let mut out = BTreeSet::new();
        Codes::Ranges(ranges).split(&[0x41, 0x81, 0x40, 0x42], &mut out);
        assert_eq!(out, [0x41, 0x42, 0x8140].into_iter().collect());
    }

    #[test]
    fn untagged_content_is_counted_and_tagged_content_is_not() {
        let ops = |src: &[u8]| Content::decode(src).unwrap().operations;
        let doc = Document::with_version("1.7");
        let mut scan = Scan {
            pages: vec![PageScan::default()],
            ..Default::default()
        };
        let mut w = Walker {
            doc: &doc,
            scan: &mut scan,
            options: ScanOptions::default(),
            page: 0,
            font_index: HashMap::new(),
            drawing: vec![],
            marks: vec![],
            patterns_walked: HashSet::new(),
            type3_walked: HashSet::new(),
            ops: 0,
            path_box: None,
        };
        let start = GState {
            ctm: Matrix::IDENTITY,
            line_width: 1.0,
            font: None,
            render_mode: 0,
        };
        w.walk_ops(
            &ops(b"/P <</MCID 0>> BDC 0 0 10 10 re f EMC /Artifact BMC 0 0 m 5 5 l S EMC 1 1 2 2 re f 0.1 w 0 0 m 1 1 l S"),
            None,
            &start,
            Kind::Page,
            0,
        );
        assert_eq!(scan.pages[0].painted, 4);
        assert_eq!(scan.pages[0].untagged, 2);
        assert_eq!(scan.pages[0].hairlines, 1);
        assert_eq!(
            scan.pages[0].mcid_boxes.get(&0),
            Some(&[0.0, 0.0, 10.0, 10.0])
        );
    }
}
