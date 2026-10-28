# Help & Support

A support system that needs no support staff, no accounts and no paid
servers. Everything the app offers works on the device. The only thing that
leaves the device is a report or an idea, and only after the person reads
what will be sent and presses Send.

| Part | Where | Needs a server? |
| --- | --- | --- |
| Ask (search the guides, explain them with the device's own AI) | `packages/ui/src/support/` | no |
| Show me / Do it for me (the pointer finds the real button, step by step) | `support/guide.ts`, `GuideLayer.tsx` | no |
| 24 guides, FAQ, known limits, in Arabic and English | `support/articles.ts` | no |
| A picture of the real app for each step (some moving) | `scripts/support/make-shots.mjs`, `shots.mjs` | no |
| The guides as PDFs (in the app and on the website) | `scripts/support/make-guides.mjs` | no |
| Report a problem (log + screenshot, only by choice; status comes back) | `support/tickets.ts` + relay | relay, or e-mail |
| Ideas board (vote with no account) | `support/ideas.ts` + relay | relay |
| Weekly review (tickets fixed through PRs, idea report) | `docs/support/weekly-review.md` | no |

Open it with F1, Help › Help & Support, Settings › Support, or the tour's
Help & Support chapter.

## The relay

`website/api/support/` is a small PHP + MySQL relay. It runs on the existing
Hostinger plan at `https://pdf.zoodrealty.com/api/support/` and files each report
and idea as an issue in the private repository `MFvision/zood-support`. The
setup steps are in [its README](../../website/api/support/README.md).

Until it is online, Send shows "could not be reached just now" and offers
**Send by e-mail**. That opens a ready-made e-mail to the support address
with the same text and a short log, so the person can still send it.

The app may only reach the relay's own path. Both content security policies
name `https://pdf.zoodrealty.com/api/support/`, and `apps/web/src/csp.test.ts`
holds them to it.

## Privacy

- The log is kept in memory only (the last 200 lines). It is sent only when
  "Include the app's log" is ticked, and the review screen shows it first.
- A screenshot is attached only when the person adds one. It is shrunk to
  1600 px as a JPEG.
- The install number is a random id with no link to the person. The relay
  stores only a salted hash of it, and the same goes for IP addresses.
- A report can be answered only through the app, using the ticket's own
  token. Nobody else can read its status.

## Change the guides

1. Edit `ARTICLES` in `packages/ui/src/support/articles.ts`. Both languages
   are required, and `support.test.ts` checks that every step's target can be
   found.
2. Pictures: a step with `pic: 'name'` shows
   `packages/ui/public/guides/shots/name-<ar|en>.jpg` (and plays
   `name-<ar|en>.webp` when there is one and the person has not asked for less
   motion). Each picture has a recipe in `scripts/support/shots.mjs` that drives
   the real app to that step and says what to light up; the words come from the
   app's own messages, so one recipe takes both languages. Desktop-only windows
   (Settings › Quick tools, the ring, the phone remote) run against a stand-in
   for the native side, `scripts/support/desktop-host.mjs`. Retake them after
   the screens they show change:

   ```
   pnpm --filter @warraq/web exec vite build
   pnpm --filter @warraq/web exec vite build --mode tauri --outDir dist-tauri
   CHROMIUM=/path/to/chromium node scripts/support/make-shots.mjs [name…]
   ```

   With no names, every picture is taken again (about 15 minutes). A recipe
   with `motion` makes a moving picture: it calls `frame()` at each moment, and
   the still is its first marked moment. `support.test.ts` fails if a step's
   picture is missing in either language.
3. Regenerate the PDFs and the website help pages:

   ```
   CHROMIUM=/path/to/chromium node --experimental-strip-types scripts/support/make-guides.mjs
   ```

4. To add a video to a guide, set `video` (a YouTube link) on its article. The
   button appears only when a video is set.

## Tests

- `packages/ui/src/support/support.test.ts`: the guides, the search (Arabic
  and English), the log, the relay client, tickets and ideas.
- `apps/web/e2e/support.spec.ts`: F1, Show me, Do it for me, a report and its
  status, the e-mail fallback, voting, the PDF guide, Arabic RTL, and that a
  guide's step pictures load.
- `node website/tools/support-relay-check.mjs`: the PHP relay end to end with
  SQLite and a fake GitHub.
