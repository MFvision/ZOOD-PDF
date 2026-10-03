package sa.zood.nearmosque.core

import java.text.Normalizer

/**
 * Search-field normalization shared with iOS and tools/reference_search.py (fixtures in
 * shared/fixtures/normalization.json). Displayed quotations are never normalized.
 */
object TextNormalizer {
    private val charMap: Map<Int, String> = buildMap {
        put(0x0671, "ا") // alef wasla
        put(0x0649, "ي") // alef maqsura
        put(0x06CC, "ي") // farsi yeh
        put(0x06D2, "ي") // yeh barree
        put(0x06A9, "ك") // keheh
        put(0x0629, "ه") // teh marbuta
        put(0x06C3, "ه") // teh marbuta goal
        put(0x06C1, "ه") // heh goal
        put(0x06BE, "ه") // heh doachashmee
        put(0x06D5, "ه") // ae
        put(0x0131, "i")      // dotless i
        put(0x0640, "")       // tatweel
        put(0x0621, "")       // standalone hamza
        for (i in 0..9) {
            put(0x0660 + i, i.toString())
            put(0x06F0 + i, i.toString())
        }
    }
    private val arabicPrefixes = listOf("وال", "فال", "بال", "كال", "لل", "ال")

    fun tokens(text: String): List<String> {
        val decomposed = Normalizer.normalize(text, Normalizer.Form.NFKD)
        val sb = StringBuilder(decomposed.length)
        var i = 0
        while (i < decomposed.length) {
            val cp = decomposed.codePointAt(i)
            i += Character.charCount(cp)
            if (Character.getType(cp) == Character.NON_SPACING_MARK.toInt()) continue
            sb.appendCodePoint(cp)
        }
        val lower = sb.toString().lowercase()
        val mapped = StringBuilder(lower.length)
        i = 0
        while (i < lower.length) {
            val cp = lower.codePointAt(i)
            i += Character.charCount(cp)
            val m = charMap[cp]
            if (m != null) mapped.append(m) else mapped.appendCodePoint(cp)
        }
        val out = ArrayList<String>()
        val cur = StringBuilder()
        val s = mapped.toString()
        i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            i += Character.charCount(cp)
            val type = Character.getType(cp)
            val keep = Character.isLetter(cp) || type == Character.DECIMAL_DIGIT_NUMBER.toInt()
            if (keep) cur.appendCodePoint(cp) else if (cur.isNotEmpty()) { out += cur.toString(); cur.setLength(0) }
        }
        if (cur.isNotEmpty()) out += cur.toString()
        return out.map(::stem)
    }

    /** Space-joined tokens stored in the full-text index column. */
    fun searchText(text: String): String = tokens(text).joinToString(" ")

    /** Loose folding for city-name prefix search (no stemming). */
    fun foldForPrefix(text: String): String {
        val decomposed = Normalizer.normalize(text.trim(), Normalizer.Form.NFKD)
        val sb = StringBuilder()
        var i = 0
        while (i < decomposed.length) {
            val cp = decomposed.codePointAt(i)
            i += Character.charCount(cp)
            if (Character.getType(cp) == Character.NON_SPACING_MARK.toInt()) continue
            val lower = String(Character.toChars(cp)).lowercase()
            for (ch in lower) {
                val m = charMap[ch.code]
                sb.append(m ?: ch.toString())
            }
        }
        return sb.toString().replace(Regex("[\\s\\-'’.]+"), " ").trim()
    }

    private fun isArabic(c: Char) = c in '؀'..'ۿ'

    internal fun stem(tok: String): String {
        if (tok.any(::isArabic)) {
            for (p in arabicPrefixes) {
                if (tok.startsWith(p) && tok.length - p.length >= 3) return tok.substring(p.length)
            }
            return tok
        }
        if (tok.length > 3 && tok.endsWith("s") && !tok.endsWith("ss") && !tok.endsWith("us") && !tok.endsWith("is")) {
            return tok.dropLast(1)
        }
        return tok
    }

    fun containsArabicLetter(s: String) = s.any(::isArabic)
}
