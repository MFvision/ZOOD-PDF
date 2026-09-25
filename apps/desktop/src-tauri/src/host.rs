//! Small pure helpers used by the commands (kept here so they are unit-testable).

use crate::drop::TargetOs;
use serde::Serialize;

pub const TITLE_EN: &str = "ZOOD PDF";
pub const TITLE_AR: &str = "زود PDF";

/// Largest document accepted by the native print command (bounded allocation).
pub const MAX_PRINT_BYTES: usize = 1024 * 1024 * 1024;

/// Env flag for the headless smoke test: quit (exit code 0) once the UI reports "ready".
pub const SMOKE_ENV: &str = "ZOOD_SMOKE_EXIT_ON_READY";

/// Window title for a BCP-47 locale tag sent by the UI.
pub fn window_title_for_locale(locale: &str) -> &'static str {
    let primary = locale
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if primary == "ar" {
        TITLE_AR
    } else {
        TITLE_EN
    }
}

pub fn smoke_flag_set(value: Option<&str>) -> bool {
    matches!(value, Some("1" | "true" | "yes"))
}

/// Tells the web layer how the window chrome is laid out so the toolbar can leave room
/// for the macOS traffic lights (title bar merged into the toolbar).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub os: &'static str,
    /// True when the web content extends under a transparent title bar.
    pub title_bar_overlay: bool,
    /// Width (CSS px) reserved on the physical left for the traffic lights; 0 elsewhere.
    pub traffic_lights_width: f64,
    /// Height (CSS px) of the overlaid title bar area; 0 elsewhere.
    pub title_bar_height: f64,
    /// Whether `print` is handled natively (PDFKit) or needs page images.
    pub native_pdf_print: bool,
}

pub fn host_info(os: TargetOs) -> HostInfo {
    let mac = os == TargetOs::MacOs;
    HostInfo {
        os: os.as_str(),
        title_bar_overlay: mac,
        traffic_lights_width: if mac { 78.0 } else { 0.0 },
        title_bar_height: if mac { 28.0 } else { 0.0 },
        native_pdf_print: mac,
    }
}

/// Cheap sanity check before handing bytes to PDFKit.
pub fn looks_like_pdf(bytes: &[u8]) -> bool {
    let head = bytes.get(..bytes.len().min(1024)).unwrap_or(&[]);
    head.windows(5).any(|w| w == b"%PDF-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arabic_locales_get_the_arabic_title() {
        for l in ["ar", "ar-SA", "AR_eg", "ar-u-nu-arab"] {
            assert_eq!(window_title_for_locale(l), "زود PDF", "{l}");
        }
        for l in ["en", "en-US", "fa", "", "arz"] {
            assert_eq!(window_title_for_locale(l), "ZOOD PDF", "{l}");
        }
    }

    #[test]
    fn smoke_flag() {
        assert!(smoke_flag_set(Some("1")));
        assert!(!smoke_flag_set(Some("0")));
        assert!(!smoke_flag_set(None));
    }

    #[test]
    fn host_info_reserves_traffic_lights_only_on_macos() {
        let mac = host_info(TargetOs::MacOs);
        assert!(mac.title_bar_overlay && mac.native_pdf_print);
        assert!(mac.traffic_lights_width > 60.0);
        for os in [TargetOs::Windows, TargetOs::Linux] {
            let i = host_info(os);
            assert!(!i.title_bar_overlay && !i.native_pdf_print);
            assert_eq!(i.traffic_lights_width, 0.0);
        }
        let json = serde_json::to_string(&mac).unwrap_or_default();
        assert!(json.contains("\"trafficLightsWidth\":78.0"), "{json}");
    }

    #[test]
    fn pdf_sniffing() {
        assert!(looks_like_pdf(b"%PDF-1.7\n..."));
        assert!(looks_like_pdf(b"\xEF\xBB\xBF%PDF-1.4"));
        assert!(!looks_like_pdf(b"<html>"));
        assert!(!looks_like_pdf(b""));
    }
}
