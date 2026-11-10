//! The main window's documents when it last stood: which files were open in
//! its tabs, in what order, in which tab groups, on which page, and which one
//! was in front. The next start opens them again where they were, as a
//! browser does ("pick up where you left off"; owner, 2026-11-10).
//!
//! The same rule as the recent files (`recent.rs`): a path is kept only while
//! it is in the file scope, that is, a file the person chose in the open
//! panel, dropped on the window or opened from Explorer or Finder. The
//! webview cannot make the host remember, and so later read, a file nobody
//! chose. Reading the session back puts each file that is still there into
//! the scope again, and leaves out the ones moved or deleted since.
//!
//! Everything is bounded: a damaged or hand-edited file can never make the
//! interface open hundreds of files or draw a name a page long.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_fs::FsExt;

const FILE_NAME: &str = "session.json";
/// The interface's own limit is twelve tabs (`MAX_TABS`); a few more cost nothing.
const MAX_TABS: usize = 16;
const MAX_GROUPS: usize = 16;
const MAX_PATH: usize = 4096;
const MAX_GROUP_NAME: usize = 60;
const MAX_PAGE: u32 = 1_000_000;
/// The colours a tab group may have (`packages/ui/src/state/tabs.ts`).
const COLOURS: [&str; 8] = [
    "grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub path: String,
    /// 1-based.
    pub page: u32,
    /// The id of its group, if it is in one.
    #[serde(default)]
    pub group: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    pub id: u32,
    pub name: String,
    pub colour: String,
    #[serde(default)]
    pub collapsed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub tabs: Vec<SessionTab>,
    #[serde(default)]
    pub groups: Vec<SessionGroup>,
    /// The index (in `tabs`) of the one in front.
    #[serde(default)]
    pub active: Option<usize>,
}

/// The lock that keeps two writes from crossing.
#[derive(Default)]
pub struct SessionState(pub Mutex<()>);

/// The session cut down to what is allowed: bounded lists, names and pages;
/// groups only with a known colour and only while a tab is in them; a tab's
/// group only when that group is kept; the front tab only when it exists.
pub fn tidy(mut session: Session) -> Session {
    session
        .tabs
        .retain(|tab| !tab.path.is_empty() && tab.path.len() <= MAX_PATH);
    session.tabs.truncate(MAX_TABS);
    for tab in &mut session.tabs {
        tab.page = tab.page.clamp(1, MAX_PAGE);
    }
    session.groups.truncate(MAX_GROUPS);
    let mut seen = Vec::new();
    session.groups.retain(|group| {
        let fresh = !seen.contains(&group.id);
        seen.push(group.id);
        fresh && COLOURS.contains(&group.colour.as_str())
    });
    for group in &mut session.groups {
        if group.name.chars().count() > MAX_GROUP_NAME {
            group.name = group.name.chars().take(MAX_GROUP_NAME).collect();
        }
    }
    let kept: Vec<u32> = session.groups.iter().map(|group| group.id).collect();
    for tab in &mut session.tabs {
        if tab.group.is_some_and(|id| !kept.contains(&id)) {
            tab.group = None;
        }
    }
    session
        .groups
        .retain(|group| session.tabs.iter().any(|tab| tab.group == Some(group.id)));
    if session.active.is_some_and(|at| at >= session.tabs.len()) {
        session.active = None;
    }
    session
}

/// Only the tabs whose file passes `keep`; the front tab follows its file
/// (or is dropped with it), and groups left empty go.
pub fn keep_tabs(session: Session, keep: impl Fn(&str) -> bool) -> Session {
    let front = session
        .active
        .and_then(|at| session.tabs.get(at))
        .map(|tab| tab.path.clone());
    let tabs: Vec<SessionTab> = session
        .tabs
        .into_iter()
        .filter(|tab| keep(&tab.path))
        .collect();
    let active = front.and_then(|path| tabs.iter().position(|tab| tab.path == path));
    tidy(Session {
        tabs,
        groups: session.groups,
        active,
    })
}

/// Reads the session back; a missing or unreadable file is no session.
pub fn load(file: &Path) -> Session {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Session>(&bytes).ok())
        .map(tidy)
        .unwrap_or_default()
}

/// Writes beside the old one and renames it over it, so a crash halfway
/// leaves the old session whole.
pub fn store(file: &Path, session: &Session) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(session).map_err(std::io::Error::other)?;
    let temp = file.with_extension("json.writing");
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, file).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

fn session_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("E_IO: no data directory for this app: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("E_IO: {}: {e}", dir.display()))?;
    Ok(dir.join(FILE_NAME))
}

/// Keeps the main window's tabs. A file the person did not choose (outside
/// the file scope) is left out, never refused as a whole: the rest still count.
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn session_save<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    state: State<'_, SessionState>,
    session: Session,
) -> Result<(), String> {
    // A document window (`doc_window.rs`) is one file, not the session.
    if window.label() != "main" {
        return Ok(());
    }
    let scope = app.fs_scope();
    let session = keep_tabs(tidy(session), |path| {
        let file = Path::new(path);
        file.is_absolute() && scope.is_allowed(file)
    });
    let _guard = state.0.lock().map_err(|_| "E_STATE: lock poisoned")?;
    let target = session_file(&app)?;
    store(&target, &session).map_err(|e| format!("E_IO: {}: {e}", target.display()))
}

/// The tabs as they were left, with only the files still there, each put
/// back in the file scope so the interface reads it as any chosen file.
// Off the main thread on Windows, where it draws every window (`stall.rs`).
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn session_load<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    state: State<'_, SessionState>,
) -> Result<Session, String> {
    if window.label() != "main" {
        return Ok(Session::default());
    }
    let _guard = state.0.lock().map_err(|_| "E_STATE: lock poisoned")?;
    let session = load(&session_file(&app)?);
    let scope = app.fs_scope();
    Ok(keep_tabs(session, |path| {
        let file = Path::new(path);
        file.is_absolute() && file.is_file() && scope.allow_file(file).is_ok()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(path: &str, group: Option<u32>) -> SessionTab {
        SessionTab {
            path: path.into(),
            page: 1,
            group,
        }
    }

    fn group(id: u32, colour: &str) -> SessionGroup {
        SessionGroup {
            id,
            name: "Work".into(),
            colour: colour.into(),
            collapsed: false,
        }
    }

    #[test]
    fn the_front_tab_follows_its_file_when_others_go() {
        let session = Session {
            tabs: vec![
                tab("/a.pdf", None),
                tab("/b.pdf", None),
                tab("/c.pdf", None),
            ],
            groups: vec![],
            active: Some(2),
        };
        let kept = keep_tabs(session, |path| path != "/a.pdf");
        assert_eq!(kept.tabs.len(), 2);
        assert_eq!(kept.active, Some(1));
        assert_eq!(kept.tabs[1].path, "/c.pdf");
    }

    #[test]
    fn the_front_tab_goes_with_its_file() {
        let session = Session {
            tabs: vec![tab("/a.pdf", None), tab("/b.pdf", None)],
            groups: vec![],
            active: Some(0),
        };
        assert_eq!(keep_tabs(session, |path| path != "/a.pdf").active, None);
    }

    #[test]
    fn empty_groups_and_unknown_colours_go() {
        let session = Session {
            tabs: vec![tab("/a.pdf", Some(1)), tab("/b.pdf", Some(2))],
            groups: vec![group(1, "blue"), group(2, "#ff0000"), group(3, "red")],
            active: None,
        };
        let tidied = tidy(session);
        assert_eq!(tidied.groups, vec![group(1, "blue")]);
        assert_eq!(tidied.tabs[1].group, None);
    }

    #[test]
    fn a_group_left_without_tabs_goes() {
        let session = Session {
            tabs: vec![tab("/a.pdf", Some(1)), tab("/b.pdf", None)],
            groups: vec![group(1, "green")],
            active: Some(1),
        };
        let kept = keep_tabs(session, |path| path != "/a.pdf");
        assert!(kept.groups.is_empty());
        assert_eq!(kept.active, Some(0));
    }

    #[test]
    fn everything_is_bounded() {
        let session = Session {
            tabs: (0..40).map(|n| tab(&format!("/{n}.pdf"), None)).collect(),
            groups: vec![SessionGroup {
                id: 1,
                name: "x".repeat(500),
                colour: "red".into(),
                collapsed: true,
            }],
            active: Some(39),
        };
        let mut session = session;
        session.tabs[0].group = Some(1);
        session.tabs[1].page = 0;
        session.tabs[2].page = u32::MAX;
        let tidied = tidy(session);
        assert_eq!(tidied.tabs.len(), MAX_TABS);
        assert_eq!(tidied.active, None);
        assert_eq!(tidied.groups[0].name.chars().count(), MAX_GROUP_NAME);
        assert_eq!(tidied.tabs[1].page, 1);
        assert_eq!(tidied.tabs[2].page, MAX_PAGE);
    }

    #[test]
    fn a_damaged_file_is_no_session() {
        let dir = std::env::temp_dir().join(format!("zood-session-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("session.json");
        std::fs::write(&file, b"{not json").unwrap();
        assert_eq!(load(&file), Session::default());
        let session = Session {
            tabs: vec![tab("/a.pdf", Some(4))],
            groups: vec![group(4, "cyan")],
            active: Some(0),
        };
        store(&file, &session).unwrap();
        assert_eq!(load(&file), session);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
