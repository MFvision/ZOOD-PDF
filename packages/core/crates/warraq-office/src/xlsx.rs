//! XLSX (SpreadsheetML) writer: one sheet per detected table (merged cells kept, numbers as
//! numbers, text in the shared-string table, right-to-left sheet view for Arabic tables). A
//! document without tables gets one sheet with a paragraph per row.

use warraq_text::bidi::Dir;

use crate::error::Result;
use crate::model::{ExportDoc, Item, Table};
use crate::ooxml::{app_props, core_props, parse_number};
use crate::xml::esc;
use crate::zip::ZipWriter;

const S_NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// Sheet name prefixes (localised by the caller).
#[derive(Debug, Clone)]
pub struct SheetNames {
    pub table: String,
    pub text: String,
}

impl Default for SheetNames {
    fn default() -> Self {
        SheetNames {
            table: "Table".into(),
            text: "Text".into(),
        }
    }
}

/// Column letters: 0 → A, 25 → Z, 26 → AA.
pub fn col_name(mut c: usize) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b'A' + (c % 26) as u8);
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

#[derive(Default)]
struct Shared {
    list: Vec<String>,
    index: std::collections::HashMap<String, usize>,
    count: usize,
}

impl Shared {
    fn id(&mut self, s: &str) -> usize {
        self.count += 1;
        if let Some(i) = self.index.get(s) {
            return *i;
        }
        let i = self.list.len();
        self.list.push(s.to_string());
        self.index.insert(s.to_string(), i);
        i
    }
}

/// Sanitised, unique sheet name (≤ 31 chars, none of `[]:*?/\`).
fn sheet_name(base: &str, n: usize, used: &mut Vec<String>) -> String {
    let clean: String = base
        .chars()
        .filter(|c| !matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\' | '\''))
        .take(24)
        .collect();
    let clean = if clean.trim().is_empty() {
        "Sheet".to_string()
    } else {
        clean
    };
    let mut name = format!("{} {n}", clean.trim());
    let mut k = 2;
    while used.iter().any(|u| u.eq_ignore_ascii_case(&name)) && k < 10_000 {
        name = format!("{} {n}.{k}", clean.trim());
        k += 1;
    }
    used.push(name.clone());
    name
}

fn cell_xml(out: &mut String, sh: &mut Shared, r: usize, c: usize, text: &str, style: u8) {
    let reference = format!("{}{}", col_name(c), r + 1);
    let s = if style > 0 {
        format!(" s=\"{style}\"")
    } else {
        String::new()
    };
    if let Some(v) = parse_number(text) {
        out.push_str(&format!("<c r=\"{reference}\"{s}><v>{v}</v></c>"));
    } else if !text.is_empty() {
        let id = sh.id(text);
        out.push_str(&format!("<c r=\"{reference}\"{s} t=\"s\"><v>{id}</v></c>"));
    }
}

fn table_sheet(t: &Table, sh: &mut Shared) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<worksheet xmlns=\"{S_NS}\" xmlns:r=\"{R_NS}\"><sheetViews><sheetView workbookViewId=\"0\"{}/></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/><cols>",
        if t.dir == Dir::Rtl { " rightToLeft=\"1\"" } else { "" }
    ));
    for (i, w) in t.widths.iter().enumerate() {
        // Column width in characters (~ 5.25 pt per character), bounded.
        let chars = (w / 5.25).clamp(6.0, 80.0);
        out.push_str(&format!(
            "<col min=\"{0}\" max=\"{0}\" width=\"{chars:.2}\" customWidth=\"1\"/>",
            i + 1
        ));
    }
    out.push_str("</cols><sheetData>");
    for r in 0..t.rows {
        out.push_str(&format!("<row r=\"{}\">", r + 1));
        for c in 0..t.cols {
            if let Some(cell) = t.cell(r, c) {
                cell_xml(
                    &mut out,
                    sh,
                    r,
                    c,
                    &cell.text,
                    u8::from(cell.bold || r == 0),
                );
            }
        }
        out.push_str("</row>");
    }
    out.push_str("</sheetData>");
    let merges: Vec<String> = t
        .cells
        .iter()
        .filter(|c| c.rowspan > 1 || c.colspan > 1)
        .map(|c| {
            format!(
                "<mergeCell ref=\"{}{}:{}{}\"/>",
                col_name(c.col),
                c.row + 1,
                col_name(c.col + c.colspan - 1),
                c.row + c.rowspan
            )
        })
        .collect();
    if !merges.is_empty() {
        out.push_str(&format!("<mergeCells count=\"{}\">", merges.len()));
        for m in merges {
            out.push_str(&m);
        }
        out.push_str("</mergeCells>");
    }
    out.push_str("</worksheet>");
    out
}

fn text_sheet(doc: &ExportDoc, sh: &mut Shared) -> String {
    let mut out = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<worksheet xmlns=\"{S_NS}\" xmlns:r=\"{R_NS}\"><sheetViews><sheetView workbookViewId=\"0\"{}/></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/><cols><col min=\"1\" max=\"1\" width=\"100\" customWidth=\"1\"/></cols><sheetData>",
        if doc.dir == Dir::Rtl { " rightToLeft=\"1\"" } else { "" }
    );
    let mut r = 0usize;
    for p in &doc.pages {
        for it in &p.items {
            if let Item::Para(para) = it {
                if r >= 1_048_575 {
                    break;
                }
                out.push_str(&format!("<row r=\"{}\">", r + 1));
                cell_xml(&mut out, sh, r, 0, &para.text, u8::from(para.heading > 0));
                out.push_str("</row>");
                r += 1;
            }
        }
    }
    out.push_str("</sheetData></worksheet>");
    out
}

/// Write an XLSX workbook.
pub fn write(doc: &ExportDoc, names: &SheetNames) -> Result<Vec<u8>> {
    let mut sh = Shared::default();
    let mut sheets: Vec<(String, String)> = Vec::new();
    let mut used = Vec::new();
    for (i, t) in doc.tables().enumerate() {
        sheets.push((
            sheet_name(&names.table, i + 1, &mut used),
            table_sheet(t, &mut sh),
        ));
    }
    if sheets.is_empty() {
        sheets.push((
            sheet_name(&names.text, 1, &mut used),
            text_sheet(doc, &mut sh),
        ));
    }
    let mut z = ZipWriter::new();
    let mut ct = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/><Override PartName=\"/xl/sharedStrings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>");
    let mut wb = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<workbook xmlns=\"{S_NS}\" xmlns:r=\"{R_NS}\"><bookViews><workbookView/></bookViews><sheets>");
    let mut rels = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
    for (i, (name, _)) in sheets.iter().enumerate() {
        let n = i + 1;
        ct.push_str(&format!("<Override PartName=\"/xl/worksheets/sheet{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"));
        wb.push_str(&format!(
            "<sheet name=\"{}\" sheetId=\"{n}\" r:id=\"rId{n}\"/>",
            esc(name)
        ));
        rels.push_str(&format!("<Relationship Id=\"rId{n}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{n}.xml\"/>"));
    }
    let k = sheets.len();
    rels.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/><Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings\" Target=\"sharedStrings.xml\"/></Relationships>", k + 1, k + 2));
    ct.push_str("</Types>");
    wb.push_str("</sheets></workbook>");
    z.add("[Content_Types].xml", ct.as_bytes(), true)?;
    z.add(
        "_rels/.rels",
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>"#,
        true,
    )?;
    z.add("xl/workbook.xml", wb.as_bytes(), true)?;
    z.add("xl/_rels/workbook.xml.rels", rels.as_bytes(), true)?;
    for (i, (_, xml)) in sheets.iter().enumerate() {
        z.add(
            &format!("xl/worksheets/sheet{}.xml", i + 1),
            xml.as_bytes(),
            true,
        )?;
    }
    let mut ss = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<sst xmlns=\"{S_NS}\" count=\"{}\" uniqueCount=\"{}\">",
        sh.count,
        sh.list.len()
    );
    for s in &sh.list {
        ss.push_str("<si><t xml:space=\"preserve\">");
        ss.push_str(&esc(s));
        ss.push_str("</t></si>");
    }
    ss.push_str("</sst>");
    z.add("xl/sharedStrings.xml", ss.as_bytes(), true)?;
    z.add("xl/styles.xml", STYLES.as_bytes(), true)?;
    z.add("docProps/core.xml", core_props(doc).as_bytes(), true)?;
    z.add("docProps/app.xml", app_props().as_bytes(), true)?;
    z.finish()
}

/// Two cell formats: 0 normal, 1 bold (header rows and bold cells). Cells wrap text.
const STYLES: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/><family val=\"2\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/><family val=\"2\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyAlignment=\"1\"><alignment wrapText=\"1\" vertical=\"top\"/></xf><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment wrapText=\"1\" vertical=\"top\"/></xf></cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_letters() {
        assert_eq!(col_name(0), "A");
        assert_eq!(col_name(25), "Z");
        assert_eq!(col_name(26), "AA");
        assert_eq!(col_name(701), "ZZ");
        assert_eq!(col_name(702), "AAA");
    }

    #[test]
    fn sheet_names_are_valid_and_unique() {
        let mut used = vec![];
        assert_eq!(sheet_name("جدول", 1, &mut used), "جدول 1");
        assert_eq!(sheet_name("a/b:c", 2, &mut used), "abc 2");
        assert_eq!(sheet_name("", 3, &mut used), "Sheet 3");
    }
}
