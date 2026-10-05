//! What a font file says of itself, read without loading it whole: its
//! family, weight and slant, whether its licence lets it be embedded, and —
//! for a collection (`.ttc`) — one face of it as a file of its own.
//!
//! A host that looks for the font a paragraph was set in (among the fonts
//! installed on the device, or in a file it has just downloaded) asks here
//! before handing any bytes to the shaper. Every file is taken for hostile:
//! counts and lengths are bounded, offsets are checked, and nothing here
//! panics on bad input.
use std::io::{Read, Seek, SeekFrom};

/// Faces read from one collection at most.
pub const MAX_FACES: usize = 64;
/// Tables one face may list.
const MAX_TABLES: usize = 128;
/// A `name` table is read up to this many bytes.
const MAX_NAME_TABLE: usize = 1 << 20;
/// Name records looked at.
const MAX_NAME_RECORDS: usize = 4096;
/// A face written out as a file of its own is at most this large.
pub const MAX_FACE_BYTES: usize = 32 << 20;

/// One face of a font file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaceFacts {
    /// Its place in the file: 0 for a plain font, the face's number in a
    /// collection.
    pub index: usize,
    /// The names it goes by as a family: the typographic family (name 16)
    /// and the legacy one (name 1), which for a face such as Montserrat
    /// SemiBold reads "Montserrat SemiBold".
    pub families: Vec<String>,
    /// 100–900 (`OS/2.usWeightClass`, to the nearest hundred).
    pub weight: u16,
    pub italic: bool,
    /// Whether its licence bits (`OS/2.fsType`) allow embedding a subset:
    /// not "restricted", not "bitmaps only", not "no subsetting".
    pub embeddable: bool,
    /// TrueType outlines (`glyf`): the only kind the embedder writes.
    pub truetype: bool,
    /// A variable font: one file, many weights, of which only the default
    /// is drawn.
    pub variable: bool,
}

#[derive(Debug, Clone, Copy)]
struct Table {
    tag: [u8; 4],
    checksum: u32,
    offset: u64,
    length: u64,
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
        *b.get(at + 2)?,
        *b.get(at + 3)?,
    ]))
}

fn read_at<R: Read + Seek>(file: &mut R, offset: u64, len: usize) -> Option<Vec<u8>> {
    // Never a buffer larger than a face may be, whatever a length claims.
    if len > MAX_FACE_BYTES {
        return None;
    }
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut out = vec![0u8; len];
    file.read_exact(&mut out).ok()?;
    Some(out)
}

/// Where each face of the file starts: one offset for a plain font, the
/// collection's list for a `.ttc`. `None` for anything that is not a font.
fn face_offsets<R: Read + Seek>(file: &mut R) -> Option<Vec<u64>> {
    let head = read_at(file, 0, 12)?;
    match &head[..4] {
        b"ttcf" => {
            let count = (be32(&head, 8)? as usize).min(MAX_FACES);
            let list = read_at(file, 12, count * 4)?;
            Some(
                (0..count)
                    .filter_map(|i| be32(&list, i * 4))
                    .map(u64::from)
                    .collect(),
            )
        }
        [0, 1, 0, 0] | b"OTTO" | b"true" => Some(vec![0]),
        _ => None,
    }
}

/// The table directory of the face that starts at `offset`.
fn tables<R: Read + Seek>(file: &mut R, offset: u64) -> Option<Vec<Table>> {
    let head = read_at(file, offset, 12)?;
    if !matches!(&head[..4], [0, 1, 0, 0] | b"OTTO" | b"true") {
        return None;
    }
    let count = be16(&head, 4)? as usize;
    if count == 0 || count > MAX_TABLES {
        return None;
    }
    let records = read_at(file, offset + 12, count * 16)?;
    (0..count)
        .map(|i| {
            let at = i * 16;
            Some(Table {
                tag: [
                    *records.get(at)?,
                    *records.get(at + 1)?,
                    *records.get(at + 2)?,
                    *records.get(at + 3)?,
                ],
                checksum: be32(&records, at + 4)?,
                offset: be32(&records, at + 8)? as u64,
                length: be32(&records, at + 12)? as u64,
            })
        })
        .collect()
}

/// A name record's text: UTF-16 for the Windows and Unicode platforms,
/// byte for byte for the Macintosh's (its Roman, ASCII in practice).
fn decode_name(platform: u16, bytes: &[u8]) -> String {
    if platform == 1 {
        bytes
            .iter()
            .map(|b| if b.is_ascii() { *b as char } else { '?' })
            .collect()
    } else {
        let units: Vec<u16> = bytes
            .chunks(2)
            .filter_map(|p| Some(u16::from_be_bytes([*p.first()?, *p.get(1)?])))
            .collect();
        String::from_utf16_lossy(&units)
    }
}

/// The family names in a `name` table: name 16 then name 1, each in
/// English where the font says which is English, without repeats.
fn family_names(name: &[u8]) -> Vec<String> {
    let count = (be16(name, 2).unwrap_or(0) as usize).min(MAX_NAME_RECORDS);
    let strings = be16(name, 4).unwrap_or(0) as usize;
    let mut found: Vec<(u16, u8, String)> = vec![];
    for i in 0..count {
        let at = 6 + i * 12;
        let (Some(platform), Some(language), Some(id), Some(length), Some(offset)) = (
            be16(name, at),
            be16(name, at + 4),
            be16(name, at + 6),
            be16(name, at + 8),
            be16(name, at + 10),
        ) else {
            break;
        };
        if id != 1 && id != 16 {
            continue;
        }
        let start = strings + offset as usize;
        let Some(bytes) = name.get(start..start + length as usize) else {
            continue;
        };
        let text = decode_name(platform, &bytes[..bytes.len().min(512)]);
        let text = text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        // Windows' US English first, then the Macintosh's English, then
        // whatever else the font carries.
        let rank = match (platform, language) {
            (3, 0x0409) => 0,
            (1, 0) => 1,
            (0, _) => 2,
            _ => 3,
        };
        found.push((id, rank, text));
    }
    // Name 16 before name 1; the best language of each first.
    found.sort_by_key(|(id, rank, _)| (std::cmp::Reverse(*id), *rank));
    let mut out: Vec<String> = vec![];
    for (_, _, text) in found {
        if !out.contains(&text) && out.len() < 8 {
            out.push(text);
        }
    }
    out
}

fn face_facts<R: Read + Seek>(file: &mut R, index: usize, offset: u64) -> Option<FaceFacts> {
    let tables = tables(file, offset)?;
    let find = |tag: &[u8; 4]| tables.iter().find(|t| &t.tag == tag).copied();
    let name = find(b"name")?;
    let name = read_at(
        file,
        name.offset,
        (name.length as usize).min(MAX_NAME_TABLE),
    )?;
    let families = family_names(&name);
    if families.is_empty() {
        return None;
    }
    // `OS/2`: weight class at 4, fsType at 8, fsSelection at 62.
    let os2 = find(b"OS/2").and_then(|t| read_at(file, t.offset, (t.length as usize).min(96)));
    let os2 = os2.as_deref().unwrap_or(&[]);
    let weight = be16(os2, 4)
        .filter(|w| (1..=1000).contains(w))
        .unwrap_or(400);
    let fs_type = be16(os2, 8).unwrap_or(0);
    let selection = be16(os2, 62).unwrap_or(0);
    // `head.macStyle` at 44 says italic too, for a font with no `OS/2`.
    let mac_style = find(b"head")
        .and_then(|t| read_at(file, t.offset + 44, 2))
        .and_then(|b| be16(&b, 0))
        .unwrap_or(0);
    Some(FaceFacts {
        index,
        families,
        weight: ((weight as f32 / 100.0).round() as u16).clamp(1, 9) * 100,
        italic: selection & 0x0001 != 0 || selection & 0x0200 != 0 || mac_style & 0x0002 != 0,
        // Bit 1: restricted licence. Bit 8: no subsetting. Bit 9: bitmaps only.
        embeddable: fs_type & (0x0002 | 0x0100 | 0x0200) == 0,
        truetype: find(b"glyf").is_some(),
        variable: find(b"fvar").is_some(),
    })
}

/// Every face of a font file, read by seeking: a few kilobytes of a file
/// that may be a hundred megabytes. Empty for anything that is not a font.
pub fn faces<R: Read + Seek>(file: &mut R) -> Vec<FaceFacts> {
    let Some(offsets) = face_offsets(file) else {
        return vec![];
    };
    offsets
        .into_iter()
        .enumerate()
        .filter_map(|(index, offset)| face_facts(file, index, offset))
        .collect()
}

/// Face `index` of a font file as a font file of its own: a collection's
/// face with only its own tables, a plain font as it is. `None` when there
/// is no such face or it is larger than [`MAX_FACE_BYTES`].
pub fn extract_face<R: Read + Seek>(file: &mut R, index: usize) -> Option<Vec<u8>> {
    let offsets = face_offsets(file)?;
    let offset = *offsets.get(index)?;
    let mut tables = tables(file, offset)?;
    let total: u64 = tables.iter().map(|t| (t.length + 3) & !3).sum();
    let directory = 12 + tables.len() * 16;
    if total as usize > MAX_FACE_BYTES.saturating_sub(directory) {
        return None;
    }
    let version = read_at(file, offset, 4)?;
    // The directory is sorted by tag, as the format asks.
    tables.sort_by_key(|t| t.tag);
    let count = tables.len() as u16;
    let entry_selector = 15 - count.leading_zeros() as u16;
    let search_range = (1u16 << entry_selector) * 16;
    let mut out = Vec::with_capacity(directory + total as usize);
    out.extend_from_slice(&version);
    out.extend_from_slice(&count.to_be_bytes());
    out.extend_from_slice(&search_range.to_be_bytes());
    out.extend_from_slice(&entry_selector.to_be_bytes());
    out.extend_from_slice(&(count * 16 - search_range).to_be_bytes());
    let mut at = directory as u32;
    for table in &tables {
        out.extend_from_slice(&table.tag);
        out.extend_from_slice(&table.checksum.to_be_bytes());
        out.extend_from_slice(&at.to_be_bytes());
        out.extend_from_slice(&(table.length as u32).to_be_bytes());
        at += ((table.length + 3) & !3) as u32;
    }
    for table in &tables {
        let data = read_at(file, table.offset, table.length as usize)?;
        out.extend_from_slice(&data);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    Some(out)
}

/// A family's name as two files' spellings of it compare: small letters and
/// digits only, so `Times New Roman`, `TimesNewRoman` and `times-new-roman`
/// are one family.
pub fn family_key(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .take(96)
        .collect()
}

/// The face of `faces` that best stands for a family at a weight and slant:
/// the same family (by [`family_key`], under either of its names), the same
/// slant, TrueType outlines, a licence that allows embedding, and the
/// nearest weight — no more than `tolerance` away. A variable font counts
/// at its default weight only, which is the one that would be drawn.
pub fn best_face<'a>(
    faces: impl IntoIterator<Item = &'a FaceFacts>,
    family: &str,
    weight: u16,
    italic: bool,
    tolerance: u16,
) -> Option<&'a FaceFacts> {
    let wanted = family_key(family);
    if wanted.is_empty() {
        return None;
    }
    faces
        .into_iter()
        .filter(|f| f.embeddable && f.truetype && f.italic == italic)
        .filter(|f| f.families.iter().any(|name| family_key(name) == wanted))
        .filter(|f| f.weight.abs_diff(weight) <= tolerance)
        // The nearest weight; of two as near, the typographic family (the
        // first name) before a legacy one, then the heavier.
        .min_by_key(|f| {
            (
                f.weight.abs_diff(weight),
                f.families.first().map(|n| family_key(n)) != Some(wanted.clone()),
                std::cmp::Reverse(f.weight),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
    const AMIRI_BOLD: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Bold.ttf");
    const INTER: &[u8] = include_bytes!("../../../../tests/fonts/static/Inter-Regular-static.ttf");
    const CAIRO_VARIABLE: &[u8] = include_bytes!("../../../../tests/fonts/Cairo-Variable.ttf");

    /// A collection of the given fonts, as a `.ttc` lays them out.
    fn collection(fonts: &[&[u8]]) -> Vec<u8> {
        let mut out = b"ttcf".to_vec();
        out.extend_from_slice(&[0, 1, 0, 0]);
        out.extend_from_slice(&(fonts.len() as u32).to_be_bytes());
        let mut base = 12 + fonts.len() * 4;
        for font in fonts {
            out.extend_from_slice(&(base as u32).to_be_bytes());
            base += font.len();
        }
        let mut base = 12 + fonts.len() * 4;
        for font in fonts {
            // Table offsets are from the start of the file: moved with it.
            let mut moved = font.to_vec();
            let count = be16(font, 4).unwrap() as usize;
            for i in 0..count {
                let at = 12 + i * 16 + 8;
                let offset = be32(font, at).unwrap() + base as u32;
                moved[at..at + 4].copy_from_slice(&offset.to_be_bytes());
            }
            out.extend_from_slice(&moved);
            base += font.len();
        }
        out
    }

    #[test]
    fn a_font_says_its_family_weight_and_slant() {
        let found = faces(&mut Cursor::new(AMIRI));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].families, ["Amiri"]);
        assert_eq!((found[0].weight, found[0].italic), (400, false));
        assert!(found[0].embeddable && found[0].truetype && !found[0].variable);
        let bold = faces(&mut Cursor::new(AMIRI_BOLD));
        assert_eq!(
            (bold[0].families[0].as_str(), bold[0].weight),
            ("Amiri", 700)
        );
        let cairo = faces(&mut Cursor::new(CAIRO_VARIABLE));
        assert!(cairo[0].variable);
        assert_eq!(cairo[0].families[0], "Cairo");
    }

    #[test]
    fn a_collection_gives_up_one_face_as_a_font_of_its_own() {
        let ttc = collection(&[AMIRI, INTER, AMIRI_BOLD]);
        let found = faces(&mut Cursor::new(&ttc));
        assert_eq!(
            found
                .iter()
                .map(|f| (f.index, f.families[0].as_str(), f.weight))
                .collect::<Vec<_>>(),
            [(0, "Amiri", 400), (1, "Inter", 400), (2, "Amiri", 700)]
        );
        let inter = extract_face(&mut Cursor::new(&ttc), 1).unwrap();
        // It stands alone: the shaper reads it and it draws Latin, as the
        // file it came from does.
        let shaper = crate::Shaper::new(&inter).unwrap();
        assert!(shaper.covers("Meeting Intelligence"));
        let whole = crate::Shaper::new(INTER).unwrap();
        assert_eq!(
            shaper.shape_line("Meeting"),
            whole.shape_line("Meeting"),
            "the same glyphs at the same advances"
        );
        assert_eq!(faces(&mut Cursor::new(&inter))[0].families[0], "Inter");
        // A plain font is given back whole, table for table.
        let plain = extract_face(&mut Cursor::new(AMIRI), 0).unwrap();
        assert!(crate::Shaper::new(&plain).unwrap().covers("نص عربي"));
        assert_eq!(extract_face(&mut Cursor::new(&ttc), 3), None);
        assert_eq!(extract_face(&mut Cursor::new(AMIRI), 1), None);
    }

    #[test]
    fn the_best_face_is_the_same_family_slant_and_nearest_weight() {
        let face = |family: &str, weight: u16, italic: bool| FaceFacts {
            index: 0,
            families: vec![family.to_string()],
            weight,
            italic,
            embeddable: true,
            truetype: true,
            variable: false,
        };
        let installed = [
            face("Montserrat", 400, false),
            face("Montserrat", 700, false),
            face("Montserrat", 700, true),
            face("Times New Roman", 400, false),
        ];
        let pick = |family: &str, weight: u16, italic: bool| {
            best_face(&installed, family, weight, italic, 150).map(|f| (f.weight, f.italic))
        };
        assert_eq!(pick("Montserrat", 700, false), Some((700, false)));
        // SemiBold is not installed: Bold is a hundred away, Regular two.
        assert_eq!(pick("montserrat", 600, false), Some((700, false)));
        assert_eq!(pick("Montserrat", 700, true), Some((700, true)));
        // Too far, or the wrong slant, or another family: nothing.
        assert_eq!(pick("Montserrat", 900, false), None);
        assert_eq!(pick("Montserrat", 400, true), None);
        assert_eq!(pick("Lato", 400, false), None);
        assert_eq!(pick("", 400, false), None);
        // However the file spelled it.
        assert_eq!(pick("TimesNewRoman", 400, false), Some((400, false)));
        assert_eq!(pick("times-new-roman", 400, false), Some((400, false)));
    }

    #[test]
    fn a_font_that_may_not_be_embedded_is_never_the_best_face() {
        // fsType is at byte 8 of OS/2: set "restricted licence" in a copy.
        let mut restricted = AMIRI.to_vec();
        let count = be16(AMIRI, 4).unwrap() as usize;
        let os2 = (0..count)
            .map(|i| 12 + i * 16)
            .find(|at| &AMIRI[*at..*at + 4] == b"OS/2")
            .map(|at| be32(AMIRI, at + 8).unwrap() as usize)
            .unwrap();
        restricted[os2 + 8..os2 + 10].copy_from_slice(&0x0002u16.to_be_bytes());
        let found = faces(&mut Cursor::new(&restricted));
        assert!(!found[0].embeddable);
        assert_eq!(best_face(&found, "Amiri", 400, false, 150), None);
        assert!(best_face(&faces(&mut Cursor::new(AMIRI)), "Amiri", 400, false, 150).is_some());
        for bits in [0x0100u16, 0x0200] {
            restricted[os2 + 8..os2 + 10].copy_from_slice(&bits.to_be_bytes());
            assert!(!faces(&mut Cursor::new(&restricted))[0].embeddable);
        }
        // "Editable" and "preview and print" embedding are allowed.
        restricted[os2 + 8..os2 + 10].copy_from_slice(&0x0008u16.to_be_bytes());
        assert!(faces(&mut Cursor::new(&restricted))[0].embeddable);
    }

    #[test]
    fn rubbish_and_cut_files_are_no_font_and_no_panic() {
        assert!(faces(&mut Cursor::new(b"")).is_empty());
        assert!(faces(&mut Cursor::new(b"%PDF-1.7 not a font")).is_empty());
        assert!(faces(&mut Cursor::new(b"<!doctype html><title>404</title>")).is_empty());
        for cut in [4, 12, 40, 200, 1000, AMIRI.len() / 2] {
            let _ = faces(&mut Cursor::new(&AMIRI[..cut]));
            let _ = extract_face(&mut Cursor::new(&AMIRI[..cut]), 0);
        }
        // A collection that claims four thousand million faces.
        let mut hostile = b"ttcf".to_vec();
        hostile.extend_from_slice(&[0, 1, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF]);
        hostile.extend_from_slice(&[0; 64]);
        assert!(faces(&mut Cursor::new(&hostile)).is_empty());
        // Table lengths that run past the end of the file.
        let mut long = AMIRI.to_vec();
        long[12 + 12..12 + 16].copy_from_slice(&0xFFFF_FFF0u32.to_be_bytes());
        assert_eq!(extract_face(&mut Cursor::new(&long), 0), None);
        assert_eq!(family_key("Times New-Roman 3"), "timesnewroman3");
    }
}
