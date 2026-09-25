//! Plain text: every line is a paragraph with its own direction (first-strong/dominant script,
//! so an English line inside Arabic notes stays left-to-right); blank lines separate paragraph
//! groups (extra space after the group).

use super::ReadOptions;
use crate::error::Result;
use crate::limits;
use crate::model::{Block, Content, Dir, Document, ParaStyle, Paragraph, Run, Section};

/// Read plain text.
pub fn read(text: &str, opts: &ReadOptions) -> Result<Document> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut blocks = Vec::new();
    for group in text.split("\n\n") {
        let lines: Vec<&str> = group.split('\n').filter(|l| !l.trim().is_empty()).collect();
        let n = lines.len();
        for (i, line) in lines.into_iter().enumerate() {
            limits::check(blocks.len() + 1, limits::MAX_BLOCKS, "paragraphs")?;
            let line: String = line
                .trim_end()
                .chars()
                .take(limits::MAX_PARAGRAPH_BYTES / 8)
                .collect();
            blocks.push(Block::Paragraph(Paragraph {
                runs: vec![Run::new(line, opts.base.clone())],
                style: ParaStyle {
                    dir: Dir::Auto,
                    space_after: if i + 1 < n { Some(0.0) } else { None },
                    ..ParaStyle::default()
                },
            }));
        }
    }
    Ok(Document {
        sections: vec![Section {
            page: opts.page,
            content: Content::Flow(blocks),
            page_from_source: false,
        }],
        lang: Some(if opts.default_rtl {
            "ar".into()
        } else {
            "en".into()
        }),
        ..Document::default()
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn lines_are_paragraphs() {
        let d = read(
            "سطر أول\nEnglish line\n\n\nآخر\r\n",
            &ReadOptions::default(),
        )
        .unwrap();
        let Content::Flow(b) = &d.sections[0].content else {
            panic!()
        };
        assert_eq!(b.len(), 3);
        let Block::Paragraph(p) = &b[1] else { panic!() };
        assert_eq!(p.text(), "English line");
        assert_eq!(p.style.space_after, None);
        let Block::Paragraph(p0) = &b[0] else {
            panic!()
        };
        assert_eq!(p0.style.space_after, Some(0.0));
    }
}
