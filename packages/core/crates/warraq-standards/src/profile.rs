//! Target profiles: PDF/A-1b, PDF/A-2b, PDF/A-2u, PDF/A-3b (ISO 19005) and PDF/X-4 (ISO 15930-7).

/// A conformance target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Profile {
    /// PDF/A-1b (ISO 19005-1:2005, level B).
    A1b,
    /// PDF/A-2b (ISO 19005-2:2011, level B).
    A2b,
    /// PDF/A-2u (ISO 19005-2:2011, level U: level B plus Unicode mapping for all text).
    A2u,
    /// PDF/A-3b (ISO 19005-3:2012, level B; any embedded file with a relationship).
    A3b,
    /// PDF/X-4 (ISO 15930-7:2010), our validation subset.
    X4,
}

/// Bit masks used by the rule catalogue.
pub mod bits {
    /// PDF/A-1b.
    pub const A1: u8 = 1;
    /// PDF/A-2b.
    pub const A2B: u8 = 2;
    /// PDF/A-2u.
    pub const A2U: u8 = 4;
    /// PDF/A-3b.
    pub const A3: u8 = 8;
    /// PDF/X-4.
    pub const X4: u8 = 16;
    /// Both PDF/A-2 levels.
    pub const A2: u8 = A2B | A2U;
    /// Every PDF/A profile.
    pub const ALL_A: u8 = A1 | A2 | A3;
}

impl Profile {
    /// Every profile, in UI order.
    pub const ALL: [Profile; 5] = [
        Profile::A1b,
        Profile::A2b,
        Profile::A2u,
        Profile::A3b,
        Profile::X4,
    ];

    /// Parse `pdfa-1b`, `PDF/A-2u`, `2b`, `pdfx-4`, `x4` … (case-insensitive).
    pub fn parse(s: &str) -> Option<Profile> {
        let k: String = s
            .to_ascii_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        let k = k.strip_prefix("pdf").unwrap_or(&k);
        match k {
            "a1b" | "1b" => Some(Profile::A1b),
            "a2b" | "2b" => Some(Profile::A2b),
            "a2u" | "2u" => Some(Profile::A2u),
            "a3b" | "3b" => Some(Profile::A3b),
            "x4" => Some(Profile::X4),
            _ => None,
        }
    }

    /// Stable id used over RPC (`pdfa-2b`).
    pub fn id(self) -> &'static str {
        match self {
            Profile::A1b => "pdfa-1b",
            Profile::A2b => "pdfa-2b",
            Profile::A2u => "pdfa-2u",
            Profile::A3b => "pdfa-3b",
            Profile::X4 => "pdfx-4",
        }
    }

    /// Human label (`PDF/A-2b`).
    pub fn label(self) -> &'static str {
        match self {
            Profile::A1b => "PDF/A-1b",
            Profile::A2b => "PDF/A-2b",
            Profile::A2u => "PDF/A-2u",
            Profile::A3b => "PDF/A-3b",
            Profile::X4 => "PDF/X-4",
        }
    }

    /// Suffix for "save as new file" names (`PDFA-2b`).
    pub fn file_suffix(self) -> &'static str {
        match self {
            Profile::A1b => "PDFA-1b",
            Profile::A2b => "PDFA-2b",
            Profile::A2u => "PDFA-2u",
            Profile::A3b => "PDFA-3b",
            Profile::X4 => "PDFX-4",
        }
    }

    /// The standard (with year) whose clauses the findings cite.
    pub fn standard(self) -> &'static str {
        match self {
            Profile::A1b => "ISO 19005-1:2005",
            Profile::A2b | Profile::A2u => "ISO 19005-2:2011",
            Profile::A3b => "ISO 19005-3:2012",
            Profile::X4 => "ISO 15930-7:2010",
        }
    }

    /// PDF/A part (1, 2, 3) or `None` for PDF/X.
    pub fn part(self) -> Option<u8> {
        match self {
            Profile::A1b => Some(1),
            Profile::A2b | Profile::A2u => Some(2),
            Profile::A3b => Some(3),
            Profile::X4 => None,
        }
    }

    /// PDF/A conformance level letter.
    pub fn conformance(self) -> Option<&'static str> {
        match self {
            Profile::A1b | Profile::A2b | Profile::A3b => Some("B"),
            Profile::A2u => Some("U"),
            Profile::X4 => None,
        }
    }

    /// Whether this is a PDF/A profile.
    pub fn is_pdfa(self) -> bool {
        self != Profile::X4
    }

    /// Bit in the rule catalogue's masks.
    pub fn bit(self) -> u8 {
        match self {
            Profile::A1b => bits::A1,
            Profile::A2b => bits::A2B,
            Profile::A2u => bits::A2U,
            Profile::A3b => bits::A3,
            Profile::X4 => bits::X4,
        }
    }

    /// PDF version written by the converter.
    pub fn output_version(self) -> &'static str {
        match self {
            Profile::A1b => "1.4",
            Profile::X4 => "1.6",
            _ => "1.7",
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_common_spellings() {
        assert_eq!(Profile::parse("PDF/A-2b"), Some(Profile::A2b));
        assert_eq!(Profile::parse("pdfa-1b"), Some(Profile::A1b));
        assert_eq!(Profile::parse("2u"), Some(Profile::A2u));
        assert_eq!(Profile::parse("pdfa-3B"), Some(Profile::A3b));
        assert_eq!(Profile::parse("PDF/X-4"), Some(Profile::X4));
        assert_eq!(Profile::parse("pdfa-4"), None);
        for p in Profile::ALL {
            assert_eq!(Profile::parse(p.id()), Some(p));
            assert_eq!(Profile::parse(p.label()), Some(p));
        }
    }
}
