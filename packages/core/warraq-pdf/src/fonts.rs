//! Font embedding: subset (glyphs actually used), CIDFontType2 with Identity-H,
//! widths, descriptor and a correct multi-character ToUnicode map.
use crate::{Error, Result};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use std::collections::BTreeMap;
use warraq_text::{ShapedGlyph, Shaper};

pub struct FontSubset {
    pub data: Vec<u8>,
    pub remap: subsetter::GlyphRemapper,
    pub widths: Vec<f32>,
    pub tounicode: BTreeMap<u16, String>,
}

impl FontSubset {
    /// Subset `font` (the bytes the `shaper` was built from) to the glyphs used.
    pub fn build(font: &[u8], shaper: &Shaper, glyphs: &[ShapedGlyph]) -> Result<Self> {
        let mut remap = subsetter::GlyphRemapper::new();
        let mut gids: Vec<u16> = glyphs.iter().map(|g| g.gid).collect();
        gids.sort_unstable();
        gids.dedup();
        for g in &gids {
            remap.remap(*g);
        }
        // A glyph that stands alone for its text somewhere is mapped to that
        // text; the first glyph of a longer cluster only when nothing else
        // claimed it. Its other glyphs have no text of their own, and a word
        // they are in is marked with `/ActualText` where it is shown (show.rs).
        let mut tounicode = BTreeMap::new();
        let clusters = warraq_text::clusters(glyphs);
        let (single, longer): (Vec<_>, Vec<_>) = clusters.iter().partition(|c| c.len() == 1);
        for cluster in single.into_iter().chain(longer) {
            let g = &glyphs[cluster.start];
            if !g.text.is_empty() {
                tounicode
                    .entry(remap.get(g.gid).unwrap_or(0))
                    .or_insert_with(|| g.text.clone());
            }
        }
        let data = subsetter::subset(font, 0, &remap)
            .map_err(|e| Error::Font(format!("subset: {e:?}")))?;
        let mut widths = vec![0.0; remap.num_gids() as usize];
        for g in &gids {
            widths[remap.get(*g).unwrap_or(0) as usize] = shaper.advance(*g);
        }
        Ok(Self {
            data,
            remap,
            widths,
            tounicode,
        })
    }

    /// CID (= new glyph id) for a glyph of the original font.
    pub fn cid(&self, gid: u16) -> u16 {
        self.remap.get(gid).unwrap_or(0)
    }

    pub fn tounicode_cmap(&self) -> Vec<u8> {
        let mut s = String::from("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n");
        let entries: Vec<(&u16, &String)> = self.tounicode.iter().collect();
        for chunk in entries.chunks(100) {
            s.push_str(&format!("{} beginbfchar\n", chunk.len()));
            for (g, t) in chunk {
                let u: String = t.encode_utf16().map(|x| format!("{x:04X}")).collect();
                s.push_str(&format!("<{g:04X}> <{u}>\n"));
            }
            s.push_str("endbfchar\n");
        }
        s.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
        s.into_bytes()
    }
}

/// Add a Type0/CIDFontType2 font (subset + ToUnicode) to `doc`; returns the font object id.
pub fn embed_subset_font(
    doc: &mut Document,
    shaper: &Shaper,
    subset: &FontSubset,
    base_name: &str,
) -> ObjectId {
    let m = shaper.metrics();
    let name = Object::Name(format!("WARRAQ+{base_name}").into_bytes());
    let mut ff = Stream::new(
        dictionary! { "Length1" => subset.data.len() as i64 },
        subset.data.clone(),
    );
    let _ = ff.compress();
    let ff = doc.add_object(ff);
    let desc = doc.add_object(dictionary! {
        "Type" => "FontDescriptor", "FontName" => name.clone(), "Flags" => 4,
        "FontBBox" => m.bbox.iter().map(|v| Object::Real(*v)).collect::<Vec<_>>(),
        "ItalicAngle" => 0, "Ascent" => Object::Real(m.ascent), "Descent" => Object::Real(m.descent),
        "CapHeight" => 700, "StemV" => 80, "FontFile2" => ff,
    });
    let widths: Vec<Object> = subset.widths.iter().map(|w| Object::Real(*w)).collect();
    let cid = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => name.clone(),
        "CIDSystemInfo" => dictionary! { "Registry" => Object::string_literal("Adobe"), "Ordering" => Object::string_literal("Identity"), "Supplement" => 0 },
        "FontDescriptor" => desc, "DW" => 1000, "W" => vec![Object::Integer(0), Object::Array(widths)], "CIDToGIDMap" => "Identity",
    });
    let mut tu = Stream::new(Dictionary::new(), subset.tounicode_cmap());
    let _ = tu.compress();
    let tu = doc.add_object(tu);
    doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type0", "BaseFont" => name, "Encoding" => "Identity-H",
        "DescendantFonts" => vec![Object::Reference(cid)], "ToUnicode" => tu,
    })
}
