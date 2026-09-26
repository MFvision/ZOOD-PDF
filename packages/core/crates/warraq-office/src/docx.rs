//! DOCX (WordprocessingML) writer.
//!
//! Right-to-left paragraphs get `<w:bidi/>`; runs of right-to-left script get `<w:rtl/>` and a
//! complex-script language (`w:lang w:bidi`). Headings use the built-in `Heading1..3` styles;
//! bold/italic come from the fonts; tables keep their spans (`w:gridSpan`, `w:vMerge`) and RTL
//! tables are laid out with `<w:bidiVisual/>`. Every source page after the first starts with a
//! page break.

use warraq_text::bidi::Dir;

use crate::error::Result;
use crate::model::{ExportDoc, Item, Para, Run, Table};
use crate::ooxml::{app_props, core_props};
use crate::xml::{dir_runs_in, esc};
use crate::zip::ZipWriter;

const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// Locale tag for a complex-script language.
pub(crate) fn bidi_lang(lang: Option<&str>) -> &'static str {
    match lang {
        Some("fa") => "fa-IR",
        Some("ur") => "ur-PK",
        Some("he") => "he-IL",
        _ => "ar-SA",
    }
}

fn twips(pt: f64) -> i64 {
    (pt * 20.0).round().clamp(0.0, 31_680.0 * 20.0) as i64
}

fn run_xml(out: &mut String, run: &Run, lang: Option<&str>, size: Option<f64>, para_rtl: bool) {
    for (text, rtl) in dir_runs_in(&run.text, para_rtl) {
        out.push_str("<w:r><w:rPr>");
        if run.bold {
            out.push_str("<w:b/><w:bCs/>");
        }
        if run.italic {
            out.push_str("<w:i/><w:iCs/>");
        }
        if let Some(s) = size {
            let hp = (s * 2.0).round().clamp(2.0, 3276.0) as i64;
            out.push_str(&format!("<w:sz w:val=\"{hp}\"/><w:szCs w:val=\"{hp}\"/>"));
        }
        if rtl {
            out.push_str("<w:rtl/>");
            out.push_str(&format!("<w:lang w:bidi=\"{}\"/>", bidi_lang(lang)));
        }
        out.push_str("</w:rPr><w:t xml:space=\"preserve\">");
        out.push_str(&esc(&text));
        out.push_str("</w:t></w:r>");
    }
}

fn para_xml(out: &mut String, p: &Para, page_break: bool) {
    out.push_str("<w:p><w:pPr>");
    if p.heading > 0 {
        out.push_str(&format!(
            "<w:pStyle w:val=\"Heading{}\"/>",
            p.heading.min(3)
        ));
    }
    if page_break {
        out.push_str("<w:pageBreakBefore/>");
    }
    if p.dir == Dir::Rtl {
        out.push_str("<w:bidi/>");
    }
    out.push_str("</w:pPr>");
    let size = (p.heading == 0).then_some(p.size).filter(|s| *s > 0.0);
    for r in &p.runs {
        run_xml(out, r, p.lang.as_deref(), size, p.dir == Dir::Rtl);
    }
    out.push_str("</w:p>");
}

fn cell_para(out: &mut String, text: &str, dir: Dir, bold: bool) {
    out.push_str("<w:p><w:pPr>");
    if dir == Dir::Rtl {
        out.push_str("<w:bidi/>");
    }
    out.push_str("</w:pPr>");
    if !text.is_empty() {
        let run = Run {
            text: text.to_string(),
            bold,
            italic: false,
        };
        run_xml(
            out,
            &run,
            crate::xml::guess_lang(text),
            None,
            dir == Dir::Rtl,
        );
    }
    out.push_str("</w:p>");
}

fn table_xml(out: &mut String, t: &Table) {
    out.push_str("<w:tbl><w:tblPr>");
    if t.dir == Dir::Rtl {
        out.push_str("<w:bidiVisual/>");
    }
    out.push_str("<w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>");
    for side in ["top", "left", "bottom", "right", "insideH", "insideV"] {
        out.push_str(&format!(
            "<w:{side} w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>"
        ));
    }
    out.push_str("</w:tblBorders><w:tblLook w:val=\"0000\"/></w:tblPr><w:tblGrid>");
    for w in &t.widths {
        out.push_str(&format!("<w:gridCol w:w=\"{}\"/>", twips(*w)));
    }
    out.push_str("</w:tblGrid>");
    let width_of = |col: usize, span: usize| -> f64 { t.widths.iter().skip(col).take(span).sum() };
    for r in 0..t.rows {
        out.push_str("<w:tr>");
        let mut c = 0;
        while c < t.cols {
            if let Some(cell) = t.cell(r, c) {
                out.push_str("<w:tc><w:tcPr>");
                out.push_str(&format!(
                    "<w:tcW w:w=\"{}\" w:type=\"dxa\"/>",
                    twips(width_of(c, cell.colspan))
                ));
                if cell.colspan > 1 {
                    out.push_str(&format!("<w:gridSpan w:val=\"{}\"/>", cell.colspan));
                }
                if cell.rowspan > 1 {
                    out.push_str("<w:vMerge w:val=\"restart\"/>");
                }
                out.push_str("</w:tcPr>");
                cell_para(out, &cell.text, cell.dir, cell.bold);
                out.push_str("</w:tc>");
                c += cell.colspan.max(1);
            } else if let Some(cov) = t.covered(r, c) {
                // Continuation of a vertical merge (horizontal covers were skipped above).
                out.push_str("<w:tc><w:tcPr>");
                out.push_str(&format!(
                    "<w:tcW w:w=\"{}\" w:type=\"dxa\"/>",
                    twips(width_of(c, cov.colspan))
                ));
                if cov.colspan > 1 {
                    out.push_str(&format!("<w:gridSpan w:val=\"{}\"/>", cov.colspan));
                }
                out.push_str("<w:vMerge/></w:tcPr><w:p/></w:tc>");
                c += cov.colspan.max(1);
            } else {
                out.push_str("<w:tc><w:p/></w:tc>");
                c += 1;
            }
        }
        out.push_str("</w:tr>");
    }
    out.push_str("</w:tbl>");
}

/// `word/document.xml`.
pub fn document_xml(doc: &ExportDoc) -> String {
    let mut out = String::with_capacity(16 * 1024);
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
    out.push_str(&format!(
        "<w:document xmlns:w=\"{W_NS}\" xmlns:r=\"{R_NS}\"><w:body>"
    ));
    for (pi, page) in doc.pages.iter().enumerate() {
        let mut first = pi > 0;
        for item in &page.items {
            match item {
                Item::Para(p) => {
                    para_xml(&mut out, p, first);
                    first = false;
                }
                Item::Table(t) => {
                    if first {
                        out.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
                        first = false;
                    }
                    table_xml(&mut out, t);
                    // Word needs a paragraph between consecutive tables and at the end of cells.
                    out.push_str("<w:p/>");
                }
            }
        }
        if first {
            out.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
        }
    }
    let (w, h) = doc
        .pages
        .first()
        .map_or((595.0, 842.0), |p| (p.width, p.height));
    out.push_str(&format!(
        "<w:sectPr><w:pgSz w:w=\"{}\" w:h=\"{}\"/><w:pgMar w:top=\"1134\" w:right=\"1134\" w:bottom=\"1134\" w:left=\"1134\" w:header=\"567\" w:footer=\"567\" w:gutter=\"0\"/>{}</w:sectPr>",
        twips(w).max(2880),
        twips(h).max(2880),
        if doc.dir == Dir::Rtl { "<w:bidi/>" } else { "" }
    ));
    out.push_str("</w:body></w:document>");
    out
}

fn styles_xml(doc: &ExportDoc) -> String {
    let lang = doc.lang.as_deref();
    let heading = |n: u8, sz: u32| {
        format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"Heading{n}\"><w:name w:val=\"heading {n}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before=\"240\" w:after=\"120\"/><w:outlineLvl w:val=\"{}\"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val=\"{sz}\"/><w:szCs w:val=\"{sz}\"/></w:rPr></w:style>",
            n - 1
        )
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:styles xmlns:w=\"{W_NS}\"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:cs=\"Arial\"/><w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/><w:lang w:val=\"en-US\" w:bidi=\"{}\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after=\"120\"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>{}{}{}</w:styles>",
        bidi_lang(lang),
        heading(1, 36),
        heading(2, 30),
        heading(3, 26)
    )
}

/// Write a DOCX package.
pub fn write(doc: &ExportDoc) -> Result<Vec<u8>> {
    let mut z = ZipWriter::new();
    z.add(
        "[Content_Types].xml",
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>"#,
        true,
    )?;
    z.add(
        "_rels/.rels",
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>"#,
        true,
    )?;
    z.add(
        "word/_rels/document.xml.rels",
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
        true,
    )?;
    z.add("word/document.xml", document_xml(doc).as_bytes(), true)?;
    z.add("word/styles.xml", styles_xml(doc).as_bytes(), true)?;
    z.add("docProps/core.xml", core_props(doc).as_bytes(), true)?;
    z.add("docProps/app.xml", app_props().as_bytes(), true)?;
    z.finish()
}
