//! Ask ZOOD's eye: one picture of the screen the pointer is on, taken the
//! moment the shortcut is pressed — before the island shows — and only when
//! the chosen model can read pictures. It is kept in memory for that one
//! question and never written or sent. xcap (Apache-2.0) takes it; a Mac
//! asks the person once for Screen Recording. Elsewhere there is no eye.

/// The longest side of the picture the model is shown, in pixels: enough to
/// read a button's label, few enough tokens to answer quickly.
pub const MAX_SIDE: u32 = 1280;

/// The screen as the model sees it, and where that screen is.
#[derive(Clone, Debug)]
pub struct Screen {
    pub width: u32,
    pub height: u32,
    /// RGB, three bytes a pixel.
    pub rgb: Vec<u8>,
    /// The monitor: its top-left and size, in the units the system placed
    /// it in (pixels on Windows, points on a Mac).
    pub monitor: Area,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// RGBA pixels made at most `MAX_SIDE` on their longest side, as RGB. Each
/// new pixel is the average of the ones it covers, so text stays readable.
pub fn shrink(width: u32, height: u32, rgba: &[u8]) -> (u32, u32, Vec<u8>) {
    let longest = width.max(height).max(1);
    let (w, h) = if longest <= MAX_SIDE {
        (width, height)
    } else {
        let scale = f64::from(MAX_SIDE) / f64::from(longest);
        (
            ((f64::from(width) * scale).round() as u32).max(1),
            ((f64::from(height) * scale).round() as u32).max(1),
        )
    };
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        let y0 = (u64::from(y) * u64::from(height) / u64::from(h)) as u32;
        let y1 = ((u64::from(y + 1) * u64::from(height)).div_ceil(u64::from(h)) as u32).max(y0 + 1);
        for x in 0..w {
            let x0 = (u64::from(x) * u64::from(width) / u64::from(w)) as u32;
            let x1 =
                ((u64::from(x + 1) * u64::from(width)).div_ceil(u64::from(w)) as u32).max(x0 + 1);
            let mut sum = [0u32; 3];
            let mut count = 0u32;
            for sy in y0..y1.min(height) {
                for sx in x0..x1.min(width) {
                    let at = ((sy * width + sx) * 4) as usize;
                    if let Some(px) = rgba.get(at..at + 3) {
                        sum[0] += u32::from(px[0]);
                        sum[1] += u32::from(px[1]);
                        sum[2] += u32::from(px[2]);
                        count += 1;
                    }
                }
            }
            let count = count.max(1);
            rgb.extend(sum.map(|s| (s / count) as u8));
        }
    }
    (w, h, rgb)
}

/// Where a point the model gave — thousandths of the picture across and
/// down, as Qwen's vision models answer — falls inside the picture, 0..1.
pub fn fraction(x: f64, y: f64) -> (f64, f64) {
    let clamp = |v: f64| {
        if v.is_finite() {
            (v / 1000.0).clamp(0.0, 1.0)
        } else {
            0.5
        }
    };
    (clamp(x), clamp(y))
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn capture() -> Result<Screen, String> {
    let (px, py) = pointer();
    let monitor = xcap::Monitor::from_point(px as i32, py as i32)
        .or_else(|_| {
            xcap::Monitor::all().and_then(|all| {
                all.into_iter()
                    .find(|m| m.is_primary().unwrap_or(false))
                    .ok_or_else(|| xcap::XCapError::new("no primary monitor"))
            })
        })
        .map_err(|e| format!("E_SCREEN: {e}"))?;
    let area = Area {
        x: f64::from(monitor.x().map_err(|e| format!("E_SCREEN: {e}"))?),
        y: f64::from(monitor.y().map_err(|e| format!("E_SCREEN: {e}"))?),
        width: f64::from(monitor.width().map_err(|e| format!("E_SCREEN: {e}"))?),
        height: f64::from(monitor.height().map_err(|e| format!("E_SCREEN: {e}"))?),
    };
    let image = monitor
        .capture_image()
        .map_err(|e| format!("E_SCREEN: {e}"))?;
    let (width, height) = (image.width(), image.height());
    let (width, height, rgb) = shrink(width, height, image.as_raw());
    Ok(Screen {
        width,
        height,
        rgb,
        monitor: area,
    })
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn capture() -> Result<Screen, String> {
    Err("E_SCREEN: Ask ZOOD sees the screen on Windows and macOS".to_string())
}

/// The pointer, in the units xcap places monitors in.
#[cfg(target_os = "windows")]
pub fn pointer() -> (f64, f64) {
    let mut at = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
    // SAFETY: writes the cursor's position into `at`.
    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut at) };
    (f64::from(at.x), f64::from(at.y))
}

#[cfg(target_os = "macos")]
pub fn pointer() -> (f64, f64) {
    crate::ring::macos::pointer()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn pointer() -> (f64, f64) {
    (0.0, 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_small_screen_is_kept_as_it_is_without_its_alpha() {
        let rgba = [1, 2, 3, 255, 4, 5, 6, 0];
        assert_eq!(shrink(2, 1, &rgba), (2, 1, vec![1, 2, 3, 4, 5, 6]));
    }

    #[test]
    fn a_large_screen_is_brought_down_by_averaging() {
        // 2560 x 1440 of one grey with a white pixel block at the top left.
        let (w, h) = (2560u32, 1440u32);
        let mut rgba = vec![100u8; (w * h * 4) as usize];
        for y in 0..2 {
            for x in 0..2 {
                let at = ((y * w + x) * 4) as usize;
                rgba[at..at + 3].copy_from_slice(&[255, 255, 255]);
            }
        }
        let (sw, sh, rgb) = shrink(w, h, &rgba);
        assert_eq!((sw, sh), (1280, 720));
        assert_eq!(rgb.len(), (1280 * 720 * 3) as usize);
        assert_eq!(&rgb[..3], &[255, 255, 255]);
        assert_eq!(&rgb[3..6], &[100, 100, 100]);
    }

    #[test]
    fn the_models_thousandths_are_kept_on_the_screen() {
        assert_eq!(fraction(500.0, 250.0), (0.5, 0.25));
        assert_eq!(fraction(-20.0, 1400.0), (0.0, 1.0));
        assert_eq!(fraction(f64::NAN, 0.0), (0.5, 0.0));
    }
}
