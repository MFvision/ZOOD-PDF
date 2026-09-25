//! Builds a native `tauri::menu::Menu` from a validated [`MenuModel`].
//! Clicking a custom item emits `zood://menu` with `{ "id": "<item id>" }` back to the web layer.

use crate::menu_model::{MenuEntry, MenuModel, MenuSection, Role};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, Runtime};

pub const MENU_EVENT: &str = "zood://menu";

enum Built<R: Runtime> {
    Item(MenuItem<R>),
    Check(CheckMenuItem<R>),
    Predefined(PredefinedMenuItem<R>),
    Submenu(Submenu<R>),
}

impl<R: Runtime> Built<R> {
    fn as_item(&self) -> &dyn IsMenuItem<R> {
        match self {
            Self::Item(i) => i,
            Self::Check(i) => i,
            Self::Predefined(i) => i,
            Self::Submenu(i) => i,
        }
    }
}

fn role<R: Runtime, M: Manager<R>>(
    m: &M,
    role: Role,
    label: Option<&str>,
) -> tauri::Result<PredefinedMenuItem<R>> {
    match role {
        Role::About => PredefinedMenuItem::about(m, label, None),
        Role::Services => PredefinedMenuItem::services(m, label),
        Role::Hide => PredefinedMenuItem::hide(m, label),
        Role::HideOthers => PredefinedMenuItem::hide_others(m, label),
        Role::ShowAll => PredefinedMenuItem::show_all(m, label),
        Role::Quit => PredefinedMenuItem::quit(m, label),
        Role::Undo => PredefinedMenuItem::undo(m, label),
        Role::Redo => PredefinedMenuItem::redo(m, label),
        Role::Cut => PredefinedMenuItem::cut(m, label),
        Role::Copy => PredefinedMenuItem::copy(m, label),
        Role::Paste => PredefinedMenuItem::paste(m, label),
        Role::SelectAll => PredefinedMenuItem::select_all(m, label),
        Role::Minimize => PredefinedMenuItem::minimize(m, label),
        Role::Maximize => PredefinedMenuItem::maximize(m, label),
        Role::Fullscreen => PredefinedMenuItem::fullscreen(m, label),
        Role::CloseWindow => PredefinedMenuItem::close_window(m, label),
    }
}

fn entry<R: Runtime, M: Manager<R>>(m: &M, e: &MenuEntry) -> tauri::Result<Built<R>> {
    Ok(match e {
        MenuEntry::Item {
            id,
            label,
            accelerator,
            enabled,
            checked: None,
        } => Built::Item(MenuItem::with_id(
            m,
            id.as_str(),
            label,
            *enabled,
            accelerator.as_deref(),
        )?),
        MenuEntry::Item {
            id,
            label,
            accelerator,
            enabled,
            checked: Some(c),
        } => Built::Check(CheckMenuItem::with_id(
            m,
            id.as_str(),
            label,
            *enabled,
            *c,
            accelerator.as_deref(),
        )?),
        MenuEntry::Separator => Built::Predefined(PredefinedMenuItem::separator(m)?),
        MenuEntry::Submenu { label, items } => Built::Submenu(submenu(m, label, items)?),
        MenuEntry::Role { role: r, label } => Built::Predefined(role(m, *r, label.as_deref())?),
    })
}

fn submenu<R: Runtime, M: Manager<R>>(
    m: &M,
    label: &str,
    items: &[MenuEntry],
) -> tauri::Result<Submenu<R>> {
    let sub = Submenu::new(m, label, true)?;
    for e in items {
        let built = entry(m, e)?;
        sub.append(built.as_item())?;
    }
    Ok(sub)
}

fn default_app_menu(app_name: &str) -> MenuSection {
    let r = |role| MenuEntry::Role { role, label: None };
    MenuSection {
        label: app_name.to_owned(),
        items: vec![
            r(Role::About),
            MenuEntry::Separator,
            r(Role::Services),
            MenuEntry::Separator,
            r(Role::Hide),
            r(Role::HideOthers),
            r(Role::ShowAll),
            MenuEntry::Separator,
            r(Role::Quit),
        ],
    }
}

/// Builds the whole menu bar. On macOS the first submenu is always the application menu,
/// so one is synthesised when the model has none.
pub fn build_menu<R: Runtime, M: Manager<R>>(
    m: &M,
    model: &MenuModel,
    app_name: &str,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(m)?;
    let app = model
        .app_menu
        .clone()
        .unwrap_or_else(|| default_app_menu(app_name));
    menu.append(&submenu(m, &app.label, &app.items)?)?;
    for s in &model.menus {
        menu.append(&submenu(m, &s.label, &s.items)?)?;
    }
    Ok(menu)
}
