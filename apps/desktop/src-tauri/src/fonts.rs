//! Fonts installed on this computer, for an edit that should be drawn in
//! the family its paragraph was set in (`packages/ui/src/edit/fontMatch.ts`,
//! step B). The work is the core's (`warraq_text::installed`): the system's
//! and the person's font folders are read — never a network — and the face
//! found is handed back as a font file of its own, only when its licence
//! allows embedding and it has a glyph for every character of the text.
//!
//! The family's name comes from a PDF and is treated as hostile: it is only
//! ever compared, letter for letter, with the names the installed fonts
//! give themselves — never put in a path.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::State;
use warraq_text::installed::{self, Installed};

/// A list this old is read again when a family is not found in it: the
/// person may have just installed the font the notice named.
const STALE_AFTER: Duration = Duration::from_secs(20);
/// The text checked for glyphs is a paragraph, not a book.
const MAX_TEXT_CHARS: usize = 20_000;

type Listing = (Instant, Arc<Vec<Installed>>);

/// The installed faces, listed once and kept: reading a few kilobytes of
/// every font file takes a fraction of a second, not nothing.
#[derive(Default)]
pub struct FontState(Mutex<Option<Listing>>);

impl FontState {
    fn listing(&self, fresh: bool) -> Listing {
        let mut kept = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match kept.as_ref() {
            Some(listing) if !fresh => listing.clone(),
            _ => {
                let listing = (
                    Instant::now(),
                    Arc::new(installed::scan(&installed::system_font_dirs())),
                );
                *kept = Some(listing.clone());
                listing
            }
        }
    }
}

/// The installed font for `family` at `weight` and slant that can draw
/// `text`, as a font file; an empty answer when there is none (the caller
/// goes on to its next source).
#[tauri::command(async)]
pub fn font_installed(
    state: State<'_, FontState>,
    family: String,
    weight: u16,
    italic: bool,
    text: String,
) -> Result<tauri::ipc::Response, String> {
    let text: String = text.chars().take(MAX_TEXT_CHARS).collect();
    let weight = weight.clamp(100, 900);
    let (read_at, faces) = state.listing(false);
    let mut found = installed::find(&faces, &family, weight, italic, &text);
    if found.is_none() && read_at.elapsed() > STALE_AFTER {
        let (_, faces) = state.listing(true);
        found = installed::find(&faces, &family, weight, italic, &text);
    }
    Ok(tauri::ipc::Response::new(
        found.map(|f| f.bytes).unwrap_or_default(),
    ))
}
