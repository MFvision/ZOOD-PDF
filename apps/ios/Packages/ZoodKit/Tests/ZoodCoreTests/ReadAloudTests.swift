import Foundation
import Testing
@testable import ZoodCore

@Suite("Read aloud: reading units, voice ranking, speed")
struct ReadAloudTests {
    let box = PageRect(x0: 72, y0: 100, x1: 540, y1: 160)

    @Test func unitsFollowParagraphsAndSwitchLanguage() {
        let paragraphs = [
            TextParagraph(page: 0, text: "عقد إيجار سكني", bbox: box, rtl: true),
            TextParagraph(page: 0, text: "- ٣ -", bbox: nil, rtl: true),
            TextParagraph(page: 0, text: "يلتزم المستأجر بالدفع. The tenant pays monthly. ويبدأ العقد اليوم.", bbox: box, rtl: true),
            TextParagraph(page: 1, text: "Chapter   two\n starts here", bbox: nil, rtl: false),
            TextParagraph(page: 1, text: "٢٠٢٤", bbox: nil, rtl: false),
        ]
        let units = ReadingPlanner.units(paragraphs, defaultLanguage: .arabic)
        #expect(units.map(\.text) == [
            "عقد إيجار سكني", "يلتزم المستأجر بالدفع.", "The tenant pays monthly.", "ويبدأ العقد اليوم.", "Chapter two starts here",
        ])
        #expect(units.map(\.language) == [.arabic, .arabic, .english, .arabic, .english])
        #expect(units.map(\.paragraph) == [0, 2, 2, 2, 3], "page numbers and letterless lines are skipped")
        #expect(units.map(\.page) == [0, 0, 0, 0, 1])
        #expect(units[1].bbox == box && units[4].bbox == nil)
        #expect(units.map(\.id) == [0, 1, 2, 3, 4])
        #expect(ReadingPlanner.firstUnit(onOrAfter: 1, in: units) == 4)
        #expect(ReadingPlanner.firstUnit(onOrAfter: 7, in: units) == nil)
    }

    @Test func sameLanguageSentencesAreGroupedUpToTheLimit() {
        let text = (1...30).map { "This is sentence number \($0)." }.joined(separator: " ")
        let units = ReadingPlanner.units([TextParagraph(page: 0, text: text, bbox: nil, rtl: false)], defaultLanguage: .english, maxCharacters: 120)
        #expect(units.count > 5)
        #expect(units.allSatisfy { $0.text.count <= 120 && $0.language == .english })
        #expect(units.map(\.text).joined(separator: " ") == text)
    }

    @Test func speakableTextKeepsTashkeelDropsTatweel() {
        #expect(ReadingPlanner.speakable("العـــربيةُ  جميلةٌ\n") == "العربيةُ جميلةٌ")
        let fromPages = ReadingPlanner.paragraphs(from: [PageContent(index: 2, text: "سطر أول\nSecond line\n\n")])
        #expect(fromPages == [
            TextParagraph(page: 2, text: "سطر أول", bbox: nil, rtl: true),
            TextParagraph(page: 2, text: "Second line", bbox: nil, rtl: false),
        ])
    }

    @Test func engineBoxesMapToPDFKitPageSpace() {
        let r = box.pdfRect(boxX: 0, boxY: 0, boxHeight: 792)
        #expect(r.x == 72 && r.y == 632 && r.width == 468 && r.height == 60)
        let cropped = PageRect(x0: 10, y0: 20, x1: 5, y1: 30).pdfRect(boxX: 50, boxY: 40, boxHeight: 700)
        #expect(cropped.x == 55 && cropped.y == 710 && cropped.width == 5 && cropped.height == 10)
    }

    @Test func voiceRankingPrefersPremiumThenRegion() {
        let voices = [
            VoiceInfo(id: "com.apple.voice.compact.en-US.Samantha", name: "Samantha", language: "en-US", quality: .standard),
            VoiceInfo(id: "com.apple.voice.enhanced.en-GB.Daniel", name: "Daniel (Enhanced)", language: "en-GB", quality: .enhanced),
            VoiceInfo(id: "com.apple.voice.premium.en-US.Ava", name: "Ava (Premium)", language: "en-US", quality: .premium),
            VoiceInfo(id: "com.apple.voice.premium.en-GB.Jamie", name: "Jamie (Premium)", language: "en-GB", quality: .premium),
            VoiceInfo(id: "com.apple.speech.synthesis.voice.Bells", name: "Bells", language: "en-US", quality: .premium, isNovelty: true),
            VoiceInfo(id: "personal", name: "My Voice", language: "en-US", quality: .premium, isPersonal: true),
            VoiceInfo(id: "com.apple.voice.compact.ar-001.Maged", name: "Majed", language: "ar-001", quality: .standard),
            VoiceInfo(id: "com.apple.voice.enhanced.ar-SA.Majed", name: "Majed (Enhanced)", language: "ar-SA", quality: .enhanced),
            VoiceInfo(id: "com.apple.voice.compact.fr-FR.Thomas", name: "Thomas", language: "fr-FR", quality: .premium),
        ]
        let en = VoiceRanker.ranked(voices, for: .english)
        #expect(en.map(\.name) == ["Ava (Premium)", "Jamie (Premium)", "Daniel (Enhanced)", "Samantha"])
        #expect(VoiceRanker.best(voices, for: .arabic)?.id == "com.apple.voice.enhanced.ar-SA.Majed")
        #expect(!VoiceRanker.onlyStandard(voices, for: .arabic))
        #expect(VoiceRanker.onlyStandard([voices[0]], for: .english))
        #expect(VoiceRanker.best([voices[0]], for: .arabic) == nil)
        // A saved choice wins while it is installed and of the right language.
        #expect(VoiceRanker.resolve(savedID: "com.apple.voice.compact.en-US.Samantha", voices: voices, for: .english)?.name == "Samantha")
        #expect(VoiceRanker.resolve(savedID: "gone", voices: voices, for: .english)?.name == "Ava (Premium)")
        #expect(VoiceRanker.resolve(savedID: "com.apple.voice.compact.en-US.Samantha", voices: voices, for: .arabic)?.name == "Majed (Enhanced)")
    }

    @Test func speedMapping() {
        #expect(SpeechRate.utteranceRate(multiplier: 1) == 0.5)
        #expect(SpeechRate.utteranceRate(multiplier: 0.75) == 0.375)
        let rates = SpeechRate.choices.map { SpeechRate.utteranceRate(multiplier: $0) }
        #expect(rates == rates.sorted() && Set(rates).count == rates.count, "monotonic")
        #expect(abs(SpeechRate.utteranceRate(multiplier: 2) - 0.85) < 0.0001)
        #expect(SpeechRate.utteranceRate(multiplier: 10) <= 1 && SpeechRate.utteranceRate(multiplier: 0) >= 0)
    }
}
