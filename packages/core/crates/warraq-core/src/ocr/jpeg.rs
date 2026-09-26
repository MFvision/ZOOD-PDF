//! Minimal, bounded JPEG header reader: enough to embed a camera/scanner JPEG unchanged as a
//! `/DCTDecode` image (size and colour components come from the file, never from the caller).

/// Frame header of a JPEG file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JpegInfo {
    pub width: u32,
    pub height: u32,
    /// 1 = gray, 3 = YCbCr/RGB, 4 = CMYK/YCCK.
    pub components: u8,
    pub bits: u8,
}

/// Most marker segments a well-formed header has before its frame header.
const MAX_SEGMENTS: usize = 4096;

/// Reads the SOF (start of frame) header. `None` if the data is not a JPEG or is truncated.
pub fn jpeg_info(data: &[u8]) -> Option<JpegInfo> {
    if data.get(0..2)? != [0xFF, 0xD8] {
        return None;
    }
    let mut i = 2usize;
    for _ in 0..MAX_SEGMENTS {
        // skip fill bytes
        while *data.get(i)? == 0xFF && *data.get(i + 1)? == 0xFF {
            i += 1;
        }
        if *data.get(i)? != 0xFF {
            return None;
        }
        let marker = *data.get(i + 1)?;
        i += 2;
        match marker {
            0xD8 | 0x01 | 0xD0..=0xD7 => continue, // no length
            0xD9 | 0xDA => return None,            // EOI / SOS before any frame header
            _ => {}
        }
        let len = usize::from(u16::from_be_bytes([*data.get(i)?, *data.get(i + 1)?]));
        if len < 2 {
            return None;
        }
        let is_sof = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof {
            let seg = data.get(i + 2..i + len)?;
            let bits = *seg.first()?;
            let height = u32::from(u16::from_be_bytes([*seg.get(1)?, *seg.get(2)?]));
            let width = u32::from(u16::from_be_bytes([*seg.get(3)?, *seg.get(4)?]));
            let components = *seg.get(5)?;
            if width == 0 || height == 0 || components == 0 {
                return None;
            }
            return Some(JpegInfo {
                width,
                height,
                components,
                bits,
            });
        }
        i = i.checked_add(len)?;
    }
    None
}
