# ZOOD PDF for Android

A small native app (Java, no Kotlin, two Apache-2.0 libraries) around the same
ZOOD PDF the web and desktop run: `apps/web`'s build, with the Rust engine as
WebAssembly, is copied into `app/src/main/assets/www` and served from inside
the app at `https://appassets.androidplatform.net` (Android's reserved name
for this; nothing goes to the network). Everything works offline.

What the native side adds (`app/src/main/java/sa/zood/pdf/`):

| | |
|---|---|
| Open with / Share to ZOOD PDF | PDFs and pictures from Files, Gmail, WhatsApp, Drive (`MainActivity.handle`) reach the page through `/__incoming/<id>` and `packages/ui/src/core/host-android.ts` |
| Save, Share | the page's downloads and `navigator.share` go to Android's save panel and share sheet (`assets/zood/shim.js`, `Bridge.java`) |
| Print | Android's print screen (`WebHostActivity.print`) |
| Back | closes the open menu or dialog, else the app steps aside |
| Camera, microphone | asked for when the page asks (scan, Ask ZOOD's voice) |
| Phone remote | "Control your computer" on the home screen (Android only) scans the PC's code and opens the PC's own remote page (`RemoteActivity`), the same as a phone browser would; the address is remembered |

Not in the Android app yet: Google Drive / OneDrive (Google refuses sign-in
inside an embedded web view; needs Custom Tabs + the app's own OAuth clients),
the iPhone app's widgets and Siri shortcuts.

## Build

Only on GitHub (`.github/workflows/android.yml`; the cloud sessions cannot reach
Google's SDK download): every push to `claude/**` or `app` that touches the app,
web or packages builds a signed `.aab` and `.apk`, runs them on an emulator
(`scripts/smoke.sh`, pictures kept with the build), and publishes them as a
GitHub pre-release `android-<version>-<run>`. Run it by hand (Actions → Android
→ Run workflow) to set the version name and send the bundle to a Google Play
track.

Package name: `sa.zood.pdf` (permanent once on Google Play). Signing: Play App
Signing holds the app key; the build signs with the upload key from the
`ANDROID_UPLOAD_KEYSTORE*` secrets.
