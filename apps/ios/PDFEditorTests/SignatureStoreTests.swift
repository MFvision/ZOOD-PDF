@testable import PDFEditor
import XCTest

/// The kept signature: encrypted on disk with a key from the Keychain.
final class SignatureStoreTests: XCTestCase {
    private var folder: URL!
    private var store: SignatureStore!

    override func setUpWithError() throws {
        folder = try PartB.folder()
        store = SignatureStore(fileURL: folder.appending(path: "signature.bin"), keychainAccount: "test-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        store.delete()
        try? FileManager.default.removeItem(at: folder)
    }

    func testRoundTripsThePictureAndKeepsNothingReadableOnDisk() throws {
        XCTAssertFalse(store.exists)
        XCTAssertNil(store.load())
        let image = PartB.picture(width: 200, height: 80)
        try store.save(image)
        XCTAssertTrue(store.exists)
        let onDisk = try Data(contentsOf: store.fileURL)
        XCTAssertFalse(onDisk.starts(with: [0x89, 0x50, 0x4E, 0x47]), "not a PNG on disk")
        XCTAssertNil(onDisk.range(of: Data("IHDR".utf8)), "no PNG chunk in the clear")
        let loaded = try XCTUnwrap(store.load())
        XCTAssertEqual(Int(loaded.size.width * loaded.scale), 200)
        XCTAssertEqual(Int(loaded.size.height * loaded.scale), 80)

        // Another store with another key cannot read it.
        let other = SignatureStore(fileURL: store.fileURL, keychainAccount: "test-other-\(UUID().uuidString)")
        XCTAssertNil(other.load())
        other.delete()

        store.delete()
        XCTAssertFalse(store.exists)
        XCTAssertNil(store.load())
    }
}
