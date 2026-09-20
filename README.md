# Warraq (ورّاق) — working name

An open, account-free, Arabic-first PDF editor of Acrobat Pro class.
One Rust core (native + WASM), one React UI (RTL-first), thin hosts for
Windows, macOS, Chromium extensions, the web and later iPad/iPhone.

* No account, ever. Local-first, offline-capable.
* Arabic and every other script render **and edit** correctly.
* Optional, independent OneDrive / Google Drive connectors — off unless a build
  carries a client ID of your own; see `docs/cloud.md`.
* License-clean foundation (see `docs/research/00-landscape.md`).

To run it on a Mac: `./scripts/install-macos.sh` builds Warraq and installs it into
`/Applications` — see `docs/install-macos.md`.

See `docs/STATUS.md` for the current state and `docs/decisions/` for ADRs.
