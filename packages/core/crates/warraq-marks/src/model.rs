//! The mark model (`marks.add` / `marks.update` params, also stored in the PDF so a mark can be
//! listed and edited later).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{MarkError, Result};
use crate::tokens::{Bates, Digits, Lang, Now, MAX_TEMPLATE_CHARS};

/// What the mark is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Watermark,
    Header,
    Footer,
    PageNumber,
    Bates,
}

/// Bundled font.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Font {
    #[default]
    Amiri,
    Cairo,
    Inter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Vertical {
    Top,
    Middle,
    Bottom,
}

/// Horizontal slot. `start`/`end` follow the document direction (`rtl`): in a right-to-left
/// document `start` is the right edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Horizontal {
    Start,
    Center,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Layer {
    Behind,
    #[default]
    Front,
}

/// Header/footer texts per slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Slots {
    #[serde(default)]
    pub start: String,
    #[serde(default)]
    pub center: String,
    #[serde(default)]
    pub end: String,
}

/// A page mark.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkSpec {
    pub kind: Kind,
    /// 0-based pages; absent/null = every page.
    #[serde(default)]
    pub pages: Option<Vec<usize>>,
    /// Text template (watermark text, page number, Bates). Default per kind.
    #[serde(default)]
    pub text: Option<String>,
    /// Header/footer slots.
    #[serde(default)]
    pub slots: Option<Slots>,
    /// Picture watermark: the JPEG/PNG comes as a blob (or is kept from the mark being updated).
    #[serde(default)]
    pub picture: bool,
    #[serde(default)]
    pub font: Font,
    /// Font size in points (text).
    #[serde(default)]
    pub size: Option<f64>,
    /// Fill colour, RGB 0–1.
    #[serde(default)]
    pub color: Option<[f64; 3]>,
    /// 0–1.
    #[serde(default)]
    pub opacity: Option<f64>,
    /// Degrees counter-clockwise.
    #[serde(default)]
    pub rotation: f64,
    /// Along the visible page's diagonal (bottom-start to top-end); overrides `rotation`.
    #[serde(default)]
    pub diagonal: bool,
    #[serde(default)]
    pub vertical: Option<Vertical>,
    #[serde(default)]
    pub horizontal: Option<Horizontal>,
    /// Offsets in points: `x` towards the right edge, `y` towards the top (displayed page).
    #[serde(default)]
    pub offset_x: f64,
    #[serde(default)]
    pub offset_y: f64,
    /// Distance from the page edges in points.
    #[serde(default)]
    pub margin: Option<f64>,
    #[serde(default)]
    pub layer: Option<Layer>,
    /// Picture width as a fraction of the displayed page width.
    #[serde(default)]
    pub scale: Option<f64>,
    /// The document reads right to left (start = right).
    #[serde(default)]
    pub rtl: bool,
    #[serde(default)]
    pub digits: Digits,
    #[serde(default)]
    pub lang: Lang,
    #[serde(default)]
    pub bates: Option<Bates>,
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub now: Option<Now>,
    /// Opaque interface state (e.g. the page-range text as typed), stored and returned as is.
    #[serde(default)]
    pub ui: Value,
}

/// Most pages a mark can name explicitly.
pub const MAX_PAGES: usize = 100_000;

fn finite_in(v: f64, lo: f64, hi: f64) -> bool {
    v.is_finite() && v >= lo && v <= hi
}

impl MarkSpec {
    pub fn vertical(&self) -> Vertical {
        self.vertical.unwrap_or(match self.kind {
            Kind::Watermark => Vertical::Middle,
            Kind::Header => Vertical::Top,
            _ => Vertical::Bottom,
        })
    }

    pub fn horizontal(&self) -> Horizontal {
        self.horizontal.unwrap_or(match self.kind {
            Kind::Bates => Horizontal::End,
            _ => Horizontal::Center,
        })
    }

    pub fn layer(&self) -> Layer {
        self.layer.unwrap_or(Layer::Front)
    }

    pub fn size(&self) -> f64 {
        self.size.unwrap_or(match self.kind {
            Kind::Watermark => 60.0,
            _ => 10.0,
        })
    }

    pub fn opacity(&self) -> f64 {
        self.opacity.unwrap_or(match self.kind {
            Kind::Watermark => 0.3,
            _ => 1.0,
        })
    }

    pub fn color(&self) -> [f64; 3] {
        self.color.unwrap_or(match self.kind {
            Kind::Watermark => [0.75, 0.1, 0.1],
            _ => [0.0, 0.0, 0.0],
        })
    }

    pub fn margin(&self) -> f64 {
        self.margin.unwrap_or(28.0)
    }

    pub fn scale(&self) -> f64 {
        self.scale.unwrap_or(0.5)
    }

    /// The single text template (not header/footer).
    pub fn template(&self) -> String {
        match &self.text {
            Some(t) => t.clone(),
            None => match self.kind {
                Kind::PageNumber => "{page}".into(),
                Kind::Bates => "{bates}".into(),
                _ => String::new(),
            },
        }
    }

    /// Texts to draw with their horizontal slot.
    pub fn items(&self) -> Vec<(Horizontal, String)> {
        match (self.kind, &self.slots) {
            (Kind::Header | Kind::Footer, Some(s)) => [
                (Horizontal::Start, &s.start),
                (Horizontal::Center, &s.center),
                (Horizontal::End, &s.end),
            ]
            .into_iter()
            .filter(|(_, t)| !t.trim().is_empty())
            .map(|(h, t)| (h, t.clone()))
            .collect(),
            _ if self.picture => Vec::new(),
            _ => {
                let t = self.template();
                if t.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![(self.horizontal(), t)]
                }
            }
        }
    }

    /// `/Subtype` of the pagination artifact.
    pub fn artifact_subtype(&self) -> &'static str {
        match self.kind {
            Kind::Watermark => "Watermark",
            Kind::Header => "Header",
            Kind::Footer => "Footer",
            Kind::PageNumber | Kind::Bates => match self.vertical() {
                Vertical::Top => "Header",
                Vertical::Middle => "Watermark",
                Vertical::Bottom => "Footer",
            },
        }
    }

    /// Reject values that cannot be drawn.
    pub fn validate(&self) -> Result<()> {
        let bad = |m: &str| Err(MarkError::Params(m.into()));
        if let Some(p) = &self.pages {
            if p.len() > MAX_PAGES {
                return bad("too many pages");
            }
        }
        let texts: Vec<&str> = match &self.slots {
            Some(s) => vec![&s.start, &s.center, &s.end],
            None => vec![],
        };
        for t in texts.into_iter().chain(self.text.as_deref()) {
            if t.chars().count() > MAX_TEMPLATE_CHARS {
                return bad("text too long");
            }
        }
        if self.file_name.chars().count() > 512 {
            return bad("file name too long");
        }
        if !finite_in(self.size(), 1.0, 500.0) {
            return bad("size must be between 1 and 500 points");
        }
        if !finite_in(self.opacity(), 0.0, 1.0) {
            return bad("opacity must be between 0 and 1");
        }
        if !self.color().iter().all(|c| finite_in(*c, 0.0, 1.0)) {
            return bad("colour components must be between 0 and 1");
        }
        if !finite_in(self.rotation, -3600.0, 3600.0) {
            return bad("rotation out of range");
        }
        if !finite_in(self.offset_x, -20_000.0, 20_000.0)
            || !finite_in(self.offset_y, -20_000.0, 20_000.0)
        {
            return bad("offset out of range");
        }
        if !finite_in(self.margin(), 0.0, 2_000.0) {
            return bad("margin out of range");
        }
        if !finite_in(self.scale(), 0.01, 4.0) {
            return bad("scale must be between 0.01 and 4");
        }
        if self.picture && self.kind != Kind::Watermark {
            return bad("only watermarks can be pictures");
        }
        if let Some(b) = &self.bates {
            if b.prefix.chars().count() > 200 || b.suffix.chars().count() > 200 {
                return bad("Bates prefix/suffix too long");
            }
        }
        if !self.picture && self.items().is_empty() {
            return bad("the mark has no text");
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_per_kind_and_validation() {
        let m: MarkSpec = serde_json::from_value(json!({ "kind": "pageNumber" })).unwrap();
        assert_eq!(m.items(), vec![(Horizontal::Center, "{page}".to_string())]);
        assert_eq!(m.artifact_subtype(), "Footer");
        m.validate().unwrap();
        let w: MarkSpec =
            serde_json::from_value(json!({ "kind": "watermark", "text": "سري" })).unwrap();
        assert_eq!(w.vertical(), Vertical::Middle);
        assert_eq!(w.artifact_subtype(), "Watermark");
        assert!((w.opacity() - 0.3).abs() < 1e-9);
        let bad: MarkSpec =
            serde_json::from_value(json!({ "kind": "watermark", "text": "x", "opacity": 2 }))
                .unwrap();
        assert!(bad.validate().is_err());
        let empty: MarkSpec = serde_json::from_value(json!({ "kind": "header" })).unwrap();
        assert!(empty.validate().is_err());
        assert!(serde_json::from_value::<MarkSpec>(json!({ "kind": "x" })).is_err());
        assert!(
            serde_json::from_value::<MarkSpec>(json!({ "kind": "footer", "nope": 1 })).is_err()
        );
        let nan = MarkSpec {
            size: Some(f64::NAN),
            ..w.clone()
        };
        assert!(nan.validate().is_err());
    }
}
