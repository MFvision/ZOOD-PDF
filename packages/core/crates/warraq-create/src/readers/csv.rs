//! CSV (RFC 4180): quoted fields with `""` escapes and embedded line breaks, delimiter sniffed
//! among comma, semicolon and tab (and the Arabic comma `،`). The first row is a header row
//! (repeated on every page); tables with mostly Arabic cells run right to left.

use super::ReadOptions;
use crate::error::Result;
use crate::layout::text::has_rtl;
use crate::limits;
use crate::model::{
    Block, Cell, Content, Dir, Document, ParaStyle, Paragraph, Row, Run, Section, Style, Table,
};

/// Parse CSV text into rows of fields.
pub fn parse(text: &str, delim: char) -> Result<Vec<Vec<String>>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    let mut cells = 0usize;
    let mut at_field_start = true;
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if at_field_start => {
                quoted = true;
                at_field_start = false;
            }
            c if c == delim => {
                row.push(std::mem::take(&mut field));
                cells += 1;
                at_field_start = true;
            }
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                cells += 1;
                rows.push(std::mem::take(&mut row));
                at_field_start = true;
            }
            c => {
                field.push(c);
                at_field_start = false;
            }
        }
        limits::check(cells, limits::MAX_CELLS, "CSV cells")?;
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    // Drop trailing empty rows.
    while rows.last().is_some_and(|r| r.iter().all(|f| f.is_empty())) {
        rows.pop();
    }
    Ok(rows)
}

/// Pick the delimiter that splits the first lines most consistently.
pub fn sniff(text: &str, name: &str) -> char {
    if name.to_ascii_lowercase().ends_with(".tsv") {
        return '\t';
    }
    let sample: Vec<&str> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(20)
        .collect();
    let mut best = (',', 0usize, false);
    for d in [',', ';', '\t', '،'] {
        let counts: Vec<usize> = sample
            .iter()
            .map(|l| {
                // Count delimiters outside quotes.
                let mut q = false;
                l.chars()
                    .filter(|&c| {
                        if c == '"' {
                            q = !q;
                        }
                        !q && c == d
                    })
                    .count()
            })
            .collect();
        let first = counts.first().copied().unwrap_or(0);
        let consistent = first > 0 && counts.iter().all(|&c| c == first);
        let score = first;
        if (consistent && !best.2) || (consistent == best.2 && score > best.1) {
            best = (d, score, consistent);
        }
    }
    best.0
}

/// Read a CSV file as one table.
pub fn read(text: &str, name: &str, opts: &ReadOptions) -> Result<crate::model::Document> {
    let d = sniff(text, name);
    let rows = parse(text, d)?;
    let ncols = rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or(0)
        .min(limits::MAX_COLUMNS);
    let all: String = rows
        .iter()
        .take(50)
        .flat_map(|r| r.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let arabic_cells = rows
        .iter()
        .take(200)
        .flatten()
        .filter(|c| has_rtl(c))
        .count();
    let latin_cells = rows
        .iter()
        .take(200)
        .flatten()
        .filter(|c| c.chars().any(|ch| ch.is_ascii_alphabetic()) && !has_rtl(c))
        .count();
    let rtl = arabic_cells > latin_cells || (arabic_cells > 0 && opts.default_rtl);
    let _ = all;
    let size = if ncols > 12 {
        7.0
    } else if ncols > 8 {
        8.5
    } else {
        10.0
    };
    let table = table_from_rows(
        &rows,
        ncols,
        true,
        if rtl { Dir::Rtl } else { Dir::Ltr },
        size,
        opts,
    );
    let mut page = opts.page;
    if ncols > 6 && page.width < page.height {
        page = page.oriented(true);
    }
    Ok(Document {
        sections: vec![Section {
            page,
            content: Content::Flow(vec![Block::Table(table)]),
            page_from_source: false,
        }],
        lang: Some(if rtl { "ar".into() } else { "en".into() }),
        ..Document::default()
    })
}

/// Build a table (first row = header when `header`).
pub fn table_from_rows(
    rows: &[Vec<String>],
    ncols: usize,
    header: bool,
    dir: Dir,
    size: f64,
    opts: &ReadOptions,
) -> Table {
    let mut out = Vec::with_capacity(rows.len());
    for (i, r) in rows.iter().enumerate() {
        let is_header = header && i == 0;
        let cells = (0..ncols)
            .map(|c| {
                let text = r.get(c).cloned().unwrap_or_default();
                let style = Style {
                    size,
                    bold: is_header,
                    ..opts.base.clone()
                };
                Cell {
                    blocks: vec![Block::Paragraph(Paragraph {
                        runs: vec![Run::new(text, style)],
                        style: ParaStyle {
                            space_after: Some(0.0),
                            dir: Dir::Auto,
                            ..ParaStyle::default()
                        },
                    })],
                    ..Cell::default()
                }
            })
            .collect();
        out.push(Row {
            cells,
            header: is_header,
        });
    }
    Table {
        rows: out,
        col_widths: None,
        dir,
        borders: true,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn rfc4180() {
        let rows = parse("a,\"b,c\",\"say \"\"hi\"\"\"\r\n\"multi\nline\",2,3\n", ',').unwrap();
        assert_eq!(rows[0], vec!["a", "b,c", "say \"hi\""]);
        assert_eq!(rows[1], vec!["multi\nline", "2", "3"]);
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn delimiter_sniffing() {
        assert_eq!(sniff("a;b;c\n1;2;3\n", "x.csv"), ';');
        assert_eq!(sniff("a\tb\n1\t2\n", "x.csv"), '\t');
        assert_eq!(sniff("الاسم،المدينة\nعلي،جدة\n", "x.csv"), '،');
        assert_eq!(sniff("a,b\n\"x;y\",2\n", "x.csv"), ',');
    }

    #[test]
    fn arabic_csv_is_rtl_with_header() {
        let d = read(
            "الاسم,المدينة\nعلي,الرياض\n",
            "a.csv",
            &ReadOptions::default(),
        )
        .unwrap();
        let Content::Flow(b) = &d.sections[0].content else {
            panic!()
        };
        let Block::Table(t) = &b[0] else { panic!() };
        assert_eq!(t.dir, Dir::Rtl);
        assert!(t.rows[0].header && !t.rows[1].header);
    }
}
