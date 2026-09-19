//! A copy of the document with its text taken out, for drawing a page
//! without it: what Export to PowerPoint puts behind the slide's own,
//! editable text boxes, so the words are not there twice.
//!
//! Every text-showing operator (`Tj`, `TJ`, `'`, `"`) of the pages and of
//! every form — annotation appearances and form fields included — is cut
//! out of a copy; `'` and `"` leave their move to the next line behind.
//! Everything else stays byte for byte, inline images too (`lex`). The
//! pages' own streams are read for their text rendering mode on the way:
//! a page whose text is all invisible (render mode 3 or 7) is a scan with a
//! recognised text layer, where the picture is the page and must keep what
//! it shows.
use lopdf::{Object, ObjectId};

use crate::lex::{lex, Operand};
use crate::{PdfDocument, Result};

/// How a page's own streams show their text.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TextShown {
    pub visible: usize,
    pub invisible: usize,
}

impl TextShown {
    /// All the text there is, and it is not drawn: a scan's text layer.
    pub fn only_invisible(&self) -> bool {
        self.invisible > 0 && self.visible == 0
    }
}

/// `content` without its text-showing operators; `tr` carries the render
/// mode across a page's streams, and `shown` counts what was cut.
fn strip(content: &[u8], tr: &mut Vec<i64>, shown: &mut TextShown) -> Option<Vec<u8>> {
    let ops = lex(content);
    let mut out = Vec::with_capacity(content.len());
    let mut at = 0;
    let mut changed = false;
    for op in &ops {
        let current = tr.last().copied().unwrap_or(0);
        let name = op.operator.as_slice();
        match name {
            b"q" => tr.push(current),
            b"Q" => {
                if tr.len() > 1 {
                    tr.pop();
                }
            }
            b"Tr" => {
                if let Some((Operand::Number(n), _)) = op.operands.first() {
                    if let Some(last) = tr.last_mut() {
                        *last = *n as i64;
                    }
                }
            }
            b"Tj" | b"TJ" | b"'" | b"\"" => {
                if matches!(current, 3 | 7) {
                    shown.invisible += 1;
                } else {
                    shown.visible += 1;
                }
                out.extend_from_slice(&content[at..op.range.start]);
                out.extend_from_slice(if name == b"Tj" || name == b"TJ" {
                    b" "
                } else {
                    b" T* "
                });
                at = op.range.end;
                changed = true;
            }
            _ => {}
        }
    }
    if !changed {
        return None;
    }
    out.extend_from_slice(&content[at..]);
    Some(out)
}

impl PdfDocument {
    /// The document as a new file with no text drawn anywhere, and for each
    /// page how its own streams showed their text.
    pub fn without_text(&self) -> Result<(Vec<u8>, Vec<TextShown>)> {
        let mut copy = self.detached_copy();
        let mut shown = Vec::with_capacity(copy.pages.len());
        let pages = copy.pages.clone();
        for page in pages {
            let mut tr = vec![0i64];
            let mut counted = TextShown::default();
            for id in copy.content_ids(page) {
                let Ok(bytes) = copy.stream_bytes(id) else {
                    continue;
                };
                if let Some(stripped) = strip(&bytes, &mut tr, &mut counted) {
                    copy.replace_stream_content(id, stripped);
                }
            }
            shown.push(counted);
        }
        let forms: Vec<ObjectId> = copy
            .doc
            .objects
            .iter()
            .filter_map(|(id, object)| {
                let stream = object.as_stream().ok()?;
                let form = stream
                    .dict
                    .get(b"Subtype")
                    .and_then(Object::as_name)
                    .is_ok_and(|n| n == b"Form");
                form.then_some(*id)
            })
            .collect();
        for id in forms {
            let Ok(bytes) = copy.stream_bytes(id) else {
                continue;
            };
            let mut tr = vec![0i64];
            if let Some(stripped) = strip(&bytes, &mut tr, &mut TextShown::default()) {
                copy.replace_stream_content(id, stripped);
            }
        }
        Ok((copy.save_to_vec()?, shown))
    }

    /// Puts `bytes` in as the stream's content, uncompressed.
    fn replace_stream_content(&mut self, id: ObjectId, bytes: Vec<u8>) {
        if let Ok(Object::Stream(stream)) = self.doc.get_object_mut(id) {
            stream.dict.remove(b"Filter");
            stream.dict.remove(b"DecodeParms");
            stream.set_content(bytes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stripped(s: &[u8]) -> (String, TextShown) {
        let mut shown = TextShown::default();
        let out = strip(s, &mut vec![0], &mut shown).unwrap_or_else(|| s.to_vec());
        (String::from_utf8_lossy(&out).into_owned(), shown)
    }

    #[test]
    fn text_is_cut_and_everything_else_kept_byte_for_byte() {
        let (out, shown) = stripped(
            b"q 1 0 0 RG 0 0 10 10 re S Q BT /F1 12 Tf 10 20 Td (Hello) Tj [(W) -20 (orld)] TJ (next) ' 1 2 (quote) \" ET /Im0 Do",
        );
        let words: Vec<&str> = out.split_whitespace().collect();
        assert_eq!(
            words.join(" "),
            "q 1 0 0 RG 0 0 10 10 re S Q BT /F1 12 Tf 10 20 Td T* T* ET /Im0 Do"
        );
        assert_eq!(
            shown,
            TextShown {
                visible: 4,
                invisible: 0
            }
        );
    }

    #[test]
    fn invisible_text_is_told_apart_and_the_mode_follows_q_and_q() {
        let (_, shown) =
            stripped(b"BT 3 Tr (layer) Tj ET q BT 0 Tr (seen) Tj ET Q BT (layer again) Tj ET");
        assert_eq!(
            shown,
            TextShown {
                visible: 1,
                invisible: 2
            }
        );
        assert!(!shown.only_invisible());
        let (_, shown) = stripped(b"q /Im0 Do Q BT 3 Tr (a) Tj (b) Tj ET");
        assert!(shown.only_invisible());
    }

    #[test]
    fn a_stream_without_text_is_left_alone() {
        assert!(strip(b"q /Im0 Do Q", &mut vec![0], &mut TextShown::default()).is_none());
    }

    #[test]
    fn a_page_drawn_without_its_text_keeps_its_pictures_and_loses_its_words() {
        let bytes = std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/raw-amiri-cid-identity-tounicode.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let doc = PdfDocument::open(bytes, None).unwrap();
        let (bare, shown) = doc.without_text().unwrap();
        assert!(shown[0].visible > 0 && !shown[0].only_invisible());
        let bare = PdfDocument::open(bare, None).unwrap();
        assert_eq!(bare.page_count(), doc.page_count());
        let content = bare.doc.get_page_content(bare.page_id(0).unwrap());
        let ops = lex(&content);
        assert!(ops
            .iter()
            .all(|op| !matches!(op.operator.as_slice(), b"Tj" | b"TJ" | b"'" | b"\"")));
    }
}
