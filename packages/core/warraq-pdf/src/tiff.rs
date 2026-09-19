//! TIFF pictures, every page of them, as image XObjects (Create → Images
//! to PDF). A scanner's multi-page TIFF is the common case: fax pages in
//! CCITT Group 3 or 4, and grey or colour pages in LZW, Deflate or JPEG.
//!
//! Each page is decoded — uncompressed, PackBits, LZW, Deflate, CCITT
//! (hayro-ccitt) or JPEG, in strips or tiles, chunky or planar, 1 to 16 bits,
//! black-and-white, grey, RGB, palette or CMYK — and stored without loss
//! (Flate); a bilevel page stays one bit a pixel. The file is hostile input:
//! every offset and count is checked, the chain of pages cannot loop, and
//! nothing is decoded past the size limits the other pictures have.
use hayro_ccitt::{DecodeSettings, DecoderContext, EncodingMode};
use lopdf::{dictionary, Document, Object, Stream};

use crate::picture::{Picture, PictureInfo};
use crate::{Error, Result};

const MAX_PAGES: usize = 5_000;
const MAX_SIDE: u32 = 16_384;
const MAX_PIXELS: u64 = 40_000_000;
/// Decoded bytes one page may take (CMYK at the pixel limit, 8 bits).
const MAX_DECODED: u64 = MAX_PIXELS * 4;

fn refuse(why: &str) -> Error {
    Error::Edit(format!("E_IMAGE: {why}"))
}

/// The file starts like a TIFF (not BigTIFF).
pub fn is_tiff(bytes: &[u8]) -> bool {
    bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*")
}

struct Reader<'a> {
    b: &'a [u8],
    big: bool,
}

impl Reader<'_> {
    fn u16(&self, at: usize) -> Option<u16> {
        let b = self.b.get(at..at.checked_add(2)?)?;
        Some(if self.big {
            u16::from_be_bytes([b[0], b[1]])
        } else {
            u16::from_le_bytes([b[0], b[1]])
        })
    }
    fn u32(&self, at: usize) -> Option<u32> {
        let b = self.b.get(at..at.checked_add(4)?)?;
        Some(if self.big {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        })
    }
}

/// One tag of a page's directory.
struct Entry {
    tag: u16,
    kind: u16,
    count: usize,
    /// Where its values are: in the entry itself when they fit in four bytes.
    at: usize,
}

fn kind_size(kind: u16) -> Option<usize> {
    match kind {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 | 13 => Some(4),
        5 | 10 | 12 => Some(8),
        _ => None,
    }
}

struct Ifd<'a> {
    r: &'a Reader<'a>,
    entries: Vec<Entry>,
}

impl Ifd<'_> {
    fn entry(&self, tag: u16) -> Option<&Entry> {
        self.entries.iter().find(|e| e.tag == tag)
    }

    /// The tag's values as numbers (BYTE, SHORT or LONG), at most `limit`.
    fn values(&self, tag: u16, limit: usize) -> Option<Vec<u32>> {
        let e = self.entry(tag)?;
        if e.count > limit {
            return None;
        }
        (0..e.count)
            .map(|k| match e.kind {
                1 | 7 => self.r.b.get(e.at + k).map(|v| *v as u32),
                3 => self.r.u16(e.at + 2 * k).map(u32::from),
                4 | 13 => self.r.u32(e.at + 4 * k),
                _ => None,
            })
            .collect()
    }

    fn value(&self, tag: u16) -> Option<u32> {
        self.values(tag, 1).and_then(|v| v.first().copied())
    }

    fn rational(&self, tag: u16) -> Option<f32> {
        let e = self.entry(tag)?;
        if e.kind != 5 || e.count < 1 {
            return None;
        }
        let (n, d) = (self.r.u32(e.at)?, self.r.u32(e.at + 4)?);
        (d > 0).then(|| n as f32 / d as f32)
    }

    fn bytes(&self, tag: u16) -> Option<&[u8]> {
        let e = self.entry(tag)?;
        if !matches!(e.kind, 1 | 7) {
            return None;
        }
        self.r.b.get(e.at..e.at.checked_add(e.count)?)
    }
}

/// The pages' directories, in order.
fn directories<'a>(r: &'a Reader<'a>) -> Result<Vec<Ifd<'a>>> {
    let mut out = Vec::new();
    let mut next = r.u32(4).ok_or_else(|| refuse("the TIFF has no pages"))? as usize;
    let mut seen = std::collections::HashSet::new();
    while next != 0 && out.len() < MAX_PAGES {
        if !seen.insert(next) {
            break;
        }
        let Some(count) = r.u16(next) else {
            break;
        };
        let count = (count as usize).min(4096);
        let mut entries = Vec::with_capacity(count);
        for k in 0..count {
            let at = next + 2 + 12 * k;
            let (Some(tag), Some(kind), Some(n)) = (r.u16(at), r.u16(at + 2), r.u32(at + 4)) else {
                break;
            };
            let Some(size) = kind_size(kind) else {
                continue;
            };
            let Some(total) = (n as usize).checked_mul(size) else {
                continue;
            };
            let values = if total <= 4 {
                at + 8
            } else {
                match r.u32(at + 8) {
                    Some(o) => o as usize,
                    None => continue,
                }
            };
            if values.checked_add(total).is_none_or(|end| end > r.b.len()) {
                continue;
            }
            entries.push(Entry {
                tag,
                kind,
                count: n as usize,
                at: values,
            });
        }
        let after = next + 2 + 12 * count;
        out.push(Ifd { r, entries });
        next = r.u32(after).unwrap_or(0) as usize;
    }
    if out.is_empty() {
        return Err(refuse("the TIFF has no pages"));
    }
    Ok(out)
}

/// What a page is, before it is decoded.
struct Layout {
    width: u32,
    height: u32,
    bits: u32,
    samples: u32,
    compression: u32,
    photometric: u32,
    planar: bool,
    predictor: u32,
    /// Bits of each byte in reverse order (FillOrder 2).
    reversed: bool,
    /// Strips (a tile width of the whole page) or tiles.
    tile_width: u32,
    tile_height: u32,
    chunks: Vec<(usize, usize)>,
    orientation: u8,
    dpi: Option<f32>,
}

fn layout(ifd: &Ifd) -> Result<Layout> {
    let width = ifd
        .value(256)
        .ok_or_else(|| refuse("a TIFF page has no width"))?;
    let height = ifd
        .value(257)
        .ok_or_else(|| refuse("a TIFF page has no height"))?;
    if width == 0 || height == 0 {
        return Err(refuse("the picture has no pixels"));
    }
    if width > MAX_SIDE || height > MAX_SIDE || width as u64 * height as u64 > MAX_PIXELS {
        return Err(refuse("the picture is too large"));
    }
    let samples = ifd.value(277).unwrap_or(1).clamp(1, 8);
    let bits = ifd
        .values(258, 8)
        .and_then(|v| v.first().copied())
        .unwrap_or(1);
    let compression = ifd.value(259).unwrap_or(1);
    let photometric = ifd.value(262).unwrap_or(if bits == 1 { 0 } else { 1 });
    let planar = ifd.value(284) == Some(2) && samples > 1;
    let (tile_width, tile_height, offsets, counts) = match (ifd.value(322), ifd.value(323)) {
        (Some(tw), Some(th))
            if tw > 0
                && th > 0
                && tw <= MAX_SIDE
                && th <= MAX_SIDE
                && tw as u64 * th as u64 <= MAX_PIXELS =>
        {
            (tw, th, 324, 325)
        }
        _ => {
            let rows = ifd.value(278).unwrap_or(height).clamp(1, height);
            (width, rows, 273, 279)
        }
    };
    let limit = 1 << 20;
    let offsets = ifd.values(offsets, limit).unwrap_or_default();
    let counts = ifd.values(counts, limit).unwrap_or_default();
    if offsets.is_empty() {
        return Err(refuse("a TIFF page has no picture data"));
    }
    let chunks = offsets
        .iter()
        .enumerate()
        .map(|(k, o)| {
            // A missing count (some fax writers) runs to the end of the file.
            let len = counts.get(k).copied().unwrap_or(u32::MAX) as usize;
            (*o as usize, len)
        })
        .collect();
    let dpi = ifd.rational(282).and_then(|r| {
        let dpi = match ifd.value(296).unwrap_or(2) {
            2 => r,
            3 => r * 2.54,
            _ => return None,
        };
        (dpi.is_finite() && (50.0..=2400.0).contains(&dpi)).then_some(dpi)
    });
    Ok(Layout {
        width,
        height,
        bits,
        samples,
        compression,
        photometric,
        planar,
        predictor: ifd.value(317).unwrap_or(1),
        reversed: ifd.value(266) == Some(2),
        tile_width,
        tile_height,
        chunks,
        orientation: ifd.value(274).filter(|o| (1..=8).contains(o)).unwrap_or(1) as u8,
        dpi,
    })
}

/// Size, orientation and resolution of the TIFF's first page.
pub fn tiff_info(bytes: &[u8]) -> Option<PictureInfo> {
    let r = Reader {
        b: bytes,
        big: bytes.starts_with(b"MM"),
    };
    let first = directories(&r).ok()?;
    let l = layout(first.first()?).ok()?;
    Some(PictureInfo {
        width: l.width,
        height: l.height,
        orientation: l.orientation,
        dpi: l.dpi,
    })
}

fn packbits(data: &[u8], limit: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(limit.min(data.len() * 2));
    let mut i = 0;
    while i < data.len() && out.len() < limit {
        let n = data[i] as i8;
        i += 1;
        if n >= 0 {
            let len = n as usize + 1;
            let end = (i + len).min(data.len());
            out.extend_from_slice(&data[i..end]);
            i = end;
        } else if n != -128 {
            if let Some(&b) = data.get(i) {
                out.extend(std::iter::repeat_n(b, (1 - n as isize) as usize));
            }
            i += 1;
        }
    }
    out.truncate(limit);
    out
}

/// A strip or tile's bytes, uncompressed, at most `limit` of them.
fn inflate(data: &[u8], compression: u32, limit: usize) -> Result<Vec<u8>> {
    let mut out = match compression {
        1 => data.to_vec(),
        32773 => packbits(data, limit),
        5 => {
            // In pieces, so a strip that would expand without end stops at the limit.
            let mut decoder =
                weezl::decode::Decoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8);
            let mut out = Vec::new();
            let mut buf = vec![0u8; 64 * 1024];
            let mut input = data;
            while out.len() < limit {
                let step = decoder.decode_bytes(input, &mut buf);
                input = &input[step.consumed_in..];
                out.extend_from_slice(&buf[..step.consumed_out]);
                match step.status {
                    Ok(weezl::LzwStatus::Ok) if step.consumed_in + step.consumed_out > 0 => {}
                    Ok(_) => break,
                    // A strip that ends without its end code still gave its rows.
                    Err(e) if out.is_empty() => {
                        return Err(refuse(&format!("an LZW strip could not be read: {e}")))
                    }
                    Err(_) => break,
                }
            }
            out
        }
        8 | 32946 => {
            use std::io::Read;
            let mut out = Vec::new();
            flate2::read::ZlibDecoder::new(data)
                .take(limit as u64 + 1)
                .read_to_end(&mut out)
                .map_err(|e| refuse(&format!("a Deflate strip could not be read: {e}")))?;
            out
        }
        other => {
            return Err(refuse(&format!(
                "TIFF compression {other} is not one Warraq reads"
            )))
        }
    };
    out.truncate(limit);
    Ok(out)
}

/// Bilevel rows decoded from CCITT data, one bit a pixel, 1 for white.
struct Bits {
    width: u32,
    row: Vec<u8>,
    rows: Vec<u8>,
    at: u32,
    limit: usize,
}

impl hayro_ccitt::Decoder for Bits {
    fn push_pixel(&mut self, white: bool) {
        if self.at < self.width {
            if white {
                self.row[(self.at / 8) as usize] |= 0x80 >> (self.at % 8);
            }
            self.at += 1;
        }
    }
    fn push_pixel_chunk(&mut self, white: bool, chunk_count: u32) {
        for _ in 0..chunk_count.saturating_mul(8).min(self.width) {
            self.push_pixel(white);
        }
    }
    fn next_line(&mut self) {
        if self.rows.len() < self.limit {
            self.rows.extend_from_slice(&self.row);
        }
        self.row.iter_mut().for_each(|b| *b = 0);
        self.at = 0;
    }
}

/// A strip of fax data as rows of bits, 1 for white.
fn ccitt(data: &[u8], l: &Layout, t4: u32, rows: u32) -> Result<Vec<u8>> {
    let encoding = match l.compression {
        4 => EncodingMode::Group4,
        3 if t4 & 1 == 1 => EncodingMode::Group3_2D { k: 2 },
        _ => EncodingMode::Group3_1D,
    };
    let columns = l.tile_width;
    let row_bytes = columns.div_ceil(8) as usize;
    let mut out = Bits {
        width: columns,
        row: vec![0; row_bytes],
        rows: Vec::with_capacity(row_bytes * rows as usize),
        at: 0,
        limit: row_bytes * rows as usize,
    };
    let mut ctx = DecoderContext::new(DecodeSettings {
        columns,
        rows,
        end_of_block: true,
        end_of_line: l.compression == 3,
        // Modified Huffman (compression 2) starts every row on a byte; T.4
        // does when its options say it fills.
        rows_are_byte_aligned: l.compression == 2 || (l.compression == 3 && t4 & 4 == 4),
        encoding,
        invert_black: false,
    });
    let reversed: Vec<u8>;
    let data = if l.reversed {
        reversed = data.iter().map(|b| b.reverse_bits()).collect();
        &reversed
    } else {
        data
    };
    // A damaged strip keeps the rows that were read before the damage.
    let _ = hayro_ccitt::decode(data, &mut out, &mut ctx);
    let mut rows_out = out.rows;
    rows_out.resize(row_bytes * rows as usize, 0xFF);
    Ok(rows_out)
}

/// Horizontal differencing (predictor 2) undone, in place, for one row.
fn undo_predictor(row: &mut [u8], samples: usize, bits: u32, big: bool) {
    match bits {
        8 => {
            for i in samples..row.len() {
                row[i] = row[i].wrapping_add(row[i - samples]);
            }
        }
        16 => {
            let step = samples * 2;
            let mut i = step;
            while i + 1 < row.len() {
                let read = |b: &[u8], at: usize| {
                    if big {
                        u16::from_be_bytes([b[at], b[at + 1]])
                    } else {
                        u16::from_le_bytes([b[at], b[at + 1]])
                    }
                };
                let v = read(row, i).wrapping_add(read(row, i - step));
                let bytes = if big {
                    v.to_be_bytes()
                } else {
                    v.to_le_bytes()
                };
                row[i] = bytes[0];
                row[i + 1] = bytes[1];
                i += 2;
            }
        }
        _ => {}
    }
}

/// A page's pixels: rows of `samples` samples of `bits` bits, each row
/// starting on a byte, as the TIFF stores a chunky page.
fn pixels(r: &Reader, ifd: &Ifd, l: &Layout) -> Result<Vec<u8>> {
    let planes = if l.planar { l.samples } else { 1 };
    let per_pixel = if l.planar { 1 } else { l.samples };
    let bits_per_pixel = (per_pixel * l.bits) as u64;
    let row_bytes = (l.width as u64 * bits_per_pixel).div_ceil(8);
    let tile_row_bytes = (l.tile_width as u64 * bits_per_pixel).div_ceil(8);
    let plane_bytes = row_bytes * l.height as u64;
    if plane_bytes * planes as u64 > MAX_DECODED {
        return Err(refuse("the picture is too large"));
    }
    let across = l.width.div_ceil(l.tile_width) as usize;
    let down = l.height.div_ceil(l.tile_height) as usize;
    let per_plane = across * down;
    let mut out = vec![0u8; (plane_bytes * planes as u64) as usize];
    let t4 = ifd.value(292).unwrap_or(0);
    let tables = ifd.bytes(347);
    let fax = matches!(l.compression, 2..=4);
    if fax && (l.bits != 1 || l.samples != 1) {
        return Err(refuse("a fax page must be one bit a pixel"));
    }
    for (k, &(offset, len)) in l
        .chunks
        .iter()
        .enumerate()
        .take(per_plane * planes as usize)
    {
        let plane = k / per_plane;
        let (ty, tx) = ((k % per_plane) / across, (k % per_plane) % across);
        let Some(data) =
            r.b.get(offset..offset.saturating_add(len).min(r.b.len()))
                .filter(|d| !d.is_empty())
        else {
            continue;
        };
        let rows_here = l
            .tile_height
            .min(l.height.saturating_sub(ty as u32 * l.tile_height));
        let want = (tile_row_bytes * l.tile_height as u64) as usize;
        let mut chunk = if fax {
            ccitt(data, l, t4, l.tile_height)?
        } else if l.compression == 7 {
            jpeg_chunk(data, tables, l)?
        } else {
            inflate(data, l.compression, want)?
        };
        if l.predictor == 2 {
            for row in chunk.chunks_mut(tile_row_bytes as usize) {
                undo_predictor(row, per_pixel as usize, l.bits, r.big);
            }
        }
        // Copy the chunk's rows into the page, clipped at its right and foot.
        let x_bits = tx as u64 * l.tile_width as u64 * bits_per_pixel;
        let copy_bits = (l.width.saturating_sub(tx as u32 * l.tile_width)).min(l.tile_width) as u64
            * bits_per_pixel;
        for row in 0..rows_here as u64 {
            let y = ty as u64 * l.tile_height as u64 + row;
            let from = (row * tile_row_bytes) as usize;
            let Some(src) = chunk.get(from..from + tile_row_bytes as usize) else {
                break;
            };
            let dst_row = plane as u64 * plane_bytes + y * row_bytes;
            copy_bits_into(&mut out, dst_row, x_bits, src, copy_bits);
        }
    }
    if fax {
        // Rows of bits, 1 where the code said white. Fax coding's white is
        // the page's white when zero is white (photometric 0, the usual);
        // a page that says zero is black shows the codes the other way.
        if l.photometric == 1 {
            out.iter_mut().for_each(|b| *b = !*b);
        }
    } else if l.reversed && l.bits < 8 {
        out.iter_mut().for_each(|b| *b = b.reverse_bits());
    }
    if l.planar {
        out = interleave(&out, l, plane_bytes as usize);
    }
    Ok(out)
}

/// Copies `count` bits from the start of `src` to bit `at` of the row at
/// byte `row` of `dst`.
fn copy_bits_into(dst: &mut [u8], row: u64, at: u64, src: &[u8], count: u64) {
    // From a byte boundary: whole bytes, the last one's spare bits being the
    // row's padding or the next chunk's to overwrite.
    if at.is_multiple_of(8) {
        let start = (row + at / 8) as usize;
        let n = count.div_ceil(8) as usize;
        if let (Some(d), Some(s)) = (dst.get_mut(start..start + n), src.get(..n)) {
            d.copy_from_slice(s);
        }
        return;
    }
    for i in 0..count {
        let bit = (src[(i / 8) as usize] >> (7 - i % 8)) & 1;
        let target = at + i;
        let byte = (row + target / 8) as usize;
        if let Some(d) = dst.get_mut(byte) {
            let mask = 0x80 >> (target % 8);
            if bit == 1 {
                *d |= mask;
            } else {
                *d &= !mask;
            }
        }
    }
}

/// Separate planes of 8 or 16 bits made into interleaved pixels.
fn interleave(planes: &[u8], l: &Layout, plane_bytes: usize) -> Vec<u8> {
    let bytes = (l.bits as usize).div_ceil(8).max(1);
    let samples = l.samples as usize;
    let pixels = plane_bytes / bytes;
    let mut out = vec![0u8; plane_bytes * samples];
    for p in 0..pixels {
        for s in 0..samples {
            for b in 0..bytes {
                if let Some(v) = planes.get(s * plane_bytes + p * bytes + b) {
                    out[(p * samples + s) * bytes + b] = *v;
                }
            }
        }
    }
    out
}

/// A JPEG strip or tile (compression 7), decoded to rows of samples.
fn jpeg_chunk(data: &[u8], tables: Option<&[u8]>, l: &Layout) -> Result<Vec<u8>> {
    // An abbreviated stream takes its tables from the page's JPEGTables:
    // the tables without their end, then the strip without its start.
    let whole: Vec<u8> = match tables {
        Some(t) if t.len() > 4 && data.starts_with(&[0xFF, 0xD8]) => {
            let mut v = t[..t.len() - 2].to_vec();
            v.extend_from_slice(&data[2..]);
            v
        }
        _ => data.to_vec(),
    };
    let mut reader =
        image::ImageReader::with_format(std::io::Cursor::new(whole), image::ImageFormat::Jpeg);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODED + (1 << 20));
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| refuse(&format!("a JPEG strip could not be read: {e}")))?;
    let row = (l.tile_width * l.samples) as usize;
    let raw = if l.samples == 1 {
        image.to_luma8().into_raw()
    } else {
        image.to_rgb8().into_raw()
    };
    // A strip decodes to its own width: fitted to the chunk's rows.
    let got = (image.width() * if l.samples == 1 { 1 } else { 3 }) as usize;
    let mut out = vec![0u8; row * l.tile_height as usize];
    for (y, src) in raw
        .chunks(got.max(1))
        .enumerate()
        .take(l.tile_height as usize)
    {
        let n = src.len().min(row);
        out[y * row..y * row + n].copy_from_slice(&src[..n]);
    }
    Ok(out)
}

/// Samples of 16 bits made 8, keeping the high byte.
fn to_eight(data: &[u8], big: bool) -> Vec<u8> {
    data.as_chunks::<2>()
        .0
        .iter()
        .map(|b| if big { b[0] } else { b[1] })
        .collect()
}

/// One page as an image XObject.
fn page_picture(doc: &mut Document, r: &Reader, ifd: &Ifd) -> Result<(Picture, PictureInfo)> {
    let mut l = layout(ifd)?;
    if l.compression == 7 {
        // Decoded to 8-bit grey or RGB, whatever the JPEG held.
        l.bits = 8;
        l.samples = if l.samples == 1 { 1 } else { 3 };
        l.photometric = if l.samples == 1 { 1 } else { 2 };
        l.planar = false;
        l.predictor = 1;
    }
    let mut data = pixels(r, ifd, &l)?;
    let (width, height) = (l.width, l.height);
    let fax = matches!(l.compression, 2..=4);
    let mut bits = l.bits;
    if bits == 16 {
        data = to_eight(&data, r.big);
        bits = 8;
    }
    let (space, samples, extra): (Object, u32, u32) = match (l.photometric, l.samples) {
        _ if fax => ("DeviceGray".into(), 1, 0),
        (0 | 1, n) => ("DeviceGray".into(), 1, n.saturating_sub(1)),
        (2, n) if n >= 3 => ("DeviceRGB".into(), 3, n - 3),
        (3, n) => {
            let entries = 1usize << bits.min(8);
            let map = ifd
                .values(320, 3 * entries)
                .filter(|m| m.len() == 3 * entries)
                .ok_or_else(|| refuse("a palette TIFF page has no palette"))?;
            let mut lookup = Vec::with_capacity(3 * entries);
            for i in 0..entries {
                for c in 0..3 {
                    lookup.push((map[c * entries + i] >> 8) as u8);
                }
            }
            (
                Object::Array(vec![
                    "Indexed".into(),
                    "DeviceRGB".into(),
                    Object::Integer(entries as i64 - 1),
                    Object::String(lookup, lopdf::StringFormat::Hexadecimal),
                ]),
                1,
                n.saturating_sub(1),
            )
        }
        (5, n) if n >= 4 => ("DeviceCMYK".into(), 4, n - 4),
        (p, _) => {
            return Err(refuse(&format!(
                "TIFF colour model {p} is not one Warraq reads"
            )))
        }
    };
    // Extra samples (alpha) are left out: only the colour goes on the page.
    if extra > 0 {
        if bits != 8 {
            return Err(refuse("a TIFF page with extra samples must be 8 bits"));
        }
        let all = (samples + extra) as usize;
        data = data
            .chunks_exact(all)
            .flat_map(|p| p[..samples as usize].to_vec())
            .collect();
    }
    let mut dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Image",
        "Width" => width as i64, "Height" => height as i64,
        "ColorSpace" => space, "BitsPerComponent" => if fax { 1 } else { bits as i64 },
    };
    // Grey that is white at zero (photometric 0) is drawn the other way round.
    if !fax && l.photometric == 0 {
        dict.set("Decode", vec![1.into(), 0.into()]);
    }
    if !matches!(bits, 1 | 2 | 4 | 8) {
        return Err(refuse(&format!("{bits}-bit TIFF samples are not read")));
    }
    let mut stream = Stream::new(dict, data);
    let _ = stream.compress();
    Ok((
        Picture {
            id: doc.add_object(stream),
            width,
            height,
        },
        PictureInfo {
            width,
            height,
            orientation: l.orientation,
            dpi: l.dpi,
        },
    ))
}

/// Every page of a TIFF, as image XObjects added to `doc`; a page that
/// cannot be read is left out, and none at all is an error.
pub fn add_tiff_pages(doc: &mut Document, bytes: &[u8]) -> Result<Vec<(Picture, PictureInfo)>> {
    let r = Reader {
        b: bytes,
        big: bytes.starts_with(b"MM"),
    };
    let pages = directories(&r)?;
    let mut out = Vec::new();
    let mut first_error = None;
    for ifd in &pages {
        // A reduced-resolution copy of another page (a thumbnail) is not a page.
        if ifd.value(254).is_some_and(|t| t & 1 == 1) {
            continue;
        }
        match page_picture(doc, &r, ifd) {
            Ok(p) => out.push(p),
            Err(e) => {
                first_error.get_or_insert(e);
            }
        }
    }
    if out.is_empty() {
        return Err(first_error.unwrap_or_else(|| refuse("the TIFF has no pages")));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A little-endian TIFF of `pages`, each (width, height, bits, samples,
    /// photometric, compression, extra tags, data).
    #[allow(clippy::type_complexity)]
    pub(crate) fn tiff(
        pages: &[(u32, u32, u16, u16, u16, u16, Vec<(u16, u16, u32)>, Vec<u8>)],
    ) -> Vec<u8> {
        let mut out = b"II*\0\0\0\0\0".to_vec();
        let mut link_at = 4usize;
        for (w, h, bits, samples, photometric, compression, extra, data) in pages {
            let data_at = out.len();
            out.extend_from_slice(data);
            if out.len() % 2 == 1 {
                out.push(0);
            }
            let ifd_at = out.len();
            out[link_at..link_at + 4].copy_from_slice(&(ifd_at as u32).to_le_bytes());
            let mut tags: Vec<(u16, u16, u32)> = vec![
                (256, 4, *w),
                (257, 4, *h),
                (258, 3, *bits as u32),
                (259, 3, *compression as u32),
                (262, 3, *photometric as u32),
                (273, 4, data_at as u32),
                (277, 3, *samples as u32),
                (278, 4, *h),
                (279, 4, data.len() as u32),
            ];
            tags.extend(extra.iter().copied());
            tags.sort_by_key(|t| t.0);
            out.extend((tags.len() as u16).to_le_bytes());
            for (tag, kind, value) in tags {
                out.extend(tag.to_le_bytes());
                out.extend(kind.to_le_bytes());
                out.extend(1u32.to_le_bytes());
                if kind == 3 {
                    out.extend((value as u16).to_le_bytes());
                    out.extend([0, 0]);
                } else {
                    out.extend(value.to_le_bytes());
                }
            }
            link_at = out.len();
            out.extend(0u32.to_le_bytes());
        }
        out
    }

    fn decoded(doc: &Document, p: &Picture) -> Vec<u8> {
        let s = doc.get_object(p.id).unwrap().as_stream().unwrap();
        s.decompressed_content()
            .unwrap_or_else(|_| s.content.clone())
    }

    #[test]
    fn every_page_of_a_tiff_is_read_grey_and_colour() {
        let grey: Vec<u8> = (0..6u8).map(|v| v * 40).collect();
        let rgb = vec![255, 0, 0, 0, 0, 255];
        let bytes = tiff(&[
            (3, 2, 8, 1, 1, 1, vec![], grey.clone()),
            (2, 1, 8, 3, 2, 1, vec![], rgb.clone()),
        ]);
        let mut doc = Document::with_version("1.7");
        let pages = add_tiff_pages(&mut doc, &bytes).unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!((pages[0].0.width, pages[0].0.height), (3, 2));
        assert_eq!(decoded(&doc, &pages[0].0), grey);
        assert_eq!(decoded(&doc, &pages[1].0), rgb);
        let s = doc.get_object(pages[1].0.id).unwrap().as_stream().unwrap();
        assert_eq!(
            s.dict.get(b"ColorSpace").unwrap().as_name().unwrap(),
            b"DeviceRGB"
        );
    }

    #[test]
    fn packbits_and_the_horizontal_predictor_are_undone() {
        // PackBits: 4 copies of 10, then the literal 1 2.
        let packed = vec![0xFD, 10, 1, 1, 2];
        let bytes = tiff(&[(6, 1, 8, 1, 1, 32773, vec![], packed)]);
        let mut doc = Document::with_version("1.7");
        let pages = add_tiff_pages(&mut doc, &bytes).unwrap();
        assert_eq!(decoded(&doc, &pages[0].0), vec![10, 10, 10, 10, 1, 2]);
        // Differences 10, +5, +5 with predictor 2: 10, 15, 20.
        let bytes = tiff(&[(3, 1, 8, 1, 1, 1, vec![(317, 3, 2)], vec![10, 5, 5])]);
        let pages = add_tiff_pages(&mut doc, &bytes).unwrap();
        assert_eq!(decoded(&doc, &pages[0].0), vec![10, 15, 20]);
    }

    #[test]
    fn lzw_and_deflate_strips_are_read() {
        let raw: Vec<u8> = (0..64u8).collect();
        let mut lzw = Vec::new();
        weezl::encode::Encoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8)
            .into_vec(&mut lzw)
            .encode_all(&raw)
            .status
            .unwrap();
        let mut deflate =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut deflate, &raw).unwrap();
        let deflate = deflate.finish().unwrap();
        let bytes = tiff(&[
            (8, 8, 8, 1, 1, 5, vec![], lzw),
            (8, 8, 8, 1, 1, 8, vec![], deflate),
        ]);
        let mut doc = Document::with_version("1.7");
        let pages = add_tiff_pages(&mut doc, &bytes).unwrap();
        assert_eq!(decoded(&doc, &pages[0].0), raw);
        assert_eq!(decoded(&doc, &pages[1].0), raw);
    }

    #[test]
    fn a_white_is_zero_page_is_drawn_the_right_way_round() {
        // One bit a pixel, 0 white: the page stays one bit and is inverted by /Decode.
        let bytes = tiff(&[(8, 1, 1, 1, 0, 1, vec![], vec![0b1000_0000])]);
        let mut doc = Document::with_version("1.7");
        let pages = add_tiff_pages(&mut doc, &bytes).unwrap();
        let s = doc.get_object(pages[0].0.id).unwrap().as_stream().unwrap();
        assert_eq!(
            s.dict.get(b"BitsPerComponent").unwrap().as_i64().unwrap(),
            1
        );
        assert!(s.dict.get(b"Decode").is_ok());
    }

    #[test]
    fn broken_or_looping_files_are_refused_or_cut_short_not_panicked_on() {
        let mut doc = Document::with_version("1.7");
        // The first page's link points back at itself.
        let mut looping = tiff(&[(1, 1, 8, 1, 1, 1, vec![], vec![7])]);
        let n = looping.len();
        let first = u32::from_le_bytes([looping[4], looping[5], looping[6], looping[7]]);
        looping[n - 4..].copy_from_slice(&first.to_le_bytes());
        assert_eq!(add_tiff_pages(&mut doc, &looping).unwrap().len(), 1);
        for bytes in [
            &b"II*\0"[..],
            b"II*\0\xff\xff\xff\xff",
            b"MM\0*\0\0\0\x08\0\x01\x01\x00\0\x04\0\0\0\x01\xff\xff\xff\xff",
        ] {
            assert!(add_tiff_pages(&mut doc, bytes).is_err());
        }
        // A page far too large is refused before anything is decoded.
        let huge = tiff(&[(100_000, 100_000, 8, 1, 1, 1, vec![], vec![0])]);
        assert!(add_tiff_pages(&mut doc, &huge).is_err());
    }
}
