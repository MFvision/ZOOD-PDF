//! Show me and Do it for me in other apps, by the buttons' names
//! (`reach.rs`) instead of a picture read by the vision model: the island
//! gets the window's buttons, picks one by its name for each part of the
//! request, and ZOOD's pointer goes to it — or, for Do it for me, clicks it.
//! A click outside ZOOD PDF lands only on a button that was read here, in
//! the middle of its box, so a guess never clicks.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{Runtime, State};

use super::eye::Area;
use super::reach::{self, Raw};
use super::AskState;

/// A control as the island sees it: its name and kind, and its middle in
/// thousandths of the area the pointer is placed on (as the vision models
/// answer, so the pointer and the click take it unchanged).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Control {
    pub name: String,
    pub role: &'static str,
    pub x: f64,
    pub y: f64,
}

/// The boxes of the controls read last, in the system's units: the only
/// places a click outside ZOOD PDF may land.
static LAST: Mutex<Vec<Area>> = Mutex::new(Vec::new());

/// The controls in `area`, by their middles, as thousandths of it.
pub fn placed(raw: &[Raw], area: Area) -> Vec<Control> {
    let mut seen = std::collections::HashSet::new();
    raw.iter()
        .filter_map(|control| {
            let cx = control.left + control.width / 2.0;
            let cy = control.top + control.height / 2.0;
            let inside = cx >= area.x
                && cy >= area.y
                && cx <= area.x + area.width
                && cy <= area.y + area.height;
            if !inside || area.width <= 0.0 || area.height <= 0.0 {
                return None;
            }
            let x = ((cx - area.x) / area.width * 1000.0).round();
            let y = ((cy - area.y) / area.height * 1000.0).round();
            // The same name in the same place once (a button and its label).
            seen.insert((control.name.clone(), x as i64 / 10, y as i64 / 10))
                .then(|| Control {
                    name: control.name.clone(),
                    role: control.role,
                    x,
                    y,
                })
        })
        .collect()
}

/// A click at `at` (system units) lands inside a control that was read.
pub fn on_a_control(at: (f64, f64)) -> bool {
    LAST.lock()
        .map(|boxes| {
            boxes.iter().any(|b| {
                at.0 >= b.x && at.1 >= b.y && at.0 <= b.x + b.width && at.1 <= b.y + b.height
            })
        })
        .unwrap_or(false)
}

/// The buttons, links, tabs, menu items and fields of the window that was
/// in front when Ask ZOOD was called, in thousandths of the screen (or of
/// the window, when a picture of it was taken). Empty when the app lists
/// none; then the island looks with the picture instead, as before.
#[tauri::command]
pub async fn ask_controls<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AskState>,
) -> Result<Vec<Control>, String> {
    let front = state
        .moment
        .lock()
        .map(|moment| moment.front.clone())
        .map_err(|e| e.to_string())?;
    let (monitor, window) =
        super::guide::areas(&state).ok_or_else(|| "E_ASK: no screen to look at".to_string())?;
    let handle = front.handle();
    let raw = tauri::async_runtime::spawn_blocking(move || reach::read(handle))
        .await
        .map_err(|e| format!("E_ASK: {e}"))??;
    if let Ok(mut last) = LAST.lock() {
        *last = raw
            .iter()
            .map(|r| Area {
                x: r.left,
                y: r.top,
                width: r.width,
                height: r.height,
            })
            .collect();
    }
    Ok(placed(&raw, window.unwrap_or(monitor)))
}

/// The controls read last are forgotten, when the island goes.
pub fn forget() {
    if let Ok(mut last) = LAST.lock() {
        last.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(name: &str, left: f64, top: f64) -> Raw {
        Raw {
            name: name.to_string(),
            role: "button",
            left,
            top,
            width: 40.0,
            height: 20.0,
        }
    }

    #[test]
    fn controls_are_placed_by_their_middles_on_the_area() {
        let area = Area {
            x: 100.0,
            y: 0.0,
            width: 1000.0,
            height: 500.0,
        };
        let placed = placed(
            &[
                raw("Print", 180.0, 240.0),
                raw("Print", 181.0, 241.0),
                raw("Off the screen", 2000.0, 10.0),
            ],
            area,
        );
        assert_eq!(
            placed,
            vec![Control {
                name: "Print".to_string(),
                role: "button",
                x: 100.0,
                y: 500.0
            }]
        );
    }

    #[test]
    fn a_click_outside_zood_lands_only_on_a_control_read() {
        *LAST.lock().unwrap() = vec![Area {
            x: 10.0,
            y: 10.0,
            width: 40.0,
            height: 20.0,
        }];
        assert!(on_a_control((30.0, 20.0)));
        assert!(!on_a_control((80.0, 20.0)));
        forget();
        assert!(!on_a_control((30.0, 20.0)));
    }
}
