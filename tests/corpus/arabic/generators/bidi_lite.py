"""A deliberately small bidi run resolver for corpus generation.

Not a full UAX #9 implementation: it handles strong runs, European/Arabic
numbers with their separators (1,200.00  12/09/2026  15%  +966), and neutrals
between runs, then reorders runs by embedding level (rule L2). The real
engine (packages/core) uses the unicode-bidi crate; this file only needs to be
right for the corpus texts, which we check visually.
"""
import unicodedata

STRONG_R = {"R", "AL"}
NUM = {"EN", "AN"}

def base_direction(text: str) -> str:
    for ch in text:
        b = unicodedata.bidirectional(ch)
        if b in STRONG_R: return "R"
        if b == "L": return "L"
    return "R"

def resolve_types(text: str, base: str):
    cls = [unicodedata.bidirectional(c) for c in text]
    t = []
    for i, b in enumerate(cls):
        if b in STRONG_R: t.append("R")
        elif b == "L": t.append("L")
        elif b in NUM: t.append("EN")
        elif b == "NSM": t.append(t[-1] if t else base)
        else: t.append(None)  # neutral, resolved below
    # W4/W5-ish: separators and terminators adjacent to numbers become numbers
    for i, b in enumerate(cls):
        if t[i] is None and b in ("CS", "ES"):
            if 0 < i < len(t) - 1 and t[i-1] == "EN" and t[i+1] == "EN": t[i] = "EN"
        if t[i] is None and b == "ET":
            j = i
            while j + 1 < len(t) and cls[j+1] == "ET": j += 1
            if (i > 0 and t[i-1] == "EN") or (j + 1 < len(t) and t[j+1] == "EN"):
                for k in range(i, j + 1): t[k] = "EN"
    # W7: a European number preceded (through neutrals) by L strong text becomes L
    last_strong = base
    for i in range(len(t)):
        if t[i] in ("L", "R"): last_strong = t[i]
        elif t[i] == "EN" and last_strong == "L": t[i] = "L"
    # N1/N2: neutrals take the direction of surrounding strong text if equal, else base
    n = len(t)
    i = 0
    while i < n:
        if t[i] is None:
            j = i
            while j < n and t[j] is None: j += 1
            prev = t[i-1] if i > 0 else base
            nxt = t[j] if j < n else base
            pd = "R" if prev in ("R", "EN") and base == "R" else ("L" if prev == "L" else ("R" if prev == "R" else base))
            nd = "R" if nxt in ("R", "EN") and base == "R" else ("L" if nxt == "L" else ("R" if nxt == "R" else base))
            if prev == "EN" and base == "L": pd = "L"
            if nxt == "EN" and base == "L": nd = "L"
            fill = pd if pd == nd else base
            for k in range(i, j): t[k] = fill
            i = j
        else:
            i += 1
    return t

def runs(text: str):
    """Return list of (segment, direction, level) in VISUAL order (left→right)."""
    base = base_direction(text)
    base_level = 1 if base == "R" else 0
    t = resolve_types(text, base)
    # levels (I1/I2)
    levels = []
    for ty in t:
        if base_level == 0:
            levels.append(0 if ty == "L" else (1 if ty == "R" else 2))
        else:
            levels.append(1 if ty == "R" else 2)
    # group into logical runs
    logical = []
    i = 0
    while i < len(text):
        j = i
        while j < len(text) and levels[j] == levels[i]: j += 1
        logical.append([text[i:j], levels[i]])
        i = j
    # L2: reverse from highest level down to lowest odd level
    if not logical: return []
    maxl = max(l for _, l in logical); minodd = min((l for _, l in logical if l % 2 == 1), default=None)
    order = list(range(len(logical)))
    if minodd is not None:
        for lvl in range(maxl, minodd - 1, -1):
            k = 0
            while k < len(order):
                if logical[order[k]][1] >= lvl:
                    m = k
                    while m < len(order) and logical[order[m]][1] >= lvl: m += 1
                    order[k:m] = order[k:m][::-1]
                    k = m
                else:
                    k += 1
    return [(logical[o][0], "rtl" if logical[o][1] % 2 else "ltr", logical[o][1]) for o in order]
