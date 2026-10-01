import CoreImage
@testable import PDFEditor
import PDFKit
import WarraqCore
import XCTest

/// The scanner's pipeline on fixture pictures, deterministic: the page found
/// on a desk and cut out, a crooked scan levelled, a shadowed and stained
/// one made paper-white again, the colour modes, the ID page at card size,
/// a book spread split at its gutter and its lines straightened — and the
/// words read before and after, measured against the corpus's truth, then
/// written into a PDF through the core and found by its search.
final class ScanPipelineTests: XCTestCase {
    private var bundle: Bundle { Bundle(for: ScanPipelineTests.self) }

    private func fixture(_ name: String, _ ext: String) throws -> URL {
        try XCTUnwrap(bundle.url(forResource: name, withExtension: ext), "\(name).\(ext) is in the test bundle")
    }

    private func photo(_ name: String) throws -> CGImage {
        try XCTUnwrap(ScanPipeline.loadImage(from: fixture(name, "jpg")), "\(name).jpg reads")
    }

    /// A corpus scan's page drawn at 300 dpi by PDFKit: the JPEG in it is
    /// 300 dpi, so this is the scan pixel for pixel.
    private func scanPage(_ name: String, page index: Int = 0) throws -> CGImage {
        let document = try XCTUnwrap(PDFDocument(url: fixture(name, "pdf")))
        let page = try XCTUnwrap(document.page(at: index))
        let bounds = page.bounds(for: .mediaBox)
        let scale: CGFloat = 300 / 72
        let size = CGSize(width: (bounds.width * scale).rounded(), height: (bounds.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            context.cgContext.translateBy(x: 0, y: size.height)
            context.cgContext.scaleBy(x: scale, y: -scale)
            page.draw(with: .mediaBox, to: context.cgContext)
        }
        return try XCTUnwrap(image.cgImage)
    }

    private func truth(_ name: String) throws -> [String] {
        try String(contentsOf: fixture(name, "txt"), encoding: .utf8)
            .split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    // MARK: - Finding and cutting out

    func testFindsThePageOnADesk() throws {
        let image = try photo("page-crooked")
        let size = CGSize(width: image.width, height: image.height)
        ScanPipeline.printDetections(in: image, name: "page-crooked")
        let quad = try XCTUnwrap(ScanPipeline.detectPage(in: image), "Vision finds the page")
        XCTAssertTrue(quad.isConvex)
        let coverage = quad.coverage(of: size)
        XCTAssertGreaterThan(coverage, 0.35, "the page fills a good part of the photo: \(coverage)")
        XCTAssertLessThan(coverage, 0.9, "not the whole photo: \(coverage)")
        for point in quad.points {
            XCTAssertGreaterThan(point.x, size.width * 0.03, "\(point)")
            XCTAssertLessThan(point.x, size.width * 0.97, "\(point)")
            XCTAssertGreaterThan(point.y, size.height * 0.03, "\(point)")
            XCTAssertLessThan(point.y, size.height * 0.97, "\(point)")
        }

        let cut = ScanPipeline.corrected(image, quad: quad)
        let aspect = CGFloat(cut.width) / CGFloat(cut.height)
        XCTAssertEqual(aspect, 1 / sqrt(2), accuracy: 0.08, "an A4 page once its perspective is corrected")
        XCTAssertLessThan(abs(ScanPipeline.skewAngle(of: cut)), 1.0, "level once cut out along its edges")
    }

    func testTheWholePhotoIsLeftAlone() throws {
        let image = try photo("page-crooked")
        let same = ScanPipeline.corrected(image, quad: .whole(CGSize(width: image.width, height: image.height)))
        XCTAssertEqual(same.width, image.width)
        XCTAssertEqual(same.height, image.height)
    }

    // MARK: - Deskew

    func testMeasuresAndLevelsTheCrookedCorpusScan() throws {
        let crooked = try scanPage("scan-notonaskh-300dpi-crooked-8deg-jpeg")
        let angle = ScanPipeline.skewAngle(of: crooked)
        XCTAssertEqual(angle, 8, accuracy: 1.0, "the corpus scan is turned 8° counter-clockwise")
        var enhancement = Enhancement.none
        enhancement.deskew = true
        let levelled = ScanPipeline.enhance(crooked, with: enhancement)
        XCTAssertEqual(levelled.skew, angle, accuracy: 0.4, "measured again on the working copy")
        XCTAssertLessThan(abs(ScanPipeline.skewAngle(of: levelled.image)), 0.6, "level afterwards")
    }

    func testSkewSignIsCounterClockwiseAsShown() throws {
        let lines = try XCTUnwrap(syntheticLines(width: 800, height: 600))
        XCTAssertEqual(ScanPipeline.skewAngle(of: lines), 0, accuracy: 0.01)
        let turned = try XCTUnwrap(ScanPipeline.render(ScanPipeline.rotated(CIImage(cgImage: lines), counterClockwiseDegrees: 5)))
        XCTAssertEqual(ScanPipeline.skewAngle(of: turned), 5, accuracy: 0.6)
        let back = try XCTUnwrap(ScanPipeline.render(ScanPipeline.rotated(CIImage(cgImage: turned), counterClockwiseDegrees: -5)))
        XCTAssertEqual(ScanPipeline.skewAngle(of: back), 0, accuracy: 0.6)
    }

    /// Black rules across white, like lines of text.
    private func syntheticLines(width: Int, height: Int) -> CGImage? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            UIColor.black.setFill()
            var y = 60
            while y < height - 60 {
                context.fill(CGRect(x: 80, y: y, width: width - 160, height: 6))
                y += 28
            }
        }
        return image.cgImage
    }

    // MARK: - Lighting, creases, contrast, colour

    /// The paper's grey where it is paper: its mean and how uneven it is.
    private func paper(of image: CGImage) throws -> (mean: Double, spread: Double, darkestTenth: Double) {
        let grey = try XCTUnwrap(GreyBitmap(image, maxSide: 600))
        let threshold = grey.otsu()
        var values: [Double] = []
        for v in grey.data where v > threshold { values.append(Double(v)) }
        XCTAssertGreaterThan(values.count, 1000)
        let mean = values.reduce(0, +) / Double(values.count)
        let variance = values.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(values.count)
        let sorted = values.sorted()
        let tenth = sorted.prefix(max(1, sorted.count / 10))
        return (mean, sqrt(variance), tenth.reduce(0, +) / Double(tenth.count))
    }

    func testDividesShadowsAndStainsAway() throws {
        let stained = try scanPage("scan-notonaskh-300dpi-shadowed-stained-jpeg")
        let before = try paper(of: stained)
        var enhancement = Enhancement.none
        enhancement.flattenLighting = true
        let flat = ScanPipeline.enhance(stained, with: enhancement).image
        let after = try paper(of: flat)
        print("SCAN-LIGHTING shadowed page: paper mean \(Int(before.mean))→\(Int(after.mean)), spread \(before.spread.rounded())→\(after.spread.rounded()), darkest tenth \(Int(before.darkestTenth))→\(Int(after.darkestTenth))")
        // The scan carries grain (gen_scans.py adds noise 7 and JPEG at 60), which
        // no division of the paper's brightness takes out: the spread that is
        // left is the grain, so the paper is asked to be clearly more even, not
        // flat.
        XCTAssertLessThan(after.spread, before.spread * 0.75, "the paper is more even")
        XCTAssertGreaterThan(after.darkestTenth, before.darkestTenth + 12, "the shadowed corner and the stains are lifted")
        XCTAssertGreaterThan(after.mean, 235, "paper is white")

        // The photo of a page under a lamp, the same way.
        let photo = try photo("photo-arabic")
        let photoBefore = try paper(of: photo)
        let photoAfter = try paper(of: ScanPipeline.enhance(photo, with: enhancement).image)
        print("SCAN-LIGHTING photo: paper mean \(Int(photoBefore.mean))→\(Int(photoAfter.mean)), spread \(photoBefore.spread.rounded())→\(photoAfter.spread.rounded())")
        XCTAssertLessThan(photoAfter.spread, photoBefore.spread / 2)
    }

    func testColourModesAndContrast() throws {
        let stained = try scanPage("scan-notonaskh-300dpi-shadowed-stained-jpeg")
        var bw = Enhancement()
        bw.mode = .blackAndWhite
        // Read pixel for pixel: shrinking a black-and-white picture would blend greys back in.
        let binary = try XCTUnwrap(GreyBitmap(ScanPipeline.enhance(stained, with: bw).image, maxSide: 4000))
        let middling = binary.data.count { $0 > 12 && $0 < 243 }
        XCTAssertLessThan(Double(middling) / Double(binary.data.count), 0.03, "black and white has (almost) no grey: \(middling)")
        let black = binary.data.count { $0 <= 12 }
        XCTAssertGreaterThan(black, binary.data.count / 200, "the ink is there")
        XCTAssertLessThan(black, binary.data.count / 4, "the shadow did not become ink")

        var grey = Enhancement()
        grey.mode = .grey
        let greyPage = try XCTUnwrap(RGBABitmap(ScanPipeline.enhance(stained, with: grey).image))
        var tinted = 0
        for k in stride(from: 0, to: greyPage.data.count, by: 4 * 997) {
            let r = Int(greyPage.data[k]), g = Int(greyPage.data[k + 1]), b = Int(greyPage.data[k + 2])
            if abs(r - g) > 2 || abs(g - b) > 2 { tinted += 1 }
        }
        XCTAssertEqual(tinted, 0, "grey has no colour")

        // Auto-contrast stretches a washed-out page.
        let washed = try XCTUnwrap(washedOut())
        let (low, high) = try XCTUnwrap(ScanPipeline.greyRange(of: CIImage(cgImage: washed)))
        XCTAssertLessThan(high - low, 0.6)
        let stretched = ScanPipeline.autoContrast(CIImage(cgImage: washed))
        let (low2, high2) = try XCTUnwrap(ScanPipeline.greyRange(of: stretched))
        XCTAssertLessThan(low2, 0.05)
        XCTAssertGreaterThan(high2, 0.95)
    }

    /// Grey text on light grey.
    private func washedOut() -> CGImage? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: 400, height: 300), format: format).image { context in
            UIColor(white: 0.75, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 400, height: 300))
            UIColor(white: 0.35, alpha: 1).setFill()
            for y in stride(from: 30, to: 270, by: 24) {
                context.fill(CGRect(x: 40, y: y, width: 320, height: 8))
            }
        }.cgImage
    }

    // MARK: - OCR, measured

    /// Vision's languages on this simulator, recorded in the log for STATUS.
    func testRecordsTheLanguagesVisionReads() {
        let languages = TextRecognizer.supportedLanguages()
        print("SCAN-OCR supportedRecognitionLanguages = \(languages)")
        print("SCAN-OCR reads Arabic = \(TextRecognizer.supports("ar", in: languages))")
        XCTAssertFalse(languages.isEmpty, "Vision names at least one language")
        XCTAssertTrue(TextRecognizer.supports("en", in: languages))
        let chosen = TextRecognizer.languages(chosen: ["ar", "en"], supported: languages)
        XCTAssertFalse(chosen.isEmpty)
        XCTAssertTrue(chosen.allSatisfy { languages.contains($0) })
    }

    /// The share of the truth's words read from a page as it is and after
    /// the enhancement, for each corpus scan and the photo.
    func testWordAccuracyBeforeAndAfterEnhancement() throws {
        let supported = TextRecognizer.supportedLanguages()
        let languages = TextRecognizer.languages(chosen: ["ar", "en"], supported: supported)
        let readsArabic = TextRecognizer.supports("ar", in: supported)
        let shadowTruth = try truth("scan-notonaskh-300dpi-shadowed-stained-jpeg")
        let crookedTruth = try truth("scan-notonaskh-300dpi-crooked-8deg-jpeg")
        let cases: [(name: String, image: CGImage, truth: String)] = [
            ("shadowed-stained page 1", try scanPage("scan-notonaskh-300dpi-shadowed-stained-jpeg", page: 0), shadowTruth.prefix(7).joined(separator: "\n")),
            ("shadowed-stained page 2", try scanPage("scan-notonaskh-300dpi-shadowed-stained-jpeg", page: 1), shadowTruth.dropFirst(7).joined(separator: "\n")),
            ("crooked 8°", try scanPage("scan-notonaskh-300dpi-crooked-8deg-jpeg"), crookedTruth.joined(separator: "\n")),
            ("photo-arabic.jpg", try photo("photo-arabic"), crookedTruth.joined(separator: "\n")),
        ]
        for item in cases {
            let raw = try TextRecognizer.recognize(item.image, languages: languages)
            let enhanced = ScanPipeline.enhance(item.image, with: Enhancement())
            let clean = try TextRecognizer.recognize(enhanced.image, languages: languages)
            let before = TextRecognizer.wordAccuracy(read: raw.text, truth: item.truth)
            let after = TextRecognizer.wordAccuracy(read: clean.text, truth: item.truth)
            print("SCAN-OCR \(item.name): as it is \(before.found)/\(before.total), enhanced \(after.found)/\(after.total) (levelled \(enhanced.skew)°), languages \(languages)")
            if readsArabic {
                XCTAssertGreaterThan(after.found, after.total / 2, "\(item.name): more than half the Arabic words read after enhancement")
                XCTAssertGreaterThanOrEqual(after.found + 3, before.found, "\(item.name): enhancement does not cost words")
            } else {
                // Only the Latin words on the page can be read; those must be.
                let latin = ["PDF", "OpenType", "ToUnicode", "Acrobat", "Chrome"]
                let found = latin.filter { clean.text.contains($0) }
                XCTAssertGreaterThanOrEqual(found.count, 3, "\(item.name): Latin words read: \(found)")
            }
        }
    }

    func testNormalizationIgnoresTashkeelAndUnifiesLetters() {
        XCTAssertEqual(TextRecognizer.normalized("محرّر"), "محرر")
        XCTAssertEqual(TextRecognizer.normalized("افتراضياً."), "افتراضيا")
        XCTAssertEqual(TextRecognizer.normalized("أحمد"), "احمد")
        XCTAssertEqual(TextRecognizer.normalized("مكتبة،"), "مكتبه")
        XCTAssertEqual(TextRecognizer.normalized("١٢٣"), "123")
        let accuracy = TextRecognizer.wordAccuracy(read: "محرر ملفات PDF", truth: "محرّر ملفات PDF مفتوح")
        XCTAssertEqual(accuracy.found, 3)
        XCTAssertEqual(accuracy.total, 4)
        XCTAssertTrue(TextRecognizer.readsRightToLeft("محرر PDF"))
        XCTAssertFalse(TextRecognizer.readsRightToLeft("PDF محرر"))
    }

    // MARK: - ID and book modes

    func testIDPageIsAtCardSize() throws {
        let slots = IDPageComposer.slots(kind: .card, sides: 2)
        XCTAssertEqual(slots.count, 2)
        XCTAssertEqual(slots[0].width, 85.60 / 25.4 * 72, accuracy: 0.01)
        XCTAssertEqual(slots[0].height, 53.98 / 25.4 * 72, accuracy: 0.01)
        XCTAssertEqual(slots[0].midX, IDPageComposer.pagePoints.width / 2, accuracy: 0.01, "centred")
        XCTAssertEqual(slots[1].minY - slots[0].maxY, IDPageComposer.gap, accuracy: 0.01)
        XCTAssertEqual((slots[0].minY + slots[1].maxY) / 2, IDPageComposer.pagePoints.height / 2, accuracy: 0.01)
        let passport = IDPageComposer.slots(kind: .passport, sides: 1)
        XCTAssertEqual(passport[0].width, 125 / 25.4 * 72, accuracy: 0.01)

        let front = try photo("id-front")
        let back = try photo("id-back")
        ScanPipeline.printDetections(in: front, name: "id-front")
        let frontQuad = try XCTUnwrap(ScanPipeline.detectPage(in: front), "the card is found on the desk")
        let cutFront = ScanPipeline.corrected(front, quad: frontQuad)
        XCTAssertEqual(CGFloat(cutFront.width) / CGFloat(cutFront.height), 85.60 / 53.98, accuracy: 0.12, "a card's proportions")
        let backQuad = try XCTUnwrap(ScanPipeline.detectPage(in: back))
        let cutBack = ScanPipeline.corrected(back, quad: backQuad)
        let page = try XCTUnwrap(IDPageComposer.compose(sides: [cutFront, cutBack], kind: .card))
        XCTAssertEqual(page.width, 2480)
        XCTAssertEqual(page.height, 3508)
        let grey = try XCTUnwrap(GreyBitmap(page, maxSide: 3508))
        let scale = IDPageComposer.dpi / 72
        func value(_ x: CGFloat, _ y: CGFloat) -> UInt8 {
            grey[Int(x * scale), Int(y * scale)]
        }
        XCTAssertLessThan(value(slots[0].midX, slots[0].midY), 250, "the front is drawn in its slot")
        XCTAssertLessThan(value(slots[1].midX, slots[1].midY), 250, "the back is drawn in its slot")
        XCTAssertGreaterThan(value(slots[0].midX, (slots[0].maxY + slots[1].minY) / 2), 250, "paper between them")
        XCTAssertGreaterThan(value(40, 40), 250, "paper around them")
    }

    func testBookSpreadSplitsAtTheGutterAndLinesAreFlattened() throws {
        let spread = try photo("book-spread")
        ScanPipeline.printDetections(in: spread, name: "book-spread")
        ScanPipeline.printDetections(in: try photo("photo-arabic"), name: "photo-arabic")
        let quad = try XCTUnwrap(ScanPipeline.detectSpread(in: spread), "the spread is found")
        XCTAssertGreaterThan(quad.coverage(of: CGSize(width: spread.width, height: spread.height)), 0.5, "both pages, not one")
        let cut = ScanPipeline.corrected(spread, quad: quad)
        let split = BookSplitter.split(cut)
        XCTAssertTrue(split.found, "the gutter stands out")
        XCTAssertEqual(Double(split.gutter), Double(cut.width) / 2, accuracy: Double(cut.width) * 0.06, "near the middle")
        XCTAssertEqual(Double(split.left.width), Double(split.right.width), accuracy: Double(cut.width) * 0.12)

        // The bow as the flattener measures it: how far the ink strays from
        // each line's own straight fit — the curve beyond the tilt, about a
        // quarter of a parabola's sag; the tilt is the deskew's to take out.
        let samples = BookFlattener.lineSamples(in: split.left)
        XCTAssertGreaterThanOrEqual(samples.count, 5, "Vision finds the lines' characters")
        let shifts = try XCTUnwrap(BookFlattener.bowShifts(of: samples, width: CGFloat(split.left.width)))
        let bow = try XCTUnwrap(shifts.max()) - (shifts.min() ?? 0)
        let flat = BookFlattener.flattened(split.left)
        let measuredBow = try XCTUnwrap(flat.bow)
        XCTAssertEqual(measuredBow, bow, accuracy: 0.01)
        XCTAssertGreaterThan(bow, 5, "the fixture's lines are bowed")
        let after = try XCTUnwrap(BookFlattener.bowShifts(of: BookFlattener.lineSamples(in: flat.image), width: CGFloat(flat.image.width)))
        let residual = (after.max() ?? 0) - (after.min() ?? 0)
        print("SCAN-BOOK bow \(bow.rounded()) px → \(residual.rounded()) px after flattening (\(samples.count) lines)")
        XCTAssertLessThan(residual, bow / 2, "the bow is at least halved")

        // Through the pipeline as book mode runs it.
        var enhancement = Enhancement()
        enhancement.flattenCurvature = true
        let page = ScanPipeline.enhance(split.right, with: enhancement)
        XCTAssertNotNil(page.bow)
    }

    /// Whiteboard mode: the board's glare and shadow go, the board is white,
    /// and the markers keep their colours — blue stays blue, red red.
    func testWhiteboardKeepsMarkerColoursOnAWhiteBoard() throws {
        let board = try photo("whiteboard")
        let before = try paper(of: board)
        var enhancement = Enhancement()
        enhancement.whiteboard = true
        let clean = try XCTUnwrap(RGBABitmap(ScanPipeline.enhance(board, with: enhancement).image))
        let after = try paper(of: try XCTUnwrap(clean.cgImage))
        print("SCAN-WHITEBOARD board mean \(Int(before.mean))→\(Int(after.mean)), spread \(before.spread.rounded())→\(after.spread.rounded())")
        XCTAssertGreaterThan(after.mean, 240, "the board is white")
        XCTAssertLessThan(after.spread, before.spread * 0.6, "glare and shadow are gone")
        // Colours: count clearly blue and clearly red pixels.
        var blue = 0, red = 0
        for k in stride(from: 0, to: clean.data.count, by: 4 * 7) {
            let r = Int(clean.data[k]), g = Int(clean.data[k + 1]), b = Int(clean.data[k + 2])
            if b > r + 60, b > g + 40 { blue += 1 }
            if r > g + 80, r > b + 80 { red += 1 }
        }
        XCTAssertGreaterThan(blue, 200, "blue marker strokes stay blue: \(blue)")
        XCTAssertGreaterThan(red, 200, "red marker strokes stay red: \(red)")
    }

    // MARK: - The PDF, through the core

    func testPlacementOnA4MatchesTheCoresFit() {
        let portrait = ScanExporter.placement(of: CGSize(width: 1000, height: 1414))
        XCTAssertEqual(portrait.paper.width, 595.276, accuracy: 0.001)
        XCTAssertEqual(portrait.scale, 0.595276, accuracy: 0.0001)
        XCTAssertEqual(portrait.offset.x, 0, accuracy: 0.001)
        XCTAssertEqual(portrait.offset.y, (841.89 - 1414 * 0.595276) / 2, accuracy: 0.001)
        let box = portrait.points(CGRect(x: 100, y: 200, width: 50, height: 20))
        XCTAssertEqual(box[0], Float(100 * 0.595276), accuracy: 0.01)
        XCTAssertEqual(box[3], Float(portrait.offset.y + 220 * 0.595276), accuracy: 0.01)
        let landscape = ScanExporter.placement(of: CGSize(width: 2000, height: 1000))
        XCTAssertEqual(landscape.paper.width, 841.89, accuracy: 0.001, "the paper turns with the picture")
        XCTAssertEqual(landscape.paper.height, 595.276, accuracy: 0.001)
        XCTAssertTrue(ScanExporter.pdfDate(Date(timeIntervalSince1970: 0)).hasPrefix("D:19700101000000Z"))
    }

    func testAScanBecomesASearchablePDFThroughTheCore() async throws {
        let supported = TextRecognizer.supportedLanguages()
        let languages = TextRecognizer.languages(chosen: ["ar", "en"], supported: supported)
        let readsArabic = TextRecognizer.supports("ar", in: supported)
        let photo = try photo("photo-arabic")
        let enhanced = ScanPipeline.enhance(photo, with: Enhancement())
        let recognition = try TextRecognizer.recognize(enhanced.image, languages: languages)
        XCTAssertGreaterThan(recognition.words.count, 20, "words were read")
        let made = try await ScanExporter.makePDF(pictures: [enhanced.image], recognitions: [recognition], angles: [0], title: "Scan test")
        XCTAssertEqual(made.pages, 1)
        XCTAssertGreaterThan(made.words, 20)

        let core = try await Core.open(bytes: made.bytes)
        let pages = await core.pageCount
        XCTAssertEqual(pages, 1)
        let size = try await core.pageSize(0)
        XCTAssertEqual(size.width, 595.276, accuracy: 0.01)
        XCTAssertEqual(size.height, 841.89, accuracy: 0.01)
        let text = try await core.extractText(page: 0)
        if readsArabic {
            // "محرّر" on the page; searched without its shadda.
            let hits = try await core.search("محرر")
            XCTAssertEqual(hits, [0], "the Arabic word is found without tashkeel")
            XCTAssertTrue(text.contains("وراق") || text.contains("محرر") || text.contains("PDF"), text.prefix(300).description)
        } else {
            let hits = try await core.search("OpenType")
            XCTAssertEqual(hits, [0])
            XCTAssertTrue(text.contains("PDF"), text.prefix(300).description)
        }

        // The words are kept with the layer, at angle 0 (the page was levelled first).
        let kept = try await Core.callStatic(op: "ocr.layer_words", args: "{}", blobs: [made.bytes])
        let layers = try XCTUnwrap(kept.object["pages"] as? [[String: Any]])
        XCTAssertEqual(layers.count, 1)
        XCTAssertEqual(layers[0]["angle"] as? Double ?? -1, 0, accuracy: 0.001)
        XCTAssertEqual((layers[0]["words"] as? [Any])?.count, recognition.words.count)
        let metadata = try await core.metadata()
        XCTAssertEqual(metadata.title, "Scan test")
    }

    func testTheSessionSavesAndTheDefaultsAreSane() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "ScanSession-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: folder) }
        let session = await ScanSession(mode: .document, documentsFolder: folder)
        let page = try photo("page-crooked")
        await session.add(images: [page])
        let count = await session.pages.count
        XCTAssertEqual(count, 1)
        await MainActor.run { session.ocrEnabled = false }
        let url = try await session.savePDF(named: "My/scan: one")
        XCTAssertEqual(url.lastPathComponent, "My-scan- one.pdf")
        let bytes = try Data(contentsOf: url)
        let core = try await Core.open(bytes: bytes)
        let pages = await core.pageCount
        XCTAssertEqual(pages, 1)
        XCTAssertEqual(ScanSession.safeFileName("..hidden"), "hidden")
        XCTAssertTrue(ScanSession.defaultName(now: Date(timeIntervalSince1970: 0)).hasSuffix("1970-01-01 03.00") || ScanSession.defaultName(now: Date(timeIntervalSince1970: 0)).contains("1970-01-01"))
    }
}
