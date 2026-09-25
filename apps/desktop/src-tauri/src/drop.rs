//! OS drag-and-drop → host event.
//!
//! Known trap: wry reports drop positions in *logical* pixels on macOS and Linux but in
//! *physical* pixels on Windows, and Tauri wraps both in a `PhysicalPosition`. The web layer
//! needs CSS (logical) pixels, so we divide by the scale factor on Windows only.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Most files accepted in a single drop; the rest are ignored (bounded work per event).
pub const MAX_DROPPED_FILES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetOs {
    MacOs,
    Windows,
    Linux,
    Other,
}

impl TargetOs {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MacOs => "macos",
            Self::Windows => "windows",
            Self::Linux => "linux",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct LogicalPoint {
    pub x: f64,
    pub y: f64,
}

/// Converts a wry drop position into CSS pixels.
pub fn drop_position_to_logical(x: f64, y: f64, scale_factor: f64, os: TargetOs) -> LogicalPoint {
    let finite = |v: f64| if v.is_finite() { v } else { 0.0 };
    let (x, y) = (finite(x), finite(y));
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    match os {
        TargetOs::Windows => LogicalPoint {
            x: x / scale,
            y: y / scale,
        },
        TargetOs::MacOs | TargetOs::Linux | TargetOs::Other => LogicalPoint { x, y },
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DropPayload {
    pub files: Vec<DroppedFile>,
    pub position: LogicalPoint,
}

/// Keeps regular files only (no directories), at most [`MAX_DROPPED_FILES`], skipping paths that
/// are not valid UTF-8 (the web layer could not name them back to us).
pub fn dropped_files(paths: &[PathBuf], is_file: impl Fn(&Path) -> bool) -> Vec<DroppedFile> {
    paths
        .iter()
        .filter(|p| is_file(p))
        .filter_map(|p| {
            let path = p.to_str()?.to_owned();
            let name = p.file_name()?.to_str()?.to_owned();
            Some(DroppedFile { name, path })
        })
        .take(MAX_DROPPED_FILES)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_positions_are_divided_by_the_scale_factor() {
        let p = drop_position_to_logical(300.0, 150.0, 1.5, TargetOs::Windows);
        assert_eq!(p, LogicalPoint { x: 200.0, y: 100.0 });
    }

    #[test]
    fn macos_and_linux_positions_are_already_logical() {
        for os in [TargetOs::MacOs, TargetOs::Linux] {
            let p = drop_position_to_logical(300.0, 150.0, 2.0, os);
            assert_eq!(p, LogicalPoint { x: 300.0, y: 150.0 }, "{os:?}");
        }
    }

    #[test]
    fn bad_scale_factors_fall_back_to_one() {
        for s in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let p = drop_position_to_logical(10.0, 20.0, s, TargetOs::Windows);
            assert_eq!(p, LogicalPoint { x: 10.0, y: 20.0 });
        }
    }

    #[test]
    fn non_finite_coordinates_become_zero() {
        let p = drop_position_to_logical(f64::NAN, f64::NEG_INFINITY, 1.0, TargetOs::Linux);
        assert_eq!(p, LogicalPoint { x: 0.0, y: 0.0 });
    }

    #[test]
    fn current_os_is_one_of_the_known_ones() {
        let os = TargetOs::current();
        #[cfg(target_os = "linux")]
        assert_eq!(os, TargetOs::Linux);
        assert!(!os.as_str().is_empty());
    }

    #[test]
    fn dropped_files_skip_directories_and_are_bounded() {
        let mut paths: Vec<PathBuf> = (0..100)
            .map(|i| PathBuf::from(format!("/tmp/f{i}.pdf")))
            .collect();
        paths.insert(0, PathBuf::from("/tmp/dir"));
        let files = dropped_files(&paths, |p| !p.ends_with("dir"));
        assert_eq!(files.len(), MAX_DROPPED_FILES);
        assert_eq!(
            files.first(),
            Some(&DroppedFile {
                name: "f0.pdf".into(),
                path: "/tmp/f0.pdf".into()
            })
        );
    }

    #[test]
    fn dropped_arabic_names_survive() {
        let files = dropped_files(&[PathBuf::from("/tmp/عقد الإيجار.pdf")], |_| true);
        assert_eq!(
            files.first().map(|f| f.name.as_str()),
            Some("عقد الإيجار.pdf")
        );
    }
}
