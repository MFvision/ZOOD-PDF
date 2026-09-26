# ADR 0015 — Local-first AI, form autofill and read-aloud on iOS/iPadOS

Status: accepted · Date: 2026-09-26 · Implements SPEC §8 (owner amendment) for the native iOS app.
Amends ADR 0010 point 9 ("No third-party Swift packages"): llama.cpp is now linked as a prebuilt,
pinned binary framework.

## Context

The owner removed bring-your-own-key cloud AI: AI must run on the device, offline, with no API keys
and no recurring fees, and the app must read documents aloud with the best local voices. The iOS app
targets iOS 18+, Swift 6 strict concurrency; development machines are Linux (no Xcode).

## Decision

1. **The Anthropic path is gone.** `AIClient`, the SSE parser, the request body, the Keychain key
   store and the key/model settings UI were deleted. No code in the app talks to an AI service.
2. **Two on-device backends, chosen per request** (`AIBackendChooser`, ZoodKit):
   * **Apple Foundation Models** (`SystemLanguageModel.default`, `LanguageModelSession`) when
     `if #available(iOS 26, *)`, `availability == .available` and `supportsLocale(_:)` is true for
     every language involved (UI language, document language, and the target language for
     translation). Arabic support is checked **at run time** — it depends on the OS release. Answers
     stream (`streamResponse`, snapshots → deltas); form autofill uses guided generation
     (`@Generable GeneratedAutofill`). `FoundationModels` is weak-linked (`-weak_framework`).
   * **Portable model**: Qwen3-1.7B GGUF Q4_K_M (1,107,409,472 bytes, Apache-2.0) or, on devices
     with < 6 GB of memory, Qwen3-0.6B Q4_K_M (396,705,472 bytes), run by **llama.cpp (MIT)**.
     Files come from `huggingface.co/unsloth/Qwen3-*-GGUF/resolve/<40-hex revision>/…` with pinned
     byte size and SHA-256 (`LocalModelCatalog`). Download only on user click, size shown first;
     background `URLSession` (resumes after pause/network loss, continues when the app is
     suspended; the app delegate forwards `handleEventsForBackgroundURLSession`); verified with
     CryptoKit SHA-256 before use; stored in Application Support/Models, excluded from backup.
     "Import model file" accepts a `.gguf` from Files (GGUF header checked; a file identical to a
     catalog model is recognised by its hash; other files get conservative context settings).
     Qwen3 runs with the ChatML template and thinking switched off (empty `<think>` block, plus a
     streaming `ThinkFilter`); content is sanitised so document text cannot inject `<|im_…|>`
     control tokens; token bytes are reassembled into whole UTF-8 characters (Arabic letters
     split across tokens). Autofill under llama.cpp is constrained by a generated GBNF grammar
     that only allows the form's own field ids and the documented source forms.
3. **llama.cpp packaging.** `scripts/ios/fetch-llama.sh` downloads the official release
   XCFramework `llama-b11200-xcframework.zip` (SHA-256 `c62cae37…b3b8808c`, checked) into
   `apps/ios/Frameworks/llama.xcframework`. That release ships **iOS device (arm64) and macOS slices
   only — no simulator slice**. `project.yml` therefore links it only for `sdk=iphoneos*`
   (`FRAMEWORK_SEARCH_PATHS[sdk=iphoneos*]`, `OTHER_LDFLAGS[sdk=iphoneos*] = -framework llama`) and a
   post-compile script embeds and signs `llama.framework` for device builds. Swift code uses
   `#if canImport(llama)`, so simulator builds compile without it and offer Apple's model only
   (`PortableModelRunner.isCompiledIn == false`). A Swift package was not used: the release zip is
   the upstream-recommended artefact, and a SwiftPM binary target cannot be limited to device SDKs.
4. **Context from the document.** The engine's logical-order text (`text.plain` pages; Arabic-aware)
   is chunked per page (never across pages, so citations are exact), ranked with BM25 over
   Arabic-normalised, lightly stemmed terms for questions, or sampled evenly over the document for
   summaries/key points, within a character budget per model (Apple 4,500 chars; Qwen3-1.7B 10,000;
   0.6B 4,500). A context overflow retries once with half the text. Answers cite `[p. N]`
   (also `[ص N]`, ranges, Arabic-Indic digits); only pages that exist become tappable links that
   move PDFKit to that page (the sheet drops to a medium detent). "Show prompt" displays exactly
   what the model received.
5. **Form autofill** reads PDFKit widget annotations (text, checkbox, choice; label from `/TU` or
   the text beside the field). The profile ("My details": names ar/en, national ID/Iqama with a
   Luhn check warning, phone, email, address, city, postal code, DOB Gregorian → Hijri Umm al-Qura,
   employer, job title) is a JSON file written with `.completeFileProtection` and excluded from
   backup; "Clear" deletes the file. Proposals come first from deterministic Arabic/English keyword
   rules, then (on request) from the model for the remaining fields. **Every model proposal is
   validated** (`AutofillValidator`): unknown/read-only/signature fields, duplicates, over-long
   values, control and bidi-override characters, script-like content, non-options, non-booleans,
   unknown sources, profile values that do not equal the profile, and document values that do not
   occur on the cited page are all dropped (and counted). Model proposals start unticked; the user
   reviews every value, then they are written into the widgets and saved through the existing
   `doc.rebase` incremental path.
6. **Read aloud** uses `AVSpeechSynthesizer` only. Paragraphs with boxes come from the engine
   (`text.extract`); sentences are grouped per language so Arabic and English get their own voice
   (`VoiceRanker`: Premium > Enhanced > default, preferred region ar-SA / en-US, novelty and
   Personal Voice excluded; the user's choice per language is kept while installed). The paragraph
   being read is highlighted with `PDFView.highlightedSelections` (engine top-left box → PDF page
   space) and scrolled into view. `AVAudioSession` `.playback` / `.spokenAudio`,
   `UIBackgroundModes: audio`, Now Playing info and remote commands (play, pause, toggle,
   next/previous paragraph), interruption → pause. The voice picker states that Siri voices are
   not available to apps and how to download Premium voices (Settings › Accessibility › Spoken
   Content › Voices).
7. **App Intents**: "Summarize PDF" (IntentFile in, summary out, runs on the device) and "Read PDF
   aloud" (opens a recent document via `zoodpdf://read?id=…` and starts reading).
8. **Testability.** Everything platform-independent lives in ZoodKit (`ZoodCore/LocalAI`,
   `ZoodCore/Autofill`, `ZoodCore/ReadAloud`, engine wrappers `pageTexts()` / `paragraphs()`) and is
   tested on Linux against the real engine. Apple-framework code is in the app target behind
   `#if canImport(FoundationModels)` / `#if canImport(llama)`.

## Consequences

* None of the app-target code (Foundation Models, llama.cpp calls, URLSession background download,
  PDFKit widgets, AVSpeechSynthesizer, MediaPlayer) has been compiled here; it is syntax-checked
  only. Simulator tests for the glue are written (`Tests/ZoodPDFTests/LocalFirstTests.swift`) and
  must be run on a Mac. The llama.cpp path can only be exercised on a physical device.
* The app grows by the llama.cpp framework (~11 MB) in device builds; models are downloaded, never
  bundled.
* Qwen3 is a small model: answers can be wrong. The UI says the document is the only source,
  citations are checked against real pages, and autofill values are verified against the profile
  or the document text before they can be accepted.
