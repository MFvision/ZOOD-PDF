//! "GlyphLessFont": a tiny TrueType font with two empty glyphs (no ink), used for invisible OCR text.
//!
//! The same idea as Tesseract's PDF renderer: a Type0/CIDFontType2 font with `Identity-H`, every
//! CID equal to a UTF-16 code unit, a CIDToGIDMap sending every CID to glyph 1 (an empty glyph that
//! advances 500/1000 em), and an identity ToUnicode CMap. The font is generated here (not copied
//! from Tesseract) so it carries no third-party bytes.

/// Units per em of the generated font.
pub const UNITS_PER_EM: u16 = 1000;
/// Advance width of glyph 1, in font units (the text layer scales words with `Tz`).
pub const ADVANCE: u16 = 500;
/// Ascent / descent in font units (glyph box of a text-layer character).
pub const ASCENT: i16 = 800;
pub const DESCENT: i16 = -200;

fn be16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_be_bytes());
}
fn be16i(v: &mut Vec<u8>, x: i16) {
    v.extend_from_slice(&x.to_be_bytes());
}
fn be32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_be_bytes());
}

fn checksum(data: &[u8]) -> u32 {
    data.chunks(4).fold(0u32, |acc, c| {
        let mut b = [0u8; 4];
        for (dst, src) in b.iter_mut().zip(c) {
            *dst = *src;
        }
        acc.wrapping_add(u32::from_be_bytes(b))
    })
}

fn head() -> Vec<u8> {
    let mut v = Vec::with_capacity(54);
    be32(&mut v, 0x0001_0000); // version
    be32(&mut v, 0x0001_0000); // fontRevision
    be32(&mut v, 0); // checkSumAdjustment (patched later)
    be32(&mut v, 0x5F0F_3CF5); // magicNumber
    be16(&mut v, 0x000B); // flags: baseline at y=0, lsb at x=0, integer ppem
    be16(&mut v, UNITS_PER_EM);
    v.extend_from_slice(&[0u8; 16]); // created, modified
    be16i(&mut v, 0); // xMin
    be16i(&mut v, DESCENT); // yMin
    be16i(&mut v, ADVANCE as i16); // xMax
    be16i(&mut v, ASCENT); // yMax
    be16(&mut v, 0); // macStyle
    be16(&mut v, 8); // lowestRecPPEM
    be16i(&mut v, 2); // fontDirectionHint
    be16i(&mut v, 0); // indexToLocFormat: short
    be16i(&mut v, 0); // glyphDataFormat
    v
}

fn hhea() -> Vec<u8> {
    let mut v = Vec::with_capacity(36);
    be32(&mut v, 0x0001_0000);
    be16i(&mut v, ASCENT);
    be16i(&mut v, DESCENT);
    be16i(&mut v, 0); // lineGap
    be16(&mut v, ADVANCE); // advanceWidthMax
    be16i(&mut v, 0); // minLeftSideBearing
    be16i(&mut v, 0); // minRightSideBearing
    be16i(&mut v, 0); // xMaxExtent
    be16i(&mut v, 1); // caretSlopeRise
    be16i(&mut v, 0); // caretSlopeRun
    be16i(&mut v, 0); // caretOffset
    v.extend_from_slice(&[0u8; 8]); // reserved
    be16i(&mut v, 0); // metricDataFormat
    be16(&mut v, 2); // numberOfHMetrics
    v
}

fn maxp() -> Vec<u8> {
    let mut v = Vec::with_capacity(32);
    be32(&mut v, 0x0001_0000);
    be16(&mut v, 2); // numGlyphs
    for x in [0u16, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0] {
        be16(&mut v, x);
    }
    v
}

fn hmtx() -> Vec<u8> {
    let mut v = Vec::new();
    for _ in 0..2 {
        be16(&mut v, ADVANCE);
        be16i(&mut v, 0);
    }
    v
}

fn loca() -> Vec<u8> {
    // Short offsets: glyph 0 and glyph 1 are both empty (no outline = no ink).
    vec![0u8; 6]
}

fn cmap() -> Vec<u8> {
    let mut v = Vec::new();
    be16(&mut v, 0); // version
    be16(&mut v, 1); // numTables
    be16(&mut v, 3); // platform: Windows
    be16(&mut v, 1); // encoding: Unicode BMP
    be32(&mut v, 12); // offset
                      // format 4 with the mandatory final 0xFFFF segment only
    be16(&mut v, 4);
    be16(&mut v, 24); // length
    be16(&mut v, 0); // language
    be16(&mut v, 2); // segCountX2
    be16(&mut v, 2); // searchRange
    be16(&mut v, 0); // entrySelector
    be16(&mut v, 0); // rangeShift
    be16(&mut v, 0xFFFF); // endCode
    be16(&mut v, 0); // reservedPad
    be16(&mut v, 0xFFFF); // startCode
    be16(&mut v, 1); // idDelta
    be16(&mut v, 0); // idRangeOffset
    v
}

fn post() -> Vec<u8> {
    let mut v = Vec::with_capacity(32);
    be32(&mut v, 0x0003_0000);
    be32(&mut v, 0); // italicAngle
    be16i(&mut v, -100); // underlinePosition
    be16i(&mut v, 50); // underlineThickness
    be32(&mut v, 1); // isFixedPitch
    v.extend_from_slice(&[0u8; 16]);
    v
}

fn name() -> Vec<u8> {
    // Format 0 with one record: family name "GlyphLessFont" (Windows, Unicode BMP, en-US).
    let family: Vec<u8> = "GlyphLessFont"
        .encode_utf16()
        .flat_map(|u| u.to_be_bytes())
        .collect();
    let mut v = Vec::new();
    be16(&mut v, 0); // format
    be16(&mut v, 1); // count
    be16(&mut v, 6 + 12); // stringOffset
    be16(&mut v, 3); // platformID
    be16(&mut v, 1); // encodingID
    be16(&mut v, 0x0409); // languageID
    be16(&mut v, 1); // nameID: family
    be16(&mut v, family.len() as u16);
    be16(&mut v, 0); // offset
    v.extend_from_slice(&family);
    v
}

/// The GlyphLessFont TrueType file (a few hundred bytes).
pub fn glyphless_font() -> Vec<u8> {
    // glyf must exist; both glyphs are empty, so it only holds padding.
    let tables: [(&[u8; 4], Vec<u8>); 9] = [
        (b"cmap", cmap()),
        (b"glyf", vec![0u8; 4]),
        (b"head", head()),
        (b"hhea", hhea()),
        (b"hmtx", hmtx()),
        (b"loca", loca()),
        (b"maxp", maxp()),
        (b"name", name()),
        (b"post", post()),
    ];
    let n = tables.len() as u16;
    let mut pow = 1u16;
    let mut log = 0u16;
    while pow * 2 <= n {
        pow *= 2;
        log += 1;
    }
    let mut out = Vec::new();
    be32(&mut out, 0x0001_0000);
    be16(&mut out, n);
    be16(&mut out, pow * 16);
    be16(&mut out, log);
    be16(&mut out, n * 16 - pow * 16);
    let mut offset = 12 + 16 * u32::from(n);
    let mut body = Vec::new();
    let mut head_at = 0usize;
    for (tag, data) in &tables {
        out.extend_from_slice(*tag);
        be32(&mut out, checksum(data));
        be32(&mut out, offset);
        be32(&mut out, data.len() as u32);
        if *tag == b"head" {
            head_at = 12 + 16 * usize::from(n) + body.len();
        }
        body.extend_from_slice(data);
        while body.len() % 4 != 0 {
            body.push(0);
        }
        offset = 12 + 16 * u32::from(n) + body.len() as u32;
    }
    out.extend_from_slice(&body);
    let adjust = 0xB1B0_AFBAu32.wrapping_sub(checksum(&out));
    if let Some(slot) = out.get_mut(head_at + 8..head_at + 12) {
        slot.copy_from_slice(&adjust.to_be_bytes());
    }
    out
}
