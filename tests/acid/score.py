"""Scoring of extracted text against the logical-order ground truth.

Word-level after NFKC normalization (presentation forms fold to base letters),
tashkeel/tatweel removal and bidi-control stripping. Character order inside
words and word order along lines are scored separately:
  recall_logical     fraction of truth words present as tokens in the extraction
  recall_reversed    same after reversing the characters of every extracted token
  order_lcs          LCS ratio of the whole word sequence (forward)
  order_lcs_linerev  same after reversing the word order of every extracted line
  pres_forms         presentation-form code points in the RAW extraction
  replacement_chars  U+FFFD count (broken ToUnicode)
"""
import re, unicodedata
MARKS = re.compile("[ً-ٰٟۖ-ۭـ‎‏‪-‮⁦-⁩]")
PRES = re.compile("[ﭐ-﷿ﹰ-﻿]")
WORD = re.compile(r"\w+", re.UNICODE)

def norm(s):
    return MARKS.sub("", unicodedata.normalize("NFKC", s or ""))

def tokens(s):
    return [t for t in WORD.findall(norm(s)) if len(t) >= 2 or t.isdigit()]

def lcs_len(a, b):
    if not a or not b: return 0
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b, 1):
            cur.append(prev[j - 1] + 1 if x == y else max(prev[j], cur[j - 1]))
        prev = cur
    return prev[-1]

def score(truth, extracted):
    extracted = extracted or ""
    tt = tokens(truth); et = tokens(extracted)
    if not tt: return {"verdict": "no-truth"}
    eset = set(et); rset = set(t[::-1] for t in et)
    uniq = list(dict.fromkeys(tt))
    rl = sum(1 for t in uniq if t in eset) / len(uniq)
    rr = sum(1 for t in uniq if t in rset) / len(uniq)
    order = lcs_len(tt, et) / len(tt)
    linerev = [w for line in extracted.splitlines() for w in reversed(tokens(line))]
    order_lr = lcs_len(tt, linerev) / len(tt)
    pres = len(PRES.findall(extracted)); repl = extracted.count("�")
    if len(et) == 0: verdict = "empty"
    elif rl >= 0.9 and order >= 0.75: verdict = "logical"
    elif rl >= 0.9 and order_lr >= 0.75: verdict = "words-ok/line-order-visual"
    elif rl >= 0.9: verdict = "words-ok/order-scrambled"
    elif rr >= 0.9: verdict = "chars-reversed(visual)"
    elif rl >= 0.5 or rr >= 0.5: verdict = "partial" + ("-reversed" if rr > rl else "")
    elif repl > 5: verdict = "garbage(U+FFFD)"
    else: verdict = "garbage"
    return {"verdict": verdict, "recall_logical": round(rl, 3), "recall_reversed": round(rr, 3), "order_lcs": round(order, 3),
            "order_lcs_linerev": round(order_lr, 3), "pres_forms": pres, "replacement_chars": repl, "n_truth_words": len(tt), "n_extracted_words": len(et)}
