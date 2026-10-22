# Privacy Blur for WhatsApp Web

A small Chrome extension that blurs WhatsApp Web so people around you can't read your screen.
It is yours: about 650 lines of plain, readable code, no build step, no third-party libraries,
no store listing, and no way to update itself.

## What it does

* **Blur contacts, chat, or both.** Contacts blurs the chat list. Chat blurs the open chat (name,
  messages, message box). Newly opened chats appear already blurred.
* **Blur strength** from 1 to 20.
* **Hover to peek.** Point at a blurred area to read it; move away and it blurs again.
  Turn it off if you prefer to use the blur button only.
* **Smooth or instant** reveal.
* **Your draft stays readable** while you type in the message box.
* **Floating toolbar** on the page: drag handle, strength slider, blur on/off, what to blur,
  settings, collapse. You can hide it and use the extension button instead.
* **Keyboard shortcut** Alt+Shift+B turns the blur on and off.
* English and Arabic, following your Chrome language.

## Install (2 minutes)

1. Open `chrome://extensions` in Chrome (or Edge, Brave, Arc).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder inside this folder.
4. Open or reload <https://web.whatsapp.com>.

If the shortcut shows "not set", assign it at `chrome://extensions/shortcuts`.
Chrome may show a "developer mode extensions" notice at startup; that is normal for an
extension you load yourself.

## What it can and cannot do

| | |
|---|---|
| Permissions | `storage` only (to remember your settings). Chrome lists it as "Read and change your data on web.whatsapp.com", because blurring the page requires running on it. |
| Runs on | `https://web.whatsapp.com/*` only. Never on any other site. |
| Network | None. There is no code that sends anything anywhere, and the popup's security policy (`connect-src 'none'`) blocks network requests even if someone added such code. |
| Reading your chats | It doesn't. The page script never looks at the page. It only sets a few attributes on the `<html>` element (for example `data-wpb-mode="both"`), and `content.css` does the blurring. |
| Keyboard | Never listens to your typing. The shortcut is delivered by Chrome itself to the background worker. |
| Screenshots, camera, microphone, clipboard | No access, no code for it. |
| Talking to other extensions or websites | Blocked (`externally_connectable` is empty). No files are exposed to web pages, so WhatsApp can't even detect it. |
| Updates | None. Loaded unpacked, it has no update URL, so it only changes when you change the files. |
| Settings | `chrome.storage.local`, which stays on this computer (not synced to your Google account). |

The real protection against a store extension is the last-but-one row. A store extension can be
sold or hijacked and silently updated with new code; a folder on your disk can't.

## Check it yourself

1. **Run the audit** (needs Node.js, no install):

   ```bash
   node audit.mjs
   ```

   It fails if the manifest asks for anything beyond `storage` and web.whatsapp.com, or if any
   script contains a network call, page reading, keyboard listening, screenshots, messaging or
   hidden code loading. It prints a fingerprint for every file so you can spot later changes.
2. **Read the code.** The files that run are short:
   * `extension/content.js` runs on WhatsApp Web (attributes + toolbar)
   * `extension/content.css` the blur rules
   * `extension/background.js` the keyboard shortcut (10 lines)
   * `extension/popup.html`, `popup.js`, `popup.css` the settings popup
3. **Watch the network.** Open WhatsApp Web, press F12, open the Network tab and use the
   extension. Nothing from the extension appears. On `chrome://extensions`, the extension's
   **Details** page lists its permissions.

## If WhatsApp changes its layout

The blur targets two element ids WhatsApp has used for years: `#pane-side` (chat list) and
`#main` (open chat). If an update renames them, edit the selectors in `extension/content.css`.

## Files

```
audit.mjs             privacy audit (node audit.mjs)
tools/make-icons.py   draws the icons (python3, Pillow)
extension/            the folder you load into Chrome
  manifest.json       permissions and settings Chrome reads
  defaults.js         default settings
  content.js          page script: attributes on <html> + floating toolbar
  content.css         blur rules
  background.js       keyboard shortcut
  popup.*             settings popup
  _locales/           English and Arabic text
  icons/
```
