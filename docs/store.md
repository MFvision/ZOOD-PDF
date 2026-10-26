# ZOOD PDF in the Microsoft Store

The Windows app also ships as a Microsoft Store package (`.msix`). The Store
signs the package itself, so Store installs show no "Unknown publisher"
warning and need no code-signing certificate of our own. The Store also
updates the app. The installer (`ZOOD-PDF-Setup-<version>.exe`, see
[updates.md](updates.md)) stays as it is.

## One program, two ways to install it

The package carries the same `warraq-desktop.exe` the installer installs. At
startup the app asks Windows whether it runs as a package
(`src/packaged.rs`), and it does four things differently when it does:

| | Installer copy | Store copy |
|---|---|---|
| Right-click menu | registry keys under the person's classes (`src/shell_menu.rs`), under "Show more options" on Windows 11 | the package declares it (`windows/store/AppxManifest.xml`), and a COM add-on (`shell-ext/`) shows it, in Windows 11's short menu too. The app writes the menu, in its language and with the tools chosen in Settings, to `shell-menu.json`, and the add-on reads that file. Turning it off hides the entries. |
| Start at sign-in ("Keep the quick tools ready") | the `Run` registry value | the package's startup task `ZoodPDFBackground`, which starts the app with `--background`. If the person switches it off in Task Manager › Startup apps, that choice wins. |
| PDFs | NSIS hooks give PDFs the document icon and add the app to "Open with" | the manifest's file type association, with the same icon (`Assets/PdfDocument.*`) |
| Updates | the app's own updater (stable channel) | the Store. The app's updater never finds an update, because the Store forbids an app updating itself. |

A package's registry writes stay inside the package, where Explorer and
sign-in never look. That is why the menu and the sign-in start can't simply
reuse the registry code. Uninstalling the package removes all of it.

## Building it

- **Pull requests**: `desktop (Store package)` (`.github/workflows/desktop-store.yml`)
  builds the app and the add-on, makes a test-signed package, and installs it
  on the Windows runner (`scripts/windows/check-store-package.ps1`). It then
  checks that the app starts as the package, asks for the right-click entries
  the way Explorer does (`shell-ext/examples/probe.rs`), picks the PDF entry
  (which must start the app), and removes the package.
- **Releases**: once the repository has the three Store variables below,
  "desktop release (1. build)" also makes `ZOOD-PDF-<version>-store.msix`
  from the same build and attaches it to the release. It stays unsigned
  because the Store signs it.
- **By hand, on Windows**: see the top of `scripts/windows/make-store-package.ps1`.

The package pictures come from the app icon:
`python3 scripts/icon/make_store_assets.py`.

## Getting it into the Store (owner, once)

1. **Partner Center account.** Wait for the developer account to be
   approved (storedeveloper.microsoft.com; support:
   https://aka.ms/windowsdevelopersupport).
2. **Reserve the name.** Partner Center › Apps and games › New product ›
   MSIX or PWA app › name it **ZOOD PDF**.
3. **Copy the identity.** Open the app › Product management › Product
   identity. Copy these three values:
   - `Package/Identity/Name`
   - `Package/Identity/Publisher` (starts with `CN=`)
   - `Package/Properties/PublisherDisplayName`
4. **Add them to GitHub.** Repository › Settings › Secrets and variables ›
   Actions › **Variables** tab (not Secrets), and create:
   - `STORE_NAME` = Package/Identity/Name
   - `STORE_PUBLISHER` = Package/Identity/Publisher
   - `STORE_PUBLISHER_DISPLAY_NAME` = Package/Properties/PublisherDisplayName
5. **Build a release** as usual. The release now has `ZOOD-PDF-<version>-store.msix`.
6. **Submit.** Partner Center › the app › Start submission. Upload the
   `.msix` under Packages, and fill in pricing (free), properties (category
   Productivity) and the Store listing. Use these:
   - Privacy policy: https://pdf.zoodrealty.com/en/privacy/
   - Restricted capability `runFullTrust`, why it is needed: "ZOOD PDF is a
     desktop (Win32) PDF editor. It runs as a full-trust desktop app to open
     and save the files the user picks, to add its quick tools to File
     Explorer's right-click menu, and to run its on-device AI and
     text-to-speech engines locally."
7. **Each new version:** run the release, then upload the new `.msix` in a
   new submission. The version must be higher than the last one submitted.

## Not tried on a real PC yet

The CI check runs on Windows Server. These still need a person on Windows 11:

- the entries in the short right-click menu, and Settings › Quick tools
  turning them off;
- "Keep the quick tools ready" starting the app at sign-in without a window;
- the PDF icon once ZOOD PDF is the default app for PDFs.

The app needs the WebView2 runtime. It comes with Windows 11 and updated
Windows 10, and the installer's bootstrapper is not available to a package.
