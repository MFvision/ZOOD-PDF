# Feature matrix

Legend: ✅ proven by an automated test in `verify.sh` · 🟡 implemented, not proven on this platform · ⛔ not available (reason in STATUS) · — not applicable.
M = iOS native app.

| Tool | Web | Desktop | Extension | iOS (M) |
| --- | --- | --- | --- | --- |
| (filled in as tools land) | | | | |
| Comment (EmbedPDF) | ✅ `open-save.spec.ts` | | 🟡 extension page opens PDFs (`extension.spec.ts`); tool not exercised there | |
| Fill & sign (EmbedPDF) | 🟡 tool strip reachable (`redact-protect.spec.ts`); signing not yet saved+reopened in a spec | | 🟡 | |
| Prepare form (EmbedPDF form fields) | 🟡 tool strip reachable (`redact-protect.spec.ts`) | | 🟡 | |
| Redact (EmbedPDF marks + apply) | ✅ mark, apply, save as whole rewrite, recents preview dropped (`redact-protect.spec.ts`) | | 🟡 | |
| Protect (EmbedPDF sheet) | 🟡 sheet reachable in en/ar (`redact-protect.spec.ts`); password save not yet reopened in a spec | | 🟡 | |
| Organize (grid, rotate, reorder, delete, insert blank/file/picture, replace, extract, split → ZIP, crop, trim, context menu, undo/redo) | ✅ `organize.spec.ts` (en + ar + phone width) | 🟡 same UI in Tauri, not exercised | 🟡 same UI, not exercised | |
| Combine (Home: pick + reorder → new document; drop on open document → «دمج مع …» / «فتح بدلاً منه»; insert at a position) | ✅ `combine.spec.ts` (en + ar) | 🟡 host drop without preview → choice sheet, not exercised | 🟡 | |
| Compress (presets, before/after, save/open the copy; original untouched) | ✅ `compress.spec.ts` (en + ar) | 🟡 | 🟡 | |
