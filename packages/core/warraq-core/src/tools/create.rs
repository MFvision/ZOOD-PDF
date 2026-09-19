//! Create: a new PDF from other content (`warraq_pdf::create`). Static —
//! there is no document yet — and answering the new file as a blob.
//!
//! - `create.document`: blocks the interface read out of a Word file, a web
//!   page, Markdown or text, typeset on pages in the faces it passes.
//! - `create.images`: pictures, one to a page.
use serde::Deserialize;
use warraq_pdf::create::{
    create_document, create_from_pictures, Block, BlockAlign, BlockDir, DocumentSource, FileInfo,
    ImageBlock, PageSetup, PicturePaper, PictureSetup, TableBlock, TableCell, TextBlock,
};

use super::{args, Reply};
use crate::CoreError;

#[derive(Deserialize)]
struct Page {
    width: f32,
    height: f32,
    /// Top, right, bottom, left.
    #[serde(default)]
    margins: [f32; 4],
}

#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum Align {
    #[default]
    Start,
    Center,
    End,
    Justify,
}

impl From<Align> for BlockAlign {
    fn from(a: Align) -> Self {
        match a {
            Align::Start => BlockAlign::Start,
            Align::Center => BlockAlign::Center,
            Align::End => BlockAlign::End,
            Align::Justify => BlockAlign::Justify,
        }
    }
}

#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum Dir {
    #[default]
    Auto,
    Rtl,
    Ltr,
}

impl From<Dir> for BlockDir {
    fn from(d: Dir) -> Self {
        match d {
            Dir::Auto => BlockDir::Auto,
            Dir::Rtl => BlockDir::Rtl,
            Dir::Ltr => BlockDir::Ltr,
        }
    }
}

fn eleven() -> f32 {
    11.0
}
fn ten() -> f32 {
    10.0
}
fn one() -> f32 {
    1.0
}
fn one_span() -> usize {
    1
}
fn six() -> f32 {
    6.0
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cell {
    #[serde(default)]
    text: String,
    #[serde(default)]
    bold: bool,
    #[serde(default)]
    align: Align,
    #[serde(default)]
    dir: Dir,
    #[serde(default = "one_span")]
    span: usize,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum BlockArgs {
    Text {
        #[serde(default)]
        text: String,
        #[serde(default = "eleven")]
        size: f32,
        #[serde(default)]
        bold: bool,
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        align: Align,
        #[serde(default)]
        dir: Dir,
        #[serde(default)]
        space_before: f32,
        #[serde(default = "six")]
        space_after: f32,
        #[serde(default)]
        indent: f32,
        #[serde(default)]
        marker: Option<String>,
        #[serde(default)]
        keep_with_next: bool,
        #[serde(default = "one")]
        spacing: f32,
        #[serde(default)]
        shade: Option<String>,
        #[serde(default)]
        preserve: bool,
    },
    Table {
        #[serde(default)]
        widths: Vec<f32>,
        #[serde(default)]
        rows: Vec<Vec<Cell>>,
        #[serde(default)]
        header_rows: usize,
        #[serde(default)]
        dir: Dir,
        #[serde(default = "ten")]
        size: f32,
        #[serde(default = "six")]
        space_before: f32,
        #[serde(default = "six")]
        space_after: f32,
    },
    Image {
        /// Into the pictures listed in `pictures`.
        index: usize,
        #[serde(default)]
        width: Option<f32>,
        #[serde(default)]
        height: Option<f32>,
        #[serde(default)]
        align: Align,
        #[serde(default)]
        dir: Dir,
        #[serde(default = "six")]
        space_before: f32,
        #[serde(default = "six")]
        space_after: f32,
    },
    PageBreak,
    Rule,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentArgs {
    page: Page,
    blocks: Vec<BlockArgs>,
    /// Blob indices of the faces, the main one first.
    fonts: Vec<usize>,
    #[serde(default)]
    font_names: Vec<String>,
    /// Blob indices of the pictures image blocks refer to.
    #[serde(default)]
    pictures: Vec<usize>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    lang: Option<String>,
    #[serde(default)]
    created: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Paper {
    /// `"own"`: each page the picture's size.
    Named(String),
    Size {
        width: f32,
        height: f32,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImagesArgs {
    paper: Paper,
    #[serde(default)]
    margin: f32,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    created: Option<String>,
}

/// `#rrggbb` as RGB from 0 to 1.
fn colour(hex: &str) -> Option<[f32; 3]> {
    let hex = hex.strip_prefix('#').filter(|h| h.len() == 6)?;
    let channel = |k: usize| {
        u8::from_str_radix(hex.get(k..k + 2)?, 16)
            .ok()
            .map(|v| v as f32 / 255.0)
    };
    Some([channel(0)?, channel(2)?, channel(4)?])
}

fn block(b: BlockArgs) -> Block {
    match b {
        BlockArgs::Text {
            text,
            size,
            bold,
            color,
            align,
            dir,
            space_before,
            space_after,
            indent,
            marker,
            keep_with_next,
            spacing,
            shade,
            preserve,
        } => Block::Text(TextBlock {
            text,
            size,
            bold,
            color: color.as_deref().and_then(colour).unwrap_or([0.0; 3]),
            align: align.into(),
            dir: dir.into(),
            space_before,
            space_after,
            indent,
            marker,
            keep_with_next,
            spacing,
            shade: shade.as_deref().and_then(colour),
            preserve,
        }),
        BlockArgs::Table {
            widths,
            rows,
            header_rows,
            dir,
            size,
            space_before,
            space_after,
        } => Block::Table(TableBlock {
            widths,
            rows: rows
                .into_iter()
                .map(|row| {
                    row.into_iter()
                        .map(|c| TableCell {
                            text: c.text,
                            bold: c.bold,
                            align: c.align.into(),
                            dir: c.dir.into(),
                            span: c.span,
                        })
                        .collect()
                })
                .collect(),
            header_rows,
            dir: dir.into(),
            size,
            space_before,
            space_after,
        }),
        BlockArgs::Image {
            index,
            width,
            height,
            align,
            dir,
            space_before,
            space_after,
        } => Block::Image(ImageBlock {
            index,
            width,
            height,
            align: align.into(),
            dir: dir.into(),
            space_before,
            space_after,
        }),
        BlockArgs::PageBreak => Block::PageBreak,
        BlockArgs::Rule => Block::Rule,
    }
}

fn blob<'a>(blobs: &'a [Vec<u8>], k: usize, what: &str) -> Result<&'a [u8], CoreError> {
    blobs
        .get(k)
        .map(Vec::as_slice)
        .ok_or_else(|| CoreError::Args(format!("create: no blob {k} for {what}")))
}

pub fn call_static(name: &str, json: &str, blobs: Vec<Vec<u8>>) -> Result<Reply, CoreError> {
    match name {
        "document" => {
            let a: DocumentArgs = args(json)?;
            let fonts = a
                .fonts
                .iter()
                .map(|k| blob(&blobs, *k, "a font"))
                .collect::<Result<Vec<_>, _>>()?;
            let pictures = a
                .pictures
                .iter()
                .map(|k| blob(&blobs, *k, "a picture").map(<[u8]>::to_vec))
                .collect::<Result<Vec<_>, _>>()?;
            let blocks: Vec<Block> = a.blocks.into_iter().map(block).collect();
            let source = DocumentSource {
                page: PageSetup {
                    width: a.page.width,
                    height: a.page.height,
                    margins: a.page.margins,
                },
                blocks: &blocks,
                fonts: &fonts,
                font_names: &a.font_names,
                pictures: &pictures,
                info: FileInfo {
                    title: a.title.as_deref(),
                    lang: a.lang.as_deref(),
                    created: a.created.as_deref(),
                },
            };
            let (bytes, report) = create_document(&source)?;
            Ok(Reply::of(&serde_json::json!({
                "pages": report.pages,
                "missingGlyphs": report.missing_glyphs,
                "picturesLeftOut": report.pictures_left_out,
            }))?
            .with_blob(bytes))
        }
        "images" => {
            let a: ImagesArgs = args(json)?;
            let paper = match a.paper {
                Paper::Named(n) if n == "own" => PicturePaper::Own,
                Paper::Named(n) => return Err(CoreError::Args(format!("no paper called {n}"))),
                Paper::Size { width, height } => PicturePaper::Paper { width, height },
            };
            let (bytes, report) = create_from_pictures(
                &blobs,
                &PictureSetup {
                    paper,
                    margin: a.margin,
                },
                &FileInfo {
                    title: a.title.as_deref(),
                    lang: None,
                    created: a.created.as_deref(),
                },
            )?;
            Ok(Reply::of(&serde_json::json!({
                "pages": report.pages,
                "leftOut": report.left_out,
            }))?
            .with_blob(bytes))
        }
        _ => Err(CoreError::UnknownOp(format!("create.{name}"))),
    }
}
