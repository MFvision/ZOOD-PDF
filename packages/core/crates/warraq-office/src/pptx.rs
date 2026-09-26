//! PPTX (PresentationML) writer: one slide per page, the slide the size of the page, a text box
//! per paragraph and per table cell at its position on the page (right-to-left paragraphs get
//! `rtl="1"` and right alignment). An optional PNG per page becomes the slide's picture
//! background (behind the text boxes).

use warraq_text::bidi::Dir;
use warraq_text::geom::Rect;

use crate::error::Result;
use crate::model::{ExportDoc, Item};
use crate::ooxml::{app_props, core_props};
use crate::xml::{dir_runs_in, esc, guess_lang};
use crate::zip::ZipWriter;

const A_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P_NS: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn emu(pt: f64) -> i64 {
    (pt * 12_700.0).round().clamp(0.0, 51_206_400.0) as i64
}

struct TextBox<'a> {
    rect: Rect,
    text: &'a str,
    dir: Dir,
    size: f64,
    bold: bool,
    italic: bool,
}

fn text_box(out: &mut String, id: usize, b: &TextBox) {
    let lang = guess_lang(b.text).unwrap_or("en");
    let tag = match lang {
        "ar" => "ar-SA",
        "fa" => "fa-IR",
        "ur" => "ur-PK",
        "he" => "he-IL",
        _ => "en-US",
    };
    let (x, y) = (emu(b.rect.x0), emu(b.rect.y0));
    // A little slack so the (substitute) font does not wrap differently.
    let (cx, cy) = (emu(b.rect.width() * 1.08 + 4.0), emu(b.rect.height() + 2.0));
    let sz = (b.size.clamp(1.0, 400.0) * 100.0).round() as i64;
    out.push_str(&format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"Text {id}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap=\"square\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\" rtlCol=\"0\"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p>",
        if b.dir == Dir::Rtl { x.saturating_sub(cx - emu(b.rect.width())) } else { x }
    ));
    if b.dir == Dir::Rtl {
        out.push_str("<a:pPr algn=\"r\" rtl=\"1\"/>");
    }
    for (t, rtl) in dir_runs_in(b.text, b.dir == Dir::Rtl) {
        out.push_str(&format!(
            "<a:r><a:rPr lang=\"{}\" sz=\"{sz}\"{}{} dirty=\"0\"/><a:t>{}</a:t></a:r>",
            if rtl { tag } else { "en-US" },
            if b.bold { " b=\"1\"" } else { "" },
            if b.italic { " i=\"1\"" } else { "" },
            esc(&t)
        ));
    }
    out.push_str(&format!(
        "<a:endParaRPr lang=\"{tag}\" sz=\"{sz}\" dirty=\"0\"/></a:p></p:txBody></p:sp>"
    ));
}

fn slide_xml(page: &crate::model::ExportPage, background: bool) -> String {
    let mut out = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:sld xmlns:a=\"{A_NS}\" xmlns:r=\"{R_NS}\" xmlns:p=\"{P_NS}\"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>"
    );
    let mut id = 2;
    if background {
        out.push_str(&format!(
            "<p:pic><p:nvPicPr><p:cNvPr id=\"{id}\" name=\"Page\"/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed=\"rId2\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>",
            emu(page.width),
            emu(page.height)
        ));
        id += 1;
    }
    for it in &page.items {
        match it {
            Item::Para(p) => {
                text_box(
                    &mut out,
                    id,
                    &TextBox {
                        rect: p.bbox,
                        text: &p.text,
                        dir: p.dir,
                        size: p.size,
                        bold: p.runs.iter().all(|r| r.bold) && !p.runs.is_empty(),
                        italic: p.runs.iter().all(|r| r.italic) && !p.runs.is_empty(),
                    },
                );
                id += 1;
            }
            Item::Table(t) => {
                for c in &t.cells {
                    if c.text.is_empty() {
                        continue;
                    }
                    let inner = Rect::new(
                        c.bbox.x0 + 2.0,
                        c.bbox.y0 + 2.0,
                        c.bbox.x1 - 2.0,
                        c.bbox.y1 - 2.0,
                    );
                    text_box(
                        &mut out,
                        id,
                        &TextBox {
                            rect: inner,
                            text: &c.text,
                            dir: c.dir,
                            size: (inner.height() * 0.6).clamp(6.0, 14.0),
                            bold: c.bold,
                            italic: false,
                        },
                    );
                    id += 1;
                }
            }
        }
    }
    out.push_str("</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>");
    out
}

/// Write a PPTX. `backgrounds`: optional PNG per page (same order as `doc.pages`).
pub fn write(doc: &ExportDoc, backgrounds: &[Vec<u8>]) -> Result<Vec<u8>> {
    let (w, h) = doc
        .pages
        .first()
        .map_or((720.0, 540.0), |p| (p.width, p.height));
    // Slide size limits: 1 inch .. 56 inches.
    let (cx, cy) = (
        emu(w).clamp(914_400, 51_206_400),
        emu(h).clamp(914_400, 51_206_400),
    );
    let mut z = ZipWriter::new();
    let n = doc.pages.len().max(1);
    let mut ct = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/><Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/><Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/><Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/><Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>");
    let mut pres_rels = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{REL}/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/><Relationship Id=\"rId2\" Type=\"{REL}/theme\" Target=\"theme/theme1.xml\"/>");
    let mut ids = String::new();
    let empty_page = crate::model::ExportPage {
        index: 0,
        width: w,
        height: h,
        items: Vec::new(),
        plain: String::new(),
    };
    for i in 0..n {
        let k = i + 1;
        let page = doc.pages.get(i).unwrap_or(&empty_page);
        let bg = backgrounds.get(i).filter(|b| b.starts_with(b"\x89PNG"));
        ct.push_str(&format!("<Override PartName=\"/ppt/slides/slide{k}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"));
        pres_rels.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"{REL}/slide\" Target=\"slides/slide{k}.xml\"/>",
            k + 2
        ));
        ids.push_str(&format!(
            "<p:sldId id=\"{}\" r:id=\"rId{}\"/>",
            255 + k,
            k + 2
        ));
        z.add(
            &format!("ppt/slides/slide{k}.xml"),
            slide_xml(page, bg.is_some()).as_bytes(),
            true,
        )?;
        let mut rels = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{REL}/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>");
        if let Some(png) = bg {
            z.add(&format!("ppt/media/page{k}.png"), png, false)?;
            rels.push_str(&format!(
                "<Relationship Id=\"rId2\" Type=\"{REL}/image\" Target=\"../media/page{k}.png\"/>"
            ));
        }
        rels.push_str("</Relationships>");
        z.add(
            &format!("ppt/slides/_rels/slide{k}.xml.rels"),
            rels.as_bytes(),
            true,
        )?;
    }
    ct.push_str("</Types>");
    pres_rels.push_str("</Relationships>");
    let pres = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:presentation xmlns:a=\"{A_NS}\" xmlns:r=\"{R_NS}\" xmlns:p=\"{P_NS}\"{}><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx=\"{cx}\" cy=\"{cy}\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>",
        if doc.dir == Dir::Rtl { " rtl=\"1\"" } else { "" }
    );
    z.add("[Content_Types].xml", ct.as_bytes(), true)?;
    z.add("_rels/.rels", format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{REL}/officeDocument\" Target=\"ppt/presentation.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/><Relationship Id=\"rId3\" Type=\"{REL}/extended-properties\" Target=\"docProps/app.xml\"/></Relationships>").as_bytes(), true)?;
    z.add("ppt/presentation.xml", pres.as_bytes(), true)?;
    z.add(
        "ppt/_rels/presentation.xml.rels",
        pres_rels.as_bytes(),
        true,
    )?;
    z.add(
        "ppt/slideMasters/slideMaster1.xml",
        master_xml().as_bytes(),
        true,
    )?;
    z.add("ppt/slideMasters/_rels/slideMaster1.xml.rels", format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{REL}/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/><Relationship Id=\"rId2\" Type=\"{REL}/theme\" Target=\"../theme/theme1.xml\"/></Relationships>").as_bytes(), true)?;
    z.add(
        "ppt/slideLayouts/slideLayout1.xml",
        layout_xml().as_bytes(),
        true,
    )?;
    z.add("ppt/slideLayouts/_rels/slideLayout1.xml.rels", format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{REL}/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/></Relationships>").as_bytes(), true)?;
    z.add("ppt/theme/theme1.xml", THEME.as_bytes(), true)?;
    z.add("docProps/core.xml", core_props(doc).as_bytes(), true)?;
    z.add("docProps/app.xml", app_props().as_bytes(), true)?;
    z.finish()
}

const EMPTY_TREE: &str = "<p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree>";

fn master_xml() -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:sldMaster xmlns:a=\"{A_NS}\" xmlns:r=\"{R_NS}\" xmlns:p=\"{P_NS}\"><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg>{EMPTY_TREE}</p:cSld><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/><p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz=\"3200\"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz=\"1800\"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz=\"1800\"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>"
    )
}

fn layout_xml() -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p:sldLayout xmlns:a=\"{A_NS}\" xmlns:r=\"{R_NS}\" xmlns:p=\"{P_NS}\" type=\"blank\" preserve=\"1\"><p:cSld name=\"Blank\">{EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
    )
}

const THEME: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ZOOD"><a:themeElements><a:clrScheme name="ZOOD"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="F2F2F7"/></a:lt2><a:accent1><a:srgbClr val="0A84FF"/></a:accent1><a:accent2><a:srgbClr val="30B0C7"/></a:accent2><a:accent3><a:srgbClr val="34C759"/></a:accent3><a:accent4><a:srgbClr val="FF9F0A"/></a:accent4><a:accent5><a:srgbClr val="FF375F"/></a:accent5><a:accent6><a:srgbClr val="BF5AF2"/></a:accent6><a:hlink><a:srgbClr val="0A84FF"/></a:hlink><a:folHlink><a:srgbClr val="5E5CE6"/></a:folHlink></a:clrScheme><a:fontScheme name="ZOOD"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="ZOOD"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"#;
