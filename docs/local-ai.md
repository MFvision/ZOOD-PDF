# Local-first AI and read aloud (desktop and web)

*2026-09-26. The owner's request: the app local-first — the smallest capable
on-device model for questions, summaries and form autofill, and text-to-speech
with the system's own voices; offline, no API keys, no recurring fees. This is
the desktop and web part (E). The iPhone and iPad app's part (F: Apple's
Foundation Models, AVSpeech) is documented with the iOS app.*

## What a person gets

- **"On this device" is the AI tool's default provider.** A small model runs
  inside the app itself; nothing leaves the device, no key is needed, and it
  works offline once the model is on the device. Claude (with the person's own
  Anthropic key) and Ollama / LM Studio remain, behind it, exactly as before.
- **The model is not in the installer.** The panel says which model, its
  licence (Apache-2.0), its size and its SHA-256, and offers one button:
  *Download the on-device model (1.0 GB, once)*. Only that click fetches
  anything — from Qwen's own repository on Hugging Face, following its redirect
  to Hugging Face's CDN and nowhere else — and the file is kept only once its
  size and SHA-256 match `packages/ui/src/ai/device/models.json`, the one
  catalogue the interface and the desktop host both read. Settings shows the
  model with its size and deletes it.
- **Every task the AI tool has** — summarize, ask, explain simply, key points,
  quiz, draft an email, translate, OCR post-correction, form fill, personal
  information, tables — runs on the on-device model too. A data task's schema
  becomes a GBNF grammar the sampling follows (`ai/device/grammar.ts`), so the
  answer is JSON of the shape asked; it is still checked field by field.
- **Long documents.** The model's window is 4,096 tokens (about 4,000
  characters of Arabic after the rules and the reply). A question about a
  longer document goes with the passages that answer it: the pages are put in
  a Library index of their own (the same inverted index and Arabic-aware
  ranking the Library searches folders with, on this device), the question is
  the query, and the best lines with their neighbours go, in page order, each
  inside its page's tag, so the answer still cites pages
  (`ai/device/retrieval.ts`). The preflight says so, and which pages.
- **Form autofill from a profile.** Settings holds *My details for forms*:
  name in Arabic and English, national ID/Iqama, phone, e-mail, address,
  employer, date of birth, IBAN — all optional. They are kept encrypted at
  rest: in the system's credential store on the desktop (the macOS Keychain,
  Windows Credential Manager/DPAPI, the Secret Service; `src-tauri/src/profile.rs`),
  and in IndexedDB under an AES-GCM key WebCrypto made for the origin and will
  not export, in a browser (`ai/profile/store.ts`). The AI tool's *Fill in the
  form from my details* sends the saved details first (labelled in both
  languages), then anything typed; the model maps the form's fields — the
  Prepare-form field list with the words printed beside each — to those
  values, never inventing one, and every proposal is reviewed in the existing
  smart-fill sheet before it is typed into the fields.
- **Read aloud**, from the toolbar's speaker button or *View › Read aloud*:
  this page, from here to the end, or the selection; play, pause, resume,
  stop; speed; a voice for Arabic and one for English from the system's own
  offline voices (premium and enhanced ones preferred; Siri's are not offered
  to apps, and the settings say so). One utterance a sentence, cut from the
  page's lines in logical order, so Arabic is read as written; the sentence
  being read is marked on the page in both views (over EmbedPDF's page through
  its scroll geometry; as a layer of Warraq's own page in Edit text), and
  reading goes on to the next page.

## How it is built

| Host | Engine | Model | Where it runs |
|---|---|---|---|
| Desktop (Tauri) | llama.cpp through `llama-cpp-2` (MIT), built from source by cmake; `src-tauri/src/ai.rs` | Qwen2.5-1.5B-Instruct Q4_K_M (1.1 GB) on a machine with 8 GB or more; Qwen2.5-0.5B-Instruct (491 MB) below that (`ai_memory_bytes`) | Metal on the Mac; the processor on Windows (AVX2 where present, chosen by ggml at run time). Context 4,096; tokens streamed to the webview as events |
| Web, PWA, extension | `@wllama/wllama` 3.6 (MIT), llama.cpp in WebAssembly, served from the app's own origin | Qwen2.5-0.5B-Instruct Q4_K_M, in the origin's private file system | Several threads where the page is cross-origin isolated, one otherwise; the panel says answers are weaker than on the desktop |
| Tests (CI, e2e) | a stub installed on the page before the app loads (`apps/web/e2e/deviceStub.ts`), on the hook `ai/device/engine.ts` looks for | none downloaded | — |

The desktop host runs one engine thread that owns the loaded model (loaded
once and kept; reloaded only when another file is named), takes one request
at a time, samples with top-k 40 / top-p 0.9 / temperature 0.3 — or greedily
under a grammar — and stops on the model's end token, at the reply cap (1,024
tokens), or on `ai_cancel`. The download streams into a `.part` file, hashed
as it goes, and is renamed into place only once the size and digest match; a
stopped or failed download leaves nothing behind.

The web page's policy adds exactly `https://huggingface.co https://*.hf.co` to
`connect-src`, for that one download (`apps/web/src/csp.test.ts`); the
desktop's policy is unchanged, since its host does the downloading.

## Proven by

- `apps/web/e2e/ai-device.spec.ts`: the default provider, the download on the
  button only, the licence and checksum shown first, a question on a long
  document answered from its passages (the sent text is lines of the document,
  within the window), a short document summarized whole with the answer
  streamed, a form filled from the saved profile (the profile is ciphertext in
  IndexedDB, the request carries the profile and the grammar, the reviewed
  values are typed into the fields), and the model deleted from Settings.
  `stayLocal` fails any of them if a request leaves the app.
- `apps/web/e2e/read-aloud.spec.ts`: the page read in logical order with the
  Arabic voice, each sentence marked over EmbedPDF's page, pause, resume,
  stop; the whole document read on to page 2 at the chosen speed; the mark
  as a layer of Warraq's own page in Edit text.
- Unit tests: the grammar for every data schema, the passage retrieval, the
  profile, the streamed SHA-256, the sentence splitter and boxes, the voices,
  and the reading state machine against a fake engine (`packages/ui/src/ai/device/*.test.ts`,
  `packages/ui/src/speech/*.test.ts`); the catalogue, the host allow-list and
  the file verification in Rust (`src-tauri/src/ai.rs`).
- The real model, once by hand on this Mac: `docs/STATUS.md`, "Local-first AI, measured".

## Limits, stated plainly

- Answers from a 1.5B model are far weaker than Claude's: fine for a summary,
  a plain question, a form's values; wrong more often on reasoning. The 0.5B
  in a browser more so, and slowly on one thread.
- The selection is read aloud without a mark on the page (its place is not
  known); the page and the document are marked sentence by sentence.
- Sentence boxes are the stretch of each line by its share of characters, not
  glyph-exact.
- Voices are whatever the system has installed; a language without a voice is
  read with the nearest, and the bar says when there is none.
- Windows has not been run here (no Windows machine): the CPU path, DPAPI store
  and Microsoft voices are built from the same code and not proven by hand.
