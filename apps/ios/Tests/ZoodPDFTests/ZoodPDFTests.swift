import PDFKit
import Testing
import UIKit
@testable import ZoodPDF
import ZoodCore
import ZoodEngine

/// Runs on the iOS Simulator inside the app (scripts/ios/build.sh). These cover what Linux
/// cannot: PDFKit + the engine together, the OCR text layer and Vision's runtime checks.
@MainActor
@Suite("iOS integration")
struct ZoodPDFTests {
    @Test func pdfKitInkIsRebasedIncrementally() async throws {
        let original = SamplePDFBuilder.arabicSample()
        let engine = try WarraqEngine(data: original)
        let doc = try #require(PDFDocument(data: original))
        let page = try #require(doc.page(at: 0))
        let ink = InkConverter.inkAnnotation(
            points: [CGPoint(x: 100, y: 100), CGPoint(x: 200, y: 180), CGPoint(x: 260, y: 120)],
            lineWidth: 3, color: .blue)
        page.addAnnotation(ink)
        let edited = try #require(doc.dataRepresentation())

        let result = try await engine.rebase(edited: edited)
        #expect(result.info.mode == .incremental)
        #expect(result.bytes.prefix(original.count) == original, "original bytes must be kept")
        let reopened = try #require(PDFDocument(data: result.bytes))
        let inks = reopened.page(at: 0)?.annotations.filter { $0.type == "Ink" } ?? []
        #expect(inks.count == 1)
        #expect(try await WarraqEngine(data: result.bytes).info().revisions == 2)
    }

    @Test func highlightAnnotationsFollowTheSelection() throws {
        let doc = try #require(PDFDocument(data: SamplePDFBuilder.arabicSample()))
        let page = try #require(doc.page(at: 0))
        let selection = try #require(page.selection(for: page.bounds(for: .mediaBox)))
        let annotations = InkConverter.highlight(selection, color: .yellow)
        #expect(!annotations.isEmpty)
        #expect(annotations.allSatisfy { $0.1.type == "Highlight" })
    }

    @Test func scanPDFHasAnInvisibleSearchableTextLayer() throws {
        let size = CGSize(width: 600, height: 800)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
        let scan = ScanImage(cg: try #require(image.cgImage))
        let lines = [OCRLine(text: "فاتورة رقم 42", box: Rect2(x: 0.1, y: 0.1, width: 0.6, height: 0.05))]
        let data = ScanPDFBuilder.build([.image(scan, lines)], title: "Scan")
        let doc = try #require(PDFDocument(data: data))
        #expect(doc.pageCount == 1)
        let text = doc.string ?? ""
        #expect(SearchNormalizer.normalize(text).contains(SearchNormalizer.normalize("فاتورة")), "\(text)")
        #expect(text.contains("42"))
    }

    @Test func idCardPageIsA4() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let card = UIGraphicsImageRenderer(size: CGSize(width: 856, height: 540), format: format).image { _ in }
        let img = ScanImage(cg: try #require(card.cgImage))
        let data = ScanPDFBuilder.build([.idCard(front: img, back: img, frontLines: [], backLines: [])], title: "ID")
        let page = try #require(PDFDocument(data: data)?.page(at: 0))
        let box = page.bounds(for: .mediaBox)
        #expect(abs(box.width - 595.276) < 1 && abs(box.height - 841.89) < 1)
    }

    @Test func visionReportsLanguagesAtRuntime() {
        // Must not crash; Arabic availability depends on the OS and is shown to the user.
        let langs = OCRService.supportedLanguages()
        #expect(!langs.isEmpty)
        #expect(OCRService.arabicAvailable == langs.contains { $0.lowercased().hasPrefix("ar") })
    }

    @Test func compressNeverGrowsAFile() async throws {
        let original = SamplePDFBuilder.arabicSample()
        if let out = try await CompressService.compress(original, password: nil, level: .smaller) {
            #expect(out.after < out.before)
            _ = try WarraqEngine(data: out.bytes)
        }
    }

    @Test func savedFilesGetUniqueSafeNames() throws {
        let a = try DocumentLibrary.saveNew(Data("%PDF-1.7".utf8), name: "a/b", folder: "Tests")
        let b = try DocumentLibrary.saveNew(Data("%PDF-1.7".utf8), name: "a/b", folder: "Tests")
        defer {
            try? FileManager.default.removeItem(at: a)
            try? FileManager.default.removeItem(at: b)
        }
        #expect(a.lastPathComponent == "a-b.pdf")
        #expect(b.lastPathComponent == "a-b 2.pdf")
    }
}
