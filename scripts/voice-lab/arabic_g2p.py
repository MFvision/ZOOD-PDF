"""Arabic with full diacritics (tashkeel) to IPA phonemes, by rule, without espeak-ng.

Piper's Arabic voice was trained on espeak-ng's phonemes, but espeak-ng is
GPL and the app takes no GPL code. Fully diacritized Arabic spells its sounds
out, so a page of rules can stand in for it: this writes the same phoneme
inventory espeak-ng uses for Arabic (one symbol per character, length as
"ː", pharyngealization as "ˤ", primary stress as "ˈ"). The lab reads the
same sentences through both and Whisper scores them; if the rules hold up
they are ported to Rust for the app.
"""

FATHA, DAMMA, KASRA = "َ", "ُ", "ِ"
FATHATAN, DAMMATAN, KASRATAN = "ً", "ٌ", "ٍ"
SHADDA, SUKUN, SUPERSCRIPT_ALEF = "ّ", "ْ", "ٰ"
TATWEEL = "ـ"

CONSONANTS = {
    "ء": "ʔ", "أ": "ʔ", "إ": "ʔ", "ؤ": "ʔ", "ئ": "ʔ",
    "ب": "b", "ت": "t", "ث": "θ", "ج": "dʒ", "ح": "ħ", "خ": "χ",
    "د": "d", "ذ": "ð", "ر": "r", "ز": "z", "س": "s", "ش": "ʃ",
    "ص": "sˤ", "ض": "dˤ", "ط": "tˤ", "ظ": "ðˤ", "ع": "ʕ", "غ": "ɣ",
    "ف": "f", "ق": "q", "ك": "k", "ل": "l", "م": "m", "ن": "n",
    "ه": "h", "و": "w", "ي": "j", "ة": "t", "ى": "j",
    "پ": "p", "چ": "tʃ", "ڤ": "v", "گ": "ɡ",
}
SHORT = {FATHA: "a", DAMMA: "u", KASRA: "i"}
TANWEEN = {FATHATAN: "an", DAMMATAN: "un", KASRATAN: "in"}
SUN = set("تثدذرزسشصضطظلن")
PUNCT = {"،": ",", "؛": ",", "؟": "?", ",": ",", ".": ".", "!": "!", "?": "?", ":": ",", ";": ","}
DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")

ONES = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة",
        "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"]
TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"]
HUNDREDS = ["", "مئة", "مئتان", "ثلاثمئة", "أربعمئة", "خمسمئة", "ستمئة", "سبعمئة", "ثمانمئة", "تسعمئة"]


def number_words(n):
    """A whole number in Arabic words (masculine, nominative), up to the millions."""
    if n == 0:
        return "صفر"
    parts = []
    for size, one, two, many in ((1_000_000, "مليون", "مليونان", "ملايين"), (1000, "ألف", "ألفان", "آلاف")):
        count, n = divmod(n, size)
        if count == 1:
            parts.append(one)
        elif count == 2:
            parts.append(two)
        elif 3 <= count <= 10:
            parts.append(f"{ONES[count]} {many}")
        elif count:
            parts.append(f"{number_words(count)} {one}")
    if n >= 100:
        parts.append(HUNDREDS[n // 100])
        n %= 100
    if n:
        if n < 20:
            parts.append(ONES[n])
        else:
            ten, one = divmod(n, 10)
            parts.append(f"{ONES[one]} و{TENS[ten]}" if one else TENS[ten])
    return " و".join(parts)


def spell_numbers(text):
    out, digits = [], ""
    for ch in text.translate(DIGITS) + " ":
        if ch.isdigit():
            digits += ch
            continue
        if digits:
            out.append(number_words(int(digits[:9])))
            digits = ""
        out.append(ch)
    return "".join(out).strip()


def letters(word):
    """The word as (letter, marks) pairs: each base letter with the diacritics on it."""
    out = []
    for ch in word:
        if ch == TATWEEL:
            continue
        if ch in SHORT or ch in TANWEEN or ch in (SHADDA, SUKUN, SUPERSCRIPT_ALEF):
            if out:
                out[-1][1].append(ch)
            continue
        out.append((ch, []))
    return out


def word_phonemes(word, after_vowel):
    """One word's phonemes, as a list of strings; `after_vowel` when the word before ends in one."""
    seq = letters(word)
    out = []
    tanween_a = False
    for i, (ch, marks) in enumerate(seq):
        nxt = seq[i + 1] if i + 1 < len(seq) else None
        vowelled = bool(set(marks) & (set(SHORT) | set(TANWEEN)))
        if ch == "ا" and not vowelled:
            article = nxt is not None and nxt[0] == "ل" and i + 2 < len(seq)
            # At the word's start, or after a one-letter prefix (wa-, fa-,
            # bi-, ka-): the alif of al- and of al-wasl verbs is not a long a.
            initial = i == 0 or (i == 1 and seq[0][0] in "وفبك")
            if initial and (article or i == 0 or (nxt is not None and SUKUN in nxt[1])):
                # Hamzat al-wasl: heard only at the start of speech.
                if not out and not after_vowel:
                    out.append("a" if article else "i")
            elif tanween_a:
                pass  # the alif written after fathatan is silent
            elif out[-1] == "a":
                out.append("ː")
            else:
                out.extend(["a", "ː"])
            continue
        tanween_a = False
        if ch == "ى" and not vowelled:
            out.append("ː" if out and out[-1] == "a" else "a")
            continue
        if ch == "ة" and not vowelled:
            # The pause form: "-a", no t.
            if not out or out[-1] != "a":
                out.append("a")
            continue
        if ch == "آ":
            out.extend(["ʔ", "a", "ː"])
            continue
        if ch == "ل" and (not marks or marks == [SUKUN]) and nxt and nxt[0] in SUN and SHADDA in nxt[1]:
            continue  # the article's l, taken by the sun letter after it
        if ch == "و" and not marks and out and out[-1] == "u":
            out.append("ː")
            continue
        if ch == "ي" and not marks and out and out[-1] == "i":
            out.append("ː")
            continue
        sound = CONSONANTS.get(ch)
        if sound is None:
            continue
        out.extend(sound)
        if SHADDA in marks:
            out.append("ː")
        for mark in marks:
            if mark in SHORT:
                out.append(SHORT[mark])
            elif mark in TANWEEN:
                out.extend(TANWEEN[mark])
                tanween_a = mark == FATHATAN
            elif mark == SUPERSCRIPT_ALEF:
                out.extend(["a", "ː"])
    return out


VOWELS = set("aiu")


def stress(phones):
    """Puts "ˈ" before the stressed vowel, by the usual rule of Modern Standard Arabic."""
    # Syllable nuclei: each short vowel, its length mark folded in.
    nuclei = [k for k, p in enumerate(phones) if p in VOWELS]
    if not nuclei:
        return phones

    def weight(n):
        k = nuclei[n]
        end = nuclei[n + 1] if n + 1 < len(nuclei) else len(phones)
        long_vowel = k + 1 < len(phones) and phones[k + 1] == "ː"
        consonants = sum(1 for p in phones[k + 1:end] if p not in VOWELS and p not in "ːˤ")
        coda = consonants - (1 if n + 1 < len(nuclei) else 0)
        return (2 if long_vowel else 1) + max(coda, 0)

    last = len(nuclei) - 1
    if weight(last) >= 3:
        pick = last
    elif last >= 1 and weight(last - 1) >= 2:
        pick = last - 1
    elif last >= 2:
        pick = last - 2
    else:
        pick = max(last - 1, 0)
    k = nuclei[pick]
    return phones[:k] + ["ˈ"] + phones[k:]


def phonemize(text):
    """Diacritized Arabic text to a flat list of IPA symbols, words joined by spaces."""
    out = []
    after_vowel = False
    for raw in spell_numbers(text).split():
        trail = ""
        while raw and raw[-1] in PUNCT:
            trail = PUNCT[raw[-1]] + trail
            raw = raw[:-1]
        if raw:
            phones = word_phonemes(raw, after_vowel)
            if phones:
                if out and out[-1] != " ":
                    out.append(" ")
                for p in stress(phones):
                    out.extend(p)
                last = [p for p in phones if p not in "ːˈ"]
                after_vowel = bool(last) and last[-1] in VOWELS and not trail
        if trail:
            out.extend(trail)
            after_vowel = False
    return out


if __name__ == "__main__":
    import sys

    print("".join(phonemize(sys.argv[1] if len(sys.argv) > 1 else "بَلَغَتِ الْإِيرَادَاتُ ثَلَاثَةَ مَلَايِينِ رِيَالٍ.")))
