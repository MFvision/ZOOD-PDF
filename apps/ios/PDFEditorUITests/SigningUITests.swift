import WarraqCore
import XCTest

/// Signatures, through the interface: an unsigned file says it has none and
/// offers to sign it; a file signed with a certificate nobody here trusts is
/// reported as intact but unverified — never as valid.
///
/// The signature the second test reads is a real one: the test makes it with
/// the core and the public test certificate from `tests/fixtures/signatures`,
/// then launches the app on the signed file.
@MainActor
final class SigningUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAnUnsignedFileSaysSoAndOffersToSignIt() throws {
        let ui = try PartBApp.launch(fixture: PartBApp.invoice)
        ui.waitForPage(containing: "فاتورة")
        ui.more("document.signatures", label: "Signatures…")

        let none = ui.app.staticTexts["signatures.none"]
        XCTAssertTrue(none.waitForExistence(timeout: 30), "it says the file has no signatures\n\(ui.tree)")
        XCTAssertTrue(ui.app.staticTexts["signatures.trusted.none"].exists, "and that nothing is trusted yet")
        XCTAssertTrue(ui.app.staticTexts["signatures.networkNote"].exists, "and that nothing is fetched")

        // Signing is offered, and says plainly that no certificate is here.
        ui.app.buttons["signatures.sign"].tap()
        let noIdentity = ui.app.staticTexts["sign.noIdentity"]
        XCTAssertTrue(noIdentity.waitForExistence(timeout: 20), "no certificate has been imported\n\(ui.tree)")
        XCTAssertTrue(ui.app.buttons["sign.import"].exists, "and one can be imported")
        XCTAssertFalse(ui.app.buttons["sign.sign"].isEnabled, "nothing to sign with, so Sign does nothing")
        XCTAssertTrue(ui.app.staticTexts["sign.privacy"].exists, "and it says nothing is sent anywhere")
        ui.app.buttons["sign.cancel"].tap()
        ui.app.buttons["sheet.done"].tap()
    }

    func testASignatureNobodyVouchesForIsNotCalledValid() async throws {
        let file = try await signedInvoice()
        let ui = try PartBApp.launch(file: file)
        ui.waitForPage(containing: "فاتورة")
        ui.more("document.signatures", label: "Signatures…")

        let status = ui.app.staticTexts["signature.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 40), "the signature is reported\n\(ui.tree)")
        XCTAssertEqual(
            status.label,
            "Intact — the signer's identity is not verified",
            "an unverified signer is never reported as valid"
        )
        XCTAssertFalse(ui.app.staticTexts["signatures.none"].exists, "and the file is not called unsigned")

        // The signer is named, and there is a certificate to trust.
        XCTAssertTrue(ui.app.buttons["signature.trust"].waitForExistence(timeout: 10), "it offers to trust the root")
        ui.app.buttons["sheet.done"].tap()
    }

    /// The invoice signed with the public test certificate, invisibly (so no
    /// font is needed), written where the app can be launched on it.
    private func signedInvoice() async throws -> URL {
        let file = try PartBApp.copyFixture(PartBApp.invoice)
        let p12URL = try XCTUnwrap(
            Bundle(for: SigningUITests.self).url(forResource: "signer-rsa-aes", withExtension: "p12"),
            "signer-rsa-aes.p12 is in the UI test bundle"
        )
        struct Args: Encodable {
            let p12Password = "warraq-test"
            let page = 0
            let lines: [String] = []
            let time: Int
            let offsetMinutes = 0
            let lockFields = false
            let pss = false
            let timestamp = false
        }
        let reply = try await Core.callStatic(
            op: "signatures.sign",
            args: Args(time: Int(Date().timeIntervalSince1970)),
            blobs: [try Data(contentsOf: file), try Data(contentsOf: p12URL), Data()]
        )
        let signed = try XCTUnwrap(reply.blobs.first, "the core answered a signed file")
        try signed.write(to: file, options: .atomic)
        return file
    }
}
