# Cloud drives: OneDrive and Google Drive

محرر PDF can open files from a cloud drive and save them back. It does that
with no server of its own and no client secret: the person signs in on the
provider's own page, and the app holds only the tokens that sign-in gives it.

**Nothing of this appears until you register an app with the provider and
build with its client ID.** A build without one has no cloud control anywhere,
no drive's address in its security policy, and can reach no drive at all. There
are no invented IDs in the repository, and no place to put a secret.

This page is what you need to register each app, build with it, and know what
it does afterwards.

---

## What a person sees, once it is configured

* **Home screen — Folders → Cloud drives.** Each drive is a folder beside the
  person's own (clicking it opens the drive, signing in first). The home
  screen's **Cloud drives** section has each drive you configured, who is signed in
  to it (as this device remembers; the drive is not asked), **Open…** and
  **Sign out** — and the drive files opened lately as pages, which reopen from
  the drive with one click.
* **File menu** — *Open from OneDrive…*, *Open from Google Drive…*, *Save to
  OneDrive…*, *Save to Google Drive…*, and, for a file that came from a drive,
  *Save a Copy on This Device…* (in the macOS menu bar too).
* **Signing in** happens on Microsoft's or Google's own page — in a pop-up in a
  browser, in your own browser on the desktop. محرر PDF never sees the
  password.
* **Opening** browses OneDrive folder by folder, with a search over the whole
  drive. For Google Drive, Google's own file picker appears as part of signing
  in, and the app afterwards lists the files it is allowed to see.
* **Saving** writes a new revision of the file it opened, checked against the
  version it had at the time. If someone else saved it meanwhile, the person is
  asked: *Save as a Copy…*, *Replace*, or *Cancel* — never a silent overwrite.
* **Signing out** revokes the sign-in where the provider allows it (Google),
  forgets it on this device, and forgets that drive's recent files.

---

## Registering the OneDrive app (Microsoft)

One app registration serves both the browser build and the desktop app.

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com) →
   **Applications → App registrations → New registration**.
2. **Name**: what the person will see on the consent screen, for example
   `محرر PDF`.
3. **Supported account types**: *Accounts in any organizational directory and
   personal Microsoft accounts* — personal OneDrive and work or school
   accounts both. (Choosing differently means changing
   `WARRAQ_ONEDRIVE_TENANT`; see the table below.)
4. Leave the redirect URI empty for now and **Register**.
5. **Authentication → Add a platform → Single-page application**, and add the
   browser build's address of the sign-in page:
   `https://<where you host the app>/oauth-callback.html`. Add one for each
   place you serve it from (including `http://localhost:5173/oauth-callback.html`
   while developing). It must be of the **SPA** type: Microsoft redeems a code
   from a browser only for that type.
6. **Authentication → Add a platform → Mobile and desktop applications**, and
   add `http://localhost/callback`. For the desktop app the port is chosen for
   each sign-in and Microsoft ignores it for loopback addresses. To use
   `http://127.0.0.1/callback` instead — which the app asks for, and which
   survives a renamed `localhost` — the portal will not accept it in the text
   box: open **Manifest** and add it to `replyUrlsWithType` with the type
   `InstalledClient`:

   ```json
   { "url": "http://127.0.0.1/callback", "type": "InstalledClient" }
   ```

7. **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions**: `Files.ReadWrite`, `User.Read`, `offline_access`. Nothing
   else. (`Files.ReadWrite.AppFolder` would reach only a folder of the app's
   own, not the PDFs the person already has.)
8. **Certificates & secrets: add nothing.** This is a public client; a secret
   would be refused (`AADSTS700025`) and must never be shipped.
9. Copy the **Application (client) ID** from the overview page.

| `WARRAQ_ONEDRIVE_TENANT` | Who can sign in |
| --- | --- |
| `common` (default) | personal Microsoft accounts and any organization's |
| `consumers` | personal Microsoft accounts only |
| `organizations` | work or school accounts of any organization |
| a tenant ID or domain | that one organization only |

---

## Registering the Google Drive app (desktop only)

The browser build ships no Google Drive; see *Why Google Drive is desktop
only* below.

1. In the [Google Cloud console](https://console.cloud.google.com), create or
   choose a project.
2. **APIs & Services → Library → Google Drive API → Enable**.
3. **APIs & Services → OAuth consent screen**: *External*, the app name the
   person will see, a support e-mail, and your contact e-mail.
4. **Scopes**: add `https://www.googleapis.com/auth/drive.file` and nothing
   else. It is a **non-sensitive** scope: the app sees only files the person
   picks in Google's picker or that the app itself saved, so it needs no
   security assessment (no CASA) and no restricted-scope review — only Google's
   basic app verification when you publish.
5. **Credentials → Create credentials → OAuth client ID → Desktop app**. Copy
   the **client ID** (it ends in `.apps.googleusercontent.com`).
6. **Ignore the client secret Google shows.** The app sends none, and there is
   no build variable for one. Google's own documentation lists it as optional
   for installed apps and says plainly that it "is not treated as a secret"
   there — see the warning below.
7. While the consent screen is unpublished, add the Google accounts that may
   sign in under **Test users**.

> **Check this once, before you ship Google Drive.** Google's documentation
> lists `client_secret` as *optional* when a desktop app redeems a code with
> PKCE, and that is what محرر PDF does. Developers have reported (through
> August 2026) that the token endpoint answers `invalid_request` —
> "client_secret is missing." — for Desktop app clients all the same. Sign in
> once in the built app after registering: if Google refuses, the app says so
> in the sheet, in its own words. Then either leave `WARRAQ_GOOGLE_CLIENT_ID`
> unset (no Google control appears at all) or decide to ship the value Google
> calls a secret — which is a change to the rule *no client secrets in
> binaries*, and so your decision, not the app's. It is recorded as an open
> decision in `docs/STATUS.md`.

---

## Building with them

The IDs are read from the environment when the web assets are built, and
travel into the build; there is nothing to configure at run time.

```sh
# The browser build (OneDrive only)
WARRAQ_ONEDRIVE_CLIENT_ID=00000000-1111-2222-3333-444444444444 \
  pnpm --filter @warraq/web build

# The desktop app (OneDrive and Google Drive)
WARRAQ_ONEDRIVE_CLIENT_ID=00000000-1111-2222-3333-444444444444 \
WARRAQ_GOOGLE_CLIENT_ID=123456789012-abcdefghijklmnop.apps.googleusercontent.com \
  ./scripts/install-macos.sh
```

| Variable | What it is |
| --- | --- |
| `WARRAQ_ONEDRIVE_CLIENT_ID` | the Microsoft app's Application (client) ID, a GUID |
| `WARRAQ_ONEDRIVE_TENANT` | `common` (default), `consumers`, `organizations`, a tenant ID or a domain |
| `WARRAQ_GOOGLE_CLIENT_ID` | a Google **Desktop app** OAuth client ID (desktop builds only) |

A value that cannot be an app's ID **fails the build** rather than shipping a
button that cannot sign in. Leaving a variable unset removes that drive
entirely.

**On GitHub** (the Windows and Mac installers and the auto-update releases),
the same three names are read from the repository's **Actions variables**
(Settings → Secrets and variables → Actions → *Variables* tab, not *Secrets*:
these IDs are public, and are in every copy of the app anyway). Add
`WARRAQ_ONEDRIVE_CLIENT_ID` and/or `WARRAQ_GOOGLE_CLIENT_ID` there and the
next build has the drive; nothing else changes. Both
`desktop-release.yml` and `desktop-windows.yml` pass them to the build.

Once a drive is in the build it appears on the home screen under
**Folders → Cloud drives**, as a folder beside the person's own, and in the
File menu.

---

## What leaves the device, and what is kept

* **Nothing happens without a click.** Signing in, browsing, searching,
  opening, saving and signing out each follow one. The home screen's account
  line and recent cloud files are read from this device, not from the drive.
* **The browser build** reaches the drive from the page itself. Its security
  policy names exactly the hosts OneDrive uses, and only when OneDrive is
  configured (`packages/ui/src/cloud/hosts.json`):
  `login.microsoftonline.com`, `graph.microsoft.com`, `*.1drv.com`,
  `*.sharepoint.com`, `*.microsoftpersonalcontent.com`.
* **The desktop app** reaches no drive from its window: every request is made
  by the host, in Rust, to those same hosts and Google's two
  (`oauth2.googleapis.com`, `www.googleapis.com`). That is also why it can sign
  in at all — Microsoft redeems a desktop app's code only for a request that
  carries no `Origin`, and every request from a webview carries one.
* **Tokens.** In a browser they live in memory and are gone when the tab
  closes, unless the person ticks *Stay signed in on this browser*, which keeps
  the refresh token in this browser's storage for as long as Microsoft honours
  it (24 hours for a browser app). On the desktop the refresh token goes
  straight from the token endpoint into the system's credential store — the
  macOS keychain, Windows Credential Manager, the Secret Service on Linux — and
  never reaches the window; the app window is given access tokens only.
* **What else is kept on the device**: which account is signed in (name and
  address), the last eight cloud files opened (drive, item, name) and a small
  picture of each one's first page. Signing out of a drive forgets its
  account, its recent files and their pictures.

---

## Limits, and things worth knowing

* **Google Drive is desktop only.** Google redeems no authorization code from
  a browser application without a client secret, whatever PKCE does, so a
  browser build with no secret cannot sign in to it at all. The alternative
  Google offers browsers — its token model, which is the implicit grant, with
  Google's own scripts running in the page — is neither what this app was asked
  to do nor what its security policy allows. `docs/STATUS.md` keeps this as a
  decision for the owner.
* **A browser sign-in lasts at most 24 hours.** Microsoft gives a browser app's
  refresh token that lifetime, however often it is refreshed; after that the
  person signs in again.
* **Google Drive cannot be written conditionally.** Drive's API has no
  `If-Match`, so before writing, the app reads the file's head revision and
  refuses if it is not the one the file was opened at. Someone saving in the
  moment between that read and the write would still be overwritten; OneDrive's
  `If-Match` has no such window.
* **OneDrive**: the person's own drive is browsed (`/me/drive`), with
  shortcuts to other drives followed; SharePoint sites and shared libraries are
  not listed. Saving goes through an upload session, so a file of any size is
  saved the same way. Names OneDrive refuses (`" * : < > ? / \ |`, trailing
  dots) are changed, and the sheet says what the file will be called.
* **National clouds** (US Government, China) are not supported: the hosts are
  the global ones.
* **The browser extension offers no cloud drive**: it has no place to be sent
  back to after a sign-in.
* **Nothing is shared**: the app never creates sharing links, and asks for no
  permission to.

---

## Signing out, and withdrawing the app's access

* **Google**: signing out asks Google to revoke the token, and forgets it here.
  The person can also remove the app at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
* **Microsoft**: a public client cannot revoke its own tokens; signing out
  forgets the sign-in on this device. To withdraw the app's access, the person
  removes it at [account.live.com/consent/Manage](https://account.live.com/consent/Manage)
  (personal accounts) or [myapps.microsoft.com](https://myapps.microsoft.com)
  (work or school). The app says this where it signs out.

---

## When a provider refuses

| What you see | What it means |
| --- | --- |
| `AADSTS50011` — redirect URI mismatch | the address the app came back to is not registered; add it exactly, as an **SPA** URI for the browser build and an **InstalledClient** one for the desktop |
| `AADSTS9002326` — cross-origin redemption | a browser redeemed a code for a redirect URI that is not of the `spa` type: fix the platform in the registration |
| `AADSTS700025` — client is public | a secret was sent; there is none in this app, so this means the registration expects a confidential client |
| `AADSTS700082`/`invalid_grant` on refresh | the sign-in ended (24 hours in a browser, or it was withdrawn); the app asks the person to sign in again |
| Google `redirect_uri_mismatch` | the client is not of type **Desktop app** |
| Google `invalid_request: client_secret is missing.` | the warning above: Google is asking a public client for a secret |
| "The browser blocked the sign-in window" | the browser stopped the pop-up; allow pop-ups for the site |

---

## How this is tested

* `apps/web/e2e/cloud.spec.ts` — OneDrive through the interface, against a
  stand-in for Microsoft's identity platform and Graph that checks PKCE, the
  redirect URI and the origin a code is redeemed from, bearer tokens,
  `If-Match` (412), `conflictBehavior` (409) and upload ranges. It builds its
  own app configured with a test client ID, and its first test shows that the
  default build has no cloud control and no drive's host in its policy.
* `apps/web/e2e/cloud-desktop.spec.ts` — the desktop's own path (both drives),
  with the host's commands answered as `cloud.rs` answers them.
* `apps/desktop/src-tauri/src/cloud.rs` — twenty Rust tests: the loopback
  listener (state, one-shot, timeouts, other paths and methods, oversized and
  silent connections), the host allowlists, the token and sign-out logic.
* `packages/ui/src/cloud/*.test.ts` — PKCE (RFC 7636's own example), tokens and
  refresh, the Graph and Drive requests, what the build ships.
