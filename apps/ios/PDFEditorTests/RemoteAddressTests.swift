import XCTest
@testable import PDFEditor

/// The phone remote's QR codes (Remote/RemoteView.swift): only the
/// computer's page on the local network, with a key, is opened.
final class RemoteAddressTests: XCTestCase {
    private let key = String(repeating: "A", count: 42) + "_"

    func testTheComputersCodeIsTaken() throws {
        let url = try XCTUnwrap(RemoteAddress.parse("http://192.168.1.4:47800/#k=\(key)"))
        XCTAssertEqual(RemoteAddress.withoutKey(url).absoluteString, "http://192.168.1.4:47800/")
        XCTAssertNotNil(RemoteAddress.parse("http://10.0.0.2:47800/#k=\(key)"))
        XCTAssertNotNil(RemoteAddress.parse("http://172.20.3.9:51000/#k=\(key)\n"))
    }

    func testAnythingElseIsTurnedAway() {
        for text in [
            "https://example.com/#k=\(key)",
            "http://8.8.8.8:47800/#k=\(key)",
            "http://172.32.0.1:47800/#k=\(key)",
            "http://evil.local:47800/#k=\(key)",
            "http://192.168.1.4/#k=\(key)",
            "http://192.168.1.4:47800/",
            "http://192.168.1.4:47800/#k=short",
            "http://user@192.168.1.4:47800/#k=\(key)",
            "http://192.168.1.4.5:47800/#k=\(key)",
            "not a url",
        ] {
            XCTAssertNil(RemoteAddress.parse(text), text)
        }
    }
}
