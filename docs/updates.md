# Updates of the desktop app

The Windows and Mac apps update themselves from this repository's GitHub
releases, with Tauri's updater plugin (`apps/desktop/src-tauri/src/updates.rs`,
`packages/ui/src/updates/`).

## What the person sees

- About eight seconds after the app opens, the main window asks the stable
  channel whether there is a newer version. If there is, a bar says
  "Version X is ready" with **Update now** and **Later**. Nothing installs
  without that click.
- Update now downloads the new version, checks its signature, installs it and
  restarts the app. On Windows the installer runs in passive mode (a progress
  window, no questions).
- Settings › About › Updates: a switch for the check at launch (on by
  default) and **Check now**. About shows the installed app's version.

## The stable channel

The apps read one file:
`https://github.com/MFvision/ZOOD-PDF/releases/download/updates-stable/latest.json`
(`plugins.updater.endpoints` in `tauri.conf.json`). The `updates-stable`
release is a pre-release that only exists to hold that file; it is changed
only by the release workflow below.

The test builds of `desktop-windows.yml` (the `windows-*` releases) are never
on the channel. They keep the version in `tauri.conf.json` (0.1.0) and are not
signed for updates, so an app installed from one of them is offered the
first real release.

## Releasing a version (two steps, both in GitHub Actions)

1. **desktop release (1. build)** (or push a tag `desktop-v0.2.0`): give the new version (higher than the
   last released one, like `0.2.0`) and a line on what is new. It builds
   Windows and Mac (Apple silicon), signs the update files, and publishes a
   pre-release `desktop-v0.2.0` with the installers and its `latest.json`.
   No installed app sees it yet: download the installers and try them.
2. **desktop release (2. release to users)** (or push a tag `stable-v0.2.0`): give the same version. It puts
   that release's `latest.json` on the stable channel and marks the release
   as the latest. Every installed app offers it on its next launch.

There is no going back to an older version through the updater (an app only
moves to a newer one): to take a bad release back, release a fixed, higher
version.

The **Run workflow** button only shows for workflows on the repository's
default branch, so the default branch should be `app` (Settings › General ›
Default branch).

## The signing key

Every update is signed with a private key; the apps install only what that
key signed (the public half is `plugins.updater.pubkey` in `tauri.conf.json`).
It lives in two repository secrets (Settings › Secrets and variables ›
Actions):

- `TAURI_SIGNING_PRIVATE_KEY`: the private key file's contents.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password.

Keep an offline copy. If the key is lost, the apps already installed can no
longer be updated: a new key means a new public key in the app, which only a
manual reinstall brings. If it leaks, anyone with it and a way to change the
channel could sign an update, so make a new key, release a version with the
new public key, and replace the secrets.

To make a new key: `pnpm --dir apps/desktop exec tauri signer generate -w zood-updater.key`.

## Not covered yet

- Code signing by Apple and Microsoft is separate from update signing. The
  Mac app is not notarized, and Windows SmartScreen warns on the installer
  until it carries a code-signing certificate. Updates work either way.
- Intel Macs: the bundled PDFium is arm64, so the release builds Apple silicon only.
