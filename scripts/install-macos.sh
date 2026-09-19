#!/bin/sh
# Build Warraq from source and install it into an Applications folder.
#
# Warraq is not notarised and not distributed through an app store, so this is
# the supported way to get it onto a Mac: build it on the machine that will run
# it. Everything stays local; nothing is uploaded and no account is involved.
#
#   ./scripts/install-macos.sh                 # installs into /Applications
#   ./scripts/install-macos.sh ~/Applications  # installs somewhere else
#   WARRAQ_SKIP_BUILD=1 ./scripts/install-macos.sh
#
# Requirements: macOS 11 or newer, the Xcode command line tools, a Rust
# toolchain (see rust-toolchain.toml), Node 22+ and pnpm.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
dest=${1:-/Applications}
app_name="محرر PDF.app"
# Earlier installs of the same app were called these.
old_names="Warraq.app ورّاق.app"
built="$repo/apps/desktop/src-tauri/target/release/bundle/macos/$app_name"

die() { printf 'install-macos: %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this script only installs on macOS"

if [ "${WARRAQ_SKIP_BUILD:-0}" != "1" ]; then
    for tool in cargo node pnpm; do
        command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH"
    done
    # `pnpm install` is idempotent and pulls the Tauri CLI used below.
    (cd "$repo" && pnpm install --frozen-lockfile)
    # CI=true keeps the .dmg bundler from driving Finder through AppleScript,
    # which needs an interactive session and automation permission.
    (cd "$repo/apps/desktop" && CI=true node_modules/.bin/tauri build)
fi

[ -d "$built" ] || die "no bundle at $built — run without WARRAQ_SKIP_BUILD"
[ -d "$dest" ] || die "$dest does not exist"
[ -w "$dest" ] || die "$dest is not writable by $(id -un)"

# Replace rather than merge: a copy over a previous install would leave behind
# files that this version no longer ships.
rm -rf "$dest/$app_name"
cp -R "$built" "$dest/$app_name"
# The same app under an earlier name would sit beside it; only ours is removed.
for old_name in $old_names; do
    old="$dest/$old_name"
    if [ -d "$old" ] && [ "$(defaults read "$old/Contents/Info" CFBundleIdentifier 2>/dev/null)" = "app.warraq.desktop" ]; then
        rm -rf "$old"
    fi
done

# The build is signed ad hoc by the linker, which is enough to launch locally
# but not enough for Gatekeeper to vouch for it on another Mac. Clearing the
# quarantine flag keeps macOS from asking about a downloaded PDFium library.
xattr -dr com.apple.quarantine "$dest/$app_name" 2>/dev/null || true

# The linker signs the executable ad hoc, but leaves the bundle itself unsealed
# and its Info.plist unbound. Sealing it here is what gives the app a stable
# identity, so macOS stops re-asking for permissions every time it is rebuilt.
codesign --force --sign - --identifier app.warraq.desktop "$dest/$app_name"
codesign --verify --deep --strict "$dest/$app_name" || die "the signature did not verify"

printf 'installed %s\n' "$dest/$app_name"
