//! The quick tools in File Explorer's right-click menu, for the copy of ZOOD
//! PDF installed from the Microsoft Store.
//!
//! The installer copy writes its menu into the person's registry classes
//! (`src/shell_menu.rs`). A Store package cannot: its registry writes stay
//! inside the package, where Explorer never looks. A package declares its
//! menu entries instead (`windows/store/AppxManifest.xml`), each one a COM
//! class that Explorer loads from this DLL. As a bonus, Windows 11 shows
//! these in its short menu, not only under "Show more options".
pub mod menu;

#[cfg(windows)]
mod com;
