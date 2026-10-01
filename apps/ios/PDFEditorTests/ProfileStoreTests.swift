@testable import PDFEditor
import XCTest

/// The autofill profile in the Keychain: round trip, update, delete, and
/// an empty profile leaving nothing behind.
final class ProfileStoreTests: XCTestCase {
    private let store = ProfileStore(service: "app.warraq.ios.tests.profile-\(UUID().uuidString)")

    override func tearDown() async throws {
        try? store.delete()
    }

    func testRoundTripsThroughTheKeychain() throws {
        XCTAssertTrue(store.load().isEmpty)
        var profile = Profile()
        profile.nameArabic = "محمد الغماس"
        profile.nameEnglish = "Mohammed Alghammas "
        profile.nationalID = "1234567890"
        profile.email = "m@example.com"
        try store.save(profile)
        let loaded = store.load()
        XCTAssertEqual(loaded, profile)
        XCTAssertEqual(loaded.value(.nameEnglish), "Mohammed Alghammas", "trimmed for a field")
        XCTAssertEqual(loaded[.nameEnglish], "Mohammed Alghammas ", "as typed for the editor")
        XCTAssertEqual(loaded.filledKeys, [.nameArabic, .nameEnglish, .nationalID, .email])

        // An update replaces the item, it does not add a second one.
        profile.phone = "0500000000"
        try store.save(profile)
        XCTAssertEqual(store.load().phone, "0500000000")
        XCTAssertEqual(store.load().nameArabic, "محمد الغماس")
    }

    func testAnEmptyProfileRemovesTheItem() throws {
        var profile = Profile()
        profile.iban = "SA0380000000608010167519"
        try store.save(profile)
        XCTAssertFalse(store.load().isEmpty)
        try store.save(Profile())
        XCTAssertTrue(store.load().isEmpty)
        try store.delete()
        XCTAssertTrue(store.load().isEmpty, "deleting twice is fine")
    }

    func testStoresAreSeparateByService() throws {
        let other = ProfileStore(service: "app.warraq.ios.tests.profile-other-\(UUID().uuidString)")
        defer { try? other.delete() }
        var profile = Profile()
        profile.employer = "Zood"
        try store.save(profile)
        XCTAssertTrue(other.load().isEmpty)
    }
}
