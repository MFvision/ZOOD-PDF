//! DOCX (WordprocessingML) → model.
//!
//! Supported: paragraphs and runs (bold/italic/underline/size/colour/font family, complex-script
//! `bCs/iCs/szCs` for Arabic runs, `w:lang`), paragraph styles with `basedOn` (headings by name,
//! id or outline level), alignment (`jc` start/end/left/right/center/both — `left`/`right` are
//! logical in bidi paragraphs, as Word writes them), `w:bidi`, spacing, indents, page breaks
//! (`w:br type=page`, `pageBreakBefore`, section breaks), numbering (`numPr` → bullets, decimal,
//! letters, roman, `arabicAbjad`/`arabicAlpha`, `hindiNumbers`), tables (`tblGrid` widths,
//! `gridSpan`, `vMerge`, `tblHeader`, `bidiVisual`, cell shading), inline/anchored pictures
//! (PNG/JPEG via `r:embed`) with their alt text, section page size/margins/orientation, the core
//! title. Deleted revisions (`w:del`) are skipped. Not supported: headers/footers, footnotes,
//! text boxes, fields' results beyond their current text, floating positions.

use std::collections::HashMap;

use super::xml::{self, Node};
use super::zip::Zip;
use super::ReadOptions;
use crate::error::Result;
use crate::layout::text::has_rtl;
use crate::limits;
use crate::model::{
    Align, Block, Cell, Color, Content, Dir, Document, Family, ImageBlock, ListInfo, NumberStyle,
    PageSetup, ParaStyle, Paragraph, Row, Run, Section, Style, Table,
};

const TWIP: f64 = 1.0 / 20.0;
const EMU_PER_PT: f64 = 12_700.0;

/// Relationship id → package part path.
pub fn relationships(z: &Zip, rels_path: &str, base_dir: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(text) = z.text(rels_path) else {
        return out;
    };
    let Ok(root) = xml::parse_root(&text) else {
        return out;
    };
    for r in root.children_named("Relationship") {
        if r.attr("TargetMode") == Some("External") {
            continue; // never follow external links
        }
        if let (Some(id), Some(t)) = (r.attr("Id"), r.attr("Target")) {
            out.insert(id.to_string(), resolve_path(base_dir, t));
        }
    }
    out
}

/// Resolve `target` relative to `base_dir` (`word/` + `media/a.png`, `../media/x.png`).
pub fn resolve_path(base_dir: &str, target: &str) -> String {
    let mut parts: Vec<&str> = if target.starts_with('/') {
        Vec::new()
    } else {
        base_dir.split('/').filter(|s| !s.is_empty()).collect()
    };
    for seg in target.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

fn on(n: Option<&Node>) -> Option<bool> {
    let n = n?;
    Some(!matches!(
        n.attr("val"),
        Some("0" | "false" | "off" | "none")
    ))
}

fn val_f(n: Option<&Node>) -> Option<f64> {
    n?.attr("val")?
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
}

/// Run properties as parsed (all optional so styles can be layered).
#[derive(Debug, Clone, Default, PartialEq)]
struct RPr {
    b: Option<bool>,
    i: Option<bool>,
    b_cs: Option<bool>,
    i_cs: Option<bool>,
    u: Option<bool>,
    sz: Option<f64>,
    sz_cs: Option<f64>,
    color: Option<Color>,
    font: Option<String>,
    font_cs: Option<String>,
    lang: Option<String>,
    lang_bidi: Option<String>,
    rtl: Option<bool>,
    vanish: Option<bool>,
}

impl RPr {
    fn parse(n: Option<&Node>) -> RPr {
        let Some(n) = n else { return RPr::default() };
        let fonts = n.child("rFonts");
        RPr {
            b: on(n.child("b")),
            i: on(n.child("i")),
            b_cs: on(n.child("bCs")),
            i_cs: on(n.child("iCs")),
            u: n.child("u")
                .map(|u| !matches!(u.attr("val"), Some("none" | "0" | "false"))),
            sz: val_f(n.child("sz")).map(|v| v / 2.0),
            sz_cs: val_f(n.child("szCs")).map(|v| v / 2.0),
            color: n
                .child("color")
                .and_then(|c| c.attr("val"))
                .and_then(Color::from_hex),
            font: fonts
                .and_then(|f| f.attr("ascii").or(f.attr("hAnsi")))
                .map(str::to_string),
            font_cs: fonts.and_then(|f| f.attr("cs")).map(str::to_string),
            lang: n
                .child("lang")
                .and_then(|l| l.attr("val"))
                .map(str::to_string),
            lang_bidi: n
                .child("lang")
                .and_then(|l| l.attr("bidi"))
                .map(str::to_string),
            rtl: on(n.child("rtl")),
            vanish: on(n.child("vanish")),
        }
    }

    /// `self` over `base`.
    fn over(&self, base: &RPr) -> RPr {
        RPr {
            b: self.b.or(base.b),
            i: self.i.or(base.i),
            b_cs: self.b_cs.or(base.b_cs),
            i_cs: self.i_cs.or(base.i_cs),
            u: self.u.or(base.u),
            sz: self.sz.or(base.sz),
            sz_cs: self.sz_cs.or(base.sz_cs),
            color: self.color.or(base.color),
            font: self.font.clone().or_else(|| base.font.clone()),
            font_cs: self.font_cs.clone().or_else(|| base.font_cs.clone()),
            lang: self.lang.clone().or_else(|| base.lang.clone()),
            lang_bidi: self.lang_bidi.clone().or_else(|| base.lang_bidi.clone()),
            rtl: self.rtl.or(base.rtl),
            vanish: self.vanish.or(base.vanish),
        }
    }

    fn style(&self, text: &str, heading: u8, base: &Style) -> Style {
        let cs = self.rtl.unwrap_or(false) || has_rtl(text);
        let pick = |a: Option<bool>, b: Option<bool>| if cs { a.or(b) } else { b };
        let size = if cs { self.sz_cs.or(self.sz) } else { self.sz }.unwrap_or(match heading {
            1 => 20.0,
            2 => 16.0,
            3 => 14.0,
            4..=6 => 12.0,
            _ => base.size,
        });
        let font = if cs {
            self.font_cs.as_ref().or(self.font.as_ref())
        } else {
            self.font.as_ref()
        };
        Style {
            family: font
                .and_then(|f| Family::from_font_name(f))
                .unwrap_or(if cs { Family::Serif } else { base.family }),
            bold: pick(self.b_cs, self.b).unwrap_or(heading > 0),
            italic: pick(self.i_cs, self.i).unwrap_or(false),
            underline: self.u.unwrap_or(false),
            size: size.clamp(1.0, 400.0),
            color: self.color.unwrap_or(base.color),
            lang: if cs {
                self.lang_bidi.clone().or_else(|| Some("ar".into()))
            } else {
                self.lang.clone()
            },
        }
    }
}

#[derive(Debug, Clone, Default)]
struct PPr {
    heading: Option<u8>,
    align: Option<Align>,
    bidi: Option<bool>,
    before: Option<f64>,
    after: Option<f64>,
    line: Option<f64>,
    indent: Option<f64>,
    num: Option<(String, u8)>,
    page_break_before: Option<bool>,
}

impl PPr {
    fn parse(n: Option<&Node>) -> PPr {
        let Some(n) = n else { return PPr::default() };
        let sp = n.child("spacing");
        let ind = n.child("ind");
        let twips = |v: Option<&str>| {
            v.and_then(|s| s.parse::<f64>().ok())
                .filter(|v| v.is_finite())
                .map(|v| v * TWIP)
        };
        PPr {
            heading: n
                .child("outlineLvl")
                .and_then(|o| o.attr("val"))
                .and_then(|v| v.parse::<u8>().ok())
                .filter(|v| *v < 6)
                .map(|v| v + 1),
            align: n.child("jc").and_then(|j| j.attr("val")).map(|v| match v {
                "center" => Align::Center,
                "both" | "distribute" | "thaiDistribute" | "lowKashida" | "mediumKashida"
                | "highKashida" => Align::Justify,
                "right" | "end" => Align::End,
                _ => Align::Start,
            }),
            bidi: on(n.child("bidi")),
            before: twips(sp.and_then(|s| s.attr("before"))),
            after: twips(sp.and_then(|s| s.attr("after"))),
            line: sp.and_then(|s| {
                let rule = s.attr("lineRule").unwrap_or("auto");
                let v = s.attr("line")?.parse::<f64>().ok()?;
                (rule == "auto" && v > 0.0).then_some(v / 240.0)
            }),
            indent: twips(ind.and_then(|i| i.attr("start").or(i.attr("left")))),
            num: n.child("numPr").and_then(|np| {
                let id = np.child("numId")?.attr("val")?.to_string();
                let lvl = np
                    .child("ilvl")
                    .and_then(|l| l.attr("val"))
                    .and_then(|v| v.parse::<u8>().ok())
                    .unwrap_or(0)
                    .min(8);
                Some((id, lvl))
            }),
            page_break_before: on(n.child("pageBreakBefore")),
        }
    }

    fn over(&self, base: &PPr) -> PPr {
        PPr {
            heading: self.heading.or(base.heading),
            align: self.align.or(base.align),
            bidi: self.bidi.or(base.bidi),
            before: self.before.or(base.before),
            after: self.after.or(base.after),
            line: self.line.or(base.line),
            indent: self.indent.or(base.indent),
            num: self.num.clone().or_else(|| base.num.clone()),
            page_break_before: self.page_break_before.or(base.page_break_before),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct StyleDef {
    based_on: Option<String>,
    ppr: PPr,
    rpr: RPr,
    heading: Option<u8>,
    table_borders: bool,
}

#[derive(Debug, Default)]
struct Styles {
    defs: HashMap<String, StyleDef>,
    default_rpr: RPr,
    default_ppr: PPr,
    default_para: Option<String>,
}

fn heading_from_name(name: &str) -> Option<u8> {
    let n = name.to_ascii_lowercase().replace(' ', "");
    if n == "title" {
        return Some(1);
    }
    let rest = n.strip_prefix("heading")?;
    rest.parse::<u8>().ok().filter(|v| (1..=6).contains(v))
}

impl Styles {
    fn parse(text: Option<String>) -> Styles {
        let mut s = Styles::default();
        let Some(root) = text.and_then(|t| xml::parse_root(&t).ok()) else {
            return s;
        };
        if let Some(dd) = root.child("docDefaults") {
            s.default_rpr = RPr::parse(dd.path(&["rPrDefault", "rPr"]));
            s.default_ppr = PPr::parse(dd.path(&["pPrDefault", "pPr"]));
        }
        for st in root.children_named("style") {
            let Some(id) = st.attr("styleId") else {
                continue;
            };
            let name = st.child("name").and_then(|n| n.attr("val")).unwrap_or("");
            let heading = heading_from_name(name).or_else(|| heading_from_name(id));
            if st.attr("type") == Some("paragraph") && st.attr("default") == Some("1") {
                s.default_para = Some(id.to_string());
            }
            let borders = st.path(&["tblPr", "tblBorders"]).is_some_and(|b| {
                b.elems()
                    .any(|e| !matches!(e.attr("val"), Some("nil" | "none")))
            });
            s.defs.insert(
                id.to_string(),
                StyleDef {
                    based_on: st
                        .child("basedOn")
                        .and_then(|b| b.attr("val"))
                        .map(str::to_string),
                    ppr: PPr::parse(st.child("pPr")),
                    rpr: RPr::parse(st.child("rPr")),
                    heading,
                    table_borders: borders,
                },
            );
        }
        s
    }

    /// Resolved (pPr, rPr, heading) of a paragraph style.
    fn resolve(&self, id: Option<&str>) -> (PPr, RPr, Option<u8>) {
        let mut chain = Vec::new();
        let mut cur = id.map(str::to_string).or_else(|| self.default_para.clone());
        while let Some(c) = cur {
            if chain.len() > 20 || chain.contains(&c) {
                break;
            }
            let next = self.defs.get(&c).and_then(|d| d.based_on.clone());
            chain.push(c);
            cur = next;
        }
        let mut ppr = self.default_ppr.clone();
        let mut rpr = self.default_rpr.clone();
        let mut heading = None;
        for c in chain.iter().rev() {
            if let Some(d) = self.defs.get(c) {
                ppr = d.ppr.over(&ppr);
                rpr = d.rpr.over(&rpr);
                if d.heading.is_some() {
                    heading = d.heading;
                }
            }
        }
        (ppr.clone(), rpr, heading.or(ppr.heading))
    }

    fn char_style(&self, id: &str) -> RPr {
        let mut chain = Vec::new();
        let mut cur = Some(id.to_string());
        while let Some(c) = cur {
            if chain.len() > 20 || chain.contains(&c) {
                break;
            }
            let next = self.defs.get(&c).and_then(|d| d.based_on.clone());
            chain.push(c);
            cur = next;
        }
        let mut rpr = RPr::default();
        for c in chain.iter().rev() {
            if let Some(d) = self.defs.get(c) {
                rpr = d.rpr.over(&rpr);
            }
        }
        rpr
    }
}

#[derive(Debug, Default)]
struct Numbering {
    /// numId → (abstractNumId, start overrides per level)
    nums: HashMap<String, (String, HashMap<u8, u32>)>,
    /// abstractNumId → level → (format, start)
    abstracts: HashMap<String, HashMap<u8, (String, u32)>>,
    counters: HashMap<(String, u8), u32>,
}

impl Numbering {
    fn parse(text: Option<String>) -> Numbering {
        let mut n = Numbering::default();
        let Some(root) = text.and_then(|t| xml::parse_root(&t).ok()) else {
            return n;
        };
        for a in root.children_named("abstractNum") {
            let Some(id) = a.attr("abstractNumId") else {
                continue;
            };
            let mut lv = HashMap::new();
            for l in a.children_named("lvl") {
                let Some(i) = l.attr("ilvl").and_then(|v| v.parse::<u8>().ok()) else {
                    continue;
                };
                let fmt = l
                    .child("numFmt")
                    .and_then(|f| f.attr("val"))
                    .unwrap_or("decimal");
                let start = l
                    .child("start")
                    .and_then(|s| s.attr("val"))
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1);
                lv.insert(i, (fmt.to_string(), start));
            }
            n.abstracts.insert(id.to_string(), lv);
        }
        for num in root.children_named("num") {
            let Some(id) = num.attr("numId") else {
                continue;
            };
            let Some(abs) = num.child("abstractNumId").and_then(|a| a.attr("val")) else {
                continue;
            };
            let mut ov = HashMap::new();
            for o in num.children_named("lvlOverride") {
                if let (Some(i), Some(s)) = (
                    o.attr("ilvl").and_then(|v| v.parse::<u8>().ok()),
                    o.child("startOverride")
                        .and_then(|s| s.attr("val"))
                        .and_then(|v| v.parse().ok()),
                ) {
                    ov.insert(i, s);
                }
            }
            n.nums.insert(id.to_string(), (abs.to_string(), ov));
        }
        n
    }

    fn next(&mut self, num_id: &str, level: u8) -> Option<ListInfo> {
        let (abs, ov) = self.nums.get(num_id)?;
        let (fmt, start) = self
            .abstracts
            .get(abs)
            .and_then(|l| l.get(&level))
            .cloned()
            .unwrap_or_else(|| ("decimal".into(), 1));
        if fmt == "none" {
            return None;
        }
        let start = ov.get(&level).copied().unwrap_or(start);
        let key = (abs.clone(), level);
        let n = match self.counters.get(&key) {
            Some(c) => c + 1,
            None => start,
        };
        self.counters.insert(key, n);
        // A higher-level item restarts deeper levels.
        let deeper: Vec<(String, u8)> = self
            .counters
            .keys()
            .filter(|(a, l)| a == abs && *l > level)
            .cloned()
            .collect();
        for k in deeper {
            self.counters.remove(&k);
        }
        let (ordered, style) = match fmt.as_str() {
            "bullet" => (false, NumberStyle::Auto),
            "lowerLetter" => (true, NumberStyle::LowerLetter),
            "upperLetter" => (true, NumberStyle::UpperLetter),
            "lowerRoman" => (true, NumberStyle::LowerRoman),
            "upperRoman" => (true, NumberStyle::UpperRoman),
            "arabicAbjad" | "arabicAlpha" => (true, NumberStyle::ArabicLetter),
            "hindiNumbers" | "hindiCounting" => (true, NumberStyle::ArabicIndic),
            _ => (true, NumberStyle::Auto),
        };
        Some(ListInfo {
            ordered,
            level,
            number: n,
            style,
        })
    }
}

struct Ctx<'a> {
    z: &'a Zip<'a>,
    rels: HashMap<String, String>,
    styles: Styles,
    numbering: Numbering,
    opts: &'a ReadOptions,
    doc: Document,
    blocks: usize,
}

/// Output of one body-level element: blocks plus an optional section break after them.
struct Out {
    blocks: Vec<Block>,
    section_end: Option<PageSetup>,
}

fn page_setup(sect: &Node, default: PageSetup) -> PageSetup {
    let mut p = default;
    if let Some(sz) = sect.child("pgSz") {
        let w = sz
            .attr("w")
            .and_then(|v| v.parse::<f64>().ok())
            .map(|v| v * TWIP);
        let h = sz
            .attr("h")
            .and_then(|v| v.parse::<f64>().ok())
            .map(|v| v * TWIP);
        if let (Some(w), Some(h)) = (w, h) {
            if w > 72.0 && h > 72.0 && w < 14_400.0 && h < 14_400.0 {
                p.width = w;
                p.height = h;
            }
        }
    }
    if let Some(m) = sect.child("pgMar") {
        let g = |k: &str, d: f64| {
            m.attr(k)
                .and_then(|v| v.parse::<f64>().ok())
                .map(|v| (v * TWIP).abs())
                .filter(|v| v.is_finite())
                .unwrap_or(d)
        };
        p.margin_top = g("top", p.margin_top);
        p.margin_bottom = g("bottom", p.margin_bottom);
        p.margin_left = g("left", p.margin_left);
        p.margin_right = g("right", p.margin_right);
    }
    p
}

impl Ctx<'_> {
    fn count(&mut self, n: usize) -> Result<()> {
        self.blocks += n;
        limits::check(self.blocks, limits::MAX_BLOCKS, "DOCX blocks")
    }

    fn body(&mut self, parent: &Node, depth: usize) -> Result<Vec<Out>> {
        let mut out = Vec::new();
        if depth > limits::MAX_NESTING {
            return Ok(out);
        }
        for el in parent.elems() {
            match el.name() {
                "p" => {
                    let blocks = self.paragraph(el)?;
                    let section_end = el
                        .path(&["pPr", "sectPr"])
                        .map(|s| page_setup(s, self.opts.page));
                    self.count(blocks.len())?;
                    out.push(Out {
                        blocks,
                        section_end,
                    });
                }
                "tbl" => {
                    let t = self.table(el, depth)?;
                    self.count(1)?;
                    out.push(Out {
                        blocks: vec![Block::Table(t)],
                        section_end: None,
                    });
                }
                "sdt" => {
                    if let Some(c) = el.child("sdtContent") {
                        out.extend(self.body(c, depth + 1)?);
                    }
                }
                "customXml" | "ins" | "smartTag" => out.extend(self.body(el, depth + 1)?),
                "AlternateContent" => {
                    if let Some(c) = el.child("Choice").or_else(|| el.child("Fallback")) {
                        out.extend(self.body(c, depth + 1)?);
                    }
                }
                _ => {}
            }
        }
        Ok(out)
    }

    fn paragraph(&mut self, p: &Node) -> Result<Vec<Block>> {
        let ppr_node = p.child("pPr");
        let style_id = ppr_node
            .and_then(|n| n.child("pStyle"))
            .and_then(|s| s.attr("val"));
        let (style_ppr, style_rpr, style_heading) = self.styles.resolve(style_id);
        let ppr = PPr::parse(ppr_node).over(&style_ppr);
        let heading = ppr.heading.or(style_heading).unwrap_or(0).min(6);
        let list = match &ppr.num {
            Some((id, lvl)) if id != "0" => self.numbering.next(id, *lvl),
            _ => None,
        };
        let pstyle = ParaStyle {
            heading,
            align: ppr.align.unwrap_or(Align::Start),
            dir: match ppr.bidi {
                Some(true) => Dir::Rtl,
                Some(false) | None => Dir::Ltr,
            },
            list,
            space_before: ppr.before,
            space_after: ppr.after,
            indent: if ppr.num.is_some() {
                0.0
            } else {
                ppr.indent.unwrap_or(0.0).clamp(0.0, 300.0)
            },
            line_height: ppr.line.map_or(1.0, |l| l.clamp(0.5, 3.0)),
            page_break_before: ppr.page_break_before.unwrap_or(false),
            background: None,
        };
        let mut b = ParaBuilder {
            blocks: Vec::new(),
            runs: Vec::new(),
            style: pstyle,
            first: true,
        };
        self.inline(p, &style_rpr, heading, &mut b, 0)?;
        b.flush(true);
        Ok(b.blocks)
    }

    fn inline(
        &mut self,
        parent: &Node,
        base: &RPr,
        heading: u8,
        b: &mut ParaBuilder,
        depth: usize,
    ) -> Result<()> {
        if depth > limits::MAX_NESTING {
            return Ok(());
        }
        for el in parent.elems() {
            match el.name() {
                "r" => self.run(el, base, heading, b, depth)?,
                "hyperlink" | "ins" | "smartTag" | "fldSimple" | "customXml" | "bdo" | "dir"
                | "moveTo" => {
                    self.inline(el, base, heading, b, depth + 1)?;
                }
                "sdt" => {
                    if let Some(c) = el.child("sdtContent") {
                        self.inline(c, base, heading, b, depth + 1)?;
                    }
                }
                "AlternateContent" => {
                    if let Some(c) = el.child("Choice").or_else(|| el.child("Fallback")) {
                        self.inline(c, base, heading, b, depth + 1)?;
                    }
                }
                _ => {} // pPr, del, bookmarks, proofErr, …
            }
        }
        Ok(())
    }

    fn run(
        &mut self,
        r: &Node,
        base: &RPr,
        heading: u8,
        b: &mut ParaBuilder,
        depth: usize,
    ) -> Result<()> {
        let rpr_node = r.child("rPr");
        let mut rpr = base.clone();
        if let Some(cs) = rpr_node
            .and_then(|n| n.child("rStyle"))
            .and_then(|s| s.attr("val"))
        {
            rpr = self.styles.char_style(cs).over(&rpr);
        }
        rpr = RPr::parse(rpr_node).over(&rpr);
        if rpr.vanish == Some(true) {
            return Ok(());
        }
        for el in r.elems() {
            match el.name() {
                "t" => {
                    let t = el.text();
                    b.push(&t, &rpr, heading, &self.opts.base);
                }
                "tab" | "ptab" => b.push("\t", &rpr, heading, &self.opts.base),
                "br" | "cr" => {
                    if el.attr("type") == Some("page") {
                        b.flush(false);
                        b.blocks.push(Block::PageBreak);
                    } else {
                        b.push("\n", &rpr, heading, &self.opts.base);
                    }
                }
                "noBreakHyphen" => b.push("-", &rpr, heading, &self.opts.base),
                "drawing" => self.drawing(el, b)?,
                "pict" | "object" => {
                    if let Some(img) = el.find("imagedata") {
                        let id = img.attr_prefixed("r:id").map(str::to_string);
                        if let Some(id) = id {
                            self.picture(&id, None, "", b)?;
                        }
                    }
                }
                "AlternateContent" => {
                    if let Some(c) = el.child("Choice").or_else(|| el.child("Fallback")) {
                        let wrapper = Node {
                            qname: "w:r".into(),
                            attrs: Vec::new(),
                            children: c.children.clone(),
                        };
                        if depth < limits::MAX_NESTING {
                            self.run(&wrapper, &rpr, heading, b, depth + 1)?;
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn drawing(&mut self, d: &Node, b: &mut ParaBuilder) -> Result<()> {
        let Some(holder) = d.child("inline").or_else(|| d.child("anchor")) else {
            return Ok(());
        };
        let size = holder.child("extent").and_then(|e| {
            let cx = e.attr("cx")?.parse::<f64>().ok()? / EMU_PER_PT;
            let cy = e.attr("cy")?.parse::<f64>().ok()? / EMU_PER_PT;
            (cx.is_finite() && cy.is_finite() && cx > 0.0 && cy > 0.0).then_some((cx, cy))
        });
        let alt = holder
            .child("docPr")
            .and_then(|p| {
                p.attr("descr")
                    .filter(|s| !s.is_empty())
                    .or(p.attr("title"))
                    .or(p.attr("name"))
            })
            .unwrap_or("")
            .to_string();
        if let Some(blip) = holder.find("blip") {
            if let Some(id) = blip.attr_prefixed("r:embed").map(str::to_string) {
                self.picture(&id, size, &alt, b)?;
            }
        }
        Ok(())
    }

    fn picture(
        &mut self,
        rel: &str,
        size: Option<(f64, f64)>,
        alt: &str,
        b: &mut ParaBuilder,
    ) -> Result<()> {
        let Some(path) = self.rels.get(rel).cloned() else {
            return Ok(());
        };
        let Ok(bytes) = self.z.read(&path) else {
            return Ok(());
        };
        let Ok(img) = crate::image::decode(&bytes) else {
            return Ok(()); // EMF/WMF/GIF… are skipped
        };
        let (w, h) = size.unwrap_or_else(|| img.natural_size());
        let idx = self.doc.add_image(img);
        b.flush(false);
        b.blocks.push(Block::Image(ImageBlock {
            image: idx,
            width: w,
            height: h,
            alt: alt.to_string(),
            align: match b.style.align {
                Align::Center => Align::Center,
                Align::End | Align::Right => Align::End,
                _ => Align::Start,
            },
        }));
        Ok(())
    }

    fn table(&mut self, t: &Node, depth: usize) -> Result<Table> {
        let tblpr = t.child("tblPr");
        let rtl = tblpr
            .and_then(|p| on(p.child("bidiVisual")))
            .unwrap_or(false);
        let style_borders = tblpr
            .and_then(|p| p.child("tblStyle"))
            .and_then(|s| s.attr("val"))
            .is_some_and(|id| {
                self.styles.defs.get(id).is_some_and(|d| d.table_borders)
                    || id.to_ascii_lowercase().contains("grid")
            });
        let own_borders = tblpr.and_then(|p| p.child("tblBorders")).map(|b| {
            b.elems()
                .any(|e| !matches!(e.attr("val"), Some("nil" | "none")))
        });
        let widths: Vec<f64> = t
            .child("tblGrid")
            .map(|g| {
                g.children_named("gridCol")
                    .map(|c| {
                        c.attr("w")
                            .and_then(|v| v.parse::<f64>().ok())
                            .unwrap_or(0.0)
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Rows with grid positions to resolve vMerge.
        let mut rows: Vec<Row> = Vec::new();
        // For each row: per cell (grid col, vmerge state)
        let mut positions: Vec<Vec<(usize, Option<bool>)>> = Vec::new();
        for tr in t.children_named("tr") {
            let header = tr
                .child("trPr")
                .is_some_and(|p| on(p.child("tblHeader")).unwrap_or(false));
            let mut cells = Vec::new();
            let mut pos = Vec::new();
            let mut col = 0usize;
            for tc in tr.children_named("tc") {
                let tcpr = tc.child("tcPr");
                let span = tcpr
                    .and_then(|p| p.child("gridSpan"))
                    .and_then(|g| g.attr("val"))
                    .and_then(|v| v.parse::<u16>().ok())
                    .unwrap_or(1)
                    .clamp(1, limits::MAX_COLUMNS as u16);
                let vmerge = tcpr
                    .and_then(|p| p.child("vMerge"))
                    .map(|v| v.attr("val") == Some("restart"));
                let fill = tcpr
                    .and_then(|p| p.child("shd"))
                    .and_then(|s| s.attr("fill"))
                    .and_then(Color::from_hex)
                    .filter(|c| {
                        *c != Color {
                            r: 255,
                            g: 255,
                            b: 255,
                        }
                    });
                let mut blocks = Vec::new();
                for out in self.body(tc, depth + 1)? {
                    blocks.extend(out.blocks);
                }
                cells.push(Cell {
                    blocks,
                    colspan: span,
                    rowspan: 1,
                    fill,
                });
                pos.push((col, vmerge));
                col += usize::from(span);
            }
            rows.push(Row { cells, header });
            positions.push(pos);
        }
        // vMerge continue → grow the rowspan of the cell above at the same grid column.
        let mut remove: Vec<(usize, usize)> = Vec::new();
        for r in 0..rows.len() {
            let Some(pos) = positions.get(r).cloned() else {
                continue;
            };
            for (ci, (col, vm)) in pos.iter().enumerate() {
                if *vm != Some(false) {
                    continue;
                }
                // find the owner going up
                let mut rr = r;
                while rr > 0 {
                    rr -= 1;
                    let owner = positions
                        .get(rr)
                        .and_then(|p| p.iter().position(|(c, v)| c == col && *v != Some(false)));
                    if let Some(oi) = owner {
                        if let Some(cell) = rows.get_mut(rr).and_then(|row| row.cells.get_mut(oi)) {
                            cell.rowspan = cell.rowspan.saturating_add(1);
                        }
                        remove.push((r, ci));
                        break;
                    }
                    let continues = positions
                        .get(rr)
                        .is_some_and(|p| p.iter().any(|(c, v)| c == col && *v == Some(false)));
                    if !continues {
                        break;
                    }
                }
            }
        }
        remove.sort_unstable();
        for (r, ci) in remove.into_iter().rev() {
            if let Some(row) = rows.get_mut(r) {
                if ci < row.cells.len() {
                    row.cells.remove(ci);
                }
            }
        }
        Ok(Table {
            rows,
            col_widths: (!widths.is_empty() && widths.iter().any(|w| *w > 0.0)).then_some(widths),
            dir: if rtl { Dir::Rtl } else { Dir::Ltr },
            borders: own_borders.unwrap_or(style_borders),
        })
    }
}

struct ParaBuilder {
    blocks: Vec<Block>,
    runs: Vec<Run>,
    style: ParaStyle,
    first: bool,
}

impl ParaBuilder {
    fn push(&mut self, text: &str, rpr: &RPr, heading: u8, base: &Style) {
        let style = rpr.style(text, heading, base);
        match self.runs.last_mut() {
            Some(r) if r.style == style => r.text.push_str(text),
            _ => self.runs.push(Run::new(text, style)),
        }
    }

    /// Emit the pending runs as a paragraph (an empty paragraph only at the end, as spacing).
    fn flush(&mut self, end: bool) {
        let has_text = self.runs.iter().any(|r| !r.text.is_empty());
        let keep_empty = end && (self.blocks.is_empty() || self.style.list.is_some());
        if !has_text && !keep_empty {
            self.runs.clear();
            return;
        }
        let mut style = self.style.clone();
        if !self.first {
            style.list = None;
            style.page_break_before = false;
        }
        self.first = false;
        self.blocks.push(Block::Paragraph(Paragraph {
            runs: std::mem::take(&mut self.runs),
            style,
        }));
    }
}

/// Read a DOCX file.
pub fn read(bytes: &[u8], opts: &ReadOptions) -> Result<Document> {
    let z = Zip::open(bytes)?;
    let main = z.text("word/document.xml")?;
    let root = xml::parse_root(&main)?;
    let styles = Styles::parse(z.text("word/styles.xml").ok());
    let numbering = Numbering::parse(z.text("word/numbering.xml").ok());
    let rels = relationships(&z, "word/_rels/document.xml.rels", "word");
    let mut ctx = Ctx {
        z: &z,
        rels,
        styles,
        numbering,
        opts,
        doc: Document::default(),
        blocks: 0,
    };
    let body = root
        .child("body")
        .ok_or_else(|| crate::error::CreateError::malformed("DOCX has no body"))?;
    let outs = ctx.body(body, 0)?;
    let final_setup = body.child("sectPr").map(|s| page_setup(s, opts.page));
    let mut sections = Vec::new();
    let mut cur: Vec<Block> = Vec::new();
    let mut any_arabic = false;
    for o in outs {
        for b in &o.blocks {
            if let Block::Paragraph(p) = b {
                if !any_arabic && has_rtl(&p.text()) {
                    any_arabic = true;
                }
            }
        }
        cur.extend(o.blocks);
        if let Some(setup) = o.section_end {
            sections.push(Section {
                page: setup,
                content: Content::Flow(std::mem::take(&mut cur)),
                page_from_source: true,
            });
        }
    }
    sections.push(Section {
        page: final_setup.unwrap_or(opts.page),
        content: Content::Flow(cur),
        page_from_source: final_setup.is_some(),
    });
    let mut doc = ctx.doc;
    doc.sections = sections;
    doc.lang = Some(if any_arabic { "ar".into() } else { "en".into() });
    if let Ok(core) = z.text("docProps/core.xml") {
        if let Ok(c) = xml::parse_root(&core) {
            let t = c.child("title").map(|t| t.text()).unwrap_or_default();
            if !t.trim().is_empty() {
                doc.title = Some(t.trim().chars().take(300).collect());
            }
        }
    }
    Ok(doc)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;
    use crate::readers::zip::build;

    fn docx(body: &str) -> Vec<u8> {
        let doc = format!(
            r#"<?xml version="1.0"?><w:document xmlns:w="w" xmlns:r="r"><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>"#
        );
        let styles = r#"<w:styles xmlns:w="w"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:sz w:val="32"/></w:rPr></w:style></w:styles>"#;
        let numbering = r#"<w:numbering xmlns:w="w"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num></w:numbering>"#;
        build(
            &[
                ("word/document.xml", doc.as_bytes()),
                ("word/styles.xml", styles.as_bytes()),
                ("word/numbering.xml", numbering.as_bytes()),
            ],
            true,
        )
    }

    fn flow(d: &Document) -> &Vec<Block> {
        match &d.sections.last().unwrap().content {
            Content::Flow(b) => b,
            Content::Fixed(_) => panic!(),
        }
    }

    #[test]
    fn paragraphs_styles_lists_breaks() {
        let d = read(
            &docx(r#"<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:bidi/></w:pPr><w:r><w:t>عنوان</w:t></w:r></w:p>
            <w:p><w:pPr><w:bidi/><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">نص </w:t></w:r><w:r><w:t>عادي</w:t></w:r><w:del><w:r><w:delText>محذوف</w:delText></w:r></w:del></w:p>
            <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>
            <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>two</w:t><w:br w:type="page"/><w:t>after</w:t></w:r></w:p>"#),
            &ReadOptions::default(),
        )
        .unwrap();
        assert_eq!(d.sections[0].page.width, 612.0);
        assert!(d.sections[0].page_from_source);
        let b = flow(&d);
        let Block::Paragraph(h) = &b[0] else { panic!() };
        assert_eq!(h.style.heading, 1);
        assert_eq!(h.runs[0].style.size, 16.0);
        assert_eq!(h.style.dir, Dir::Rtl);
        let Block::Paragraph(p) = &b[1] else { panic!() };
        assert_eq!(p.text(), "نص عادي");
        assert_eq!(p.style.align, Align::Justify);
        assert!(p.runs[0].style.bold && !p.runs[1].style.bold);
        let Block::Paragraph(l2) = &b[3] else {
            panic!()
        };
        assert_eq!(l2.style.list.as_ref().unwrap().number, 2);
        assert!(matches!(b[4], Block::PageBreak));
        let Block::Paragraph(after) = &b[5] else {
            panic!()
        };
        assert_eq!(after.text(), "after");
        assert!(after.style.list.is_none());
    }

    #[test]
    fn tables_with_spans_and_rtl() {
        let d = read(
            &docx(r#"<w:tbl><w:tblPr><w:bidiVisual/><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="4000"/></w:tblGrid>
            <w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>رأس</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#),
            &ReadOptions::default(),
        )
        .unwrap();
        let Block::Table(t) = &flow(&d)[0] else {
            panic!()
        };
        assert_eq!(t.dir, Dir::Rtl);
        assert!(t.borders);
        assert!(t.rows[0].header);
        assert_eq!(t.rows[0].cells[0].colspan, 2);
        assert_eq!(t.rows[1].cells[0].rowspan, 2);
        assert_eq!(t.rows[2].cells.len(), 1);
        assert_eq!(t.col_widths.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn paths() {
        assert_eq!(resolve_path("word", "media/a.png"), "word/media/a.png");
        assert_eq!(
            resolve_path("ppt/slides", "../media/x.png"),
            "ppt/media/x.png"
        );
        assert_eq!(resolve_path("word", "/customXml/x.xml"), "customXml/x.xml");
        assert_eq!(resolve_path("word", "../../../../etc/passwd"), "etc/passwd");
    }

    #[test]
    fn garbage_is_an_error() {
        assert!(read(b"PK\x03\x04junk", &ReadOptions::default()).is_err());
        let z = build(
            &[("word/document.xml", b"<w:document><w:body><w:p><w:r><w:t>x")],
            false,
        );
        assert!(read(&z, &ReadOptions::default()).is_ok());
    }
}
