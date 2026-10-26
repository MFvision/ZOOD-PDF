//! Asks Windows for the Store package's menu entries as Explorer does, prints
//! them, and, given a PDF, picks the PDF entry on it, which starts the app's
//! quick window (scripts/windows/check-store-package.ps1). Run it with the
//! package installed: `probe [file.pdf]`.
#[cfg(windows)]
fn main() -> windows::core::Result<()> {
    use windows::core::{GUID, HSTRING};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        IExplorerCommand, IShellItem, IShellItemArray, SHCreateItemFromParsingName,
        SHCreateShellItemArrayFromShellItem,
    };
    use zood_shell_ext::menu::{CLSID_QUICK, CLSID_TO_PDF};

    // SAFETY: plain COM calls on this thread; every string Windows returns is
    // read once and left to the process's end.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let file = std::env::args().nth(1);
        let items: Option<IShellItemArray> = match &file {
            Some(file) => {
                let item: IShellItem =
                    SHCreateItemFromParsingName(&HSTRING::from(file.as_str()), None)?;
                Some(SHCreateShellItemArrayFromShellItem(&item)?)
            }
            None => None,
        };

        let quick: IExplorerCommand =
            CoCreateInstance(&GUID::from_u128(CLSID_QUICK), None, CLSCTX_LOCAL_SERVER)?;
        println!(
            "PDF entry: {}",
            quick.GetTitle(items.as_ref())?.to_string()?
        );
        println!(
            "  flags {}, state {}",
            quick.GetFlags()?,
            quick.GetState(items.as_ref(), true)?
        );
        let list = quick.EnumSubCommands()?;
        let mut count = 0;
        loop {
            let mut got = [None];
            let mut fetched = 0;
            let _ = list.Next(&mut got, Some(&mut fetched));
            let Some(tool) = got[0].take().filter(|_| fetched == 1) else {
                break;
            };
            println!(
                "  - {} (flags {})",
                tool.GetTitle(None)?.to_string()?,
                tool.GetFlags()?
            );
            count += 1;
        }
        if count == 0 {
            eprintln!("the PDF entry has no tools");
            std::process::exit(1);
        }

        let to_pdf: IExplorerCommand =
            CoCreateInstance(&GUID::from_u128(CLSID_TO_PDF), None, CLSCTX_LOCAL_SERVER)?;
        println!("Convert entry: {}", to_pdf.GetTitle(None)?.to_string()?);

        if let Some(items) = &items {
            quick.Invoke(items, None)?;
            println!("picked the PDF entry on {}", file.unwrap_or_default());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("the probe runs on Windows only");
}
