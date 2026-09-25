# Feature matrix

Legend: ✅ proven by an automated test in `verify.sh` · 🟡 implemented, not proven on this platform · ⛔ not available (reason in STATUS) · — not applicable.
M = iOS native app.

| Tool | Web | Desktop | Extension | iOS (M) |
| --- | --- | --- | --- | --- |
| (filled in as tools land) | | | | |
| Comment (EmbedPDF) | ✅ `open-save.spec.ts` | | 🟡 extension page opens PDFs (`extension.spec.ts`); tool not exercised there | |
| Fill & sign (EmbedPDF) | 🟡 tool strip reachable (`redact-protect.spec.ts`); signing not yet saved+reopened in a spec | | 🟡 | |
| Digital signature (engine `sign.*`: PAdES B-B…B-LTA, verify, attack detection) | 🟡 engine proven by Rust tests (STATUS › Digital signatures); UI not wired yet | 🟡 same engine; TSA/OCSP HTTP from the desktop host not wired | 🟡 | 🟡 engine via C ABI, not exercised |
| Prepare form (EmbedPDF form fields) | 🟡 tool strip reachable (`redact-protect.spec.ts`) | | 🟡 | |
| Redact (EmbedPDF marks + apply) | ✅ mark, apply, save as whole rewrite, recents preview dropped (`redact-protect.spec.ts`) | | 🟡 | |
| Protect (EmbedPDF sheet) | 🟡 sheet reachable in en/ar (`redact-protect.spec.ts`); password save not yet reopened in a spec | | 🟡 | |
