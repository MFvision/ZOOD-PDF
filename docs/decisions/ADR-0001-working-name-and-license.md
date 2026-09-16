# ADR-0001 · Working name "Warraq", Apache-2.0, no GitHub push until the org is named

**Status:** accepted with placeholders · **Date:** 2026-09-16

## Context
The brief leaves `{{PRODUCT_NAME}}`, `{{ORG}}` and `{{LICENSE}}` to be filled in.
Work could not start without a name for the repository and crate/package
prefixes, and creating a GitHub repository is an outward-facing action that needs
the real organization name.

## Options
1. Wait for the names (blocks all work).
2. Pick a neutral working name, keep it trivially replaceable, and record the
   decision points for the owner.

## Choice
Option 2. Working name **Warraq** (ورّاق, the classical manuscript copyist and
bookseller; reads well in Latin script; no PDF product of that name was found in
the GitHub and npm searches of 2026-09-16, see `docs/research/raw/landscape.json`
search rows). Crate prefix `warraq-`, npm scope `@warraq/`. A trademark search is
still required before public use.

License: **Apache-2.0** for our code (patent grant, compatible with all adopted
components: BSD-3 PDFium, MIT/Apache Rust crates, OFL fonts). The alternative
"proprietary" is compatible with the same components but forfeits outside
contributions; the owner can still choose it before the first public release
because no third-party contribution has been accepted yet.

GitHub: the repository exists locally only (`git init`, branch `main`). Pushing
requires the organization name and the owner's approval; the exact command is in
`docs/STATUS.md`.

## Consequences
* Every occurrence of the name is in code identifiers and docs; a rename is a
  search-and-replace plus a crate rename before first publish.
* `LICENSE` file at the root is Apache-2.0; third-party notices are collected in
  `THIRD-PARTY-NOTICES.md` as components are integrated.
