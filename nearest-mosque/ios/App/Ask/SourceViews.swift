import NMCore
import NMData
import SwiftUI

func referenceLabel(_ c: SourceChunk, l10n: Localization) -> String {
    let base: String
    if let s = c.section?.surah, let a = c.section?.ayah { base = l10n.t("reference_quran", s, a) } else { base = c.anchor }
    let name = (l10n.language == "ar" || l10n.language == "ur") ? c.section?.nameAr : c.section?.nameTranslit
    return name.map { "\(base) · \($0)" } ?? base
}

/// A citation: reference, exact original quote in its own direction, labelled translation, and
/// actions to read in context offline or open the original link.
struct SourceCard: View {
    @Environment(Localization.self) private var l10n
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL
    let index: Int?
    let citation: ResolvedCitation
    var onRead: (ResolvedCitation) -> Void

    var body: some View {
        let c = citation.chunk
        let doc = citation.documents[c.original.docId]
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "book.closed").font(.title3).foregroundStyle(Theme.gold).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text((index.map { "[\($0)] " } ?? "") + referenceLabel(c, l10n: l10n)).font(.subheadline.weight(.semibold))
                    Text(l10n.t("supporting_passage") + " · " + [doc?.title[l10n.language] ?? doc?.title["en"], doc?.edition].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.white.opacity(0.7))
                }
            }
            Text(l10n.t("exact_quote")).font(.caption2.weight(.semibold)).foregroundStyle(Theme.gold)
            OriginalText(text: c.original.text, lang: c.original.lang)
            ForEach(c.allTranslations, id: \.docId) { t in
                let td = citation.documents[t.docId]
                Text(l10n.t("translation_by", [td?.translator, td?.year.map { String($0) }].compactMap { $0 }.joined(separator: ", ")))
                    .font(.caption2.weight(.semibold)).foregroundStyle(Theme.gold)
                Text(t.text).font(.subheadline)
                    .environment(\.layoutDirection, .leftToRight)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 16) {
                Button { onRead(citation) } label: { Label(l10n.t("source_open"), systemImage: "text.book.closed") }
                if let u = c.url.flatMap({ URL(string: $0) }) {
                    Button { openURL(u) } label: { Label(l10n.t("source_original_link"), systemImage: "arrow.up.right.square") }
                }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Color(hex: 0x8CC0DE))
            .padding(.top, 2)
        }
        .foregroundStyle(.white)
        .glassCard(padding: 14, cornerRadius: 20, tint: Color.white.opacity(0.04))
    }
}

/// Original text always keeps its own script direction, whatever the interface language.
struct OriginalText: View {
    let text: String
    let lang: String
    var body: some View {
        let rtl = lang == "ar" || lang == "ur"
        Text(text)
            .font(rtl ? .system(size: 22) : .body)
            .lineSpacing(rtl ? 10 : 2)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.layoutDirection, rtl ? .rightToLeft : .leftToRight)
            .environment(\.locale, Locale(identifier: lang))
            .textSelection(.enabled)
    }
}

/// Offline reader: the cited passage with its surrounding verses.
struct ReaderView: View {
    @Environment(AppModel.self) private var app
    @Environment(Localization.self) private var l10n
    @Environment(\.dismiss) private var dismiss
    let citation: ResolvedCitation

    var body: some View {
        let around = (try? app.ask?.context(citation)) ?? []
        NavigationStack {
            List(around) { c in
                VStack(alignment: .leading, spacing: 6) {
                    Text(referenceLabel(c, l10n: l10n)).font(.caption.weight(.semibold)).foregroundStyle(Theme.gold)
                    OriginalText(text: c.original.text, lang: c.original.lang)
                    ForEach(c.allTranslations, id: \.docId) { Text($0.text).font(.subheadline).environment(\.layoutDirection, .leftToRight) }
                }
                .padding(.vertical, 4)
                .listRowBackground(c.id == citation.chunk.id ? Theme.gold.opacity(0.18) : nil)
            }
            .navigationTitle(referenceLabel(citation.chunk, l10n: l10n))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(l10n.t("done")) { dismiss() } } }
        }
    }
}
