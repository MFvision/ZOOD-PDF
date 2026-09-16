#!/usr/bin/env python3
"""Merge results-<candidate>.json files, score text against truth, and write
tests/acid/results.json plus docs/research/raw/acid-scores.md."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent)); from score import score
REPO = Path(sys.argv[1]).resolve(); ACID = REPO / "tests/acid"; TRUTH = REPO / "tests/corpus/arabic/truth"
IMAGE_ONLY = {"scan-notonaskh-300dpi-skewed-jpeg", "scan-arial-200dpi-bilevel"}
cands = sorted(p.stem.replace("results-", "") for p in ACID.glob("results-*.json") if p.stem != "results")
data = {c: json.load(open(ACID / f"results-{c}.json")) for c in cands}
stems = sorted(set().union(*[d.keys() for d in data.values()]))
merged = {}
for s in stems:
    truth_path = TRUTH / f"{s}.txt"; truth = truth_path.read_text(encoding="utf-8") if truth_path.exists() else None
    merged[s] = {}
    for c in cands:
        r = dict(data[c].get(s, {"open": False, "error": "not run"}))
        text = r.pop("text", "")
        if r.get("open") and truth and s not in IMAGE_ONLY: r["score"] = score(truth, text)
        elif r.get("open") and s in IMAGE_ONLY: r["score"] = {"verdict": "image-only (OCR needed)", "n_extracted_words": len(text.split())}
        elif r.get("open"): r["score"] = {"verdict": "no-truth", "n_extracted_chars": len(text)}
        r["text_head"] = text[:90].replace("\n", " ⏎ ")
        merged[s][c] = r
json.dump(merged, open(ACID / "results.json", "w"), ensure_ascii=False, indent=1)
out = [f"# Acid-test scores\n\nCandidates: {', '.join(cands)}. Word-level scoring, see `tests/acid/score.py`.\n"]
out.append("| File | " + " | ".join(f"{c}: verdict (word recall logical / reversed, order fwd/line-rev) · open+render ms" for c in cands) + " |")
out.append("|---|" + "---|" * len(cands))
tally = {c: {} for c in cands}
for s in stems:
    cells = []
    for c in cands:
        r = merged[s][c]
        if not r.get("open"): cells.append(f"❌ open failed: {r.get('error','')[:60]}"); tally[c]["open-failed"] = tally[c].get("open-failed", 0) + 1; continue
        sc = r.get("score", {}); v = sc.get("verdict", "?"); tally[c][v] = tally[c].get(v, 0) + 1
        extra = f" ({sc['recall_logical']:.2f} / {sc['recall_reversed']:.2f}, {sc['order_lcs']:.2f}/{sc['order_lcs_linerev']:.2f})" if "recall_logical" in sc else ""
        flags = ("; pres.forms" if sc.get("pres_forms") else "") + ("; U+FFFD×%d" % sc["replacement_chars"] if sc.get("replacement_chars") else "")
        cells.append(f"{v}{extra}{flags} · {r.get('t_open_ms','?')}+{r.get('t_render_p1_ms','?')} ms")
    out.append(f"| `{s}` | " + " | ".join(cells) + " |")
out.append("\n## Verdict tally per candidate\n")
for c in cands: out.append(f"- **{c}**: " + ", ".join(f"{k}: {v}" for k, v in sorted(tally[c].items())))
perf = [s for s in stems if s.startswith("perf-")]
if perf:
    out.append("\n## Performance (page 1 open + render, and full-document text extraction)\n")
    out.append("| File | " + " | ".join(cands) + " |"); out.append("|---|" + "---|" * len(cands))
    for s in perf: out.append(f"| `{s}` | " + " | ".join(f"open {merged[s][c].get('t_open_ms','?')} ms, render {merged[s][c].get('t_render_p1_ms','?')} ms, text(all) {merged[s][c].get('t_text_all_pages_ms','?')} ms" for c in cands) + " |")
(REPO / "docs/research/raw").mkdir(parents=True, exist_ok=True)
(REPO / "docs/research/raw/acid-scores.md").write_text("\n".join(out) + "\n", encoding="utf-8")
print("\n".join(out[-(len(cands) + 2 + (len(perf) + 3 if perf else 0)):]))
