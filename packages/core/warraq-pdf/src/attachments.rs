//! Attachments: files embedded in a PDF — in the document's `EmbeddedFiles`
//! name tree, or in a file attachment annotation on a page — listed, read out,
//! added and removed.
//!
//! An attachment is only ever handed back as bytes, to be saved where the
//! person chooses: nothing here opens or runs one. Its size is read from the
//! file, and its bytes are decoded against a limit.
use lopdf::{Dictionary, Object, ObjectId, Stream, StringFormat};

use crate::document::decode_text_string;
use crate::{Error, PdfDocument, Result};

/// The most an attachment may decode to: a bound on what a hostile file can
/// make Warraq allocate, and on what can be added.
pub const MAX_ATTACHMENT: usize = 256 << 20;

/// Where an attachment lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentPlace {
    /// The document's `EmbeddedFiles` name tree.
    Document,
    /// A file attachment annotation on page `page` (zero-based).
    Page(usize),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Attachment {
    /// Names it for `attachment_bytes` and `remove_attachment`: `d<k>` for the
    /// k-th entry of the name tree, `p<page>:<k>` for the k-th annotation of a
    /// page. Valid until the file changes.
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    /// Bytes, as the file declares them or as they decode; `None` if neither.
    pub size: Option<usize>,
    /// The media type the file declares, if any.
    pub mime: Option<String>,
    pub place: AttachmentPlace,
}

/// The most notes `notes` lists, and the most characters it keeps of one.
pub const MAX_NOTES: usize = 2_000;
pub const MAX_NOTE: usize = 4_000;

/// A comment on a page (`PdfDocument::notes`).
#[derive(Debug, Clone, PartialEq)]
pub struct PageNote {
    /// Zero-based.
    pub page: usize,
    pub text: String,
    pub author: Option<String>,
}

fn text(doc: &PdfDocument, o: Option<&Object>) -> Option<String> {
    let o = doc.doc.dereference(o?).ok()?.1;
    Some(decode_text_string(o.as_str().ok()?))
}

/// A PDF text string for `s`: PDFDocEncoding-safe ASCII as it is, anything
/// else as UTF-16BE with its byte-order mark.
pub fn text_string(s: &str) -> Object {
    if s.chars().all(|c| (' '..='~').contains(&c)) {
        Object::String(s.as_bytes().to_vec(), StringFormat::Literal)
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in s.encode_utf16() {
            bytes.extend(unit.to_be_bytes());
        }
        Object::String(bytes, StringFormat::Hexadecimal)
    }
}

/// A file name that is only a name: no folders, no control characters, not
/// empty. Names come from the file, and are shown and offered to a save panel.
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let clean = clean.trim().trim_start_matches('.').trim().to_string();
    if clean.is_empty() {
        "attachment".into()
    } else {
        clean.chars().take(200).collect()
    }
}

impl PdfDocument {
    /// The embedded-file stream of a file specification, and the spec itself.
    fn embedded_stream<'a>(&'a self, spec: &'a Object) -> Option<(&'a Dictionary, &'a Stream)> {
        let spec = self.doc.dereference(spec).ok()?.1.as_dict().ok()?;
        let ef = self
            .doc
            .dereference(spec.get(b"EF").ok()?)
            .ok()?
            .1
            .as_dict()
            .ok()?;
        let file = ef.get(b"UF").or_else(|_| ef.get(b"F")).ok()?;
        let stream = self.doc.dereference(file).ok()?.1.as_stream().ok()?;
        Some((spec, stream))
    }

    fn describe(
        &self,
        key: String,
        fallback: &[u8],
        spec: &Object,
        place: AttachmentPlace,
    ) -> Attachment {
        let spec_dict = self
            .doc
            .dereference(spec)
            .ok()
            .and_then(|(_, o)| o.as_dict().ok());
        let name = spec_dict
            .and_then(|d| text(self, d.get(b"UF").ok()).or_else(|| text(self, d.get(b"F").ok())))
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| decode_text_string(fallback));
        let description = spec_dict.and_then(|d| text(self, d.get(b"Desc").ok()));
        let stream = self.embedded_stream(spec).map(|(_, s)| s);
        let declared = stream
            .and_then(|s| s.dict.get(b"Params").ok())
            .and_then(|p| self.doc.dereference(p).ok())
            .and_then(|(_, p)| p.as_dict().ok())
            .and_then(|p| p.get(b"Size").ok())
            .and_then(|s| s.as_i64().ok())
            .filter(|s| *s >= 0)
            .map(|s| s as usize);
        let size = declared.or_else(|| {
            stream.and_then(|s| {
                if s.dict.has(b"Filter") {
                    None
                } else {
                    Some(s.content.len())
                }
            })
        });
        let mime = stream
            .and_then(|s| s.dict.get(b"Subtype").ok())
            .and_then(|s| s.as_name().ok())
            .map(|s| {
                String::from_utf8_lossy(s)
                    .replace("#2F", "/")
                    .replace("#2f", "/")
            });
        Attachment {
            key,
            name: safe_file_name(&name),
            description: description.filter(|d| !d.trim().is_empty()),
            size,
            mime,
            place,
        }
    }

    /// Every file attached to the document, the name tree's first.
    pub fn attachments(&self) -> Vec<Attachment> {
        let mut out = vec![];
        if let Some(root) = self.names_root(b"EmbeddedFiles") {
            for (k, (key, spec)) in self.name_tree_entries(root).into_iter().enumerate() {
                out.push(self.describe(format!("d{k}"), &key, &spec, AttachmentPlace::Document));
            }
        }
        for (page, &page_id) in self.pages.iter().enumerate() {
            for (k, (_, annot)) in self.page_annotations(page_id).into_iter().enumerate() {
                if annot.get(b"Subtype").and_then(|s| s.as_name()).ok() != Some(b"FileAttachment") {
                    continue;
                }
                let Ok(spec) = annot.get(b"FS") else {
                    continue;
                };
                let mut a = self.describe(
                    format!("p{page}:{k}"),
                    b"",
                    spec,
                    AttachmentPlace::Page(page),
                );
                if a.description.is_none() {
                    a.description =
                        text(self, annot.get(b"Contents").ok()).filter(|d| !d.trim().is_empty());
                }
                out.push(a);
            }
        }
        out
    }

    /// The comments on the pages — sticky notes, and the text of any other
    /// markup that carries some — page by page, for a presenter's notes.
    /// Form fields, links and pop-ups are not comments. Bounded: at most
    /// [`MAX_NOTES`] notes, each cut to [`MAX_NOTE`] characters.
    pub fn notes(&self) -> Vec<PageNote> {
        let mut out = vec![];
        for (page, &page_id) in self.pages.iter().enumerate() {
            for (_, annot) in self.page_annotations(page_id) {
                let kind = annot
                    .get(b"Subtype")
                    .and_then(|s| s.as_name())
                    .unwrap_or(b"");
                if matches!(kind, b"Widget" | b"Link" | b"Popup" | b"FileAttachment") {
                    continue;
                }
                let Some(body) = text(self, annot.get(b"Contents").ok()) else {
                    continue;
                };
                let body: String = body.trim().chars().take(MAX_NOTE).collect();
                if body.is_empty() {
                    continue;
                }
                let author = text(self, annot.get(b"T").ok())
                    .map(|a| a.trim().chars().take(80).collect::<String>());
                out.push(PageNote {
                    page,
                    text: body,
                    author: author.filter(|a| !a.is_empty()),
                });
                if out.len() >= MAX_NOTES {
                    return out;
                }
            }
        }
        out
    }

    /// The file specification an attachment key names.
    fn spec_for(&self, key: &str) -> Result<Object> {
        let missing = || Error::Edit(format!("no attachment {key}"));
        if let Some(k) = key.strip_prefix('d') {
            let k: usize = k.parse().map_err(|_| missing())?;
            let root = self.names_root(b"EmbeddedFiles").ok_or_else(missing)?;
            return self
                .name_tree_entries(root)
                .into_iter()
                .nth(k)
                .map(|(_, spec)| spec)
                .ok_or_else(missing);
        }
        let (page, k) = key
            .strip_prefix('p')
            .and_then(|r| r.split_once(':'))
            .ok_or_else(missing)?;
        let page: usize = page.parse().map_err(|_| missing())?;
        let k: usize = k.parse().map_err(|_| missing())?;
        let page_id = self.page_id(page)?;
        let annots = self.page_annotations(page_id);
        let (_, annot) = annots.get(k).ok_or_else(missing)?;
        annot.get(b"FS").cloned().map_err(|_| missing())
    }

    /// An attachment's name and bytes, decoded; never more than `MAX_ATTACHMENT`.
    pub fn attachment_bytes(&self, key: &str) -> Result<(String, Vec<u8>)> {
        let listed = self
            .attachments()
            .into_iter()
            .find(|a| a.key == key)
            .ok_or_else(|| Error::Edit(format!("no attachment {key}")))?;
        let spec = self.spec_for(key)?;
        let (_, stream) = self
            .embedded_stream(&spec)
            .ok_or_else(|| Error::Edit("the attachment has no embedded file".into()))?;
        let bytes = if stream.dict.has(b"Filter") {
            stream
                .decompressed_content_with_limit(MAX_ATTACHMENT)
                .map_err(|e| Error::Edit(format!("the attachment cannot be read: {e}")))?
        } else {
            stream.content.clone()
        };
        Ok((listed.name, bytes))
    }

    /// The catalog's `/Names` dictionary, made its own object if it was not.
    fn names_dict_id(&mut self) -> Result<ObjectId> {
        let catalog = self
            .doc
            .catalog()
            .map_err(|e| Error::Parse(e.to_string()))?;
        let names = catalog.get(b"Names").ok().cloned();
        let root_id = self
            .doc
            .trailer
            .get(b"Root")
            .and_then(|r| r.as_reference())
            .map_err(|e| Error::Parse(e.to_string()))?;
        match names {
            Some(Object::Reference(id)) if self.doc.get_dictionary(id).is_ok() => Ok(id),
            other => {
                let dict = match other {
                    Some(Object::Dictionary(d)) => d,
                    _ => Dictionary::new(),
                };
                let id = self.doc.add_object(Object::Dictionary(dict));
                self.doc
                    .get_dictionary_mut(root_id)
                    .map_err(|e| Error::Parse(e.to_string()))?
                    .set("Names", Object::Reference(id));
                self.mark_touched(root_id);
                Ok(id)
            }
        }
    }

    /// Writes the `EmbeddedFiles` tree as one flat, sorted node holding
    /// `entries` — or removes it when there are none.
    fn write_embedded_files(&mut self, mut entries: Vec<(Vec<u8>, Object)>) -> Result<()> {
        let names_id = self.names_dict_id()?;
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let names = self
            .doc
            .get_dictionary_mut(names_id)
            .map_err(|e| Error::Parse(e.to_string()))?;
        if entries.is_empty() {
            names.remove(b"EmbeddedFiles");
        } else {
            let mut flat = vec![];
            for (key, value) in entries {
                flat.push(Object::String(key, StringFormat::Hexadecimal));
                flat.push(value);
            }
            let mut node = Dictionary::new();
            node.set("Names", Object::Array(flat));
            names.set("EmbeddedFiles", Object::Dictionary(node));
        }
        self.mark_touched(names_id);
        Ok(())
    }

    /// Attaches `bytes` to the document as `name`, with a description if one
    /// is given. A name already taken gets a number: "a (2).txt".
    pub fn add_attachment(
        &mut self,
        name: &str,
        bytes: Vec<u8>,
        description: Option<&str>,
    ) -> Result<String> {
        if bytes.len() > MAX_ATTACHMENT {
            return Err(Error::Edit(format!(
                "a file larger than {} MB cannot be attached",
                MAX_ATTACHMENT >> 20
            )));
        }
        let wanted = safe_file_name(name);
        let mut entries: Vec<(Vec<u8>, Object)> = self
            .names_root(b"EmbeddedFiles")
            .map(|root| self.name_tree_entries(root))
            .unwrap_or_default();
        let taken: Vec<String> = entries.iter().map(|(k, _)| decode_text_string(k)).collect();
        let mut chosen = wanted.clone();
        let (stem, ext) = match wanted.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
            _ => (wanted.clone(), String::new()),
        };
        let mut n = 2;
        while taken.contains(&chosen) && n < 10_000 {
            chosen = format!("{stem} ({n}){ext}");
            n += 1;
        }
        let size = bytes.len() as i64;
        let mut params = Dictionary::new();
        params.set("Size", Object::Integer(size));
        let mut file_dict = Dictionary::new();
        file_dict.set("Type", Object::Name(b"EmbeddedFile".to_vec()));
        file_dict.set("Params", Object::Dictionary(params));
        let mut stream = Stream::new(file_dict, bytes);
        let _ = stream.compress();
        let file_id = self.doc.add_object(stream);
        let mut ef = Dictionary::new();
        ef.set("F", Object::Reference(file_id));
        ef.set("UF", Object::Reference(file_id));
        let mut spec = Dictionary::new();
        spec.set("Type", Object::Name(b"Filespec".to_vec()));
        spec.set("F", text_string(&chosen));
        spec.set("UF", text_string(&chosen));
        spec.set("EF", Object::Dictionary(ef));
        if let Some(d) = description.map(str::trim).filter(|d| !d.is_empty()) {
            spec.set("Desc", text_string(d));
        }
        let spec_id = self.doc.add_object(Object::Dictionary(spec));
        let key = match text_string(&chosen) {
            Object::String(k, _) => k,
            _ => chosen.as_bytes().to_vec(),
        };
        entries.push((key, Object::Reference(spec_id)));
        self.write_embedded_files(entries)?;
        Ok(chosen)
    }

    /// Removes the attachment `key` names from the document. The file's
    /// earlier revision still holds it until the file is written whole.
    pub fn remove_attachment(&mut self, key: &str) -> Result<()> {
        let missing = || Error::Edit(format!("no attachment {key}"));
        if let Some(k) = key.strip_prefix('d') {
            let k: usize = k.parse().map_err(|_| missing())?;
            let mut entries = self
                .names_root(b"EmbeddedFiles")
                .map(|root| self.name_tree_entries(root))
                .unwrap_or_default();
            if k >= entries.len() {
                return Err(missing());
            }
            entries.remove(k);
            return self.write_embedded_files(entries);
        }
        let (page, k) = key
            .strip_prefix('p')
            .and_then(|r| r.split_once(':'))
            .ok_or_else(missing)?;
        let page: usize = page.parse().map_err(|_| missing())?;
        let k: usize = k.parse().map_err(|_| missing())?;
        let page_id = self.page_id(page)?;
        let page_dict = self
            .doc
            .get_dictionary(page_id)
            .map_err(|e| Error::Parse(e.to_string()))?;
        let annots = match page_dict.get(b"Annots") {
            Ok(Object::Reference(id)) => self
                .doc
                .get_object(*id)
                .and_then(|o| o.as_array())
                .map_err(|_| missing())?
                .clone(),
            Ok(Object::Array(a)) => a.clone(),
            _ => return Err(missing()),
        };
        // `page_annotations` skips entries that do not resolve; count alike.
        let resolvable: Vec<usize> = annots
            .iter()
            .enumerate()
            .filter(|(_, a)| {
                self.doc
                    .dereference(a)
                    .ok()
                    .is_some_and(|(_, o)| o.as_dict().is_ok())
            })
            .map(|(i, _)| i)
            .collect();
        let at = *resolvable.get(k).ok_or_else(missing)?;
        let is_attachment = self
            .doc
            .dereference(&annots[at])
            .ok()
            .and_then(|(_, o)| o.as_dict().ok())
            .and_then(|d| d.get(b"Subtype").ok())
            .and_then(|s| s.as_name().ok())
            == Some(b"FileAttachment");
        if !is_attachment {
            return Err(missing());
        }
        let mut kept = annots;
        kept.remove(at);
        let page_dict = self
            .doc
            .get_dictionary_mut(page_id)
            .map_err(|e| Error::Parse(e.to_string()))?;
        page_dict.set("Annots", Object::Array(kept));
        self.mark_touched(page_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/fixtures/hidden/everything.pdf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn both_kinds_of_attachment_are_listed_with_name_size_and_description() {
        let doc = PdfDocument::open(fixture(), None).unwrap();
        let list = doc.attachments();
        assert_eq!(list.len(), 2, "{list:#?}");
        assert_eq!(list[0].name, "doc-secret.txt");
        assert_eq!(list[0].size, Some(18));
        assert_eq!(
            list[0].description.as_deref(),
            Some("A document attachment")
        );
        assert_eq!(list[0].mime.as_deref(), Some("text/plain"));
        assert_eq!(list[0].place, AttachmentPlace::Document);
        assert_eq!(list[1].name, "annot-secret.txt");
        assert_eq!(list[1].place, AttachmentPlace::Page(0));
        assert_eq!(list[1].description.as_deref(), Some("An attached note"));
        let (name, bytes) = doc.attachment_bytes(&list[1].key).unwrap();
        assert_eq!(name, "annot-secret.txt");
        assert_eq!(bytes, b"ATTACH-ANNOT-SECRET\n");
        assert!(doc.attachment_bytes("d9").is_err());
        assert!(
            doc.attachment_bytes("p0:0").is_err(),
            "a comment is not an attachment"
        );
    }

    /// The fixture's sticky note is a presenter's note; its attachment is not.
    #[test]
    fn comments_are_listed_as_notes() {
        let doc = PdfDocument::open(fixture(), None).unwrap();
        let notes = doc.notes();
        assert!(!notes.is_empty());
        assert!(notes.iter().all(|n| n.page == 0 && !n.text.is_empty()));
        assert!(notes.iter().all(|n| n.text != "An attached note"));
    }

    /// Added as an update, with an Arabic name and a clash, read back, then
    /// removed — each through a save and a reopen.
    #[test]
    fn an_attachment_is_added_read_back_and_removed() {
        let mut doc = PdfDocument::open(fixture(), None).unwrap();
        let name = doc
            .add_attachment(
                "../../تقرير.txt",
                "نص عربي".as_bytes().to_vec(),
                Some("وصف"),
            )
            .unwrap();
        assert_eq!(name, "تقرير.txt", "no folders in a name");
        let again = doc
            .add_attachment("تقرير.txt", b"2".to_vec(), None)
            .unwrap();
        assert_eq!(again, "تقرير (2).txt");
        let saved = doc.save_incremental().unwrap();
        assert!(saved.starts_with(&fixture()), "an update of the file");
        let mut doc = PdfDocument::open(saved, None).unwrap();
        let list = doc.attachments();
        assert_eq!(list.len(), 4, "{list:#?}");
        let added = list.iter().find(|a| a.name == "تقرير.txt").unwrap();
        assert_eq!(added.description.as_deref(), Some("وصف"));
        assert_eq!(added.size, Some("نص عربي".len()));
        assert_eq!(
            doc.attachment_bytes(&added.key).unwrap().1,
            "نص عربي".as_bytes()
        );

        let doc_key = list
            .iter()
            .find(|a| a.name == "doc-secret.txt")
            .unwrap()
            .key
            .clone();
        doc.remove_attachment(&doc_key).unwrap();
        let annot_key = doc
            .attachments()
            .into_iter()
            .find(|a| a.name == "annot-secret.txt")
            .unwrap()
            .key;
        doc.remove_attachment(&annot_key).unwrap();
        let doc = PdfDocument::open(doc.save_incremental().unwrap(), None).unwrap();
        let names: Vec<String> = doc.attachments().into_iter().map(|a| a.name).collect();
        assert_eq!(names, vec!["تقرير (2).txt", "تقرير.txt"]);
    }

    #[test]
    fn names_from_the_file_are_only_names() {
        assert_eq!(safe_file_name("C:\\Users\\x\\evil.exe"), "evil.exe");
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("\u{0}\n"), "attachment");
        assert_eq!(safe_file_name(".hidden"), "hidden");
    }
}
