#!/usr/bin/env python3
"""Checks the iOS String Catalogs (runs anywhere, no Xcode needed).

* every localisation key used in apps/ios Swift sources exists in App/Localizable.xcstrings
  (widget sources: in Widgets/Localizable.xcstrings);
* every key has an English and an Arabic value (plural keys: Arabic zero/one/two/few/many/other);
* no catalog key is unused;
* interpolated keys have as many %-placeholders as the Swift interpolation has arguments.

Keys are the dotted literals the app uses ("home.hero.title", "doc.pageOf \\(a) \\(b)" →
"doc.pageOf %lld %lld"). SF Symbol names and accessibility identifiers are skipped.
Exit status 1 on any problem.
"""
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "apps", "ios")
NAMESPACES = {
    "ai", "annotate", "app", "autofill", "color", "combine", "common", "compress", "convert", "doc", "drop", "engine",
    "entity", "error", "home", "intent", "more", "nav", "organize", "plus", "profile", "protect", "range", "read", "recents",
    "scan", "search", "section", "tags", "tool", "widget",
}
# Accessibility identifiers / engine method names that look like keys.
NOT_KEYS = {
    "doc.pdfview", "doc.canvas", "doc.title", "doc.save", "doc.annotate", "doc.tools", "doc.tool.organize",
    "doc.password", "home.plus", "protect.user", "protect.confirm", "protect.apply", "organize.range",
    "scan.shutter", "scan.save", "scan.useScan", "scan.document.start", "combine.add", "combine.run",
    "compress.run", "annotate.done", "annotate.highlightSelection", "doc.saveFull", "text.plain",
}
SYMBOL_WORDS = {"viewfinder", "questionmark", "badge", "richtext", "fill", "on", "rectangle", "text"}
PAT = re.compile(r'"((?:[a-z][a-zA-Z]*)\.[A-Za-z0-9.]+)((?: \\\((?:[^()]|\([^()]*\))*\))*)"')


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)["strings"]


def check_entry(key, entry, problems, where):
    locs = entry.get("localizations", {})
    for lang in ("en", "ar"):
        loc = locs.get(lang)
        if not loc:
            problems.append(f"{where}: {key} has no {lang} value")
            continue
        if "variations" in loc:
            forms = loc["variations"].get("plural", {})
            need = {"one", "other"} if lang == "en" else {"zero", "one", "two", "few", "many", "other"}
            if not need <= set(forms):
                problems.append(f"{where}: {key} {lang} plural forms missing {sorted(need - set(forms))}")
        elif not loc.get("stringUnit", {}).get("value"):
            problems.append(f"{where}: {key} {lang} value is empty")


def main():
    problems = []
    app = load(os.path.join(ROOT, "App", "Localizable.xcstrings"))
    widgets = load(os.path.join(ROOT, "Widgets", "Localizable.xcstrings"))
    for k, e in app.items():
        check_entry(k, e, problems, "App")
    for k, e in widgets.items():
        check_entry(k, e, problems, "Widgets")
    used_app, used_widgets = set(), set()
    for folder in ("App", "Shared", "Intents", "Widgets"):
        for dp, _, files in os.walk(os.path.join(ROOT, folder)):
            for name in files:
                if not name.endswith(".swift"):
                    continue
                src = open(os.path.join(dp, name), encoding="utf-8").read()
                for m in PAT.finditer(src):
                    base, interp = m.group(1), m.group(2)
                    n = interp.count("\\(")
                    if base.split(".")[0] not in NAMESPACES:
                        continue
                    if n == 0 and base in NOT_KEYS and base not in app:
                        continue
                    if set(base.split(".")[1:]) & SYMBOL_WORDS and base not in app:
                        continue
                    catalogs = [(app, used_app)]
                    if folder in ("Widgets", "Shared"):
                        catalogs.append((widgets, used_widgets))
                    for cat, used in catalogs:
                        if n == 0:
                            if base in cat:
                                used.add(base)
                            else:
                                problems.append(f"{name}: key '{base}' missing")
                        else:
                            hits = [k for k in cat if k.split(" ")[0] == base and len(re.findall(r"%(?:\d\$)?(?:lld|@)", k)) == n]
                            if hits:
                                used.update(hits)
                            else:
                                problems.append(f"{name}: interpolated key '{base}' with {n} argument(s) missing")
    for k in sorted(set(app) - used_app):
        problems.append(f"App catalog key unused: {k}")
    for k in sorted(set(widgets) - used_widgets):
        problems.append(f"Widgets catalog key unused: {k}")
    shortcuts = load(os.path.join(ROOT, "App", "AppShortcuts.xcstrings"))
    for k, e in shortcuts.items():
        check_entry(k, e, problems, "AppShortcuts")
        if "${applicationName}" not in e["localizations"]["ar"]["stringUnit"]["value"]:
            problems.append(f"AppShortcuts: Arabic phrase for '{k}' lacks ${{applicationName}}")
    if problems:
        print("\n".join(problems))
        print(f"[ios-strings] RED: {len(problems)} problem(s)")
        return 1
    print(f"[ios-strings] GREEN: {len(app)} app keys, {len(widgets)} widget keys, {len(shortcuts)} shortcut phrases (en + ar)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
