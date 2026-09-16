#!/usr/bin/env python3
"""CI gate for the Arabic corpus: every corpus PDF must open and render in PDFium.

Reads tests/acid/results.json (written by tests/acid/merge.py; shape
{stem: {candidate: {...}}}) or, with --results, a raw results-<candidate>.json
from tests/acid/run_python.py (shape {stem: {...}}). Fails when any file in
tests/corpus/arabic/generated (and, unless --generated-only, realworld) is
missing from the results, did not open, or did not render its first page.

Usage: check_corpus.py <repo> [--candidate pdfium] [--results PATH] [--generated-only]
"""
import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("repo")
    ap.add_argument("--candidate", default="pdfium", help="engine key in the results (default: pdfium)")
    ap.add_argument("--results", help="results file (default: <repo>/tests/acid/results.json)")
    ap.add_argument("--generated-only", action="store_true", help="ignore tests/corpus/arabic/realworld")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    corpus = repo / "tests" / "corpus" / "arabic"
    sets = {"generated": sorted(p.stem for p in (corpus / "generated").glob("*.pdf"))}
    if not args.generated_only:
        sets["realworld"] = sorted(p.stem for p in (corpus / "realworld").glob("*.pdf"))
    if not sets["generated"]:
        print(f"check_corpus: no PDFs found in {corpus / 'generated'}", file=sys.stderr)
        return 2

    results_path = Path(args.results) if args.results else repo / "tests" / "acid" / "results.json"
    try:
        data = json.loads(results_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"check_corpus: cannot read {results_path}: {e}", file=sys.stderr)
        return 2

    def lookup(stem: str):
        entry = data.get(stem)
        if not isinstance(entry, dict):
            return None
        if isinstance(entry.get(args.candidate), dict):  # merged results.json
            return entry[args.candidate]
        if "open" in entry:  # raw results-<candidate>.json
            return entry
        return None

    failures = []
    total = 0
    for kind, stems in sets.items():
        for stem in stems:
            total += 1
            r = lookup(stem)
            if r is None:
                failures.append((kind, stem, "missing from results (runner did not report it)"))
            elif not r.get("open"):
                failures.append((kind, stem, r.get("error") or "open failed"))
            elif r.get("t_render_p1_ms") is None:
                failures.append((kind, stem, "opened but page 1 did not render"))

    print(f"check_corpus: {args.candidate} — {total - len(failures)}/{total} corpus files opened and rendered "
          f"({', '.join(f'{k}: {len(v)}' for k, v in sets.items())}; results: {results_path.relative_to(repo) if results_path.is_relative_to(repo) else results_path})")
    for kind, stem, why in failures:
        print(f"::error title=Arabic corpus gate::{kind}/{stem}.pdf — {why}")
    if failures:
        print(f"check_corpus: FAILED — {len(failures)} file(s) did not open/render in {args.candidate}", file=sys.stderr)
        return 1
    print("check_corpus: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
