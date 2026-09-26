//! Minimal PNG encoder (8-bit RGBA or grey, filter 0, zlib via `miniz_oxide`).

use crate::error::{OfficeError, Result};

/// Maximum pixels of an encoded image (64 megapixels).
pub const MAX_PIXELS: usize = 64 * 1024 * 1024;

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut h = crc32fast::Hasher::new();
    h.update(kind);
    h.update(data);
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&h.finalize().to_be_bytes());
}

/// Encode `pixels` (`channels` = 1 grey or 4 RGBA, row-major, no padding) as PNG.
pub fn encode(width: u32, height: u32, channels: u8, pixels: &[u8]) -> Result<Vec<u8>> {
    let color_type = match channels {
        1 => 0u8,
        3 => 2,
        4 => 6,
        _ => return Err(OfficeError::Params("png channels must be 1, 3 or 4".into())),
    };
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || w.saturating_mul(h) > MAX_PIXELS {
        return Err(OfficeError::Limit("png size"));
    }
    let stride = w * usize::from(channels);
    if pixels.len() != stride * h {
        return Err(OfficeError::Params("pixel buffer size mismatch".into()));
    }
    let mut raw = Vec::with_capacity((stride + 1) * h);
    for row in pixels.chunks_exact(stride) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let z = miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6);
    let mut out = Vec::with_capacity(z.len() + 64);
    out.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, color_type, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

/// Encode as a `data:image/png;base64,…` URI.
pub fn data_uri(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64(png))
}

/// Standard base64 with padding.
pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let enc = |i: u32| char::from(T.get((i & 63) as usize).copied().unwrap_or(b'A'));
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b0 = u32::from(c.first().copied().unwrap_or(0));
        let b1 = u32::from(c.get(1).copied().unwrap_or(0));
        let b2 = u32::from(c.get(2).copied().unwrap_or(0));
        let n = (b0 << 16) | (b1 << 8) | b2;
        s.push(enc(n >> 18));
        s.push(enc(n >> 12));
        s.push(if c.len() > 1 { enc(n >> 6) } else { '=' });
        s.push(if c.len() > 2 { enc(n) } else { '=' });
    }
    s
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn png_has_valid_structure() {
        let px = vec![255u8; 3 * 2 * 4];
        let png = encode(3, 2, 4, &px).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 3);
        // IDAT inflates back to filtered rows
        let len = u32::from_be_bytes(png[33..37].try_into().unwrap()) as usize;
        assert_eq!(&png[37..41], b"IDAT");
        let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&png[41..41 + len]).unwrap();
        assert_eq!(raw.len(), 2 * (1 + 12));
        assert!(png.ends_with(&[0xAE, 0x42, 0x60, 0x82]), "IEND crc");
    }

    #[test]
    fn rejects_bad_sizes() {
        assert!(encode(0, 1, 4, &[]).is_err());
        assert!(encode(2, 2, 4, &[0; 3]).is_err());
        assert!(encode(1, 1, 2, &[0; 2]).is_err());
    }

    #[test]
    fn base64_known_answers() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
