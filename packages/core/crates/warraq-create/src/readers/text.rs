//! Plain text: blank lines separate paragraphs, single line breaks are kept as forced breaks,
//! each paragraph's direction comes from its first strong character.

use super::ReadOptions;
use crate::error::Result;
use crate::limits;
use crate::model::{Block, Content, Dir, Document, ParaStyle, Paragraph, Run, Section};

/// Read plain text.
pub fn read(text: &str, opts: &ReadOptions) -> Result<Document> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut blocks = Vec::new();
    for chunk in text.split("\n\n") {
        let chunk = chunk.trim_matches('\n');
        if chunk.trim().is_empty() {
            continue;
        }
        limits::check(blocks.len() + 1, limits::MAX_BLOCKS, "paragraphs")?;
        // Very long paragraphs are split at line breaks to stay within the paragraph bound.
        let mut cur = String::new();
        for line in chunk.split('\n') {
            if cur.len() + line.len() > limits::MAX_PARAGRAPH_BYTES / 2 && !cur.is_empty() {
                blocks.push(para(std::mem::take(&mut cur), opts));
            }
            if !cur.is_empty() {
                cur.push('\n');
            }
            let line: String = line.chars().take(limits::MAX_PARAGRAPH_BYTES / 8).collect();
            cur.push_str(&line);
        }
        if !cur.is_empty() {
            blocks.push(para(cur, opts));
        }
    }
    Ok(Document {
        sections: vec![Section {
            page: opts.page,
            content: Content::Flow(blocks),
            page_from_source: false,
        }],
        lang: Some(if opts.default_rtl { "ar".into() } else { "en".into() }),
        ..Document::default()
    })
}

fn para(text: String, opts: &ReadOptions) -> Block {
    Block::Paragraph(Paragraph {
        runs: vec![Run::new(text, opts.base.clone())],
        style: ParaStyle {
            dir: Dir::Auto,
            ..ParaStyle::default()
        },
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn paragraphs_and_breaks() {
        let d = read("سطر أول\nسطر ثان\n\n\nEnglish para\r\n", &ReadOptions::default()).unwrap();
        let Content::Flow(b) = &d.sections[0].content else { panic!() };
        assert_eq!(b.len(), 2);
        let Block::Paragraph(p) = &b[0] else { panic!() };
        assert_eq!(p.text(), "سطر أول\nسطر ثان");
    }
}
