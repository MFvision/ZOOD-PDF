//! One clipboard for the phone and the PC.
//!
//! While the remote is on and the person has "Share the clipboard" on (the
//! default), what is copied on the PC — text or a picture — goes to the
//! paired phones, and what the phone sends (`{ t: "clip", text }` or
//! `{ t: "clip", png }`) is put on the PC's clipboard, ready for Ctrl+V. What
//! a password manager copies is marked by it as private, and is never sent.
//!
//! The clipboard itself is arboard (MIT OR Apache-2.0); pictures go as PNG
//! (png, MIT OR Apache-2.0). Windows and macOS only.

use std::hash::{Hash, Hasher};

/// The longest text sent either way, in characters.
pub const MAX_TEXT: usize = 100_000;
/// The largest picture sent from the PC, in pixels.
const MAX_PIXELS: usize = 4096 * 4096;

/// What is on a clipboard: text, or a picture as PNG.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Clip {
    Text(String),
    Png(Vec<u8>),
}

impl Clip {
    /// A short fingerprint, to tell a new copy from the one already sent.
    pub fn fingerprint(&self) -> u64 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.hash(&mut hasher);
        hasher.finish()
    }
}

/// The phone's `clip` message, as something to put on the clipboard.
pub fn from_phone(message: &serde_json::Value) -> Option<Clip> {
    use base64::Engine;
    if let Some(text) = message.get("text").and_then(|t| t.as_str()) {
        if text.is_empty() {
            return None;
        }
        return Some(Clip::Text(text.chars().take(MAX_TEXT).collect()));
    }
    let png = message.get("png").and_then(|p| p.as_str())?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(png).ok()?;
    bytes
        .starts_with(b"\x89PNG\r\n\x1a\n")
        .then_some(Clip::Png(bytes))
}

/// The message that carries `clip` to a phone.
pub fn to_phone(clip: &Clip) -> serde_json::Value {
    use base64::Engine;
    match clip {
        Clip::Text(text) => serde_json::json!({ "t": "clip", "text": text }),
        Clip::Png(png) => serde_json::json!({
            "t": "clip",
            "png": base64::engine::general_purpose::STANDARD.encode(png),
        }),
    }
}

/// RGBA pixels as a PNG.
pub fn encode_png(width: usize, height: usize, rgba: &[u8]) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || width * height > MAX_PIXELS || rgba.len() != width * height * 4
    {
        return None;
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(out)
}

/// A PNG as RGBA pixels: width, height, pixels.
pub fn decode_png(bytes: &[u8]) -> Option<(usize, usize, Vec<u8>)> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    let (width, height) = {
        let info = reader.info();
        (info.width as usize, info.height as usize)
    };
    if width == 0 || height == 0 || width * height > MAX_PIXELS {
        return None;
    }
    let mut buffer = vec![0; reader.output_buffer_size()?];
    let frame = reader.next_frame(&mut buffer).ok()?;
    let data = &buffer[..frame.buffer_size()];
    let rgba = match frame.color_type {
        png::ColorType::Rgba => data.to_vec(),
        png::ColorType::Rgb => data
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|&[r, g, b]| [r, g, b, 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => data
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|&[g, a]| [g, g, g, a])
            .collect(),
        png::ColorType::Grayscale => data.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return None,
    };
    (rgba.len() == width * height * 4).then_some((width, height, rgba))
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod system {
    use super::{decode_png, encode_png, Clip, MAX_TEXT};

    /// What is on the PC's clipboard now, unless its app marked it private.
    pub fn read() -> Option<Clip> {
        if private() {
            return None;
        }
        let mut board = arboard::Clipboard::new().ok()?;
        if let Ok(text) = board.get_text() {
            if !text.is_empty() {
                return Some(Clip::Text(text.chars().take(MAX_TEXT).collect()));
            }
        }
        let image = board.get_image().ok()?;
        encode_png(image.width, image.height, &image.bytes).map(Clip::Png)
    }

    pub fn write(clip: &Clip) -> bool {
        let Ok(mut board) = arboard::Clipboard::new() else {
            return false;
        };
        match clip {
            Clip::Text(text) => board.set_text(text.clone()).is_ok(),
            Clip::Png(png) => match decode_png(png) {
                Some((width, height, bytes)) => board
                    .set_image(arboard::ImageData {
                        width,
                        height,
                        bytes: bytes.into(),
                    })
                    .is_ok(),
                None => false,
            },
        }
    }

    /// Password managers mark what they copy so clipboard tools leave it
    /// alone: Windows' "ExcludeClipboardContentFromMonitorProcessing" format.
    #[cfg(target_os = "windows")]
    fn private() -> bool {
        use windows_sys::Win32::System::DataExchange::{
            IsClipboardFormatAvailable, RegisterClipboardFormatW,
        };
        [
            "ExcludeClipboardContentFromMonitorProcessing",
            "Clipboard Viewer Ignore",
        ]
        .iter()
        .any(|name| {
            let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: a NUL-terminated UTF-16 string that outlives the call.
            let format = unsafe { RegisterClipboardFormatW(wide.as_ptr()) };
            // SAFETY: plain query of a registered format number.
            format != 0 && unsafe { IsClipboardFormatAvailable(format) } != 0
        })
    }

    /// The same on a Mac: nspasteboard.org's concealed and transient types.
    #[cfg(target_os = "macos")]
    fn private() -> bool {
        use objc2_app_kit::NSPasteboard;
        let board = NSPasteboard::generalPasteboard();
        let Some(types) = board.types() else {
            return false;
        };
        types.iter().any(|t| {
            let name = t.to_string();
            name == "org.nspasteboard.ConcealedType" || name == "org.nspasteboard.TransientType"
        })
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod system {
    use super::Clip;

    pub fn read() -> Option<Clip> {
        None
    }

    pub fn write(_clip: &Clip) -> bool {
        false
    }
}

pub use system::{read, write};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phone_clip_is_text_or_a_real_png() {
        let text = from_phone(&serde_json::json!({ "t": "clip", "text": "مرحبا" }));
        assert_eq!(text, Some(Clip::Text("مرحبا".into())));
        assert_eq!(
            from_phone(&serde_json::json!({ "t": "clip", "text": "" })),
            None
        );
        assert_eq!(
            from_phone(&serde_json::json!({ "t": "clip", "png": "aGVsbG8=" })),
            None
        );
        let png = encode_png(2, 1, &[255, 0, 0, 255, 0, 0, 255, 128]).unwrap();
        let message = to_phone(&Clip::Png(png.clone()));
        assert_eq!(from_phone(&message), Some(Clip::Png(png)));
    }

    #[test]
    fn pictures_go_through_png_unchanged() {
        let rgba = vec![10, 20, 30, 255, 40, 50, 60, 0, 70, 80, 90, 128, 1, 2, 3, 4];
        let png = encode_png(2, 2, &rgba).unwrap();
        assert_eq!(decode_png(&png), Some((2, 2, rgba)));
        assert_eq!(encode_png(0, 0, &[]), None);
        assert_eq!(encode_png(2, 2, &[0; 3]), None);
    }

    #[test]
    fn a_new_copy_has_a_new_fingerprint() {
        let a = Clip::Text("one".into());
        assert_eq!(a.fingerprint(), Clip::Text("one".into()).fingerprint());
        assert_ne!(a.fingerprint(), Clip::Text("two".into()).fingerprint());
    }
}
