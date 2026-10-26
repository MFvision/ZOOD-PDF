//! The COM side: Explorer asks the package's COM surrogate for one of the two
//! classes the manifest declares (`windows/store/AppxManifest.xml`), and gets
//! an `IExplorerCommand` for it. The PDF entry has a submenu of tools; the
//! "Convert to PDF" entry runs at once. Both start the app with the same
//! arguments as the registry menu of the installer copy.
use std::ffi::{c_void, OsString};
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicPtr, AtomicUsize, Ordering};
use std::sync::Arc;

use windows::core::{implement, Interface, Ref, Result, BOOL, GUID, HRESULT, HSTRING, PWSTR};
use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_NOTIMPL, E_POINTER, HINSTANCE, HMODULE,
    S_FALSE, S_OK,
};
use windows::Win32::Globalization::GetUserDefaultUILanguage;
use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFamilyName;
use windows::Win32::System::Com::{CoTaskMemFree, IBindCtx, IClassFactory, IClassFactory_Impl};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::System::SystemServices::DLL_PROCESS_ATTACH;
use windows::Win32::UI::Shell::{
    IEnumExplorerCommand, IEnumExplorerCommand_Impl, IExplorerCommand, IExplorerCommand_Impl,
    IShellItemArray, SHStrDupW, ECF_DEFAULT, ECF_HASSUBCOMMANDS, ECF_SEPARATORBEFORE, ECS_ENABLED,
    ECS_HIDDEN, SIGDN_FILESYSPATH,
};

use crate::menu::{self, Menu};

const CLSID_QUICK: GUID = GUID::from_u128(menu::CLSID_QUICK);
const CLSID_TO_PDF: GUID = GUID::from_u128(menu::CLSID_TO_PDF);

/// This DLL, set when Windows loads it.
static MODULE: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

#[no_mangle]
extern "system" fn DllMain(module: HINSTANCE, reason: u32, _reserved: *mut c_void) -> BOOL {
    if reason == DLL_PROCESS_ATTACH {
        MODULE.store(module.0, Ordering::Relaxed);
    }
    true.into()
}

/// The folder this DLL was installed in: the package's own.
fn install_dir() -> Option<PathBuf> {
    let mut buffer = vec![0u16; 1024];
    // SAFETY: the module handle Windows gave DllMain, and a buffer of ours.
    let len =
        unsafe { GetModuleFileNameW(Some(HMODULE(MODULE.load(Ordering::Relaxed))), &mut buffer) }
            as usize;
    if len == 0 || len >= buffer.len() {
        return None;
    }
    let path = PathBuf::from(OsString::from_wide(&buffer[..len]));
    path.parent().map(PathBuf::from)
}

/// The package's family name: the surrogate's own when it runs as the
/// package, or worked out from where the DLL is installed.
fn family_name() -> Option<String> {
    let mut len = 0u32;
    // SAFETY: a size query, then a read into a buffer of that size.
    unsafe {
        let _ = GetCurrentPackageFamilyName(&mut len, None);
        if len > 0 {
            let mut buffer = vec![0u16; len as usize];
            if GetCurrentPackageFamilyName(&mut len, Some(PWSTR(buffer.as_mut_ptr()))).is_ok() {
                let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
                return Some(String::from_utf16_lossy(&buffer[..end]));
            }
        }
    }
    let dir = install_dir()?;
    menu::family_name(&menu::package_full_name(&dir)?)
}

fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

fn load_menu() -> Menu {
    // SAFETY: no arguments; returns a language id.
    let arabic = menu::is_arabic_language(unsafe { GetUserDefaultUILanguage() });
    menu::load(
        local_app_data().as_deref(),
        family_name().as_deref(),
        arabic,
    )
}

/// The app's icon, as Explorer reads one: `"<exe>",0`.
fn icon() -> Option<String> {
    Some(format!("{},0", install_dir()?.join(menu::EXE).display()))
}

/// Starts the app on the chosen files: through its alias, so it runs as the
/// package, or the copy beside this DLL.
fn launch(tool: Option<&str>, files: &[OsString]) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    let alias = local_app_data().map(|dir| dir.join(r"Microsoft\WindowsApps").join(menu::ALIAS));
    // An alias is a link Windows starts, not a file: look at the link itself.
    let program = alias
        .filter(|alias| std::fs::symlink_metadata(alias).is_ok())
        .or_else(|| install_dir().map(|dir| dir.join(menu::EXE)))
        .ok_or_else(|| windows::core::Error::from(E_POINTER))?;
    std::process::Command::new(program)
        .args(menu::arguments(tool, files))
        .spawn()
        .map(drop)
        .map_err(|e| windows::core::Error::new(E_NOTIMPL, e.to_string()))
}

/// The chosen files' paths. Items that are not files (a phone's, a zip's
/// insides) are left out.
fn files(items: &IShellItemArray) -> Vec<OsString> {
    let mut files = Vec::new();
    // SAFETY: COM calls on a live array; each name Windows allocated is freed.
    unsafe {
        let count = items.GetCount().unwrap_or(0);
        for index in 0..count {
            let Ok(item) = items.GetItemAt(index) else {
                continue;
            };
            let Ok(name) = item.GetDisplayName(SIGDN_FILESYSPATH) else {
                continue;
            };
            files.push(OsString::from_wide(name.as_wide()));
            CoTaskMemFree(Some(name.0 as *const c_void));
        }
    }
    files
}

fn text(value: &str) -> Result<PWSTR> {
    // SAFETY: SHStrDupW copies into memory Explorer frees.
    unsafe { SHStrDupW(&HSTRING::from(value)) }
}

#[derive(Clone)]
enum Entry {
    /// The PDF entry: a submenu.
    Quick,
    /// One tool in it (`items[index]`).
    Tool(usize),
    /// "Convert to PDF".
    ToPdf,
}

#[implement(IExplorerCommand)]
struct Command {
    entry: Entry,
    menu: Arc<Menu>,
}

impl Command {
    fn item(&self) -> Option<&menu::Item> {
        match self.entry {
            Entry::Tool(index) => self.menu.items.get(index),
            _ => None,
        }
    }
}

impl IExplorerCommand_Impl for Command_Impl {
    fn GetTitle(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        match self.entry {
            Entry::Quick => text(&self.menu.title),
            Entry::ToPdf => text(&self.menu.to_pdf),
            Entry::Tool(_) => text(&self.item().map(|i| i.label.clone()).unwrap_or_default()),
        }
    }

    fn GetIcon(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        match (&self.entry, icon()) {
            (Entry::Quick | Entry::ToPdf, Some(icon)) => text(&icon),
            _ => Err(E_NOTIMPL.into()),
        }
    }

    fn GetToolTip(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        Err(E_NOTIMPL.into())
    }

    fn GetCanonicalName(&self) -> Result<GUID> {
        match self.entry {
            Entry::Quick => Ok(CLSID_QUICK),
            Entry::ToPdf => Ok(CLSID_TO_PDF),
            Entry::Tool(_) => Err(E_NOTIMPL.into()),
        }
    }

    fn GetState(&self, _items: Ref<'_, IShellItemArray>, _slow_ok: BOOL) -> Result<u32> {
        Ok(if self.menu.on {
            ECS_ENABLED.0
        } else {
            ECS_HIDDEN.0
        } as u32)
    }

    fn Invoke(&self, items: Ref<'_, IShellItemArray>, _context: Ref<'_, IBindCtx>) -> Result<()> {
        let files = items.as_ref().map(files).unwrap_or_default();
        match self.entry {
            Entry::Quick => launch(None, &files),
            Entry::ToPdf => launch(Some("topdf"), &files),
            Entry::Tool(_) => launch(self.item().and_then(|i| i.tool.as_deref()), &files),
        }
    }

    fn GetFlags(&self) -> Result<u32> {
        let flags = match self.entry {
            Entry::Quick => ECF_HASSUBCOMMANDS,
            Entry::Tool(_) if self.item().is_some_and(|i| i.separator_before) => {
                ECF_SEPARATORBEFORE
            }
            _ => ECF_DEFAULT,
        };
        Ok(flags.0 as u32)
    }

    fn EnumSubCommands(&self) -> Result<IEnumExplorerCommand> {
        let Entry::Quick = self.entry else {
            return Err(E_NOTIMPL.into());
        };
        let commands = (0..self.menu.items.len())
            .map(|index| {
                Command {
                    entry: Entry::Tool(index),
                    menu: self.menu.clone(),
                }
                .into()
            })
            .collect();
        Ok(Commands {
            commands: Rc::new(commands),
            next: AtomicUsize::new(0),
        }
        .into())
    }
}

// The surrogate's classes are single-threaded (ThreadingModel="STA" in the
// manifest), so the submenu's list is shared by `Rc`.
#[implement(IEnumExplorerCommand)]
struct Commands {
    commands: Rc<Vec<IExplorerCommand>>,
    next: AtomicUsize,
}

impl IEnumExplorerCommand_Impl for Commands_Impl {
    fn Next(&self, wanted: u32, out: *mut Option<IExplorerCommand>, fetched: *mut u32) -> HRESULT {
        if out.is_null() {
            return E_POINTER;
        }
        let mut given = 0u32;
        while given < wanted {
            let index = self.next.load(Ordering::Relaxed);
            let Some(command) = self.commands.get(index) else {
                break;
            };
            // SAFETY: Explorer passes room for `wanted` entries.
            unsafe { out.add(given as usize).write(Some(command.clone())) };
            self.next.store(index + 1, Ordering::Relaxed);
            given += 1;
        }
        if !fetched.is_null() {
            // SAFETY: checked just now.
            unsafe { *fetched = given };
        }
        if given == wanted {
            S_OK
        } else {
            S_FALSE
        }
    }

    fn Skip(&self, count: u32) -> Result<()> {
        self.next.fetch_add(count as usize, Ordering::Relaxed);
        Ok(())
    }

    fn Reset(&self) -> Result<()> {
        self.next.store(0, Ordering::Relaxed);
        Ok(())
    }

    fn Clone(&self) -> Result<IEnumExplorerCommand> {
        Ok(Commands {
            commands: self.commands.clone(),
            next: AtomicUsize::new(self.next.load(Ordering::Relaxed)),
        }
        .into())
    }
}

#[implement(IClassFactory)]
struct Factory(GUID);

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<'_, windows::core::IUnknown>,
        iid: *const GUID,
        object: *mut *mut c_void,
    ) -> Result<()> {
        if object.is_null() {
            return Err(E_POINTER.into());
        }
        // SAFETY: checked just now.
        unsafe { *object = std::ptr::null_mut() };
        if !outer.is_null() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let entry = if self.0 == CLSID_TO_PDF {
            Entry::ToPdf
        } else {
            Entry::Quick
        };
        let command: IExplorerCommand = Command {
            entry,
            menu: Arc::new(load_menu()),
        }
        .into();
        // SAFETY: `iid` and `object` come from COM, as `query` expects.
        unsafe { command.query(iid, object).ok() }
    }

    fn LockServer(&self, _lock: BOOL) -> Result<()> {
        Ok(())
    }
}

/// # Safety
/// Called by COM with valid pointers.
#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    clsid: *const GUID,
    iid: *const GUID,
    object: *mut *mut c_void,
) -> HRESULT {
    if clsid.is_null() || object.is_null() {
        return E_POINTER;
    }
    // SAFETY: checked just now.
    unsafe { *object = std::ptr::null_mut() };
    let clsid = unsafe { *clsid };
    if clsid != CLSID_QUICK && clsid != CLSID_TO_PDF {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    let factory: IClassFactory = Factory(clsid).into();
    // SAFETY: as in `CreateInstance`.
    unsafe { factory.query(iid, object) }
}

/// Stays loaded while the surrogate lives: the surrogate ends with Explorer's
/// use of it.
#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    S_FALSE
}
