# 0017 — Local read aloud

Status: accepted (2026-09-26) · Owner amendment: `docs/SPEC.md` §8

## Context

The owner asked for local text-to-speech: built-in voices (Siri or "Ava (Premium)" if accessible), on
iPhone, iPad, Mac and Windows, offline, no keys, no fees. The document text must be read in logical
order, switching between Arabic and English voices, with the paragraph being read highlighted. Nothing
may leave the device (SPEC §1), and a control that is shown must work (no façades).

## Decision

**Text (engine).** A new RPC `text.readingUnits` (`warraq-text/src/reading.rs`) returns the
paragraphs of the logical-order extraction in reading order with their page, box and per-line boxes.
Text is cleaned for speech: tatweel, bidi controls, soft hyphens, BOMs dropped; tashkeel kept;
whitespace collapsed; an English word hyphenated at a line end joined. Numbers and abbreviations are
left to the voice. Each paragraph is split into **script runs** (Arabic → `ar`, Latin → `en`, other
scripts → `other` with their ISO 15924 script) so a mixed sentence is read by an Arabic voice and an
English voice in turn; neutral tokens (numbers, punctuation) stay in the run they are in, and a
minority run of fewer than 3 letters is merged into its neighbour (no voice switch for "A" in
«الملحق A»). Pagination artifacts (headers/footers/watermarks) are skipped; invisible OCR text is read.

**Speech (interface, `packages/ui/src/services/speech`).** One queue (`reader.ts`) over pluggable
backends:

* **web** (`web.ts`, web app, extension, Linux desktop): `speechSynthesis` restricted to voices with
  `localService === true` whose names are not network voices ("Google …", "… Online (Natural)").
  An utterance is only spoken with an explicitly chosen local voice — never the engine's default,
  which may be a network voice. The voice list waits for `voiceschanged` (Chrome loads it lazily).
* **native** (`native.ts`, desktop macOS/Windows): the host's `speech_*` commands backed by the
  `zood-speech` crate (`apps/desktop/speech`): macOS `AVSpeechSynthesizer` (objc2-avf-audio; voices
  with their quality, Premium → Enhanced → default; novelty and Personal Voice excluded; used on the
  main thread, delegate reports start/finish); Windows `Windows.Media.SpeechSynthesis` (windows-rs;
  installed OneCore voices, Arabic ones such as Hoda/Naayf when the speech pack is installed) played
  through one `MediaPlayer` per utterance. Linux has no native engine: `host_info.speech` is false
  and the webview's local voices are used, or the feature is hidden.

Paragraph runs are spoken as **sentence chunks of ≤ 200 characters** (Chrome silently stops long
utterances after ~15 s). Every utterance carries a generation number, so late events of cancelled
utterances never move the queue. **Pause** uses the engine's pause where it is reliable (native);
on the web it cancels and **resume repeats the sentence** (Chrome's `pause()` is unreliable,
especially on Linux and Android). The voice per language, speed and pitch are remembered on the
device only (`localStorage` `zood.readAloud`).

**Interface.** A Read aloud button in the document toolbar (Alt+Shift+R) opens a compact floating
player: previous/next paragraph, play/pause (Alt+Shift+B / N / P), progress, speed, and a voice
picker per language with the note that Siri voices are not available to other apps. Reading starts
at the paragraph under the text selection, else at the first paragraph of the page on screen. The
paragraph being read is highlighted over EmbedPDF's page (positions from its scroll plugin's
`getRectPositionForPage`, recomputed on scroll/zoom/layout) and scrolled into view. Media transport
buttons keep their LTR order in Arabic, like every media player; the rest of the player mirrors.
**When the device has no on-device voice the button is not shown** (no façade); a document language
without a voice is announced in the player and its passages are skipped — never read by a voice of
another language.

## Consequences

* Nothing is sent anywhere; the voices belong to the OS/browser, so quality depends on what is
  installed (macOS Premium/Enhanced voices are downloaded in System Settings → Accessibility → Spoken
  Content; Windows voices through Settings → Time & language → Speech).
* Siri voices cannot be used: Apple does not expose them to third-party apps (stated in the picker).
* The macOS and Windows engines cannot be run on the Linux CI machine; they are type-checked and
  clippy-clean for `aarch64-apple-darwin` / `x86_64-pc-windows-msvc` (`scripts/check-speech.sh`,
  part of `verify.sh`) and their unit tests run in the macOS/Windows workflows. Speaking through them
  needs a person at a Mac / Windows PC (STATUS).
* Highlight positions depend on EmbedPDF 2.15.1 internals (viewport element with the gap as padding,
  scroll plugin geometry); the e2e spec checks the highlight lands on the paragraph's line (±1.2 % of
  the page height) so an upgrade that breaks it fails the gate.
