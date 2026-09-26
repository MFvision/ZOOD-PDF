//! `redact.find`: Arabic-aware search and personal-data patterns over the logical-order text,
//! with rectangles for every hit.
//!
//! Text comes from warraq-text (logical order, hidden text and artifacts included — they are
//! redactable content too). Queries use `warraq_text::search` (tashkeel, tatweel, alef / taa
//! marbuta / yaa and digit forms folded). Patterns run on `normalize_for_search(page.plain)`; the
//! normaliser's offset map takes each match back to the original characters, whose glyph
//! rectangles come from `warraq_text::search::rects_for`.

use serde::Serialize;
use warraq_pdf::{pages, Pdf};
use warraq_text::geom::Rect;
use warraq_text::normalize::is_tashkeel_or_tatweel;
use warraq_text::search::rects_for;
use warraq_text::{
    extract_pages, normalize_for_search, ContentSource, DocSource, LayoutOptions, PageText,
};

use crate::error::{RedactError, Result};
use crate::patterns::{builtin, custom, scan, Kind, Pattern};

/// Most hits returned.
pub const MAX_HITS: usize = 20_000;

/// What to look for.
#[derive(Debug, Clone, Default)]
pub struct FindOptions {
    pub query: Option<String>,
    pub patterns: Vec<Kind>,
    pub regex: Option<String>,
    /// 0-based pages (default all).
    pub pages: Option<Vec<usize>>,
}

/// One hit.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FindHit {
    pub page: usize,
    pub kind: Kind,
    /// The matched text as it appears in the document.
    pub text: String,
    /// PDF user-space rectangles `[x0, y0, x1, y1]` (y up), one per line.
    pub rects: Vec<[f64; 4]>,
    /// The same rectangles in the viewer's page space: points from the top-left corner of the
    /// displayed (rotated) page, y down.
    pub view_rects: Vec<[f64; 4]>,
}

/// Size of a displayed page (points, rotation applied).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PageSize {
    pub width: f64,
    pub height: f64,
    pub rotation: i64,
}

/// Result of a search.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FindResult {
    pub hits: Vec<FindHit>,
    pub pages: Vec<PageSize>,
    pub truncated: bool,
}

/// Page geometry for coordinate conversion.
#[derive(Debug, Clone, Copy)]
pub struct PageGeom {
    /// Box the extractor measures from (CropBox, else MediaBox).
    pub bx: [f64; 4],
    pub rotate: i64,
}

impl PageGeom {
    /// Extractor rectangle (top-left, y down) → user space.
    pub fn to_user(&self, r: &Rect) -> [f64; 4] {
        [
            self.bx[0] + r.x0,
            self.bx[3] - r.y1,
            self.bx[0] + r.x1,
            self.bx[3] - r.y0,
        ]
    }

    /// Extractor rectangle → viewer rectangle (rotation applied, top-left origin).
    pub fn to_view(&self, r: &Rect) -> [f64; 4] {
        let w = self.bx[2] - self.bx[0];
        let h = self.bx[3] - self.bx[1];
        let map = |x: f64, y: f64| match self.rotate {
            90 => (h - y, x),
            180 => (w - x, h - y),
            270 => (y, w - x),
            _ => (x, y),
        };
        let (a, b) = map(r.x0, r.y0);
        let (c, d) = map(r.x1, r.y1);
        [a.min(c), b.min(d), a.max(c), b.max(d)]
    }

    /// Displayed size.
    pub fn view_size(&self) -> PageSize {
        let w = self.bx[2] - self.bx[0];
        let h = self.bx[3] - self.bx[1];
        let (width, height) = if self.rotate == 90 || self.rotate == 270 {
            (h, w)
        } else {
            (w, h)
        };
        PageSize {
            width,
            height,
            rotation: self.rotate,
        }
    }
}

/// Geometry of every page, in page order.
pub fn page_geoms<S: ContentSource + ?Sized>(pdf: &Pdf, src: &S) -> Result<Vec<PageGeom>> {
    let list = pages::flatten(pdf)?;
    let n = src.page_count();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let bx = src.page_box(i)?;
        let rotate = list.get(i).map_or(0, |p| p.rotate);
        out.push(PageGeom { bx, rotate });
    }
    Ok(out)
}

/// Extract the pages to search.
pub fn extract(pdf: &Pdf, pages_wanted: Option<&[usize]>) -> Result<Vec<PageText>> {
    let src = DocSource::borrowed(pdf.document());
    let all: Vec<usize> = (0..src.page_count()).collect();
    let list: Vec<usize> = match pages_wanted {
        Some(p) => p
            .iter()
            .copied()
            .filter(|&i| i < src.page_count())
            .collect(),
        None => all,
    };
    let opts = LayoutOptions {
        glyphs: false,
        include_hidden: true,
        include_artifacts: true,
    };
    Ok(extract_pages(&src, &list, &opts)?)
}

fn char_index(plain: &str, byte: usize) -> usize {
    plain.get(..byte).map_or(0, |s| s.chars().count())
}

/// Map a byte range of `normalize_for_search(plain)` back to char offsets of `plain`.
fn original_range(
    plain: &str,
    norm: &str,
    map: &[usize],
    r: &std::ops::Range<usize>,
) -> Option<(usize, usize, usize, usize)> {
    let ci = norm.get(..r.start)?.chars().count();
    let n = norm.get(r.clone())?.chars().count();
    if n == 0 {
        return None;
    }
    let ostart = *map.get(ci)?;
    let olast = *map.get(ci + n - 1)?;
    let mut oend = olast + plain.get(olast..)?.chars().next().map_or(0, char::len_utf8);
    while let Some(c) = plain.get(oend..).and_then(|s| s.chars().next()) {
        if is_tashkeel_or_tatweel(c) {
            oend += c.len_utf8();
        } else {
            break;
        }
    }
    Some((
        char_index(plain, ostart),
        char_index(plain, oend),
        ostart,
        oend,
    ))
}

/// Run a search.
pub fn find(pdf: &Pdf, opts: &FindOptions) -> Result<FindResult> {
    let mut patterns: Vec<Pattern> = Vec::new();
    for k in &opts.patterns {
        patterns.extend(builtin(*k)?);
    }
    if let Some(src) = &opts.regex {
        patterns.push(Pattern {
            kind: Kind::Custom,
            regex: custom(src)?,
            group: 0,
            validate: |_| true,
            shrink: false,
        });
    }
    let query = opts
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty());
    if query.is_none() && patterns.is_empty() {
        return Err(RedactError::Params(
            "give a query, patterns or a regex".into(),
        ));
    }
    let pages_text = extract(pdf, opts.pages.as_deref())?;
    let src = DocSource::borrowed(pdf.document());
    let geoms = page_geoms(pdf, &src)?;
    let mut hits: Vec<FindHit> = Vec::new();
    let mut truncated = false;
    let mut seen: std::collections::HashSet<(usize, usize, usize)> =
        std::collections::HashSet::new();
    let geom = |p: usize| {
        geoms.get(p).copied().unwrap_or(PageGeom {
            bx: [0.0, 0.0, 612.0, 792.0],
            rotate: 0,
        })
    };
    if let Some(q) = query {
        for h in warraq_text::search(&pages_text, q) {
            if hits.len() >= MAX_HITS {
                truncated = true;
                break;
            }
            let g = geom(h.page);
            seen.insert((h.page, h.start, h.end));
            hits.push(FindHit {
                page: h.page,
                kind: Kind::Query,
                text: h.text.clone(),
                rects: h.rects.iter().map(|r| g.to_user(r)).collect(),
                view_rects: h.rects.iter().map(|r| g.to_view(r)).collect(),
            });
        }
    }
    if !patterns.is_empty() {
        for page in &pages_text {
            if hits.len() >= MAX_HITS {
                truncated = true;
                break;
            }
            let (norm, map) = normalize_for_search(&page.plain);
            let g = geom(page.page);
            for (kind, r) in scan(&norm, &patterns, MAX_HITS - hits.len()) {
                let Some((start, end, ob, oe)) = original_range(&page.plain, &norm, &map, &r)
                else {
                    continue;
                };
                if !seen.insert((page.page, start, end)) {
                    continue;
                }
                let rects = rects_for(page, start, end);
                if rects.is_empty() {
                    continue;
                }
                hits.push(FindHit {
                    page: page.page,
                    kind,
                    text: page.plain.get(ob..oe).unwrap_or("").to_string(),
                    rects: rects.iter().map(|r| g.to_user(r)).collect(),
                    view_rects: rects.iter().map(|r| g.to_view(r)).collect(),
                });
            }
        }
    }
    hits.sort_by(|a, b| {
        a.page.cmp(&b.page).then(
            b.rects
                .first()
                .map_or(0.0, |r| r[3])
                .partial_cmp(&a.rects.first().map_or(0.0, |r| r[3]))
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    Ok(FindResult {
        hits,
        pages: geoms.iter().map(PageGeom::view_size).collect(),
        truncated,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn coordinates_convert_with_rotation() {
        let g = PageGeom {
            bx: [0.0, 0.0, 600.0, 800.0],
            rotate: 0,
        };
        let r = Rect::new(10.0, 20.0, 30.0, 40.0);
        assert_eq!(g.to_user(&r), [10.0, 760.0, 30.0, 780.0]);
        assert_eq!(g.to_view(&r), [10.0, 20.0, 30.0, 40.0]);
        let g = PageGeom { rotate: 90, ..g };
        assert_eq!(g.to_view(&r), [760.0, 10.0, 780.0, 30.0]);
        assert_eq!(g.view_size().width, 800.0);
        let g = PageGeom { rotate: 180, ..g };
        assert_eq!(g.to_view(&r), [570.0, 760.0, 590.0, 780.0]);
        let g = PageGeom { rotate: 270, ..g };
        assert_eq!(g.to_view(&r), [20.0, 570.0, 40.0, 590.0]);
    }
}
