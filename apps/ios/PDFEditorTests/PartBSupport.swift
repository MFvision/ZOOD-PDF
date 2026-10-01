@testable import PDFEditor
import PDFKit
import WarraqCore
import XCTest

/// What part B's tests share: the corpus files copied where a model can
/// save them, a loaded model, and a picture to place.
enum PartB {
    static func fixtureURL(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle(for: Marker.self).url(forResource: name, withExtension: "pdf"), "\(name).pdf is in the test bundle")
    }

    static func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: fixtureURL(name))
    }

    /// A folder of this test's own, cleaned up by the caller.
    static func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "PartB-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// The corpus file copied into `folder`, opened and loaded.
    @MainActor
    static func loadedModel(_ name: String, in folder: URL, password: String? = nil) async throws -> DocumentModel {
        let destination = folder.appending(path: "\(name).pdf")
        try FileManager.default.copyItem(at: fixtureURL(name), to: destination)
        let model = try DocumentModel(url: destination)
        await model.load(password: password)
        XCTAssertEqual(model.state, .ready, "\(name) loads")
        return model
    }

    /// The page's text as the core reads it, unwrapped: `XCTUnwrap` takes an
    /// autoclosure, which cannot hold an `await`, so the reading happens here.
    @MainActor
    static func text(of model: DocumentModel, page: Int,
                     file: StaticString = #filePath, line: UInt = #line) async throws -> String {
        let text = await model.text(ofPage: page)
        return try XCTUnwrap(text, "the core reads page \(page)", file: file, line: line)
    }

    /// A small opaque picture, as a signature or a page would be.
    static func picture(width: Int = 120, height: Int = 60, color: UIColor = .black) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height))
        return renderer.image { context in
            color.setFill()
            context.fill(CGRect(x: 10, y: 10, width: width - 20, height: height - 20))
        }
    }

    private final class Marker {}
}
