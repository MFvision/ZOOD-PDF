//! The macOS menu bar.
//!
//! On macOS the app uses the system's menu bar instead of the one the web UI
//! draws in the page. Its items come from the same model the page's menu bar
//! is drawn from (`packages/ui/src/shell/menuModel.ts`): the UI sends it here
//! with [`set_menu`] whenever it changes — labels in the interface's language,
//! accelerators, which items are enabled and checked — and an item chosen
//! here is sent back as [`MENU_EVENT`] with its id, so the page runs the very
//! same code its own menu would.
//!
//! Around those items this module adds what every Mac app has and the page
//! cannot provide: the application menu's system items (Services, Hide, Hide
//! Others, Show All, Quit; About and Settings… are the model's), the clipboard
//! items with their system roles (Cut, Copy, Paste, Select All go to the first
//! responder, so they work in any text field), Enter Full Screen, and the
//! Window menu.
//!
//! Undo and Redo are the model's own items rather than the system roles: a
//! system Undo reaches only the web view's text fields, never the document's
//! history, so choosing it from the menu would have done nothing to a drawing
//! or an edit. While a text field has the focus the page enables them by what
//! its typing can undo and sends them there (`packages/ui/src/shell/typing.ts`),
//! and it handles ⌘Z itself, so typing in a field is undone either way.
//!
//! A shortcut never runs twice: WebKit gives the page the first look at a key
//! equivalent and passes it to the menu only if the page did not handle it;
//! the UI also drops a menu event that echoes a key it just handled
//! (`packages/ui/src/shell/shortcutEcho.ts`).

use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{
    CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Sent to the webview when a menu item from the UI's model is chosen.
/// Payload: the item's id, as the model has it.
pub const MENU_EVENT: &str = "warraq://menu";

/// Ids of the model's items are namespaced so they can never collide with the
/// ids the system items get.
const PREFIX: &str = "warraq:";

/// The labels of the items the host adds, in the interface's language.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Labels {
    pub app_name: String,
    pub services: String,
    pub hide: String,
    pub hide_others: String,
    pub show_all: String,
    pub quit: String,
    pub window: String,
    pub minimize: String,
    pub zoom: String,
    pub bring_all_to_front: String,
    pub fullscreen: String,
    pub close_window: String,
    pub cut: String,
    pub copy: String,
    pub paste: String,
    pub select_all: String,
}

/// One item of the model.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSpec {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub accelerator: Option<String>,
    pub enabled: bool,
    /// Present on check and radio items only.
    #[serde(default)]
    pub checked: Option<bool>,
    #[serde(default)]
    pub separator_before: bool,
}

/// One menu of the model: `app`, `file`, `edit`, `view`, `tools`, `help`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SubmenuSpec {
    pub id: String,
    pub label: String,
    pub items: Vec<ItemSpec>,
}

/// The whole menu bar, as the UI sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MenuSpec {
    pub labels: Labels,
    pub menus: Vec<SubmenuSpec>,
}

impl MenuSpec {
    /// What needs a rebuild when it changes — every label, id, accelerator and
    /// kind of item — without what can be updated in place: enabled, checked.
    pub fn shape(&self) -> MenuSpec {
        let mut shape = self.clone();
        for item in shape
            .menus
            .iter_mut()
            .flat_map(|menu| menu.items.iter_mut())
        {
            item.enabled = true;
            item.checked = item.checked.map(|_| false);
        }
        shape
    }

    fn menu(&self, id: &str) -> Option<&SubmenuSpec> {
        self.menus.iter().find(|menu| menu.id == id)
    }
}

/// The shape of the menu bar last built, so an update that only enables,
/// disables or checks items does not rebuild it (which would close a menu the
/// person has open).
#[derive(Default)]
pub struct MenuState(Mutex<Option<MenuSpec>>);

/// The model's id for a menu event, or `None` for the host's own items.
pub fn model_id(event_id: &str) -> Option<&str> {
    event_id.strip_prefix(PREFIX)
}

fn item_id(id: &str) -> String {
    format!("{PREFIX}{id}")
}

/// Appends one of the model's items, with its separator.
fn append_item<R: Runtime>(
    app: &AppHandle<R>,
    submenu: &Submenu<R>,
    item: &ItemSpec,
) -> tauri::Result<()> {
    if item.separator_before {
        submenu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    let id = item_id(&item.id);
    let accelerator = item.accelerator.as_deref();
    match item.checked {
        Some(checked) => submenu.append(&CheckMenuItem::with_id(
            app,
            id,
            &item.label,
            item.enabled,
            checked,
            accelerator,
        )?),
        None => submenu.append(&MenuItem::with_id(
            app,
            id,
            &item.label,
            item.enabled,
            accelerator,
        )?),
    }
}

fn model_submenu<R: Runtime>(app: &AppHandle<R>, spec: &SubmenuSpec) -> tauri::Result<Submenu<R>> {
    let submenu = Submenu::with_id(app, format!("{PREFIX}menu-{}", spec.id), &spec.label, true)?;
    for item in &spec.items {
        append_item(app, &submenu, item)?;
    }
    Ok(submenu)
}

/// What the application menu holds, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AppEntry<'a> {
    /// One of the model's items, run by the page like any other.
    Model(&'a ItemSpec),
    Separator,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
}

/// The application menu: the model's About and Settings…, then the system's
/// items (Services, Hide, Hide Others, Show All, Quit).
///
/// About is the page's own sheet, not the system's panel: that one knew only
/// the name and version, and choosing it never reached the page, so on the
/// Mac nothing showed the core's version or the engine drawing the pages —
/// the one sign that PDFium did not load — nor what the app keeps private.
fn application_entries(spec: &MenuSpec) -> Vec<AppEntry<'_>> {
    let items = spec
        .menu("app")
        .map(|menu| menu.items.as_slice())
        .unwrap_or_default();
    let mut entries: Vec<AppEntry<'_>> = items.iter().map(AppEntry::Model).collect();
    entries.extend([
        AppEntry::Separator,
        AppEntry::Services,
        AppEntry::Separator,
        AppEntry::Hide,
        AppEntry::HideOthers,
        AppEntry::ShowAll,
        AppEntry::Separator,
        AppEntry::Quit,
    ]);
    entries
}

/// Builds the whole menu bar from the UI's model.
pub fn build<R: Runtime>(app: &AppHandle<R>, spec: &MenuSpec) -> tauri::Result<Menu<R>> {
    let labels = &spec.labels;
    let menu = Menu::new(app)?;

    let application = Submenu::new(app, &labels.app_name, true)?;
    for entry in application_entries(spec) {
        match entry {
            AppEntry::Model(item) => append_item(app, &application, item)?,
            AppEntry::Separator => application.append(&PredefinedMenuItem::separator(app)?)?,
            AppEntry::Services => {
                application.append(&PredefinedMenuItem::services(app, Some(&labels.services))?)?
            }
            AppEntry::Hide => {
                application.append(&PredefinedMenuItem::hide(app, Some(&labels.hide))?)?
            }
            AppEntry::HideOthers => application.append(&PredefinedMenuItem::hide_others(
                app,
                Some(&labels.hide_others),
            )?)?,
            AppEntry::ShowAll => {
                application.append(&PredefinedMenuItem::show_all(app, Some(&labels.show_all))?)?
            }
            AppEntry::Quit => {
                application.append(&PredefinedMenuItem::quit(app, Some(&labels.quit))?)?
            }
        }
    }
    menu.append(&application)?;

    for spec_menu in spec.menus.iter().filter(|menu| menu.id != "app") {
        let submenu = if spec_menu.id == "help" {
            // The system puts its search field in the menu it knows as Help.
            let help = Submenu::with_id(app, HELP_SUBMENU_ID, &spec_menu.label, true)?;
            for item in &spec_menu.items {
                append_item(app, &help, item)?;
            }
            help
        } else {
            model_submenu(app, spec_menu)?
        };
        if spec_menu.id == "edit" {
            // The clipboard, with the system's roles, after Undo and Redo.
            let clipboard = [
                PredefinedMenuItem::separator(app)?,
                PredefinedMenuItem::cut(app, Some(&labels.cut))?,
                PredefinedMenuItem::copy(app, Some(&labels.copy))?,
                PredefinedMenuItem::paste(app, Some(&labels.paste))?,
                PredefinedMenuItem::select_all(app, Some(&labels.select_all))?,
            ];
            let after = spec_menu
                .items
                .iter()
                .take_while(|item| item.id != "redo")
                .count()
                + 1;
            let mut position = after.min(spec_menu.items.len());
            // Separators the model asked for before the items so far shift the index.
            position += spec_menu.items[..position]
                .iter()
                .filter(|item| item.separator_before)
                .count();
            for (offset, item) in clipboard.iter().enumerate() {
                submenu.insert(item, position + offset)?;
            }
        }
        if spec_menu.id == "view" {
            submenu.append(&PredefinedMenuItem::separator(app)?)?;
            submenu.append(&PredefinedMenuItem::fullscreen(
                app,
                Some(&labels.fullscreen),
            )?)?;
        }
        if spec_menu.id == "help" {
            // The Window menu comes before Help, as on every Mac.
            menu.append(&window_menu(app, labels)?)?;
        }
        menu.append(&submenu)?;
    }
    if spec.menu("help").is_none() {
        menu.append(&window_menu(app, labels)?)?;
    }
    Ok(menu)
}

fn window_menu<R: Runtime>(app: &AppHandle<R>, labels: &Labels) -> tauri::Result<Submenu<R>> {
    let window = Submenu::with_id(app, WINDOW_SUBMENU_ID, &labels.window, true)?;
    window.append(&PredefinedMenuItem::minimize(app, Some(&labels.minimize))?)?;
    window.append(&PredefinedMenuItem::maximize(app, Some(&labels.zoom))?)?;
    window.append(&PredefinedMenuItem::separator(app)?)?;
    window.append(&PredefinedMenuItem::bring_all_to_front(
        app,
        Some(&labels.bring_all_to_front),
    )?)?;
    window.append(&PredefinedMenuItem::separator(app)?)?;
    window.append(&PredefinedMenuItem::close_window(
        app,
        Some(&labels.close_window),
    )?)?;
    Ok(window)
}

/// Enables, disables and checks the items of the menu bar in place.
fn update_states<R: Runtime>(menu: &Menu<R>, spec: &MenuSpec) -> tauri::Result<()> {
    let submenus: Vec<Submenu<R>> = menu
        .items()?
        .into_iter()
        .filter_map(|item| match item {
            MenuItemKind::Submenu(submenu) => Some(submenu),
            _ => None,
        })
        .collect();
    for item in spec.menus.iter().flat_map(|menu| menu.items.iter()) {
        let id = item_id(&item.id);
        let Some(found) = submenus.iter().find_map(|submenu| submenu.get(&id)) else {
            continue;
        };
        match found {
            MenuItemKind::MenuItem(entry) => entry.set_enabled(item.enabled)?,
            MenuItemKind::Check(entry) => {
                entry.set_enabled(item.enabled)?;
                entry.set_checked(item.checked.unwrap_or(false))?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// The UI's menu model, sent on every change. Rebuilt when labels, items or
/// accelerators change (the language, a tool added); otherwise only which
/// items are enabled and checked is updated.
#[tauri::command]
pub fn set_menu<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, MenuState>,
    spec: MenuSpec,
) -> Result<(), String> {
    let shape = spec.shape();
    let mut built = state.0.lock().map_err(|e| e.to_string())?;
    let current = app.menu();
    match current {
        Some(menu) if built.as_ref() == Some(&shape) => {
            update_states(&menu, &spec).map_err(|e| e.to_string())
        }
        _ => {
            let menu = build(&app, &spec).map_err(|e| e.to_string())?;
            app.set_menu(menu).map_err(|e| e.to_string())?;
            *built = Some(shape);
            Ok(())
        }
    }
}

/// Forwards the model's items to the webview; the system's items act by themselves.
pub fn forward<R: Runtime>(app: &AppHandle<R>, event_id: &str) {
    if let Some(id) = model_id(event_id) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit(MENU_EVENT, id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> MenuSpec {
        serde_json::from_str(include_str!("../tests/menu_spec.json")).expect("menu_spec.json")
    }

    #[test]
    fn the_ui_spec_deserializes() {
        let spec = spec();
        assert_eq!(spec.labels.app_name, "محرر PDF");
        let ids: Vec<&str> = spec.menus.iter().map(|menu| menu.id.as_str()).collect();
        assert_eq!(ids, ["app", "file", "edit", "view", "tools", "help"]);
    }

    #[test]
    fn enabling_or_checking_keeps_the_shape() {
        let before = spec();
        let mut after = before.clone();
        for item in after
            .menus
            .iter_mut()
            .flat_map(|menu| menu.items.iter_mut())
        {
            item.enabled = !item.enabled;
            item.checked = item.checked.map(|checked| !checked);
        }
        assert_eq!(
            before.shape(),
            after.shape(),
            "only states changed: no rebuild"
        );

        let mut relabelled = before.clone();
        relabelled.menus[1].items[0].label = "فتح…".into();
        assert_ne!(
            before.shape(),
            relabelled.shape(),
            "a new label rebuilds the menu"
        );
    }

    /// About is the page's own sheet, which names the core's version and the
    /// engine that draws the pages — the one place a Mac without PDFium says
    /// so. The system's panel knows neither, and the page never heard of it.
    #[test]
    fn about_opens_the_pages_own_sheet() {
        let spec = spec();
        let entries = application_entries(&spec);
        assert!(
            matches!(entries.first(), Some(AppEntry::Model(item)) if item.id == "about"),
            "About is the model's item, sent to the page: {entries:?}"
        );
        assert!(
            matches!(entries.get(1), Some(AppEntry::Model(item)) if item.id == "settings" && item.separator_before),
            "Settings… follows, after a separator"
        );
        assert_eq!(entries.last(), Some(&AppEntry::Quit));
    }

    #[test]
    fn menu_events_are_namespaced() {
        assert_eq!(model_id(&item_id("save")), Some("save"));
        assert_eq!(
            model_id("1234"),
            None,
            "the system's items are not sent to the page"
        );
    }

    /// Every accelerator the UI sends parses; one that did not would be dropped
    /// silently and the menu item would show no shortcut.
    #[test]
    fn every_accelerator_parses() {
        for item in spec().menus.iter().flat_map(|menu| menu.items.iter()) {
            if let Some(accelerator) = &item.accelerator {
                assert!(
                    accelerator
                        .parse::<muda::accelerator::Accelerator>()
                        .is_ok(),
                    "{} has an accelerator muda cannot read: {accelerator}",
                    item.id
                );
            }
        }
    }
}
