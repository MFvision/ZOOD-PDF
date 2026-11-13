# ZOOD PDF (محرر زود PDF) — project instructions

An open, account-free, Arabic-first PDF editor for the owner's company **ZOOD** (zood.sa), on
Windows and macOS (Tauri), the web, a Chrome extension, iPhone and iPad (SwiftUI) and Android.
People see the name **ZOOD PDF** in English and **محرر زود PDF** in Arabic. The code name is
**Warraq** (ورّاق), which is why packages, crates, bundle ids and storage keys say `warraq`.

Checked against the tree on 2026-11-13 (desktop 0.4.37). Where this file and the code
disagree, the code is right: correct this file in the same change.

## Start here, every session

1. **Check you are on the real tree.** The project lives on the `app` branch. GitHub's default
   branch (`claude/zood-pdf-foundation-nh5t9y`) is a different, older rebuild with no shared
   history, and a cloud session clones it. Run
   `git fetch origin app && git merge-base HEAD origin/app`: if it prints nothing, you are on
   the wrong tree. Branch from `origin/app`, and name `app` as the base of every pull request.
   Other branches belong to other sessions and to the owner's other projects: leave them alone.
2. **Read before you write.** `docs/HANDOVER.md` tells what the owner asked for and why;
   `git log --oneline -30` tells what is true now. Then read the files you will change and
   their tests.
3. **Find the nearest example and follow its shape.** `git show --stat 21658592` (browser-style
   tabs) lists everything one finished feature touches: the host, the interface, both
   languages, Ask ZOOD's books, the tour and the tests.

## The owner, and how to work here

The owner is not an engineer. He speaks his requests, so they arrive loosely worded: read for
what he means. He wants the finished, release-quality thing, not a demo.

- **Decide, then do.** Technical choices are yours. Ask only when a step needs his hands (a
  password, an Apple or store sign-in, a purchase) or is a product choice between real options;
  then give the options in plain words, recommend one, and carry on with everything that does
  not depend on the answer. Once he says go, finish without checking back.
- **Answer short, in plain language.** No jargon. "Is it enough?" and "can it do X?" get a
  straight yes or not yet first.
- **Be exact about what is proven.** Every report separates what was run and passed, what
  compiles but was not run on that system, and what is written but not built. A cloud session
  cannot run Windows, macOS or iOS: say so each time, and never round up.
- **A misunderstanding is a bug.** When the app or Ask ZOOD gets a reasonable request wrong,
  fix it with a test rather than explaining it away.
- **When he sends a video or an app to learn from:** find its source and its licence, explain
  the idea simply, compare it with what ZOOD has, then rebuild the idea our way. Ideas only,
  never the code.
- **End with something he can try:** a download link, a build, or a before-and-after picture.
- **Never type his passwords.** When Xcode's Apple account has signed out ("Failed to Use
  Accounts"), he signs in again himself.

Cost rules (he is on a Max plan with extra usage off):

- **One agent at a time.** No parallel agents or workflows: five at once used up the weekly
  allowance and cost him money (2026-10-01).
- A fresh conversation per job. Keep this file and `docs/HANDOVER.md` current instead of
  relying on a long conversation.
- Proportionate checks: the tests for what changed, not every suite. No iOS simulators unless
  the job is iOS (slow and heavy on his 8 GB Mac).
- Note the weekly usage % before a job and report the change after. A cloud session cannot
  read it: say so and point him to the Claude app.

## What it is, and how it is built

Three promises decide most questions:

- **Arabic first.** Right-to-left is the default. Arabic must extract, search, copy, edit and
  write back correctly; every other engine we measured gets some of that wrong, and that is
  why this product exists.
- **Private and local.** No accounts, no telemetry. Nothing leaves the device unless the
  person presses a cloud or AI button. The AI runs on the device.
- **The original is never lost.** The bytes that were opened stay untouched until the person
  saves, and a save appends an update to them.

One engine, one interface, thin hosts:

- **The engine** (`packages/core`, Rust, five crates): `warraq-text` (bidi, HarfRust shaping,
  logical-order extraction, Arabic-aware search), `warraq-pdf` (the object model on `lopdf`,
  incremental saves, encryption, fonts, pages, forms, redaction, page marks, standards),
  `warraq-render` (the pure-Rust hayro renderer; PDFium behind the `pdfium` feature),
  `warraq-sign` (PAdES signatures, RustCrypto) and `warraq-core` (the façade every host calls).
  It is built three ways: to WebAssembly for the web, the extension and Android; linked
  natively into the desktop app; and as an XCFramework behind a C ABI for iOS.
- **The interface** (`packages/ui`, `@warraq/ui`, React 19 + Vite + vitest): the whole product
  surface, used as source by the web, desktop and extension hosts. EmbedPDF 2.15.1 (PDFium as
  WebAssembly, version pinned) shows the document and supplies the marking on the page for
  Comment, Fill & sign, Prepare form and Redact. The Rust engine does the document work of all
  20 tools (`tools/tools.ts` says, tool by tool, which engine and why).
- **How a document moves.** `state/AppContext.tsx` keeps each open document as bytes and hands
  it between EmbedPDF and the engine. EmbedPDF writes files whole, so what it saves goes
  through the engine's `file.rebase`, which appends only the changed objects to the original.
- **How the interface reaches the engine.** Always through `core/client.ts`: a Web Worker
  running the WASM in a browser, Tauri commands (`core/host-tauri.ts` to
  `src-tauri/src/core_bridge.rs`) on the desktop. A tool's work is one call: an `op` such as
  `pages.rotate`, JSON arguments, and bytes beside them (`packages/core/API.md`).
- **The hosts.** `apps/web` is the PWA and owns the browser tests. `apps/desktop` (Tauri 2)
  adds what a browser cannot: native dialogs and menus, printing, updates, the on-device model
  (llama.cpp), Ask ZOOD, the quick tools and ring, the phone remote, cloud drives.
  `apps/extension` is Chrome MV3. `apps/android` is a small Java shell around the web build.
  `apps/ios` is a separate native SwiftUI app that shares only the engine.
- **Ask ZOOD** (desktop): the assistant behind a key tap in any app. It answers by the cheapest
  sure route first: a fixed command from the command book (`ask/book.ts`) or the settings book
  (`ask/settingsBook.ts`), then a small decision model that ranks options without writing a
  word, then the larger on-device model for anything that needs words. It never sends, pays,
  deletes or signs without asking first.
- **The website** (`website/`): plain HTML, CSS and JavaScript with no build step, published
  to Hostinger from `app`.

## Map of the folders

```
packages/core/            the Rust engine (its own cargo workspace)
  warraq-core/src/tools/  one module per tool; every tool operation is added here
  warraq-core/tests/      tool tests, golden renders, robustness and hostile-input suites
  vendor/                 hayro crates patched with hard limits (ZOOD-PATCHES.md in each)
  fuzz/                   cargo-fuzz targets (nightly)
  API.md                  the engine's contract: every op, its arguments and its answer
packages/ui/src/          the interface
  core/                   engine client, worker, desktop bridge (host-tauri.ts), mock engine
  state/                  AppContext (documents, services), reducer, tabs, settings, preferences
  shell/                  window, toolbar, tab bar, menus (menuModel.ts), keyboard shortcuts
  i18n/                   en.json and ar.json: every word the interface shows
  styles/                 tokens.css, looks.css and looks/, components.css, motion.css
  components/             Dialog, Popover, ContextMenu, IconButton, Stepper, ZoodMark
  embed/                  EmbedPDF: theme, Arabic locale, control, text hand-over
  tools/                  the tool registry (tools.ts), the gallery, the panels' frame
  edit/ organize/ combine/ compress/ export/ create/ compare/ ocr/ redact/ forms/ marks/
  signatures/ standards/ accessibility/ batch/ library/ links/ print/ panes/   one per tool
  ai/                     the AI tool: chat, on-device model catalogue (device/models.json)
  ask/                    Ask ZOOD: island, command book, settings book, coverage test
  quick/ sort/ remote/    quick tools and ring, Sort with ZOOD, phone remote (desktop)
  settings/ home/ tour/ support/ updates/ speech/ cloud/ history/ viewer/
packages/ui/vite/         build plugins: EmbedPDF string patches, OCR models, notices, cloud ids
apps/web/                 web host; e2e/ holds the Playwright specs and their helpers
apps/desktop/src-tauri/   Tauri host (its own cargo workspace): src/, tests/, tauri*.conf.json
apps/extension/           MV3 host and its manifest checks
apps/android/             Java shell; built only on GitHub
apps/ios/                 SwiftUI app: PDFEditor/, WarraqCore/ (Swift wrapper), Widgets/,
                          tests; project.yml (XcodeGen) is the project, never an .xcodeproj
website/                  the public site, help pages, and api/support (PHP relay)
tests/corpus/arabic/      the Arabic corpus with truth text; tests/acid/ scores it
tests/golden/ fixtures/ fonts/   reference renders, sample files, the bundled OFL faces
scripts/                  verify.sh, install-macos.sh, ios/, ci/ (Windows checks), support/
                          (guide pictures and PDFs), icon/, windows/ (Store package)
docs/                     HANDOVER.md, STATUS.md, feature-matrix.md, architecture.md,
                          decisions/ (ADRs), design/README.md, updates.md, cloud.md, local-ai.md,
                          store.md, support/, backlog/ (the owner's own test notes), research/
.github/workflows/        CI, releases, Windows build, iOS compile, Android, website
prototypes/               early experiments; not part of the product
```

Git-ignored and never committed: `packages/ui/src/core-wasm/` (the built engine), `.tools/`
(the Mac's local helpers), `apps/ios/Vendor/*.xcframework`, `apps/ios/*.xcodeproj`, model
files, and ZOOD's licensed font (`apps/ios/PDFEditor/Resources/LicensedFonts/`,
`website/assets/fonts/licensed/`).

## Commands

Needs Node 22+, pnpm 10, Rust stable with the `wasm32-unknown-unknown` target
(`rust-toolchain.toml`), wasm-pack, Python 3 and Google Chrome.

```bash
pnpm install --frozen-lockfile
pnpm build:core                 # engine -> packages/ui/src/core-wasm (needs wasm-pack)
pnpm dev:web                    # the web app with hot reload, http://localhost:5173
pnpm --filter @warraq/desktop dev   # the desktop app (a Mac or Windows only)
```

Check what you changed (run the lines for the area you touched):

```bash
# Interface
pnpm -r lint                                        # eslint, stylelint, extension manifest
pnpm -r --filter './packages/**' build              # the typecheck (vitest does not typecheck)
pnpm -r test                                        # every vitest suite
pnpm --filter @warraq/ui exec vitest run src/ask/coverage.test.ts     # one file

# Engine
cargo fmt --all --check --manifest-path packages/core/Cargo.toml
cargo clippy --all-targets --manifest-path packages/core/Cargo.toml -- -D warnings
cargo test --manifest-path packages/core/Cargo.toml
cargo test --manifest-path packages/core/Cargo.toml -p warraq-core --test tool_pages  # one suite
cargo check --manifest-path packages/core/Cargo.toml --target wasm32-unknown-unknown -p warraq-core
cargo test --manifest-path packages/core/Cargo.toml -p warraq-core --features ffi ffi::  # iOS C ABI

# Desktop host (a Mac or Windows; it does not compile in a Linux cloud session)
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml

# Browser tests: rebuild the engine and the web app first, every time
pnpm build:core && pnpm --filter @warraq/web build
pnpm --filter @warraq/web exec playwright test e2e/compress.spec.ts   # one spec
pnpm --filter @warraq/web e2e                                         # all of them (long)
```

Everything CI runs, with one verdict (the Mac; the script is zsh):

```bash
./scripts/verify.sh --no-e2e
```

Gates with baselines, refreshed only for an intended change and committed with it:

```bash
cargo run --release --manifest-path packages/core/Cargo.toml -p warraq-core --example acid -- .
python3 tests/acid/gate_warraq.py .            # the Arabic extraction ratchet; --update to refresh
UPDATE_GOLDEN=1 cargo test --manifest-path packages/core/Cargo.toml -p warraq-core --test golden
```

Building and shipping:

- **Mac:** `source .tools/env.sh` for the toolchain; heavy builds go through
  `.tools/one-at-a-time.sh <command>` (a machine-wide lock). Build with
  `cd apps/desktop && CI=true node_modules/.bin/tauri build --bundles app,dmg`, then
  `WARRAQ_SKIP_BUILD=1 ./scripts/install-macos.sh` installs it into /Applications. The
  checkout's branch there is `main`, published as `app` (`git push origin HEAD:refs/heads/app`).
- **Windows:** built on GitHub. Pushing to the `windows-build` branch builds a test installer,
  publishes it as a `windows-*` release, runs the core and desktop tests on Windows and writes
  the outcome to the `ci-logs` branch
  (`git fetch origin ci-logs && git show FETCH_HEAD:status.txt`). Installers are on
  https://github.com/MFvision/ZOOD-PDF/releases.
- **Desktop release** (`docs/updates.md`): two steps. Pushing a branch
  `release/desktop-v<version>` builds, signs and publishes a pre-release; after the installers
  are tried, pushing `release/stable-v<version>` puts it on the update channel for everyone.
  Then the website's download links and checksums are updated (`website/js/story.js`).
- **iPhone/iPad** (the Mac): `scripts/ios/build-core.sh` after engine changes,
  `scripts/ios/build.sh` for tests, `scripts/ios/testflight.sh` to upload (team AWV883QWPU,
  bundle `app.warraq.ios`). A build reaches his phone only once it is assigned to a tester in
  App Store Connect. Without a Mac, the `iOS compile` workflow on the pull request is the proof
  that it builds.
- **Android:** only on GitHub (`android.yml`).
- **Website:** `node website/tools/serve.mjs 8080` to look at it; merging `website/**` into
  `app` publishes it.

**Pushing has effects here.** Every pull request runs CI, with Mac and Windows desktop builds.
A push to a `claude/**` branch that touches `packages/`, `apps/web/` or `apps/android/` builds
Android and publishes a GitHub pre-release. `website/**` on `app` goes live. Branches named
`release/desktop-v*`, `release/stable-v*` or `windows-build`, and tags `desktop-v*`,
`stable-v*` or `v*`, start builds and releases: push those names only when the owner asked for
that release.

CI installs the newest stable Rust, so a new Rust release can add a clippy lint and turn the
`rust` check red on code nobody touched. Read the failing job before changing your own code;
the fix is usually one line, in a commit of its own.

In a Linux cloud session (checked 2026-11-13): install, lint, unit tests, typecheck and the
engine's tests run as written, and browser specs run once the engine is built (Chrome is
there). wasm-pack is missing: `cargo install wasm-pack --locked` (about two minutes).
`pnpm build:core` then fails at its last step, because the optimizer cannot be downloaded
there; build without it, as `android.yml` does (same engine, larger file, about six minutes
the first time):

```bash
CARGO_TARGET_DIR="$PWD/.tools/wasm-target" wasm-pack build packages/core/warraq-core \
  --target web --release --no-opt --out-dir ../../ui/src/core-wasm --out-name warraq_core
```

`verify.sh` needs zsh, so run its steps one by one. The desktop host needs WebKitGTK and does
not compile; there is no Xcode and no Android SDK. For those, CI on the pull request is the
check, and the report says so.

## Coding rules

Everywhere:

- **Every input is hostile:** PDFs, pictures, Office files, fonts, stored settings, replies
  from the network, words read from a page. Bound every loop, size and depth; answer with an
  error, never a crash or a hang. No `eval` or `new Function`.
- **No new network call** without the owner's yes: it changes the privacy promise. Every
  request the app makes today follows the person's own action, a one-time question or a
  switch in Settings (cloud drives, AI providers, model downloads, the open font library,
  Help's reports, the update check). The hosts the page may reach are pinned in two content
  security policies (`apps/web/index.html`, `apps/desktop/src-tauri/tauri.conf.json`) and by
  `apps/web/src/csp.test.ts`. No CDN links, web fonts, analytics or crash reporters.
- **No façade.** A control that is shown works end to end; unfinished work stays out of the
  interface. Never "coming soon".
- **Saves are incremental updates** over the opened bytes. Only work that must cover the whole
  file writes it whole (redaction, protection, compress, standards), and those hand back a new
  file for the host to save.
- **Licences:** MIT, Apache-2.0, BSD, ISC, OFL. Never GPL, AGPL or LGPL code. Record every new
  dependency in `THIRD-PARTY-NOTICES.md`. Never Adobe's, Apple's or ArtCraft's names, icons or
  artwork.
- **No secrets in the repository or in binaries; the repository is public.** The one exception
  the owner allowed (2026-10-24) is Google's installed-app "secret" for Google Drive, which
  Google says is not secret for desktop apps: it comes from the `WARRAQ_GOOGLE_CLIENT_SECRET`
  Actions secret at build time, into the desktop host and the iPhone app's Info.plist, and is
  never committed. ZOOD's licensed font (ITF Huwiya Arabic) is never committed: builds fall
  back to an OFL face without it.
- **Comments say why**, in plain words, and name the incident that taught it. Match the file
  you are in: its naming, its comment style, its line length. Do not reformat lines you did
  not change.

The engine (Rust):

- **One core, every build.** What you add must compile for `wasm32-unknown-unknown` too. The
  core is functions over bytes: the host reads files, fetches from the network and passes the
  time in. The one native-only part (installed fonts, `warraq-text/src/installed.rs`) is
  behind `#[cfg(not(target_arch = "wasm32"))]`; anything like it is gated the same way, with
  the browser still working without it.
- **A tool's work is an op.** Add `"<tool>.<verb>"` in `warraq-core/src/tools/<tool>.rs`
  (arguments are camelCase JSON, bytes travel as blobs) and describe it in `API.md`. The
  bridges carry any op, so the WASM bindings, worker and desktop bridge need no change.
- **No panic on anything read from a file:** no `unwrap`, `expect` or bare indexing on parsed
  data outside tests. In a browser a panic ends the engine for that tab.
- **Limits are named constants** (`MAX_*`) beside the code they guard, with the reason. A new
  parser or decoder gets cases in `warraq-core/tests/hostile.rs`.
- **Errors start with a code** (`E_PASSWORD`, `E_EDIT: …`). The interface turns the code into
  friendly words; the person never sees the code.
- **Text written into a PDF** is shaped, embedded as a subset with a ToUnicode map, and proven
  to read back as typed. Never trust another engine's text order.

The desktop host (Rust, Tauri):

- It stays thin: only what a browser cannot do. A new command is a `#[tauri::command]`, a line
  in `generate_handler!` (`src/lib.rs`) and a typed wrapper in `packages/ui/src/core/host-tauri.ts`,
  called only after `isTauriHost()`. The web app must still work without it.
- It ships on Windows and macOS: code under `#[cfg(target_os = …)]` must compile on both.
- Files are read and written only at paths the person picked or dropped.
- `tests/desktop_contract.rs` pins the configuration (permissions, `custom-protocol`, the
  title bar, the updater). Read it before changing `tauri*.conf.json` or `capabilities/`.

The interface (TypeScript, React):

- Strict TypeScript with `noUncheckedIndexedAccess`; `import type` for types; an unused name
  starts with `_`.
- **Every word comes from `t('key')`** (`useT`, `useI18n`), with the key added to `en.json` and
  `ar.json` at the same place and with the same `{placeholders}`.
- **Stored state is validated on every read** (`readJson`, then a sanitizer that falls back to
  the default): a damaged or old entry once opened the app to a white page.
- **A result belongs to the document it was made from.** Keep the document's id with it, so
  another tab never shows or saves it.
- CSS uses logical properties and tokens only (see Design rules).

The iPhone and iPad app (Swift): Swift 6 with strict concurrency; strings in the `.xcstrings`
catalogues in both languages; the engine only through the `WarraqCore` wrapper; colours and
spacing from `Design/Theme.swift` and the themes.

Tests:

- **A bug starts with a test that fails**, then the fix. Say in the commit that it fails
  without the fix.
- **A feature is done when a Playwright spec proves it** by clicking through the real
  interface, saving, reopening and looking at the bytes. Specs import `test` from
  `./helpers`, whose `stayLocal` fixture fails any test that lets a request leave the app.
- **Never weaken a test to get green:** no skip, no loosened assertion, no refreshed baseline
  that hides a change you did not intend.

Git: one branch per job from `app`; commit subjects in plain words that say what changed for
the person ("Compress: a smaller copy is only offered for the document it was made from");
commits end with the attribution lines the session gives; the pull request's base is `app`.

## Design rules

`docs/design/README.md` is the reference for tokens and components. It was written before the
looks existed, so where it says "one accent colour" or "nothing loops", `styles/looks.css` and
`styles/motion.css` are the truth.

- **Arabic first.** The page starts as `<html lang="ar" dir="rtl">`. Lay out with logical
  properties only (`margin-inline-start`, `inset-inline-end`, `text-align: start`); stylelint
  rejects `left`/`right`. Icons that point a direction mirror (`<Icon mirror>`). Arabic is never
  letter-spaced: tracking breaks the joins. Write Arabic as a person in Saudi Arabia would say
  it, not as a word-for-word translation.
- **Tokens, never colours.** Name what a surface is (`--window-background`,
  `--secondary-label`, `--accent`), from `styles/tokens.css`. There are 13 looks
  (`html[data-look]`; Zood, in navy, beige paper and bronze, is the default from the first
  launch, the owner's choice of 2026-10-20), each in light and dark, with increased contrast
  and reduced transparency. A hard-coded colour is right in one of
  them and wrong in the rest. Spacing, radii, shadows and durations are tokens too.
- **One place for each thing.** The document's title, page and state sit in the toolbar; tools
  in the tool picker and the inspector; settings in Settings. Nothing appears twice.
- **Build from the parts that exist:** `IconButton`, `Dialog`, `Popover`, `ContextMenu`,
  `Stepper`, `.segmented`, `.tool-actions`. A tool panel is `<div className="tool-panel">`
  with choices in `fieldset`/`legend` and one primary button. Icons are Lucide.
- **Motion with a purpose.** A control answers on press; things come in from where they live.
  All motion sits under `prefers-reduced-motion` and the app's own Reduce motion setting.
- **Narrow and touch.** Layouts change at 900, 700 and 640 px; nothing scrolls sideways. On a
  touch screen every target is at least 44 px (`e2e/pwa.spec.ts` fails a smaller one).
- **Plain words.** No technical terms, codes or file paths in the interface. An error says
  what happened and what to do next. Docs and comments say "the person", not "the user".
- **Instant tools.** A tool that needs nothing more runs the moment it is picked: no confirm
  pop-up. A window opens only when input is needed, with a live preview of the pages. Ask
  before anything that sends, deletes, pays or signs, and keep an Undo for moved files.
- **Teach it.** An important feature gets a welcome-tour chapter with live practice
  (`tour/chapters.ts`: raise `TOUR_VERSION` and set the chapter's `since`, which is also what
  What's new shows after an update) and a Help guide with a picture of the real button for
  each step in both languages (`support/articles.ts`, `scripts/support/make-shots.mjs`).
  Retake the pictures when a screen in a guide changes.
- **Look at it** in Arabic and English, light and dark, in Zood and one other look, and at
  375 px wide, before calling it finished.

## Mistakes a weaker model makes here, and how to avoid each

1. **Working on the wrong tree, or opening a pull request against the default branch.** The
   default branch is not this project. Do the tree check in "Start here"; pass `base: app`.
2. **Trusting a document over the code.** `docs/STATUS.md`, `docs/HANDOVER.md`, `docs/ci.md`
   and the README are dated logs (the README still says Warraq; `ci.md` lists two workflows
   where there are eleven). Confirm a claim in the code, a test or a workflow before repeating
   it, and correct the document you relied on.
3. **Guessing an API instead of reading it:** an EmbedPDF command id, an engine op's
   arguments, a Tauri permission. They are written down (`tools/tools.ts`,
   `packages/core/API.md`, `capabilities/default.json`); a guess gives a button that does
   nothing.
4. **Testing against yesterday's engine, or the mock one.** The built engine is git-ignored,
   and without it the interface quietly loads a mock (`core/loadModule.ts`), so tests can pass
   on fake answers. Playwright serves `apps/web/dist` and does not build it. Rebuild the
   engine and the web app before every browser test.
5. **One language, or text typed into a component.** `i18n.test.ts` fails on a key missing
   from either file, mismatched placeholders, an old name (Warraq, ورّاق) or a competitor's
   name. Add both languages in the same change, and reread the Arabic as a native reader.
6. **Renaming `warraq` out of the code.** Package names, crate names, bundle ids
   (`app.warraq.desktop`, `app.warraq.ios`), storage keys (`warraq.preferences`) and event
   names are identifiers that people's installs and saved settings depend on. Only the words
   people read say ZOOD PDF.
7. **CSS that fails stylelint, or a colour typed by hand.** The usual three: a physical
   property, an alpha that is not a percentage (`rgb(0 0 0 / 50%)`), a media query not in
   range form (`(width <= 700px)`). Class names are kebab-case. Run `pnpm -r lint`.
8. **Adding a setting, menu command or tool that Ask ZOOD does not know.**
   `ask/coverage.test.ts` fails on purpose. Add the setting to `SETTINGS_BOOK`
   (`ask/settingsBook.ts`), a command's words to `BOOK_WORDS` and a tool's to `TOOL_WORDS`
   (`ask/book.ts`), in Arabic and English. Never grow the test's exception lists to pass.
9. **Editing the bridges for a new engine operation, or engine code that only works
   natively** (`std::fs`, the system clock, threads, a crate with a C dependency). Add the op
   in `tools/`; the bridges carry it already. Then run the wasm32 check.
10. **A panic or an unbounded loop on file data.** Use `?`, `.get()`, checked arithmetic and a
    `MAX_*` limit, then add the nasty case to the hostile suite.
11. **Saving by writing the file whole**, or saving EmbedPDF's bytes directly. That drops the
    original bytes and breaks signatures. Go through the engine's incremental save or
    `file.rebase`.
12. **Refreshing a baseline to turn a gate green.** A changed golden render or a lower Arabic
    score is a finding. Refresh only when the change is the one you meant, and say so in the
    commit.
13. **Changing a screen and leaving its tests and pictures behind.** Specs find controls by
    their English names, so a renamed button breaks them. Search `apps/web/e2e` for the old
    words, update the specs, and retake the affected guide pictures (or say they need it).
14. **A new desktop command that is not registered**, or one called without `isTauriHost()`.
    The first fails in the app at run time; the second breaks the web app.
15. **Simplifying away a workaround.** Odd-looking code here usually prevents a failure that
    already happened: the `custom-protocol` feature (without it the built app opens an empty
    window), the NSIS-only Windows installer (MSI cannot write the Arabic name), the page's
    own CSP stripped from desktop builds, native file dialogs in place of `<input type=file>`,
    `lto = false` for the iOS build. Read the comment and `git log -S` before removing any.
16. **Adding a dependency in passing, or upgrading a pinned one.** EmbedPDF, tesseract.js,
    onnxruntime-web and wllama are pinned to exact versions because build steps and tests
    depend on their exact files. A new dependency needs its licence checked and a line in
    `THIRD-PARTY-NOTICES.md`; an upgrade is a job of its own.
17. **Adding a network request**, even a harmless one (a font, an icon, a version check). The
    `stayLocal` fixture and the CSP test fail it, and it breaks the product's first promise.
18. **Claiming what was not run.** "Works on Windows" from a Linux session is false. Write
    what ran, where, and what is unproven; use the CI workflows to prove the rest.
19. **Starting a release or a deploy by accident** with a branch name or a website change (see
    "Pushing has effects here").
20. **Fanning out agents, or running every suite for a small change.** It spends the owner's
    weekly allowance. One agent; the tests for what changed.
21. **Committing what must stay out:** the built engine, `.tools/`, model files, the licensed
    font, a client secret, an `.xcodeproj`. Read `git status` and stage files by name; never
    `git add -A` blind.
22. **Forgetting the Mac is shared with other sessions.** Stop only the process ids you
    started, never by pattern. Give a second checkout its own `WARRAQ_E2E_PORT`. Keep
    `packages/core` and the desktop host in separate cargo target directories, and each
    checkout in its own: shared, they overwrite each other's `libwarraq_core` and the build
    fails with "multiple different versions of crate", or hands back another tree's engine.
23. **Showing unfinished work**, in the app or on the website. The website claims only what
    `docs/feature-matrix.md` marks done, and lists only downloads that exist.
24. **Asking the owner a technical question, or answering with jargon.** Decide, then report
    in plain words what changed for him.

## Before you say a task is done

1. `git status` and `git diff --stat` show only what the job needed, on a branch that descends
   from `app`. Nothing git-ignored, secret or generated is staged.
2. The tests for what changed were run and passed: give the counts. A bug fix has a test that
   failed before it; a visible feature has a Playwright spec.
3. Lint, typecheck and formatting are clean for what you touched: `pnpm -r lint`,
   `pnpm -r --filter './packages/**' build`, `cargo fmt --check` and `cargo clippy` for each
   crate you changed, and the wasm32 check after any engine change.
4. Words: every new string is in `en.json` and `ar.json`, and the Arabic reads naturally.
5. You looked at it: Arabic and English, light and dark, narrow. If you could not (no
   display, no Mac, no Windows), the report says so.
6. The feature's whole footprint is there, where it applies: Ask ZOOD's books, the tour, the
   Help guide and its pictures, `THIRD-PARTY-NOTICES.md`, `packages/core/API.md`.
7. The documents are true again: `docs/HANDOVER.md` gains a dated entry (what was done, what
   was not tried and on which system, what waits on the owner), `docs/feature-matrix.md`
   changes if a tool's state did, and this file changes if a command, folder or rule did.
8. Nothing was pushed to a release, build or deploy name unless the owner asked.
9. The report to the owner is short and plain: what he can do now that he could not before,
   what is not done, what was not tested, the link or build to try, and the usage note.
