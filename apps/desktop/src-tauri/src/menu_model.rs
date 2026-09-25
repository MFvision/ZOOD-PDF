//! The web layer's menu model (JSON), parsed and validated before a native menu is built.
//!
//! The model is untrusted in the sense that it crosses the IPC boundary: sizes are bounded,
//! ids are restricted, labels may not carry control characters, accelerators are checked
//! against a closed vocabulary so the native builder never fails half way.

use serde::Deserialize;
use std::collections::HashSet;

pub const MAX_MODEL_BYTES: usize = 64 * 1024;
pub const MAX_TOP_LEVEL_MENUS: usize = 12;
pub const MAX_ITEMS: usize = 300;
pub const MAX_DEPTH: usize = 4;
pub const MAX_LABEL_CHARS: usize = 120;
pub const MAX_ID_CHARS: usize = 64;
pub const MAX_ACCELERATOR_CHARS: usize = 40;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MenuModel {
    /// Optional application menu (macOS always shows the first submenu as the app menu).
    #[serde(default, rename = "appMenu")]
    pub app_menu: Option<MenuSection>,
    pub menus: Vec<MenuSection>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MenuSection {
    pub label: String,
    pub items: Vec<MenuEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Maximize,
    Fullscreen,
    CloseWindow,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MenuEntry {
    Item {
        id: String,
        label: String,
        #[serde(default)]
        accelerator: Option<String>,
        #[serde(default = "yes")]
        enabled: bool,
        #[serde(default)]
        checked: Option<bool>,
    },
    Separator,
    Submenu {
        label: String,
        items: Vec<MenuEntry>,
    },
    Role {
        role: Role,
        #[serde(default)]
        label: Option<String>,
    },
}

fn yes() -> bool {
    true
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MenuError {
    #[error("menu model is larger than {MAX_MODEL_BYTES} bytes")]
    TooLarge,
    #[error("menu model is not valid JSON for the schema: {0}")]
    Json(String),
    #[error("too many top-level menus")]
    TooManyMenus,
    #[error("too many menu items")]
    TooManyItems,
    #[error("menus nested deeper than {MAX_DEPTH}")]
    TooDeep,
    #[error("invalid label: {0:?}")]
    BadLabel(String),
    #[error("invalid id: {0:?}")]
    BadId(String),
    #[error("duplicate id: {0:?}")]
    DuplicateId(String),
    #[error("invalid accelerator: {0:?}")]
    BadAccelerator(String),
}

const MODIFIERS: &[&str] = &[
    "cmdorctrl",
    "commandorcontrol",
    "cmd",
    "command",
    "super",
    "meta",
    "ctrl",
    "control",
    "alt",
    "option",
    "shift",
];

const NAMED_KEYS: &[&str] = &[
    "enter",
    "return",
    "escape",
    "esc",
    "backspace",
    "delete",
    "tab",
    "space",
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "pageup",
    "pagedown",
    "plus",
    "minus",
    "equal",
    "comma",
    "period",
    "slash",
    "backslash",
    "semicolon",
    "quote",
    "backquote",
    "bracketleft",
    "bracketright",
    "insert",
];

pub fn is_valid_accelerator(acc: &str) -> bool {
    if acc.is_empty() || acc.chars().count() > MAX_ACCELERATOR_CHARS {
        return false;
    }
    let parts: Vec<&str> = acc.split('+').collect();
    let Some((key, mods)) = parts.split_last() else {
        return false;
    };
    let mut seen = HashSet::new();
    for m in mods {
        let m = m.to_ascii_lowercase();
        if !MODIFIERS.contains(&m.as_str()) || !seen.insert(m) {
            return false;
        }
    }
    let k = key.to_ascii_lowercase();
    let single = k.chars().count() == 1
        && k.chars()
            .all(|c| c.is_ascii_alphanumeric() || "=-,./;'[]\\`".contains(c));
    let function = k
        .strip_prefix('f')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=24).contains(&n));
    single || function || NAMED_KEYS.contains(&k.as_str())
}

fn check_label(label: &str) -> Result<(), MenuError> {
    let n = label.chars().count();
    if label.trim().is_empty() || n > MAX_LABEL_CHARS || label.chars().any(char::is_control) {
        return Err(MenuError::BadLabel(
            label.chars().take(MAX_LABEL_CHARS).collect(),
        ));
    }
    Ok(())
}

fn check_id(id: &str) -> Result<(), MenuError> {
    let ok = !id.is_empty()
        && id.len() <= MAX_ID_CHARS
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    if ok {
        Ok(())
    } else {
        Err(MenuError::BadId(id.chars().take(MAX_ID_CHARS).collect()))
    }
}

struct Walk {
    items: usize,
    ids: HashSet<String>,
}

impl Walk {
    fn section(&mut self, s: &MenuSection) -> Result<(), MenuError> {
        check_label(&s.label)?;
        self.entries(&s.items, 1)
    }

    fn entries(&mut self, entries: &[MenuEntry], depth: usize) -> Result<(), MenuError> {
        if depth > MAX_DEPTH {
            return Err(MenuError::TooDeep);
        }
        for e in entries {
            self.items += 1;
            if self.items > MAX_ITEMS {
                return Err(MenuError::TooManyItems);
            }
            match e {
                MenuEntry::Item {
                    id,
                    label,
                    accelerator,
                    ..
                } => {
                    check_id(id)?;
                    check_label(label)?;
                    if let Some(a) = accelerator {
                        if !is_valid_accelerator(a) {
                            return Err(MenuError::BadAccelerator(
                                a.chars().take(MAX_ACCELERATOR_CHARS).collect(),
                            ));
                        }
                    }
                    if !self.ids.insert(id.clone()) {
                        return Err(MenuError::DuplicateId(id.clone()));
                    }
                }
                MenuEntry::Separator => {}
                MenuEntry::Submenu { label, items } => {
                    check_label(label)?;
                    self.entries(items, depth + 1)?;
                }
                MenuEntry::Role { label, .. } => {
                    if let Some(l) = label {
                        check_label(l)?;
                    }
                }
            }
        }
        Ok(())
    }
}

pub fn validate(model: &MenuModel) -> Result<(), MenuError> {
    if model.menus.len() > MAX_TOP_LEVEL_MENUS {
        return Err(MenuError::TooManyMenus);
    }
    let mut walk = Walk {
        items: 0,
        ids: HashSet::new(),
    };
    if let Some(app) = &model.app_menu {
        walk.section(app)?;
    }
    for s in &model.menus {
        walk.section(s)?;
    }
    Ok(())
}

pub fn parse_menu_model(json: &str) -> Result<MenuModel, MenuError> {
    if json.len() > MAX_MODEL_BYTES {
        return Err(MenuError::TooLarge);
    }
    let model: MenuModel =
        serde_json::from_str(json).map_err(|e| MenuError::Json(e.to_string()))?;
    validate(&model)?;
    Ok(model)
}

fn has_role(entries: &[MenuEntry], role: Role) -> bool {
    entries.iter().any(|e| match e {
        MenuEntry::Role { role: r, .. } => *r == role,
        MenuEntry::Submenu { items, .. } => has_role(items, role),
        _ => false,
    })
}

/// WKWebView only gets ⌘C/⌘V/⌘X/⌘A/⌘Z when the menu bar carries the matching native
/// items. If the web model has no Copy role, append a standard Edit menu.
pub fn ensure_edit_roles(model: &mut MenuModel, edit_label: &str) {
    if model.menus.iter().any(|s| has_role(&s.items, Role::Copy)) {
        return;
    }
    let role = |role| MenuEntry::Role { role, label: None };
    model.menus.insert(
        model.menus.len().min(1),
        MenuSection {
            label: edit_label.to_owned(),
            items: vec![
                role(Role::Undo),
                role(Role::Redo),
                MenuEntry::Separator,
                role(Role::Cut),
                role(Role::Copy),
                role(Role::Paste),
                role(Role::SelectAll),
            ],
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "menus": [
        { "label": "ملف", "items": [
          { "type": "item", "id": "file.open", "label": "فتح…", "accelerator": "CmdOrCtrl+O" },
          { "type": "item", "id": "file.save", "label": "حفظ", "accelerator": "CmdOrCtrl+S", "enabled": false },
          { "type": "separator" },
          { "type": "submenu", "label": "تصدير", "items": [
            { "type": "item", "id": "export.docx", "label": "Word" }
          ]},
          { "type": "role", "role": "closeWindow", "label": "إغلاق" }
        ]},
        { "label": "عرض", "items": [
          { "type": "item", "id": "view.sidebar", "label": "الشريط الجانبي", "checked": true }
        ]}
      ]
    }"#;

    #[test]
    fn parses_a_localised_model() {
        let m = parse_menu_model(SAMPLE).map_err(|e| e.to_string());
        let m = m.as_ref().map(|m| m.menus.len());
        assert_eq!(m, Ok(2));
    }

    #[test]
    fn item_defaults() {
        let Ok(m) = parse_menu_model(SAMPLE) else {
            unreachable!()
        };
        let first = m.menus.first().and_then(|s| s.items.first()).cloned();
        assert_eq!(
            first,
            Some(MenuEntry::Item {
                id: "file.open".into(),
                label: "فتح…".into(),
                accelerator: Some("CmdOrCtrl+O".into()),
                enabled: true,
                checked: None
            })
        );
    }

    #[test]
    fn rejects_oversized_json() {
        let big = format!(
            "{{\"menus\":[],\"pad\":\"{}\"}}",
            "x".repeat(MAX_MODEL_BYTES)
        );
        assert_eq!(parse_menu_model(&big), Err(MenuError::TooLarge));
    }

    #[test]
    fn rejects_bad_json_and_unknown_types() {
        assert!(matches!(parse_menu_model("{"), Err(MenuError::Json(_))));
        let unknown = r#"{"menus":[{"label":"a","items":[{"type":"script","code":"x"}]}]}"#;
        assert!(matches!(parse_menu_model(unknown), Err(MenuError::Json(_))));
        let bad_role = r#"{"menus":[{"label":"a","items":[{"type":"role","role":"shell"}]}]}"#;
        assert!(matches!(
            parse_menu_model(bad_role),
            Err(MenuError::Json(_))
        ));
    }

    fn item(id: &str) -> String {
        format!(r#"{{"type":"item","id":"{id}","label":"x"}}"#)
    }

    #[test]
    fn bounds_item_count() {
        let items: Vec<String> = (0..=MAX_ITEMS).map(|i| item(&format!("i{i}"))).collect();
        let json = format!(
            r#"{{"menus":[{{"label":"a","items":[{}]}}]}}"#,
            items.join(",")
        );
        assert_eq!(parse_menu_model(&json), Err(MenuError::TooManyItems));
    }

    #[test]
    fn bounds_top_level_menus() {
        let menus: Vec<String> = (0..=MAX_TOP_LEVEL_MENUS)
            .map(|_| r#"{"label":"a","items":[]}"#.to_owned())
            .collect();
        let json = format!(r#"{{"menus":[{}]}}"#, menus.join(","));
        assert_eq!(parse_menu_model(&json), Err(MenuError::TooManyMenus));
    }

    #[test]
    fn bounds_depth() {
        let mut inner = item("deep");
        for _ in 0..MAX_DEPTH {
            inner = format!(r#"{{"type":"submenu","label":"s","items":[{inner}]}}"#);
        }
        let json = format!(r#"{{"menus":[{{"label":"a","items":[{inner}]}}]}}"#);
        assert_eq!(parse_menu_model(&json), Err(MenuError::TooDeep));
    }

    #[test]
    fn rejects_bad_ids_labels_and_duplicates() {
        let bad_id =
            r#"{"menus":[{"label":"a","items":[{"type":"item","id":"a b","label":"x"}]}]}"#;
        assert!(matches!(parse_menu_model(bad_id), Err(MenuError::BadId(_))));
        let empty = r#"{"menus":[{"label":"  ","items":[]}]}"#;
        assert!(matches!(
            parse_menu_model(empty),
            Err(MenuError::BadLabel(_))
        ));
        let ctrl = r#"{"menus":[{"label":"a\u0007","items":[]}]}"#;
        assert!(matches!(
            parse_menu_model(ctrl),
            Err(MenuError::BadLabel(_))
        ));
        let long = format!(
            r#"{{"menus":[{{"label":"{}","items":[]}}]}}"#,
            "ز".repeat(MAX_LABEL_CHARS + 1)
        );
        assert!(matches!(
            parse_menu_model(&long),
            Err(MenuError::BadLabel(_))
        ));
        let dup = format!(
            r#"{{"menus":[{{"label":"a","items":[{},{}]}}]}}"#,
            item("x"),
            item("x")
        );
        assert_eq!(
            parse_menu_model(&dup),
            Err(MenuError::DuplicateId("x".into()))
        );
    }

    #[test]
    fn accelerators() {
        for ok in [
            "CmdOrCtrl+O",
            "CmdOrCtrl+Shift+S",
            "Alt+F4",
            "F11",
            "CmdOrCtrl+=",
            "Ctrl+PageDown",
        ] {
            assert!(is_valid_accelerator(ok), "{ok}");
        }
        for bad in [
            "",
            "CmdOrCtrl+",
            "Hyper+O",
            "Ctrl+Ctrl+O",
            "CmdOrCtrl+ز",
            "F25",
            "Ctrl+OO",
        ] {
            assert!(!is_valid_accelerator(bad), "{bad}");
        }
        let json = r#"{"menus":[{"label":"a","items":[{"type":"item","id":"a","label":"x","accelerator":"Boom+1"}]}]}"#;
        assert!(matches!(
            parse_menu_model(json),
            Err(MenuError::BadAccelerator(_))
        ));
    }

    #[test]
    fn app_menu_is_validated_too() {
        let json = r#"{"appMenu":{"label":"","items":[]},"menus":[]}"#;
        assert!(matches!(
            parse_menu_model(json),
            Err(MenuError::BadLabel(_))
        ));
    }

    #[test]
    fn adds_an_edit_menu_when_copy_is_missing() {
        let Ok(mut m) = parse_menu_model(SAMPLE) else {
            unreachable!()
        };
        ensure_edit_roles(&mut m, "تحرير");
        assert_eq!(m.menus.len(), 3);
        assert_eq!(m.menus.get(1).map(|s| s.label.as_str()), Some("تحرير"));
        assert!(has_role(
            &m.menus.get(1).map(|s| s.items.clone()).unwrap_or_default(),
            Role::Paste
        ));
        // Idempotent.
        ensure_edit_roles(&mut m, "تحرير");
        assert_eq!(m.menus.len(), 3);
    }
}
