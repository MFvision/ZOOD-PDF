# ADR-0002 · The Arabic corpus is the gate; a red Arabic test blocks merge

**Status:** accepted · **Date:** 2026-09-16

## Context
Every existing PDF engine we measured fails Arabic in a different way (see
`docs/research/01-arabic-test-results.md`). The brief makes every Arabic defect a
P0. Without a fixed, versioned corpus with ground truth, "works with Arabic" is an
opinion.

## Choice
* `tests/corpus/arabic/` holds 26 generated files (each with a logical-order
  truth file) and 15 real-world files with provenance and license, covering
  Word, InDesign, LibreOffice, Google Docs/Skia, macOS Quartz, ReportLab-style
  visual order, symbolic legacy fonts, missing/broken ToUnicode, scans, AcroForms,
  encryption, object streams, incremental updates and 100/500-page performance
  files.
* Scoring is word-level after NFKC and mark stripping, separating character
  order inside words from word order along lines (`tests/acid/score.py`).
* CI runs the corpus on every PR. A regression on any Arabic file fails the
  build. New Arabic bugs get a corpus file before the fix.
* Reference engines used only for measurement (MuPDF/PyMuPDF AGPL, pikepdf MPL)
  never ship.

## Consequences
* The corpus is part of the definition of done for Phase 2 and every later phase.
* Real-world files are redistributed under their stated terms (UN public
  documents, CC BY/BY-SA/CC0, public bug-tracker attachments for test use); the
  manifest must be kept accurate when files are added.
