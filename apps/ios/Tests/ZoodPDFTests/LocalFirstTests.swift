import PDFKit
import Testing
import UIKit
@testable import ZoodPDF
import ZoodCore
import ZoodEngine

/// Simulator checks for the local-first AI, autofill and read-aloud glue (PDFKit, AVFoundation,
/// Foundation Models availability). The platform-independent logic is tested on Linux (ZoodKit).
@MainActor
@Suite("Local-first AI, autofill and read-aloud (iOS)")
struct LocalFirstTests {
    /// A one-page PDF with a text field named "email", saved by PDFKit.
    private func formPDF() throws -> Data {
        let doc = try #require(PDFDocument(data: SamplePDFBuilder.arabicSample()))
        let page = try #require(doc.page(at: 0))
        let field = PDFAnnotation(bounds: CGRect(x: 72, y: 500, width: 240, height: 24), forType: .widget, withProperties: nil)
        field.widgetFieldType = .text
        field.fieldName = "EmailAddress"
        page.addAnnotation(field)
        return try #require(doc.dataRepresentation())
    }

    @Test func autofillWritesFormValuesAsAnIncrementalUpdate() async throws {
        let original = try formPDF()
        let engine = try WarraqEngine(data: original)
        let doc = try #require(PDFDocument(data: original))
        let entries = FormReader.entries(in: doc)
        let entry = try #require(entries.first { $0.field.name == "EmailAddress" })
        #expect(entry.field.kind == .text && entry.field.isFillable)

        var profile = UserProfile()
        profile.email = "m@example.sa"
        let proposals = AutofillMatcher.proposals(fields: entries.map(\.field), profile: profile)
        #expect(proposals.map(\.value) == ["m@example.sa"])

        FormReader.write("m@example.sa", kind: .text, to: entry.widgets)
        let edited = try #require(doc.dataRepresentation())
        let result = try await engine.rebase(edited: edited)
        #expect(result.info.mode == .incremental)
        #expect(result.bytes.prefix(original.count) == original, "original bytes must be kept")
        let reopened = try #require(PDFDocument(data: result.bytes))
        #expect(FormReader.entries(in: reopened).first { $0.field.name == "EmailAddress" }?.field.currentValue == "m@example.sa")
    }

    @Test func engineParagraphBoxesSelectTheSameTextInPDFKit() async throws {
        let data = SamplePDFBuilder.arabicSample()
        let paragraphs = try await WarraqEngine(data: data).paragraphs()
        let first = try #require(paragraphs.first { $0.bbox != nil })
        let page = try #require(PDFDocument(data: data)?.page(at: first.page))
        let crop = page.bounds(for: .cropBox)
        let r = try #require(first.bbox).pdfRect(boxX: crop.minX, boxY: crop.minY, boxHeight: crop.height)
        let selection = page.selection(for: CGRect(x: r.x, y: r.y, width: r.width, height: r.height).insetBy(dx: -2, dy: -2))
        let text = SearchNormalizer.normalize(selection?.string ?? "")
        let firstWord = SearchNormalizer.normalize(String(first.text.split(separator: " ").first ?? ""))
        #expect(!firstWord.isEmpty && text.contains(firstWord), "\(text) vs \(first.text)")
    }

    @Test func voicesAreRankedFromTheInstalledSet() {
        let voices = VoiceCatalog.installed()
        #expect(!voices.isEmpty)
        #expect(VoiceRanker.best(voices, for: .english) != nil)
        #expect(VoiceCatalog.voice(for: .english) != nil)
    }

    @Test func appleModelAvailabilityIsCheckedAtRuntime() {
        // Must not crash on any OS; on iOS < 26 it is simply unavailable.
        if !AppleModel.isAvailable { #expect(AppleModel.unavailableReason != nil) }
        _ = AppleModel.supports(.arabic)
        #expect(PortableModelRunner.isCompiledIn == false, "llama.cpp has no simulator slice (ADR 0015)")
    }
}
