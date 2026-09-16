#!/usr/bin/env python3
"""Arabic corpus gate for the Warraq core (CI): fails when extraction quality regresses
against tests/acid/baseline-warraq.json. Usage:
  gate_warraq.py <repo>            # check
  gate_warraq.py <repo> --update   # rewrite the baseline from the current results
A red Arabic test blocks merge (ADR-0002)."""
import json, sys
from pathlib import Path
repo = Path(sys.argv[1]).resolve(); acid = repo / "tests/acid"
sys.path.insert(0, str(acid)); from score import score
results = json.load(open(acid / "results-warraq.json"))
truth_dir = repo / "tests/corpus/arabic/truth"
current = {}
for stem, r in results.items():
    t = truth_dir / f"{stem}.txt"
    entry = {"open": bool(r.get("open"))}
    if r.get("open") and t.exists():
        sc = score(t.read_text(encoding="utf-8"), r.get("text", ""))
        entry.update(verdict=sc.get("verdict"), recall_logical=sc.get("recall_logical", 0.0), order_lcs=sc.get("order_lcs", 0.0))
    current[stem] = entry
baseline_path = acid / "baseline-warraq.json"
if "--update" in sys.argv:
    json.dump(current, open(baseline_path, "w"), ensure_ascii=False, indent=1, sort_keys=True); print(f"baseline written: {len(current)} files"); sys.exit(0)
baseline = json.load(open(baseline_path))
TOL = 0.05; failures = []
for stem, b in baseline.items():
    c = current.get(stem)
    if c is None: failures.append(f"{stem}: missing from results"); continue
    if b["open"] and not c["open"]: failures.append(f"{stem}: no longer opens"); continue
    if "recall_logical" in b and c.get("recall_logical", 0.0) + TOL < b["recall_logical"]: failures.append(f"{stem}: recall {c.get('recall_logical')} < baseline {b['recall_logical']}")
    if "order_lcs" in b and c.get("order_lcs", 0.0) + TOL < b["order_lcs"]: failures.append(f"{stem}: order {c.get('order_lcs')} < baseline {b['order_lcs']}")
    if b.get("verdict") == "logical" and c.get("verdict") != "logical": failures.append(f"{stem}: was logical, now {c.get('verdict')}")
improved = [s for s, b in baseline.items() if "recall_logical" in b and current.get(s, {}).get("recall_logical", 0) > b["recall_logical"] + TOL]
print(f"checked {len(baseline)} files; improved: {len(improved)}; failures: {len(failures)}")
for f in failures: print("  FAIL", f)
sys.exit(1 if failures else 0)
