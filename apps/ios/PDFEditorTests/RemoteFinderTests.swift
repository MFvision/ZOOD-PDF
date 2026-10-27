import XCTest
@testable import PDFEditor

/// Finding the computer again at a new address (Remote/RemoteFinder.swift,
/// Remote/RemoteBridge.swift): only an announcement with this phone's tag
/// counts, and the tag is the computer's byte for byte
/// (`announce::tests::tags_are_pinned` in apps/desktop/src-tauri).
final class RemoteFinderTests: XCTestCase {
    private let key = Data(repeating: 1, count: 32)

    func testTheTagMatchesTheComputers() {
        XCTAssertTrue(RemoteTag.seen("4Puanl3SBJY", key: key, address: "192.168.1.20:47800"))
        XCTAssertFalse(RemoteTag.seen("4Puanl3SBJY", key: key, address: "192.168.1.21:47800"))
        XCTAssertFalse(RemoteTag.seen("4Puanl3SBJY", key: Data(repeating: 2, count: 32), address: "192.168.1.20:47800"))
        XCTAssertFalse(RemoteTag.seen("", key: key, address: "192.168.1.20:47800"))
        XCTAssertFalse(RemoteTag.seen("not base64!", key: key, address: "192.168.1.20:47800"))
    }

    func testOnlyTheRealComputerIsOpened() {
        let real = ["v": "1", "pc": "MOHAMMED-PC", "addr": "192.168.1.20", "port": "47800", "seen": "4Puanl3SBJY"]
        XCTAssertEqual(RemoteFinder.verified(real, pc: "MOHAMMED-PC", key: key)?.absoluteString, "http://192.168.1.20:47800/")

        var otherName = real
        otherName["pc"] = "OTHER-PC"
        XCTAssertNil(RemoteFinder.verified(otherName, pc: "MOHAMMED-PC", key: key))

        var noTag = real
        noTag["seen"] = ""
        XCTAssertNil(RemoteFinder.verified(noTag, pc: "MOHAMMED-PC", key: key))

        var moved = real
        moved["addr"] = "192.168.1.99"
        XCTAssertNil(RemoteFinder.verified(moved, pc: "MOHAMMED-PC", key: key), "a copied tag for another address")

        var outside = real
        outside["addr"] = "8.8.8.8"
        XCTAssertNil(RemoteFinder.verified(outside, pc: "MOHAMMED-PC", key: key))
    }

    func testPairingsFromThePageAreChecked() {
        let good = Data(repeating: 7, count: 32).base64EncodedString()
        XCTAssertNotNil(RemotePairings.Pairing(["device": "ab12", "key": good]))
        XCTAssertNil(RemotePairings.Pairing(["device": "ab12", "key": "short"]))
        XCTAssertNil(RemotePairings.Pairing(["device": "not hex", "key": good]))
        XCTAssertNil(RemotePairings.Pairing(["key": good]))
    }

    func testPairingsAreKeptByTheComputersName() {
        let store = RemotePairings(service: "app.warraq.ios.remote.tests")
        let pairing = RemotePairings.Pairing(device: "ab12", key: Data(repeating: 7, count: 32).base64EncodedString())
        store.keep(pairing, for: "TEST-PC")
        defer { store.forget("TEST-PC") }
        XCTAssertEqual(store.pairing(for: "TEST-PC"), pairing)
        XCTAssertNil(store.pairing(for: "OTHER-PC"))
    }
}
