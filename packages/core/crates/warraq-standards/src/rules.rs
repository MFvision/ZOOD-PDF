//! The rule catalogue: 52 PDF/A rules and 4 PDF/X-4 rules (plus 10 PDF/A rules that the PDF/X-4
//! subset reuses). `docs/standards-rules.md` documents the same list; a test keeps them in sync.
//!
//! Clause numbers cite ISO 19005-1:2005 (PDF/A-1), ISO 19005-2:2011 (PDF/A-2) and ISO 19005-3:2012
//! (PDF/A-3, which keeps the PDF/A-2 numbering except for embedded files). PDF/X-4 rules cite the
//! topic of ISO 15930-7:2010 rather than a clause number (see the docs for why).

use crate::profile::bits::{A1, A2, A2U, A3, ALL_A, X4};
use crate::profile::Profile;

/// Severity of a finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    /// Violates a "shall" requirement: the file does not conform.
    Error,
    /// Suspicious or stale structure that readers tolerate; does not block conformance.
    Warning,
}

impl Severity {
    /// `error` / `warning`.
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

/// How much of a rule the converter can repair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fix {
    /// Always repaired by the converter.
    Yes,
    /// Some findings are repaired (each finding carries its own flag).
    Partly,
    /// Never repaired automatically (the finding explains why).
    No,
}

impl Fix {
    /// `yes` / `partly` / `no`.
    pub fn as_str(self) -> &'static str {
        match self {
            Fix::Yes => "yes",
            Fix::Partly => "partly",
            Fix::No => "no",
        }
    }
}

/// One rule.
#[derive(Debug, Clone, Copy)]
pub struct Rule {
    /// Stable id (`font-embedded`).
    pub id: &'static str,
    /// Area for grouping in docs (`File structure`, `Fonts`, …).
    pub area: &'static str,
    /// Profiles the rule applies to (bit mask of [`crate::profile::bits`]).
    pub profiles: u8,
    /// ISO 19005-1 clause ("" = not applicable).
    pub a1: &'static str,
    /// ISO 19005-2 clause ("" = not applicable).
    pub a2: &'static str,
    /// ISO 19005-3 clause when it differs from `a2`.
    pub a3: &'static str,
    /// ISO 15930-7 topic for the PDF/X-4 subset ("" = not applicable).
    pub x4: &'static str,
    /// Severity of its findings.
    pub severity: Severity,
    /// What the converter repairs.
    pub fix: Fix,
    /// One-line English summary (the UI localises by id).
    pub summary: &'static str,
}

impl Rule {
    /// Whether the rule applies to `p`.
    pub fn applies(&self, p: Profile) -> bool {
        self.profiles & p.bit() != 0
    }

    /// The clause cited for `p` (without the standard's name).
    pub fn clause(&self, p: Profile) -> &'static str {
        match p {
            Profile::A1b => self.a1,
            Profile::A2b | Profile::A2u => self.a2,
            Profile::A3b => {
                if self.a3.is_empty() {
                    self.a2
                } else {
                    self.a3
                }
            }
            Profile::X4 => self.x4,
        }
    }
}

#[allow(clippy::too_many_arguments)]
const fn r(
    id: &'static str,
    area: &'static str,
    profiles: u8,
    a1: &'static str,
    a2: &'static str,
    x4: &'static str,
    fix: Fix,
    summary: &'static str,
) -> Rule {
    Rule {
        id,
        area,
        profiles,
        a1,
        a2,
        a3: "",
        x4,
        severity: Severity::Error,
        fix,
        summary,
    }
}

const FS: &str = "File structure";
const MD: &str = "Metadata";
const CO: &str = "Colour";
const TR: &str = "Transparency";
const XO: &str = "Images, XObjects and content";
const FO: &str = "Fonts";
const AN: &str = "Annotations";
const AC: &str = "Actions";
const FM: &str = "Forms";
const EF: &str = "Embedded files";
const PX: &str = "PDF/X-4";

/// Number of PDF/A rules (SPEC: "own 52-rule validator").
pub const PDFA_RULE_COUNT: usize = 52;

/// Every rule: the first 52 are the PDF/A rules, the last 4 are PDF/X-4 only.
pub static RULES: [Rule; 56] = [
    // ---- File structure (17)
    r("file-header", FS, ALL_A, "6.1.2", "6.1.2", "", Fix::Yes,
      "The file starts at byte 0 with %PDF-1.n"),
    r("binary-comment", FS, ALL_A, "6.1.2", "6.1.2", "", Fix::Yes,
      "The header is followed by a comment line with at least four bytes above 127"),
    r("trailer-id", FS, ALL_A | X4, "6.1.3", "6.1.3", "file identifier", Fix::Yes,
      "The trailer has a file identifier (/ID)"),
    r("no-encryption", FS, ALL_A | X4, "6.1.3", "6.1.3", "encryption", Fix::Yes,
      "The file is not encrypted (no /Encrypt in the trailer)"),
    r("eof-marker", FS, ALL_A, "6.1.3", "6.1.3", "", Fix::Yes,
      "Nothing but one end-of-line marker follows the last %%EOF"),
    r("xref-syntax", FS, ALL_A, "6.1.4", "6.1.4", "", Fix::Yes,
      "Cross-reference tables are well formed (PDF/A-1: classic tables, no xref/object streams)"),
    Rule { severity: Severity::Warning, ..r("linearization", FS, ALL_A, "6.1.3", "6.1.3", "", Fix::Yes,
      "A linearization dictionary still describes the file (its /L equals the file length)") },
    r("hex-strings", FS, ALL_A, "6.1.6", "6.1.6", "", Fix::Yes,
      "Hexadecimal strings have an even number of hexadecimal digits and nothing else"),
    r("stream-length", FS, ALL_A, "6.1.7", "6.1.7.1", "", Fix::Yes,
      "Every stream's /Length equals the number of bytes between stream and endstream"),
    r("stream-keywords", FS, ALL_A, "6.1.7", "6.1.7.1", "", Fix::Yes,
      "stream is followed by CRLF or LF, endstream is preceded by an end-of-line marker"),
    r("external-streams", FS, ALL_A | X4, "6.1.7", "6.1.7.1", "external content", Fix::No,
      "No stream takes its data from an external file (/F, /FFilter, /FDecodeParms)"),
    r("stream-filters", FS, ALL_A, "6.1.10", "6.1.7.2", "", Fix::Partly,
      "No LZWDecode filter (streams and inline images); Crypt filters only /Identity"),
    r("indirect-object-syntax", FS, ALL_A, "6.1.8", "6.1.9", "", Fix::Yes,
      "Object headers are 'N G obj' on their own line; endobj is preceded by an end-of-line marker"),
    r("impl-limits-objects", FS, ALL_A, "6.1.12", "6.1.13", "", Fix::No,
      "Integers, reals, strings, names, arrays, dictionaries and object counts stay within the implementation limits; names are UTF-8 (PDF/A-2/3)"),
    r("impl-limits-content", FS, ALL_A, "6.1.12", "6.1.13", "", Fix::No,
      "Graphics state nesting (q) is at most 28 deep; DeviceN has at most 8 (PDF/A-1) or 32 colourants"),
    r("page-size", FS, ALL_A, "6.1.12", "6.1.13", "", Fix::No,
      "Page boundaries are between 3 and 14,400 units"),
    r("optional-content", FS, ALL_A, "6.1.13", "6.9", "", Fix::Partly,
      "PDF/A-1: no optional content; PDF/A-2/3: every configuration has /Name, no /AS, /Order lists every group"),
    // ---- Metadata (6)
    r("metadata-present", MD, ALL_A | X4, "6.7.2", "6.6.2.1", "metadata", Fix::Yes,
      "The catalog has an XMP /Metadata stream"),
    r("xmp-well-formed", MD, ALL_A | X4, "6.7.9", "6.6.2.1", "metadata", Fix::Yes,
      "The XMP packet is well-formed XML/RDF; its header has no bytes or encoding attribute"),
    r("metadata-no-filter", MD, ALL_A, "6.7.2", "6.6.2.1", "", Fix::Yes,
      "Metadata streams are not compressed (no /Filter)"),
    r("pdfa-identification", MD, ALL_A, "6.7.11", "6.6.4", "", Fix::Yes,
      "XMP declares pdfaid:part and pdfaid:conformance matching the target"),
    r("xmp-extension-schemas", MD, ALL_A, "6.7.8", "6.6.2.3", "", Fix::Yes,
      "XMP properties outside the predefined schemas are described by a PDF/A extension schema"),
    r("info-xmp-consistency", MD, ALL_A, "6.7.3", "6.6.3", "", Fix::Yes,
      "Document information entries equal their XMP counterparts (title, author, subject, keywords, creator, producer, dates)"),
    // ---- Colour (5)
    r("output-intent", CO, ALL_A, "6.2.2", "6.2.3", "", Fix::Yes,
      "A GTS_PDFA1 output intent has a valid ICC output or monitor profile; all intents share one profile"),
    r("icc-based", CO, ALL_A, "6.2.3.2", "6.2.4.2", "", Fix::No,
      "ICCBased colour spaces embed a valid profile whose colour space matches /N (PDF/A-1: ICC version 2)"),
    r("device-colour", CO, ALL_A | X4, "6.2.3.3", "6.2.4.3", "device colour", Fix::Partly,
      "DeviceRGB/DeviceCMYK/DeviceGray are used only with a matching output intent or default colour space"),
    r("rendering-intent", CO, ALL_A, "6.2.9", "6.2.6", "", Fix::Partly,
      "Rendering intents are one of the four standard names"),
    r("extgstate-transfer", CO, ALL_A, "6.2.8", "6.2.5", "", Fix::Yes,
      "Graphics states have no transfer function (/TR, /TR2 other than /Default)"),
    // ---- Transparency (4)
    r("transparency-smask", TR, A1, "6.4", "", "", Fix::No,
      "PDF/A-1: no soft masks (graphics state /SMask other than /None, image /SMask)"),
    r("transparency-alpha", TR, A1, "6.4", "", "", Fix::No,
      "PDF/A-1: constant alpha (/CA, /ca) is 1.0 in graphics states and annotations"),
    r("blend-mode", TR, ALL_A, "6.4", "6.2.10", "", Fix::No,
      "PDF/A-1: only Normal/Compatible blend modes; PDF/A-2/3: only the standard blend modes"),
    r("transparency-group", TR, A1, "6.4", "", "", Fix::Partly,
      "PDF/A-1: no transparency groups (/Group with /S /Transparency)"),
    // ---- Images, XObjects and content (5)
    r("image-alternates", XO, ALL_A, "6.2.4", "6.2.8", "", Fix::Yes,
      "Images have no /Alternates"),
    r("image-interpolate", XO, ALL_A, "6.2.4", "6.2.8", "", Fix::Yes,
      "Images (including inline images) do not set /Interpolate true"),
    r("opi", XO, ALL_A | X4, "6.2.4", "6.2.8", "OPI", Fix::Yes,
      "Images and form XObjects have no /OPI"),
    r("postscript-reference-xobjects", XO, ALL_A | X4, "6.2.5", "6.2.9", "PostScript and reference XObjects", Fix::Partly,
      "No PostScript XObjects, no /Subtype2 /PS or /PS in forms, no reference XObjects (/Ref)"),
    r("undefined-operators", XO, ALL_A, "6.2.10", "6.2.2", "", Fix::No,
      "Content streams use only operators defined by the PDF specification"),
    // ---- Fonts (6)
    r("font-embedded", FO, ALL_A | X4, "6.3.4", "6.2.11.4.1", "fonts", Fix::Partly,
      "Every font program is embedded (the standard 14 fonts too)"),
    r("font-widths", FO, ALL_A, "6.3.6", "6.2.11.5", "", Fix::Partly,
      "/Widths agree with the advance widths in the embedded font program"),
    r("tounicode", FO, A2U, "", "6.2.11.7.2", "", Fix::Partly,
      "PDF/A-2u: every font maps its character codes to Unicode"),
    r("notdef", FO, A2 | A3, "", "6.2.11.8", "", Fix::No,
      "Text does not show the .notdef glyph"),
    r("type3-fonts", FO, ALL_A, "6.3.2", "6.2.11.2", "", Fix::No,
      "Type 3 fonts are complete (FontMatrix, CharProcs, Encoding, Widths) and their glyph procedures are streams"),
    r("cid-fonts", FO, ALL_A, "6.3.3", "6.2.11.3", "", Fix::Partly,
      "CIDFonts have CIDSystemInfo compatible with the CMap; Type 2 CIDFonts have /CIDToGIDMap"),
    // ---- Annotations (3)
    r("annot-types", AN, ALL_A, "6.5.2", "6.3.1", "", Fix::Yes,
      "Only permitted annotation types (no Sound/Movie/Screen/3D/RichMedia; PDF/A-1 also no FileAttachment)"),
    r("annot-flags", AN, ALL_A, "6.5.3", "6.3.2", "", Fix::Yes,
      "Annotations are printable and not hidden (/F: Print set; Hidden, Invisible, NoView, ToggleNoView clear)"),
    r("annot-appearance", AN, ALL_A, "6.5.3", "6.3.3", "", Fix::Partly,
      "Appearance dictionaries contain only /N; PDF/A-2/3: every annotation except Popup and Link has one"),
    // ---- Actions (3)
    r("javascript", AC, ALL_A | X4, "6.6.1", "6.5.1", "actions and JavaScript", Fix::Yes,
      "No JavaScript (JavaScript actions, the /JavaScript name tree, scripted open actions)"),
    r("forbidden-actions", AC, ALL_A, "6.6.1", "6.5.1", "", Fix::Yes,
      "No Launch, Sound, Movie, ImportData, ResetForm (PDF/A-2/3 also Hide, SetOCGState, Rendition, Trans, GoTo3DView) or non-navigation named actions"),
    r("additional-actions", AC, ALL_A, "6.6.2", "6.5.2", "", Fix::Yes,
      "No additional-actions (/AA) in widgets and fields (PDF/A-2/3 also catalog and pages)"),
    // ---- Forms (2)
    r("need-appearances", FM, ALL_A, "6.9", "6.4.1", "", Fix::Partly,
      "The interactive form does not set /NeedAppearances true"),
    r("xfa", FM, A2 | A3, "", "6.4.2", "", Fix::Partly,
      "No XFA forms (/XFA) and no /NeedsRendering"),
    // ---- Embedded files (1)
    Rule { a3: "6.8", ..r("embedded-files", EF, ALL_A, "6.1.11", "6.8", "", Fix::Partly,
      "PDF/A-1: no embedded files; PDF/A-2: embedded files are PDF/A; PDF/A-3: embedded files declare /AFRelationship, a MIME /Subtype, /F and /UF") },
    // ---- PDF/X-4 only (4)
    r("x4-version", PX, X4, "", "", "identification (GTS_PDFXVersion)", Fix::Yes,
      "XMP declares pdfxid:GTS_PDFXVersion PDF/X-4"),
    r("x4-output-intent", PX, X4, "", "", "output intent", Fix::Yes,
      "Exactly one GTS_PDFX output intent with an embedded ICC output profile and an OutputConditionIdentifier"),
    r("x4-boxes", PX, X4, "", "", "page boxes", Fix::Yes,
      "Every page has a TrimBox or an ArtBox (not both); boxes lie within the MediaBox"),
    r("x4-trapped", PX, X4, "", "", "trapping key", Fix::Yes,
      "/Trapped is True or False in the document information and XMP"),
];

/// Look a rule up by id.
pub fn rule(id: &str) -> Option<&'static Rule> {
    RULES.iter().find(|r| r.id == id)
}

/// Rules that apply to `p`.
pub fn rules_for(p: Profile) -> impl Iterator<Item = &'static Rule> {
    RULES.iter().filter(move |r| r.applies(p))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn fifty_two_pdfa_rules_with_unique_ids_and_clauses() {
        let ids: HashSet<_> = RULES.iter().map(|r| r.id).collect();
        assert_eq!(ids.len(), RULES.len());
        let pdfa: Vec<_> = RULES.iter().filter(|r| r.profiles & ALL_A != 0).collect();
        assert_eq!(pdfa.len(), PDFA_RULE_COUNT);
        for r in &RULES {
            for p in Profile::ALL {
                if r.applies(p) {
                    assert!(
                        !r.clause(p).is_empty(),
                        "{} has no clause for {:?}",
                        r.id,
                        p
                    );
                }
            }
        }
        // The PDF/X-4 subset: its 4 own rules plus 10 shared ones.
        assert_eq!(rules_for(Profile::X4).count(), 14);
    }
}
