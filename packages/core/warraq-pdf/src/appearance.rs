//! Appearances for new Arabic text that PDFium cannot draw (ADR-0007).
//!
//! When EmbedPDF sets a form field's value, PDFium writes the field's
//! appearance with the field's own font — Helvetica, as a rule — which has no
//! Arabic glyphs. The value is stored, but the saved file draws nothing where
//! it should be: measured, `BT … ET` with nothing between. Every viewer that
//! shows the stored appearance, which is most of them, shows an empty field.
//!
//! This redraws those appearances with Warraq's shaping (HarfRust, bidi runs
//! in visual order), one subset of a bundled face embedded for all of them,
//! and a ToUnicode that maps back to the text typed. What PDFium drew around
//! the text — border, background — is kept.
use std::collections::BTreeSet;

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Object, ObjectId, Stream};
use warraq_text::{base_direction, Direction, ShapedGlyph, Shaper};

use crate::document::decode_text_string;
use crate::fonts::{embed_subset_font, FontSubset};
use crate::show::{show_line, ShownLine};
use crate::{Error, PdfDocument, Result};

/// What a pass redrew.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AppearanceReport {
    /// Text fields and combo boxes.
    pub fields: usize,
    /// Text-box comments (FreeText).
    pub comments: usize,
}

/// The resource name the redrawn text uses.
const FONT_NAME: &[u8] = b"WarraqAr";
/// Space between a box's edge and its text, in points.
const PADDING: f32 = 2.0;
/// Field flags (ISO 32000-2, tables 226 and 228).
const FLAG_MULTILINE: i64 = 1 << 12;
const FLAG_PASSWORD: i64 = 1 << 13;
const FLAG_COMBO: i64 = 1 << 17;
/// Annotation flag: hidden (table 167).
const ANNOT_HIDDEN: i64 = 1 << 1;
/// Auto-sized single-line text never grows past this, as in Acrobat.
const AUTO_MAX: f32 = 12.0;

/// Text whose letters PDFium's standard fonts do not have: Arabic script,
/// which also writes Persian and Urdu, and its presentation forms.
pub fn needs_shaping(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(
            c as u32,
            0x0600..=0x06FF
                | 0x0750..=0x077F
                | 0x0870..=0x089F
                | 0x08A0..=0x08FF
                | 0xFB50..=0xFDFF
                | 0xFE70..=0xFEFF
        )
    })
}

fn parse(e: impl std::fmt::Display) -> Error {
    Error::Parse(e.to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Align {
    /// No `/Q`: the start of the text's own direction.
    Start,
    Left,
    Center,
    Right,
}

/// One appearance to redraw.
struct Job {
    annot: ObjectId,
    comment: bool,
    text: String,
    /// The box the text goes in, in the appearance's own space.
    bbox: [f32; 4],
    /// The annotation's `/Rect` on the page, which a comment grows with.
    rect: [f32; 4],
    /// The comment's box was made bigger to hold its text.
    grown: bool,
    matrix: Option<Object>,
    /// From the default appearance; 0 means fit the box.
    size: f32,
    /// The colour operators of the default appearance (`0 g`, `1 0 0 rg`).
    color: Vec<Operation>,
    align: Align,
    multiline: bool,
    /// The appearance being replaced: its border and background stay.
    old: Option<Stream>,
}

/// A laid-out line: where its baseline starts, and its glyphs in visual order.
struct Line {
    x: f32,
    y: f32,
    glyphs: Vec<ShapedGlyph>,
}

impl PdfDocument {
    /// Redraw the appearance of every text field, combo box and text-box
    /// comment that holds Arabic, in `font` (a bundled face). Everything else
    /// is left as it is, and so is a document with nothing to redraw.
    pub fn fix_arabic_appearances(&mut self, font: &[u8]) -> Result<AppearanceReport> {
        let jobs = self.appearance_jobs();
        if jobs.is_empty() {
            return Ok(AppearanceReport::default());
        }
        let shaper = Shaper::new(font).map_err(|e| Error::Font(e.to_string()))?;
        // Lay every one out first, so one subset of the face serves them all.
        let laid: Vec<(Job, f32, Vec<Line>)> = jobs
            .into_iter()
            .map(|mut job| {
                let (size, lines) = layout(&shaper, &job);
                if job.comment && grow_to_fit(&mut job, &shaper, size, &lines) {
                    let (size, lines) = layout(&shaper, &job);
                    return (job, size, lines);
                }
                (job, size, lines)
            })
            .collect();
        let glyphs: Vec<ShapedGlyph> = laid
            .iter()
            .flat_map(|(_, _, lines)| lines.iter().flat_map(|line| line.glyphs.iter().cloned()))
            .collect();
        let subset = FontSubset::build(font, &shaper, &glyphs)?;
        let font_id = embed_subset_font(&mut self.doc, &shaper, &subset, "WarraqArabic");

        let mut report = AppearanceReport::default();
        for (job, size, lines) in laid {
            let stream = self.appearance_stream(&job, size, &lines, font_id, &subset, &shaper)?;
            let stream_id = self.doc.add_object(stream);
            let ap = match self
                .doc
                .get_dictionary(job.annot)
                .ok()
                .and_then(|annot| annot.get(b"AP").ok())
            {
                Some(Object::Dictionary(d)) => d.clone(),
                Some(Object::Reference(id)) => {
                    self.doc.get_dictionary(*id).cloned().unwrap_or_default()
                }
                _ => Dictionary::new(),
            };
            let mut ap = ap;
            ap.set("N", Object::Reference(stream_id));
            let annot = self.doc.get_dictionary_mut(job.annot).map_err(parse)?;
            annot.set("AP", ap);
            if job.grown {
                annot.set(
                    "Rect",
                    job.rect
                        .iter()
                        .map(|v| Object::Real(*v))
                        .collect::<Vec<_>>(),
                );
            }
            self.mark_touched(job.annot);
            if job.comment {
                report.comments += 1;
            } else {
                report.fields += 1;
            }
        }
        Ok(report)
    }

    /// Every annotation on every page whose appearance must be redrawn.
    fn appearance_jobs(&self) -> Vec<Job> {
        let mut seen = BTreeSet::new();
        let mut jobs = Vec::new();
        for &page in &self.pages {
            let annots = match self
                .doc
                .get_dictionary(page)
                .ok()
                .and_then(|p| p.get(b"Annots").ok())
            {
                Some(Object::Array(items)) => items.clone(),
                Some(Object::Reference(id)) => self
                    .doc
                    .get_object(*id)
                    .ok()
                    .and_then(|o| o.as_array().ok())
                    .cloned()
                    .unwrap_or_default(),
                _ => Vec::new(),
            };
            for item in annots {
                let Ok(id) = item.as_reference() else {
                    continue;
                };
                if seen.insert(id) {
                    jobs.extend(self.job_for(id));
                }
            }
        }
        jobs
    }

    /// A field attribute, from the widget or the first field above it that
    /// has it (ISO 32000-2, 12.7.4: attributes are inherited), resolved.
    fn field_value(&self, widget: ObjectId, key: &[u8]) -> Option<Object> {
        let mut id = widget;
        let mut seen = BTreeSet::new();
        while seen.insert(id) {
            let dict = self.doc.get_dictionary(id).ok()?;
            if let Ok(value) = dict.get(key) {
                return Some(self.resolve(value));
            }
            id = dict.get(b"Parent").ok()?.as_reference().ok()?;
        }
        None
    }

    fn resolve(&self, value: &Object) -> Object {
        match value {
            Object::Reference(id) => self.doc.get_object(*id).cloned().unwrap_or(Object::Null),
            other => other.clone(),
        }
    }

    /// The document-wide form defaults: `/AcroForm` `/DA` and `/Q`.
    fn form_default(&self, key: &[u8]) -> Option<Object> {
        let form = self.doc.catalog().ok()?.get(b"AcroForm").ok()?;
        let form = match form {
            Object::Reference(id) => self.doc.get_dictionary(*id).ok()?,
            Object::Dictionary(d) => d,
            _ => return None,
        };
        form.get(key).ok().map(|v| self.resolve(v))
    }

    fn job_for(&self, id: ObjectId) -> Option<Job> {
        let dict = self.doc.get_dictionary(id).ok()?;
        let flags = dict
            .get(b"F")
            .ok()
            .and_then(|f| f.as_i64().ok())
            .unwrap_or(0);
        if flags & ANNOT_HIDDEN != 0 {
            return None;
        }
        let (text, comment, multiline) = match dict.get(b"Subtype").ok()?.as_name().ok()? {
            b"Widget" => {
                let kind = self.field_value(id, b"FT")?;
                let kind = kind.as_name().ok()?;
                let field_flags = self
                    .field_value(id, b"Ff")
                    .and_then(|f| f.as_i64().ok())
                    .unwrap_or(0);
                if field_flags & FLAG_PASSWORD != 0 {
                    return None;
                }
                let value = match (kind, self.field_value(id, b"V")?) {
                    (b"Tx", Object::String(bytes, _)) => decode_text_string(&bytes),
                    (b"Ch", Object::String(bytes, _)) if field_flags & FLAG_COMBO != 0 => {
                        decode_text_string(&bytes)
                    }
                    _ => return None,
                };
                (
                    value,
                    false,
                    kind == b"Tx" && field_flags & FLAG_MULTILINE != 0,
                )
            }
            b"FreeText" => {
                let contents = self.resolve(dict.get(b"Contents").ok()?);
                (decode_text_string(contents.as_str().ok()?), true, true)
            }
            _ => return None,
        };
        if !needs_shaping(&text) {
            return None;
        }

        let old = dict
            .get(b"AP")
            .ok()
            .map(|ap| self.resolve(ap))
            .and_then(|ap| ap.as_dict().ok().and_then(|d| d.get(b"N").ok().cloned()))
            .map(|n| self.resolve(&n))
            .and_then(|n| n.as_stream().ok().cloned());
        let rect = numbers(&self.resolve(dict.get(b"Rect").ok()?))?;
        let (w, h) = ((rect[2] - rect[0]).abs(), (rect[3] - rect[1]).abs());
        if w < 1.0 || h < 1.0 {
            return None;
        }
        let bbox = old
            .as_ref()
            .and_then(|s| s.dict.get(b"BBox").ok())
            .and_then(|b| numbers(&self.resolve(b)))
            .unwrap_or([0.0, 0.0, w, h]);
        let matrix = old
            .as_ref()
            .and_then(|s| s.dict.get(b"Matrix").ok())
            .map(|m| self.resolve(m));

        let da = if comment {
            dict.get(b"DA").ok().map(|d| self.resolve(d))
        } else {
            self.field_value(id, b"DA")
        }
        .or_else(|| self.form_default(b"DA"));
        let (size, color) = da
            .as_ref()
            .and_then(|d| d.as_str().ok())
            .map(parse_default_appearance)
            .unwrap_or((0.0, Vec::new()));
        let q = if comment {
            dict.get(b"Q").ok().and_then(|q| q.as_i64().ok())
        } else {
            self.field_value(id, b"Q").and_then(|q| q.as_i64().ok())
        }
        .or_else(|| self.form_default(b"Q").and_then(|q| q.as_i64().ok()));
        let align = match q {
            Some(1) => Align::Center,
            Some(2) => Align::Right,
            // An explicit left is honoured; no /Q at all means the start of
            // the text's own direction, which for Arabic is the right.
            Some(0) if dict.has(b"Q") => Align::Left,
            _ => Align::Start,
        };
        Some(Job {
            annot: id,
            comment,
            text,
            bbox,
            rect,
            grown: false,
            matrix,
            size,
            color,
            align,
            multiline,
            old,
        })
    }

    fn appearance_stream(
        &self,
        job: &Job,
        size: f32,
        lines: &[Line],
        font_id: ObjectId,
        subset: &FontSubset,
        shaper: &Shaper,
    ) -> Result<Stream> {
        let [x0, y0, x1, y1] = job.bbox;
        let mut text = vec![
            Operation::new("q", vec![]),
            Operation::new(
                "re",
                vec![
                    Object::Real(x0 + 1.0),
                    Object::Real(y0 + 1.0),
                    Object::Real((x1 - x0 - 2.0).max(0.0)),
                    Object::Real((y1 - y0 - 2.0).max(0.0)),
                ],
            ),
            Operation::new("W", vec![]),
            Operation::new("n", vec![]),
            Operation::new("BT", vec![]),
        ];
        if job.color.is_empty() {
            text.push(Operation::new("g", vec![0.into()]));
        } else {
            text.extend(job.color.iter().cloned());
        }
        text.push(Operation::new(
            "Tf",
            vec![Object::Name(FONT_NAME.to_vec()), Object::Real(size)],
        ));
        for line in lines {
            draw_line(&mut text, line, size, subset, shaper);
        }
        text.push(Operation::new("ET", vec![]));
        text.push(Operation::new("Q", vec![]));

        // Around the text, what was drawn before — border and background —
        // with the text block inside `/Tx BMC … EMC` replaced.
        let mut ops = job
            .old
            .as_ref()
            .and_then(|s| {
                let bytes = s
                    .decompressed_content()
                    .unwrap_or_else(|_| s.content.clone());
                Content::decode(&bytes).ok()
            })
            .map(|c| c.operations)
            .unwrap_or_default();
        let marked = ops.iter().position(|op| {
            op.operator == "BMC"
                && op.operands.first().and_then(|o| o.as_name().ok()) == Some(b"Tx")
        });
        match marked.and_then(|start| {
            ops[start..]
                .iter()
                .position(|op| op.operator == "EMC")
                .map(|end| (start, start + end))
        }) {
            Some((start, end)) => {
                ops.splice(start + 1..end, text);
            }
            None => {
                ops.push(Operation::new("BMC", vec![Object::Name(b"Tx".to_vec())]));
                ops.extend(text);
                ops.push(Operation::new("EMC", vec![]));
            }
        }
        let content = Content { operations: ops }
            .encode()
            .map_err(|e| Error::Edit(e.to_string()))?;

        let mut resources = job
            .old
            .as_ref()
            .and_then(|s| s.dict.get(b"Resources").ok())
            .map(|r| self.resolve(r))
            .and_then(|r| r.as_dict().ok().cloned())
            .unwrap_or_default();
        let mut fonts = resources
            .get(b"Font")
            .ok()
            .map(|f| self.resolve(f))
            .and_then(|f| f.as_dict().ok().cloned())
            .unwrap_or_default();
        fonts.set(FONT_NAME, Object::Reference(font_id));
        resources.set("Font", fonts);

        let mut dict = Dictionary::new();
        dict.set("Type", Object::Name(b"XObject".to_vec()));
        dict.set("Subtype", Object::Name(b"Form".to_vec()));
        dict.set(
            "BBox",
            job.bbox
                .iter()
                .map(|v| Object::Real(*v))
                .collect::<Vec<_>>(),
        );
        if let Some(matrix) = &job.matrix {
            dict.set("Matrix", matrix.clone());
        }
        dict.set("Resources", resources);
        let mut stream = Stream::new(dict, content);
        let _ = stream.compress();
        Ok(stream)
    }
}

/// Four numbers from a rectangle array, normalized so x0 ≤ x1 and y0 ≤ y1.
fn numbers(value: &Object) -> Option<[f32; 4]> {
    let items = value.as_array().ok()?;
    if items.len() != 4 {
        return None;
    }
    let mut v = [0f32; 4];
    for (slot, item) in v.iter_mut().zip(items) {
        *slot = item.as_float().ok()?;
    }
    Some([
        v[0].min(v[2]),
        v[1].min(v[3]),
        v[0].max(v[2]),
        v[1].max(v[3]),
    ])
}

/// The size and colour of a default appearance string such as
/// `/Helv 12 Tf 0 g`; a size of 0 means "fit the box".
fn parse_default_appearance(da: &[u8]) -> (f32, Vec<Operation>) {
    let operations = Content::decode(da)
        .map(|c| c.operations)
        .unwrap_or_default();
    let mut size = 0.0;
    let mut color = Vec::new();
    for op in operations {
        match op.operator.as_str() {
            "Tf" => {
                size = op
                    .operands
                    .get(1)
                    .and_then(|o| o.as_float().ok())
                    .unwrap_or(0.0)
            }
            "g" | "rg" | "k" => color.push(op),
            _ => {}
        }
    }
    (size, color)
}

/// Makes a comment's box big enough for its text, as Acrobat grows a text box
/// as you type (EmbedPDF leaves it at its default 100 x 20 points, and the
/// text was cut off): wider for a word longer than the box, on the side away
/// from where the text starts, and taller for more lines, downwards. The box
/// and the annotation's `/Rect` change together. True when it grew.
fn grow_to_fit(job: &mut Job, shaper: &Shaper, size: f32, lines: &[Line]) -> bool {
    let metrics = shaper.metrics();
    let em = ((metrics.ascent - metrics.descent) / 1000.0).max(0.5);
    let [x0, y0, x1, y1] = job.bbox;
    let (w, h) = (x1 - x0, y1 - y0);
    let widest = lines
        .iter()
        .map(|line| width_at_one(&line.glyphs) * size)
        .fold(0.0f32, f32::max);
    let wide = widest + 2.0 * PADDING + 1.0;
    let tall = lines.len() as f32 * em * size + 2.0 * PADDING;
    let (grow_w, grow_h) = ((wide - w).max(0.0), (tall - h).max(0.0));
    if grow_w <= 0.0 && grow_h <= 0.0 {
        return false;
    }
    // The box is mapped onto /Rect; keep that scale when both change.
    let (sx, sy) = (
        (job.rect[2] - job.rect[0]) / w.max(0.001),
        (job.rect[3] - job.rect[1]) / h.max(0.001),
    );
    if grow_w > 0.0 {
        if base_direction(&job.text) == Direction::Rtl {
            job.bbox[0] -= grow_w;
            job.rect[0] -= grow_w * sx;
        } else {
            job.bbox[2] += grow_w;
            job.rect[2] += grow_w * sx;
        }
    }
    job.bbox[1] -= grow_h;
    job.rect[1] -= grow_h * sy;
    job.grown = true;
    true
}

/// Width of shaped glyphs at size 1, in points.
fn width_at_one(glyphs: &[ShapedGlyph]) -> f32 {
    glyphs.iter().map(|g| g.x_advance).sum::<f32>() / 1000.0
}

/// The size to draw at and each line's position, inside `job.bbox`.
fn layout(shaper: &Shaper, job: &Job) -> (f32, Vec<Line>) {
    let metrics = shaper.metrics();
    let [x0, y0, x1, y1] = job.bbox;
    let (w, h) = (x1 - x0, y1 - y0);
    let inner = (w - 2.0 * PADDING).max(1.0);
    // Height of one line per point of size.
    let em = ((metrics.ascent - metrics.descent) / 1000.0).max(0.5);
    let start = |text: &str, width: f32| {
        let align = match job.align {
            Align::Start if base_direction(text) == Direction::Rtl => Align::Right,
            Align::Start => Align::Left,
            other => other,
        };
        x0 + match align {
            Align::Center => (w - width) / 2.0,
            Align::Right => w - PADDING - width,
            _ => PADDING,
        }
    };

    if !job.multiline {
        let text = job.text.replace(['\n', '\r'], " ");
        let glyphs = shaper.shape_line(&text);
        let natural = width_at_one(&glyphs).max(0.001);
        let size = if job.size > 0.0 {
            job.size
        } else {
            AUTO_MAX
                .min((h - 2.0 * PADDING) / em)
                .min(inner / natural)
                .max(4.0)
        };
        let baseline = y0 + (h - em * size) / 2.0 - metrics.descent / 1000.0 * size;
        let x = start(&text, natural * size);
        return (
            size,
            vec![Line {
                x,
                y: baseline,
                glyphs,
            }],
        );
    }

    let size = if job.size > 0.0 { job.size } else { AUTO_MAX };
    let mut texts: Vec<String> = Vec::new();
    for paragraph in job.text.replace('\r', "").split('\n') {
        let mut current = String::new();
        for word in paragraph.split(' ') {
            let candidate = if current.is_empty() {
                word.to_string()
            } else {
                format!("{current} {word}")
            };
            if !current.is_empty() && width_at_one(&shaper.shape_line(&candidate)) * size > inner {
                texts.push(std::mem::replace(&mut current, word.to_string()));
            } else {
                current = candidate;
            }
        }
        texts.push(current);
    }
    let mut y = y1 - PADDING - metrics.ascent / 1000.0 * size;
    let lines = texts
        .into_iter()
        .map(|text| {
            let glyphs = shaper.shape_line(&text);
            let line = Line {
                x: start(&text, width_at_one(&glyphs) * size),
                y,
                glyphs,
            };
            y -= em * size;
            line
        })
        .collect();
    (size, lines)
}

/// One line as text operators, as `append_line` writes one on a page
/// (show.rs): runs of glyphs, a moved glyph on its own, and a word its
/// glyphs do not spell marked with its text.
fn draw_line(
    ops: &mut Vec<Operation>,
    line: &Line,
    size: f32,
    subset: &FontSubset,
    shaper: &Shaper,
) {
    show_line(
        ops,
        subset,
        shaper,
        &ShownLine {
            glyphs: &line.glyphs,
            matrix: [1.0, 0.0, 0.0, 1.0, line.x, line.y],
            size,
            space_stretch: 0.0,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::StringFormat;

    const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");

    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    const ACROBAT_FORM: &str =
        "realworld/F_pdfjs15546_rtl_acroform_textfields_arabic_digits_acrobat.pdf";
    const PDFLIB_FORM: &str = "generated/acroform-pdflib-arabic-fields.pdf";

    fn utf16(text: &str) -> Object {
        let mut bytes = vec![0xFE, 0xFF];
        bytes.extend(text.encode_utf16().flat_map(u16::to_be_bytes));
        Object::String(bytes, StringFormat::Hexadecimal)
    }

    /// The field whose `/T` is `name`, found among the form's fields.
    fn field(doc: &PdfDocument, name: &str) -> ObjectId {
        doc.doc
            .objects
            .iter()
            .find(|(_, o)| {
                o.as_dict()
                    .ok()
                    .and_then(|d| d.get(b"T").ok())
                    .and_then(|t| t.as_str().ok())
                    .map(decode_text_string)
                    .as_deref()
                    == Some(name)
            })
            .map(|(id, _)| *id)
            .unwrap()
    }

    /// The normal appearance stream of an annotation, and its decoded operators.
    fn appearance(doc: &PdfDocument, annot: ObjectId) -> (Stream, Vec<Operation>) {
        let ap = doc
            .doc
            .get_dictionary(annot)
            .unwrap()
            .get(b"AP")
            .unwrap()
            .clone();
        let ap = doc.resolve(&ap);
        let n = doc.resolve(ap.as_dict().unwrap().get(b"N").unwrap());
        let stream = n.as_stream().unwrap().clone();
        let bytes = stream
            .decompressed_content()
            .unwrap_or_else(|_| stream.content.clone());
        (stream, Content::decode(&bytes).unwrap().operations)
    }

    /// What the redrawn text says, read back through its font's ToUnicode.
    fn drawn_text(doc: &PdfDocument, stream: &Stream, ops: &[Operation]) -> String {
        let fonts = doc.resolve(
            doc.resolve(stream.dict.get(b"Resources").unwrap())
                .as_dict()
                .unwrap()
                .get(b"Font")
                .unwrap(),
        );
        let font = doc.resolve(fonts.as_dict().unwrap().get(FONT_NAME).unwrap());
        let cmap = doc.resolve(font.as_dict().unwrap().get(b"ToUnicode").unwrap());
        let cmap = cmap.as_stream().unwrap();
        let cmap =
            String::from_utf8(cmap.decompressed_content().unwrap_or(cmap.content.clone())).unwrap();
        let mut map = std::collections::HashMap::new();
        let hex =
            |s: &str| u32::from_str_radix(s.trim_matches(|c| c == '<' || c == '>'), 16).unwrap();
        for line in cmap.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() == 2 && parts[0].starts_with('<') && parts[1].starts_with('<') {
                let text: String = parts[1]
                    .trim_matches(|c| c == '<' || c == '>')
                    .as_bytes()
                    .chunks(4)
                    .filter_map(|c| u32::from_str_radix(std::str::from_utf8(c).ok()?, 16).ok())
                    .filter_map(char::from_u32)
                    .collect();
                map.insert(hex(parts[0]), text);
            }
        }
        let mut out = String::new();
        for op in ops.iter().filter(|op| op.operator == "TJ") {
            for item in op.operands[0].as_array().unwrap() {
                if let Object::String(bytes, _) = item {
                    for pair in bytes.chunks(2) {
                        let cid = u32::from(pair[0]) << 8 | u32::from(pair[1]);
                        out.push_str(map.get(&cid).map(String::as_str).unwrap_or("?"));
                    }
                }
            }
        }
        out
    }

    #[test]
    fn knows_which_text_needs_shaping() {
        assert!(needs_shaping("مرحبا"));
        assert!(needs_shaping("Name: پیمان")); // Persian
        assert!(needs_shaping("ہے")); // Urdu
        assert!(needs_shaping("\u{FEFB}")); // a presentation form
                                            // Arabic-Indic digits and the Arabic decimal separator are Arabic too:
                                            // Helvetica has neither.
        assert!(needs_shaping("١٢٣"));
        assert!(needs_shaping("3٫5"));
        assert!(
            !needs_shaping("Warraq 123, 4.5 - (x)"),
            "Latin, digits and punctuation alone"
        );
        assert!(!needs_shaping(""));
    }

    #[test]
    fn an_arabic_value_is_drawn_where_pdfium_left_nothing() {
        let mut doc = PdfDocument::open(corpus(ACROBAT_FORM), None).unwrap();
        let text2 = field(&doc, "Text2");
        let value = "مرحبا بالعالم";
        doc.doc
            .get_dictionary_mut(text2)
            .unwrap()
            .set("V", utf16(value));
        let report = doc.fix_arabic_appearances(AMIRI).unwrap();
        assert_eq!(
            report,
            AppearanceReport {
                fields: 1,
                comments: 0
            }
        );

        let (stream, ops) = appearance(&doc, text2);
        // The border Acrobat drew is still there.
        assert!(
            ops.iter().any(|op| op.operator == "re") && ops.iter().any(|op| op.operator == "s")
        );
        // The text, in a marked /Tx block, in the embedded face.
        assert!(ops.iter().any(|op| op.operator == "BMC"));
        let tf = ops.iter().find(|op| op.operator == "Tf").unwrap();
        assert_eq!(tf.operands[0].as_name().unwrap(), FONT_NAME);
        assert_eq!(
            tf.operands[1].as_float().unwrap(),
            12.0,
            "the size its /DA asks for"
        );
        // Every letter typed is in what is drawn (in visual order, so compare sets).
        let drawn = drawn_text(&doc, &stream, &ops);
        let letters = |s: &str| {
            s.chars()
                .filter(|c| !c.is_whitespace())
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(letters(&drawn), letters(value), "drawn: {drawn}");
        // /Q 2: the line ends at the right edge, less the padding.
        let tm = ops.iter().find(|op| op.operator == "Tm").unwrap();
        let x = tm.operands[4].as_float().unwrap();
        assert!(
            x > 20.0,
            "right-aligned text starts well inside the box: {x}"
        );

        // Saved and reopened, the field keeps its new appearance.
        let saved = doc.save_incremental().unwrap();
        let back = PdfDocument::open(saved, None).unwrap();
        let (stream, ops) = appearance(&back, field(&back, "Text2"));
        assert_eq!(letters(&drawn_text(&back, &stream, &ops)), letters(value));
    }

    #[test]
    fn a_value_inherited_from_its_field_reaches_the_widget_below() {
        // pdf-lib's form: the value is on the field, the widget is its kid.
        let mut doc = PdfDocument::open(corpus(PDFLIB_FORM), None).unwrap();
        let report = doc.fix_arabic_appearances(AMIRI).unwrap();
        // "محمد عبد الله" is Arabic; the ID number, all digits, is left alone.
        assert_eq!(report.fields, 1);
        let name = field(&doc, "الاسم الكامل");
        let widget = doc
            .doc
            .get_dictionary(name)
            .unwrap()
            .get(b"Kids")
            .unwrap()
            .as_array()
            .unwrap()[0]
            .as_reference()
            .unwrap();
        let (stream, ops) = appearance(&doc, widget);
        let drawn = drawn_text(&doc, &stream, &ops);
        assert!(
            drawn.contains('م') && drawn.contains('ح') && drawn.contains('د'),
            "{drawn}"
        );
    }

    #[test]
    fn a_document_without_arabic_values_is_left_untouched() {
        let mut doc = PdfDocument::open(corpus(ACROBAT_FORM), None).unwrap();
        let text2 = field(&doc, "Text2");
        doc.doc
            .get_dictionary_mut(text2)
            .unwrap()
            .set("V", Object::string_literal("Warraq 123"));
        let before = doc.doc.objects.len();
        assert_eq!(
            doc.fix_arabic_appearances(AMIRI).unwrap(),
            AppearanceReport::default()
        );
        assert_eq!(
            doc.doc.objects.len(),
            before,
            "no font embedded for nothing"
        );
    }

    #[test]
    fn a_long_arabic_comment_wraps_inside_its_box() {
        let mut doc = PdfDocument::open(corpus(ACROBAT_FORM), None).unwrap();
        let page = doc.page_id(0).unwrap();
        let comment = doc.doc.add_object(Dictionary::from_iter([
            ("Type", Object::Name(b"Annot".to_vec())),
            ("Subtype", Object::Name(b"FreeText".to_vec())),
            (
                "Rect",
                vec![
                    Object::Real(50.0),
                    Object::Real(480.0),
                    Object::Real(200.0),
                    Object::Real(500.0),
                ]
                .into(),
            ),
            ("DA", Object::string_literal("/Helv 11 Tf 1 0 0 rg")),
            (
                "Contents",
                utf16("هذا تعليق طويل كتبه القارئ على الهامش ليرى كيف يلتف النص داخل المربع"),
            ),
        ]));
        let page = doc.doc.get_dictionary_mut(page).unwrap();
        match page.get_mut(b"Annots") {
            Ok(Object::Array(items)) => items.push(Object::Reference(comment)),
            _ => page.set("Annots", vec![Object::Reference(comment)]),
        }
        let report = doc.fix_arabic_appearances(AMIRI).unwrap();
        assert_eq!(report.comments, 1);
        let (stream, ops) = appearance(&doc, comment);
        // Every line sits inside the box, which grew downwards to hold them.
        let bbox = numbers(stream.dict.get(b"BBox").unwrap()).unwrap();
        let rect = numbers(
            doc.doc
                .get_dictionary(comment)
                .unwrap()
                .get(b"Rect")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(rect[3], 500.0, "the top stays where it was placed");
        // Placed 150 x 20, like EmbedPDF's default box: far too small for it.
        assert!(rect[1] < 480.0, "grew downwards: {rect:?}");
        for op in ops.iter().filter(|op| op.operator == "Tm") {
            let y = op.operands[5].as_float().unwrap();
            assert!(y > bbox[1] && y < bbox[3], "line at {y} inside {bbox:?}");
        }
        let lines: BTreeSet<i64> = ops
            .iter()
            .filter(|op| op.operator == "Tm")
            .map(|op| op.operands[5].as_float().unwrap().round() as i64)
            .collect();
        assert!(lines.len() > 1, "wrapped onto several lines: {lines:?}");
        // Its colour is the one its /DA asks for.
        assert!(ops.iter().any(|op| op.operator == "rg"));
    }
}
