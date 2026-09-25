//! PPTX (PresentationML) → one fixed page per slide (slide size from `sldSz`).
//!
//! Text boxes and placeholders are positioned by their `a:xfrm` (placeholders without one take
//! the position of the matching placeholder on the slide layout, then the master); groups map
//! their child coordinates; pictures (`p:pic`, PNG/JPEG) keep their alt text; tables in graphic
//! frames become tables. Paragraph alignment, `rtl`, bullets/numbering (`buChar`, `buAutoNum`),
//! run size/bold/italic/underline/colour/language are honoured. Hidden slides are skipped.
//! Not supported: themes/backgrounds, shapes' fills and outlines, charts, SmartArt, notes.

use std::collections::HashMap;

use super::docx::{relationships, resolve_path};
use super::xml::{self, Node};
use super::zip::Zip;
use super::ReadOptions;
use crate::error::{CreateError, Result};
use crate::layout::text::has_rtl;
use crate::limits;
use crate::model::{
    Align, Block, Cell, Color, Content, Dir, Document, Family, FixedPage, Frame, FrameContent,
    ListInfo, NumberStyle, PageSetup, ParaStyle, Paragraph, Row, Run, Section, Style, Table,
};

const EMU: f64 = 12_700.0;

#[derive(Debug, Clone, Copy)]
struct Xfrm {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn xfrm(n: Option<&Node>) -> Option<Xfrm> {
    let n = n?;
    let off = n.child("off")?;
    let ext = n.child("ext")?;
    let g = |e: &Node, k: &str| {
        e.attr(k)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
    };
    Some(Xfrm {
        x: g(off, "x")?,
        y: g(off, "y")?,
        w: g(ext, "cx")?,
        h: g(ext, "cy")?,
    })
}

/// Group transform: child coordinates → parent coordinates.
#[derive(Debug, Clone, Copy)]
struct Map {
    sx: f64,
    sy: f64,
    dx: f64,
    dy: f64,
}

impl Map {
    const ID: Map = Map {
        sx: 1.0,
        sy: 1.0,
        dx: 0.0,
        dy: 0.0,
    };
    fn apply(&self, x: Xfrm) -> Xfrm {
        Xfrm {
            x: x.x * self.sx + self.dx,
            y: x.y * self.sy + self.dy,
            w: x.w * self.sx,
            h: x.h * self.sy,
        }
    }
}

/// Placeholder key: (type, idx).
fn ph_key(sp: &Node) -> Option<(String, Option<String>)> {
    let ph = sp.find("ph")?;
    Some((
        ph.attr("type").unwrap_or("body").to_string(),
        ph.attr("idx").map(str::to_string),
    ))
}

struct Deck<'a> {
    z: &'a Zip<'a>,
    opts: &'a ReadOptions,
    doc: Document,
    frames: usize,
}

fn placeholder_positions(tree: Option<&Node>) -> Vec<((String, Option<String>), Xfrm)> {
    let mut out = Vec::new();
    if let Some(t) = tree {
        for sp in t.find_all("sp") {
            if let (Some(k), Some(x)) = (ph_key(sp), xfrm(sp.path(&["spPr", "xfrm"]))) {
                out.push((k, x));
            }
        }
    }
    out
}

fn lookup(
    list: &[((String, Option<String>), Xfrm)],
    key: &(String, Option<String>),
) -> Option<Xfrm> {
    let norm = |t: &str| match t {
        "ctrTitle" => "title".to_string(),
        "subTitle" => "body".to_string(),
        o => o.to_string(),
    };
    list.iter()
        .find(|(k, _)| k.1.is_some() && k.1 == key.1)
        .or_else(|| list.iter().find(|(k, _)| norm(&k.0) == norm(&key.0)))
        .map(|(_, x)| *x)
}

impl Deck<'_> {
    fn text_body(&self, body: &Node, ph_type: Option<&str>) -> Vec<Block> {
        let default_size = match ph_type {
            Some("title" | "ctrTitle") => 36.0,
            Some("subTitle") => 24.0,
            Some(_) => 20.0,
            None => 18.0,
        };
        let title = matches!(ph_type, Some("title" | "ctrTitle"));
        let mut blocks = Vec::new();
        let mut counters: HashMap<u8, u32> = HashMap::new();
        for p in body.children_named("p") {
            let ppr = p.child("pPr");
            let align = match ppr.and_then(|x| x.attr("algn")) {
                Some("ctr") => Align::Center,
                Some("r") => Align::Right,
                Some("just" | "justLow" | "dist" | "thaiDist") => Align::Justify,
                Some("l") => Align::Left,
                _ => {
                    if matches!(ph_type, Some("ctrTitle" | "subTitle")) {
                        Align::Center
                    } else {
                        Align::Start
                    }
                }
            };
            let rtl = ppr
                .and_then(|x| x.attr("rtl"))
                .map(|v| v == "1" || v == "true");
            let level = ppr
                .and_then(|x| x.attr("lvl"))
                .and_then(|v| v.parse::<u8>().ok())
                .unwrap_or(0)
                .min(8);
            let mut runs: Vec<Run> = Vec::new();
            for el in p.elems() {
                let (text, rpr) = match el.name() {
                    "r" | "fld" => (
                        el.child("t").map(|t| t.text()).unwrap_or_default(),
                        el.child("rPr"),
                    ),
                    "br" => ("\n".to_string(), el.child("rPr")),
                    _ => continue,
                };
                let size = rpr
                    .and_then(|r| r.attr("sz"))
                    .and_then(|v| v.parse::<f64>().ok())
                    .map_or(default_size, |v| v / 100.0);
                let flag = |k: &str| rpr.and_then(|r| r.attr(k)).map(|v| v == "1" || v == "true");
                let color = rpr
                    .and_then(|r| r.find("srgbClr"))
                    .and_then(|c| c.attr("val"))
                    .and_then(Color::from_hex);
                let face = rpr
                    .and_then(|r| {
                        if has_rtl(&text) {
                            r.child("cs")
                        } else {
                            r.child("latin")
                        }
                    })
                    .and_then(|f| f.attr("typeface"))
                    .and_then(Family::from_font_name);
                let style = Style {
                    family: face.unwrap_or(self.opts.base.family),
                    bold: flag("b").unwrap_or(title),
                    italic: flag("i").unwrap_or(false),
                    underline: rpr.and_then(|r| r.attr("u")).is_some_and(|u| u != "none"),
                    size: size.clamp(1.0, 400.0),
                    color: color.unwrap_or(Color::BLACK),
                    lang: rpr.and_then(|r| r.attr("lang")).map(str::to_string),
                };
                match runs.last_mut() {
                    Some(r) if r.style == style => r.text.push_str(&text),
                    _ => runs.push(Run::new(text, style)),
                }
            }
            let list = ppr.and_then(|x| {
                if let Some(a) = x.child("buAutoNum") {
                    let n = counters.entry(level).or_insert_with(|| {
                        a.attr("startAt")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(1)
                            .max(1)
                            - 1
                    });
                    *n += 1;
                    let scheme = a.attr("type").unwrap_or("arabicPeriod");
                    let style = if scheme.starts_with("alphaLc") {
                        NumberStyle::LowerLetter
                    } else if scheme.starts_with("alphaUc") {
                        NumberStyle::UpperLetter
                    } else if scheme.starts_with("romanLc") {
                        NumberStyle::LowerRoman
                    } else if scheme.starts_with("romanUc") {
                        NumberStyle::UpperRoman
                    } else if scheme.starts_with("arabicDb") || scheme.starts_with("hindi") {
                        NumberStyle::ArabicIndic
                    } else if scheme.starts_with("arabicAbjad") || scheme.starts_with("arabicAlpha")
                    {
                        NumberStyle::ArabicLetter
                    } else {
                        NumberStyle::Auto
                    };
                    Some(ListInfo {
                        ordered: true,
                        level,
                        number: *n,
                        style,
                    })
                } else {
                    x.child("buChar").map(|_| ListInfo {
                        ordered: false,
                        level,
                        number: 1,
                        style: NumberStyle::Auto,
                    })
                }
            });
            if list.is_none() {
                counters.clear();
            }
            if runs.iter().all(|r| r.text.trim().is_empty()) && list.is_none() {
                // Empty paragraphs keep their spacing.
                if !blocks.is_empty() {
                    blocks.push(Block::Paragraph(Paragraph {
                        runs: vec![Run::new(
                            "",
                            Style {
                                size: default_size * 0.6,
                                ..Style::default()
                            },
                        )],
                        style: ParaStyle::default(),
                    }));
                }
                continue;
            }
            blocks.push(Block::Paragraph(Paragraph {
                runs,
                style: ParaStyle {
                    heading: u8::from(title),
                    align,
                    dir: match rtl {
                        Some(true) => Dir::Rtl,
                        Some(false) => Dir::Auto,
                        None => Dir::Auto,
                    },
                    list,
                    space_before: Some(0.0),
                    space_after: Some(4.0),
                    ..ParaStyle::default()
                },
            }));
        }
        blocks
    }

    fn table(&self, tbl: &Node) -> Table {
        let widths: Vec<f64> = tbl
            .child("tblGrid")
            .map(|g| {
                g.children_named("gridCol")
                    .map(|c| c.attr("w").and_then(|v| v.parse().ok()).unwrap_or(0.0))
                    .collect()
            })
            .unwrap_or_default();
        let rtl = tbl
            .child("tblPr")
            .and_then(|p| p.attr("rtl"))
            .is_some_and(|v| v == "1");
        let first_row_header = tbl
            .child("tblPr")
            .and_then(|p| p.attr("firstRow"))
            .is_some_and(|v| v == "1");
        let mut rows = Vec::new();
        for (ri, tr) in tbl.children_named("tr").enumerate() {
            let mut cells = Vec::new();
            for tc in tr.children_named("tc") {
                if tc.attr("hMerge") == Some("1") || tc.attr("vMerge") == Some("1") {
                    continue;
                }
                let blocks = tc
                    .child("txBody")
                    .map(|b| self.text_body(b, None))
                    .unwrap_or_default();
                let span = |k: &str| {
                    tc.attr(k)
                        .and_then(|v| v.parse::<u16>().ok())
                        .unwrap_or(1)
                        .clamp(1, 1000)
                };
                cells.push(Cell {
                    blocks,
                    colspan: span("gridSpan"),
                    rowspan: span("rowSpan"),
                    fill: None,
                });
            }
            rows.push(Row {
                cells,
                header: first_row_header && ri == 0,
            });
        }
        Table {
            rows,
            col_widths: (!widths.is_empty()).then_some(widths),
            dir: if rtl { Dir::Rtl } else { Dir::Auto },
            borders: true,
        }
    }

    fn picture(&mut self, pic: &Node, rels: &HashMap<String, String>) -> Option<(usize, String)> {
        let id = pic.find("blip")?.attr_prefixed("r:embed")?;
        let path = rels.get(id)?;
        let bytes = self.z.read(path).ok()?;
        let img = crate::image::decode(&bytes).ok()?;
        let alt = pic
            .find("cNvPr")
            .and_then(|c| c.attr("descr").filter(|s| !s.is_empty()).or(c.attr("name")))
            .unwrap_or("")
            .to_string();
        Some((self.doc.add_image(img), alt))
    }

    #[allow(clippy::too_many_arguments)]
    fn shapes(
        &mut self,
        tree: &Node,
        map: Map,
        rels: &HashMap<String, String>,
        layout_ph: &[((String, Option<String>), Xfrm)],
        master_ph: &[((String, Option<String>), Xfrm)],
        frames: &mut Vec<Frame>,
        depth: usize,
    ) -> Result<()> {
        if depth > limits::MAX_NESTING {
            return Ok(());
        }
        for el in tree.elems() {
            self.frames += 1;
            limits::check(self.frames, limits::MAX_BLOCKS, "slide shapes")?;
            match el.name() {
                "sp" => {
                    let key = ph_key(el);
                    let pos = xfrm(el.path(&["spPr", "xfrm"]))
                        .map(|x| map.apply(x))
                        .or_else(|| {
                            let k = key.as_ref()?;
                            lookup(layout_ph, k).or_else(|| lookup(master_ph, k))
                        });
                    let Some(pos) = pos else { continue };
                    let Some(body) = el.child("txBody") else {
                        continue;
                    };
                    let blocks = self.text_body(body, key.as_ref().map(|k| k.0.as_str()));
                    if blocks.is_empty() {
                        continue;
                    }
                    let inset = 7.2;
                    frames.push(Frame {
                        x: pos.x / EMU + inset,
                        y: pos.y / EMU + 3.6,
                        width: (pos.w / EMU - 2.0 * inset).max(12.0),
                        height: pos.h / EMU,
                        content: FrameContent::Blocks(blocks),
                    });
                }
                "pic" => {
                    let Some(pos) = xfrm(el.path(&["spPr", "xfrm"])).map(|x| map.apply(x)) else {
                        continue;
                    };
                    if let Some((image, alt)) = self.picture(el, rels) {
                        frames.push(Frame {
                            x: pos.x / EMU,
                            y: pos.y / EMU,
                            width: pos.w / EMU,
                            height: pos.h / EMU,
                            content: FrameContent::Image { image, alt },
                        });
                    }
                }
                "graphicFrame" => {
                    let Some(pos) = xfrm(el.child("xfrm")).map(|x| map.apply(x)) else {
                        continue;
                    };
                    if let Some(tbl) = el.find("tbl") {
                        let t = self.table(tbl);
                        frames.push(Frame {
                            x: pos.x / EMU,
                            y: pos.y / EMU,
                            width: pos.w / EMU,
                            height: pos.h / EMU,
                            content: FrameContent::Blocks(vec![Block::Table(t)]),
                        });
                    }
                }
                "grpSp" => {
                    let gx = el.path(&["grpSpPr", "xfrm"]);
                    let inner = gx.and_then(|g| {
                        let outer = xfrm(Some(g))?;
                        let choff = g.child("chOff")?;
                        let chext = g.child("chExt")?;
                        let f = |n: &Node, k: &str| n.attr(k).and_then(|v| v.parse::<f64>().ok());
                        let (cx, cy) = (f(choff, "x")?, f(choff, "y")?);
                        let (cw, ch) = (f(chext, "cx")?, f(chext, "cy")?);
                        let sx = if cw > 0.0 { outer.w / cw } else { 1.0 };
                        let sy = if ch > 0.0 { outer.h / ch } else { 1.0 };
                        Some(Map {
                            sx: sx * map.sx,
                            sy: sy * map.sy,
                            dx: (outer.x - cx * sx) * map.sx + map.dx,
                            dy: (outer.y - cy * sy) * map.sy + map.dy,
                        })
                    });
                    self.shapes(
                        el,
                        inner.unwrap_or(map),
                        rels,
                        layout_ph,
                        master_ph,
                        frames,
                        depth + 1,
                    )?;
                }
                "AlternateContent" => {
                    if let Some(c) = el.child("Choice").or_else(|| el.child("Fallback")) {
                        self.shapes(c, map, rels, layout_ph, master_ph, frames, depth + 1)?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

fn dir_of(path: &str) -> String {
    path.rsplit_once('/')
        .map_or(String::new(), |(d, _)| d.to_string())
}

fn rels_path(part: &str) -> String {
    match part.rsplit_once('/') {
        Some((d, f)) => format!("{d}/_rels/{f}.rels"),
        None => format!("_rels/{part}.rels"),
    }
}

fn related(z: &Zip, part: &str, kind_suffix: &str) -> Option<String> {
    let text = z.text(&rels_path(part)).ok()?;
    let root = xml::parse_root(&text).ok()?;
    let found = root
        .children_named("Relationship")
        .find(|r| r.attr("Type").is_some_and(|t| t.ends_with(kind_suffix)))
        .and_then(|r| r.attr("Target"))
        .map(|t| resolve_path(&dir_of(part), t));
    found
}

/// Read a PPTX file.
pub fn read(bytes: &[u8], opts: &ReadOptions) -> Result<Document> {
    let z = Zip::open(bytes)?;
    let pres = xml::parse_root(&z.text("ppt/presentation.xml")?)?;
    let (w, h) = pres
        .child("sldSz")
        .and_then(|s| {
            let cx = s.attr("cx")?.parse::<f64>().ok()? / EMU;
            let cy = s.attr("cy")?.parse::<f64>().ok()? / EMU;
            (cx > 72.0 && cy > 72.0 && cx < 14_400.0 && cy < 14_400.0).then_some((cx, cy))
        })
        .unwrap_or((720.0, 405.0));
    let prels = relationships(&z, "ppt/_rels/presentation.xml.rels", "ppt");
    let mut deck = Deck {
        z: &z,
        opts,
        doc: Document::default(),
        frames: 0,
    };
    let mut pages = Vec::new();
    let mut any_rtl = false;
    let ids: Vec<&Node> = pres
        .child("sldIdLst")
        .map(|l| l.children_named("sldId").collect())
        .unwrap_or_default();
    for sid in ids {
        let Some(path) = sid
            .attr_prefixed("r:id")
            .and_then(|id| prels.get(id))
            .cloned()
        else {
            continue;
        };
        let Ok(text) = z.text(&path) else { continue };
        let slide = xml::parse_root(&text)?;
        if slide.attr("show") == Some("0") {
            continue;
        }
        let rels = relationships(&z, &rels_path(&path), &dir_of(&path));
        let layout_path = related(&z, &path, "/slideLayout");
        let layout = layout_path
            .as_ref()
            .and_then(|p| z.text(p).ok())
            .and_then(|t| xml::parse_root(&t).ok());
        let master = layout_path
            .as_ref()
            .and_then(|p| related(&z, p, "/slideMaster"))
            .and_then(|p| z.text(&p).ok())
            .and_then(|t| xml::parse_root(&t).ok());
        let layout_ph = placeholder_positions(layout.as_ref().and_then(|l| l.find("spTree")));
        let master_ph = placeholder_positions(master.as_ref().and_then(|m| m.find("spTree")));
        let mut frames = Vec::new();
        if let Some(tree) = slide.find("spTree") {
            deck.shapes(tree, Map::ID, &rels, &layout_ph, &master_ph, &mut frames, 0)?;
        }
        for f in &frames {
            if let FrameContent::Blocks(b) = &f.content {
                any_rtl |= b
                    .iter()
                    .any(|x| matches!(x, Block::Paragraph(p) if has_rtl(&p.text())));
            }
        }
        limits::check(pages.len() + 1, limits::MAX_PAGES, "slides")?;
        pages.push(FixedPage {
            width: w,
            height: h,
            frames,
            background: None,
        });
    }
    if pages.is_empty() {
        return Err(CreateError::malformed("the presentation has no slides"));
    }
    let mut doc = deck.doc;
    doc.sections.push(Section {
        page: PageSetup::with_size(w, h, 0.0),
        content: Content::Fixed(pages),
        page_from_source: true,
    });
    doc.lang = Some(if any_rtl { "ar".into() } else { "en".into() });
    Ok(doc)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;
    use crate::readers::zip::build;

    #[test]
    fn slides_with_positioned_text_and_layout_placeholders() {
        let pres = r#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>"#;
        let prels = r#"<Relationships><Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/></Relationships>"#;
        let slide = r#"<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
          <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>عنوان الشريحة</a:t></a:r></a:p></p:txBody></p:sp>
          <p:sp><p:spPr><a:xfrm><a:off x="1270000" y="2540000"/><a:ext cx="5080000" cy="1270000"/></a:xfrm></p:spPr><p:txBody><a:p><a:pPr algn="r" rtl="1"/><a:r><a:rPr sz="2000" b="1"/><a:t>نص</a:t></a:r></a:p></p:txBody></p:sp>
        </p:spTree></p:cSld></p:sld>"#;
        let srels = r#"<Relationships><Relationship Id="rId1" Type="x/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>"#;
        let layout = r#"<p:sldLayout xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="635000" y="635000"/><a:ext cx="7620000" cy="1270000"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>"#;
        let z = build(
            &[
                ("ppt/presentation.xml", pres.as_bytes()),
                ("ppt/_rels/presentation.xml.rels", prels.as_bytes()),
                ("ppt/slides/slide1.xml", slide.as_bytes()),
                ("ppt/slides/_rels/slide1.xml.rels", srels.as_bytes()),
                ("ppt/slideLayouts/slideLayout1.xml", layout.as_bytes()),
            ],
            true,
        );
        let d = read(&z, &ReadOptions::default()).unwrap();
        let Content::Fixed(pages) = &d.sections[0].content else {
            panic!()
        };
        assert_eq!(pages.len(), 1);
        assert_eq!((pages[0].width, pages[0].height), (720.0, 540.0));
        assert_eq!(pages[0].frames.len(), 2);
        // Title from the layout placeholder position (50pt, 50pt + insets).
        assert!((pages[0].frames[0].x - 57.2).abs() < 0.01);
        let FrameContent::Blocks(b) = &pages[0].frames[1].content else {
            panic!()
        };
        let Block::Paragraph(p) = &b[0] else { panic!() };
        assert_eq!(p.style.dir, Dir::Rtl);
        assert_eq!(p.style.align, Align::Right);
        assert!(p.runs[0].style.bold);
        assert_eq!(p.runs[0].style.size, 20.0);
    }
}
