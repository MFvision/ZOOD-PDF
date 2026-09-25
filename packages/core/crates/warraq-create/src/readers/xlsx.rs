//! XLSX (SpreadsheetML) → one table per visible sheet, each under a heading with the sheet name.
//!
//! Cell values: shared strings (rich text concatenated), inline strings, formula string results,
//! booleans, errors, and numbers written plainly (integers without a decimal point, otherwise
//! the shortest round-trip form; number formats and dates are not applied). Merged cells become
//! column/row spans; `rightToLeft` sheets become right-to-left tables. The first row repeats as
//! the header on every page.

use std::collections::HashMap;

use super::csv::table_from_rows;
use super::docx::relationships;
use super::xml::{self, Node};
use super::zip::Zip;
use super::ReadOptions;
use crate::error::{CreateError, Result};
use crate::layout::text::has_rtl;
use crate::limits;
use crate::model::{
    Align, Block, Content, Dir, Document, ParaStyle, Paragraph, Run, Section, Style,
};

/// Largest number of rows rendered per sheet.
const MAX_ROWS: usize = 100_000;

/// "BC12" → (row 11, col 54) zero-based.
pub fn cell_ref(r: &str) -> Option<(usize, usize)> {
    let mut col = 0usize;
    let mut letters = 0;
    let mut rest = r;
    for (i, c) in r.char_indices() {
        if c.is_ascii_alphabetic() {
            col = col
                .checked_mul(26)?
                .checked_add((c.to_ascii_uppercase() as u8 - b'A' + 1) as usize)?;
            letters += 1;
            if letters > 3 {
                return None;
            }
        } else {
            rest = r.get(i..)?;
            break;
        }
    }
    let row: usize = rest.trim_start_matches('$').parse().ok()?;
    if col == 0 || row == 0 {
        return None;
    }
    Some((row - 1, col - 1))
}

/// Plain number formatting.
pub fn format_number(v: &str) -> String {
    match v.trim().parse::<f64>() {
        Ok(f) if f.is_finite() && (f.abs() >= 1e15 || (f != 0.0 && f.abs() < 1e-6)) => {
            v.trim().to_string()
        }
        Ok(f) if f.is_finite() => {
            if f == f.trunc() {
                format!("{}", f as i64)
            } else {
                let s = format!("{f}");
                if s.contains('e') {
                    v.trim().to_string()
                } else {
                    s
                }
            }
        }
        _ => v.trim().to_string(),
    }
}

fn shared_strings(z: &Zip) -> Result<Vec<String>> {
    let Ok(text) = z.text("xl/sharedStrings.xml") else {
        return Ok(Vec::new());
    };
    let root = xml::parse_root(&text)?;
    let mut out = Vec::new();
    for si in root.children_named("si") {
        limits::check(out.len(), limits::MAX_CELLS, "shared strings")?;
        let mut s = String::new();
        for c in si.elems() {
            match c.name() {
                "t" => s.push_str(&c.text()),
                "r" => {
                    if let Some(t) = c.child("t") {
                        s.push_str(&t.text());
                    }
                }
                _ => {} // rPh (phonetic), phoneticPr
            }
        }
        out.push(s);
    }
    Ok(out)
}

fn cell_value(c: &Node, sst: &[String]) -> String {
    let t = c.attr("t").unwrap_or("n");
    let v = c.child("v").map(|v| v.text()).unwrap_or_default();
    match t {
        "s" => v
            .trim()
            .parse::<usize>()
            .ok()
            .and_then(|i| sst.get(i))
            .cloned()
            .unwrap_or_default(),
        "inlineStr" => c
            .child("is")
            .map(|i| {
                let mut s = String::new();
                for e in i.elems() {
                    match e.name() {
                        "t" => s.push_str(&e.text()),
                        "r" => s.push_str(&e.child("t").map(|t| t.text()).unwrap_or_default()),
                        _ => {}
                    }
                }
                s
            })
            .unwrap_or_default(),
        "b" => {
            if v.trim() == "1" {
                "TRUE".into()
            } else {
                "FALSE".into()
            }
        }
        "str" | "e" | "d" => v,
        _ => format_number(&v),
    }
}

/// Read one sheet into rows of strings (+ merges and direction).
/// Rows of cell texts, merged ranges (r0, c0, r1, c1) and the sheet direction.
type Sheet = (Vec<Vec<String>>, Vec<(usize, usize, usize, usize)>, bool);

fn sheet(root: &Node, sst: &[String]) -> Result<Sheet> {
    let rtl = root
        .path(&["sheetViews", "sheetView"])
        .and_then(|v| v.attr("rightToLeft"))
        .is_some_and(|v| v == "1" || v == "true");
    let mut cells: HashMap<(usize, usize), String> = HashMap::new();
    let (mut max_r, mut max_c) = (0usize, 0usize);
    let mut next_row = 0usize;
    if let Some(data) = root.child("sheetData") {
        for row in data.children_named("row") {
            let r = row
                .attr("r")
                .and_then(|v| v.parse::<usize>().ok())
                .map_or(next_row, |v| v.saturating_sub(1));
            next_row = r + 1;
            if r >= MAX_ROWS {
                break;
            }
            let mut next_col = 0usize;
            for c in row.children_named("c") {
                let (rr, cc) = c.attr("r").and_then(cell_ref).unwrap_or((r, next_col));
                next_col = cc + 1;
                if cc >= limits::MAX_COLUMNS || rr >= MAX_ROWS {
                    continue;
                }
                let v = cell_value(c, sst);
                if v.is_empty() {
                    continue;
                }
                limits::check(cells.len() + 1, limits::MAX_CELLS, "spreadsheet cells")?;
                max_r = max_r.max(rr + 1);
                max_c = max_c.max(cc + 1);
                cells.insert((rr, cc), v);
            }
        }
    }
    let mut merges = Vec::new();
    if let Some(m) = root.child("mergeCells") {
        for mc in m.children_named("mergeCell") {
            let Some((a, b)) = mc.attr("ref").and_then(|r| r.split_once(':')) else {
                continue;
            };
            if let (Some((r0, c0)), Some((r1, c1))) = (cell_ref(a), cell_ref(b)) {
                if r1 >= r0 && c1 >= c0 && r1 < max_r.max(1) + 1 && c1 < limits::MAX_COLUMNS {
                    merges.push((r0, c0, r1, c1));
                }
            }
        }
    }
    // Drop leading empty rows/columns.
    let min_r = cells.keys().map(|k| k.0).min().unwrap_or(0);
    let min_c = cells.keys().map(|k| k.1).min().unwrap_or(0);
    let mut rows = Vec::with_capacity(max_r.saturating_sub(min_r));
    for r in min_r..max_r {
        let row: Vec<String> = (min_c..max_c)
            .map(|c| cells.remove(&(r, c)).unwrap_or_default())
            .collect();
        rows.push(row);
    }
    let merges = merges
        .into_iter()
        .filter(|m| m.0 >= min_r && m.1 >= min_c)
        .map(|(a, b, c, d)| (a - min_r, b - min_c, c - min_r, d - min_c))
        .collect();
    Ok((rows, merges, rtl))
}

/// Read an XLSX file.
pub fn read(bytes: &[u8], opts: &ReadOptions) -> Result<Document> {
    let z = Zip::open(bytes)?;
    let wb = xml::parse_root(&z.text("xl/workbook.xml")?)?;
    let rels = relationships(&z, "xl/_rels/workbook.xml.rels", "xl");
    let sst = shared_strings(&z)?;
    let mut blocks = Vec::new();
    let mut any_rtl = false;
    let mut widest = 0usize;
    let sheets: Vec<&Node> = wb
        .child("sheets")
        .map(|s| s.children_named("sheet").collect())
        .unwrap_or_default();
    for sh in sheets {
        if matches!(sh.attr("state"), Some("hidden" | "veryHidden")) {
            continue;
        }
        let name = sh.attr("name").unwrap_or("").to_string();
        let Some(path) = sh.attr_prefixed("r:id").and_then(|id| rels.get(id)) else {
            continue;
        };
        let Ok(text) = z.text(path) else { continue };
        let root = xml::parse_root(&text)?;
        let (rows, merges, rtl) = sheet(&root, &sst)?;
        if rows.is_empty() {
            continue;
        }
        let ncols = rows.iter().map(Vec::len).max().unwrap_or(0);
        widest = widest.max(ncols);
        let arabic = rtl || rows.iter().take(20).flatten().any(|c| has_rtl(c));
        any_rtl |= rtl || arabic;
        if !blocks.is_empty() {
            blocks.push(Block::PageBreak);
        }
        let heading = Style {
            size: 14.0,
            bold: true,
            ..opts.base.clone()
        };
        blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run::new(name, heading)],
            style: ParaStyle {
                heading: 2,
                dir: if rtl { Dir::Rtl } else { Dir::Auto },
                ..ParaStyle::default()
            },
        }));
        let size = if ncols > 12 {
            7.0
        } else if ncols > 8 {
            8.5
        } else {
            10.0
        };
        let mut table = table_from_rows(
            &rows,
            ncols,
            true,
            if rtl { Dir::Rtl } else { Dir::Ltr },
            size,
            opts,
        );
        // Numbers align to the end like in Excel.
        for row in &mut table.rows {
            for cell in &mut row.cells {
                for b in &mut cell.blocks {
                    if let Block::Paragraph(p) = b {
                        let t = p.text();
                        if !t.is_empty() && t.trim().parse::<f64>().is_ok() {
                            p.style.align = Align::End;
                            p.style.dir = if rtl { Dir::Rtl } else { Dir::Ltr };
                        }
                    }
                }
            }
        }
        apply_merges(&mut table, &merges);
        blocks.push(Block::Table(table));
    }
    if blocks.is_empty() {
        return Err(CreateError::malformed("the workbook has no visible data"));
    }
    let mut page = opts.page;
    if widest > 6 && page.width < page.height {
        page = page.oriented(true);
    }
    Ok(Document {
        sections: vec![Section {
            page,
            content: Content::Flow(blocks),
            page_from_source: false,
        }],
        lang: Some(if any_rtl { "ar".into() } else { "en".into() }),
        ..Document::default()
    })
}

fn apply_merges(t: &mut crate::model::Table, merges: &[(usize, usize, usize, usize)]) {
    // Mark covered cells, set spans on the top-left cell, then drop covered cells.
    let mut covered = std::collections::HashSet::new();
    for &(r0, c0, r1, c1) in merges {
        if let Some(cell) = t.rows.get_mut(r0).and_then(|r| r.cells.get_mut(c0)) {
            cell.colspan = u16::try_from(c1 - c0 + 1).unwrap_or(1);
            cell.rowspan = u16::try_from(r1 - r0 + 1).unwrap_or(1);
        }
        for r in r0..=r1 {
            for c in c0..=c1 {
                if (r, c) != (r0, c0) {
                    covered.insert((r, c));
                }
            }
        }
    }
    if covered.is_empty() {
        return;
    }
    for (r, row) in t.rows.iter_mut().enumerate() {
        let mut c = 0;
        row.cells.retain(|_| {
            let keep = !covered.contains(&(r, c));
            c += 1;
            keep
        });
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;
    use crate::readers::zip::build;

    #[test]
    fn refs_and_numbers() {
        assert_eq!(cell_ref("A1"), Some((0, 0)));
        assert_eq!(cell_ref("BC12"), Some((11, 54)));
        assert_eq!(cell_ref("ZZZZ1"), None);
        assert_eq!(format_number("3"), "3");
        assert_eq!(format_number("3.0"), "3");
        assert_eq!(format_number("0.1"), "0.1");
        assert_eq!(format_number("1.5E+20"), "1.5E+20");
    }

    #[test]
    fn workbook_with_shared_strings_merges_and_rtl() {
        let wb = r#"<workbook xmlns:r="r"><sheets><sheet name="المبيعات" sheetId="1" r:id="rId1"/><sheet name="h" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>"#;
        let rels = r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>"#;
        let sst = r#"<sst><si><t>المنتج</t></si><si><r><t>الكم</t></r><r><t>ية</t></r></si><si><t>قلم</t></si></sst>"#;
        let s1 = r#"<worksheet><sheetViews><sheetView rightToLeft="1"/></sheetViews><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
          <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.0</v></c></row>
          <row r="3"><c r="A3" t="inlineStr"><is><t>مجموع</t></is></c></row>
        </sheetData><mergeCells><mergeCell ref="A3:B3"/></mergeCells></worksheet>"#;
        let z = build(
            &[
                ("xl/workbook.xml", wb.as_bytes()),
                ("xl/_rels/workbook.xml.rels", rels.as_bytes()),
                ("xl/sharedStrings.xml", sst.as_bytes()),
                ("xl/worksheets/sheet1.xml", s1.as_bytes()),
                ("xl/worksheets/sheet2.xml", b"<worksheet><sheetData><row><c t=\"inlineStr\"><is><t>secret</t></is></c></row></sheetData></worksheet>"),
            ],
            true,
        );
        let d = read(&z, &ReadOptions::default()).unwrap();
        let Content::Flow(b) = &d.sections[0].content else {
            panic!()
        };
        assert_eq!(b.len(), 2, "hidden sheet skipped");
        let Block::Paragraph(h) = &b[0] else { panic!() };
        assert_eq!(h.text(), "المبيعات");
        let Block::Table(t) = &b[1] else { panic!() };
        assert_eq!(t.dir, Dir::Rtl);
        let txt = |r: usize, c: usize| match &t.rows[r].cells[c].blocks[0] {
            Block::Paragraph(p) => p.text(),
            _ => String::new(),
        };
        assert_eq!(txt(0, 1), "الكمية");
        assert_eq!(txt(1, 1), "12");
        assert_eq!(t.rows[2].cells.len(), 1);
        assert_eq!(t.rows[2].cells[0].colspan, 2);
    }
}
