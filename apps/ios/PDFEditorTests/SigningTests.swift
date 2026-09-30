@testable import PDFEditor
import WarraqCore
import XCTest

/// Signing and checking, through the core: a real PKCS#12 certificate signs a
/// real Arabic document, and the signature checks out — but only when the
/// person trusts the root it hangs from, only with the right password, only
/// while the certificates are valid, and never when the certificate is a web
/// server's rather than a document signer's.
///
/// Every certificate here is from `tests/fixtures/signatures`: every key in
/// that folder is public and every password is `warraq-test`. They protect
/// nothing.
@MainActor
final class SigningTests: XCTestCase {
    private var folder: URL!
    private var identities: SigningIdentities!

    /// The password of every fixture certificate file.
    private let fixturePassword = "warraq-test"

    override func setUp() async throws {
        folder = try PartB.folder()
        // A Keychain service of this run's own: the tests never touch, and
        // never leave behind, what the person has.
        identities = SigningIdentities(keychain: SignatureKeychain(service: "app.warraq.ios.tests.\(UUID().uuidString)"))
    }

    override func tearDown() async throws {
        identities.deleteEverything()
        try? FileManager.default.removeItem(at: folder)
    }

    // MARK: - Reading a certificate file

    func testACertificateFileOpensWithItsPasswordAndNoOther() async throws {
        let p12 = try fixture("signer-rsa-aes", "p12")
        let identity = try await Signing.identity(in: p12, password: fixturePassword)
        XCTAssertFalse(identity.name.isEmpty, "the certificate names its subject: \(identity.name)")
        XCTAssertFalse(identity.issuer.isEmpty)
        XCTAssertTrue(identity.validNow, "the fixture certificates are valid for twenty years")
        XCTAssertTrue(identity.canSign, "a signer's certificate may sign")
        XCTAssertTrue(identity.rsa, "signer-rsa is an RSA key")

        // The wrong password is refused, and named for what it is.
        do {
            _ = try await Signing.identity(in: p12, password: "not the password")
            XCTFail("a wrong certificate password was accepted")
        } catch let error as CoreError {
            XCTAssertEqual(error.code, "E_P12_PASSWORD", "\(error)")
            XCTAssertEqual(Signing.message(for: error), String(localized: "That is not the certificate's password."))
        }
    }

    /// A certificate whose time has passed cannot be presented as usable.
    func testACertificateThatHasExpiredIsSaidToBeInvalidNow() async throws {
        let p12 = try fixture("signer-rsa-aes", "p12")
        let longAfter = Date().addingTimeInterval(60 * 60 * 24 * 365 * 25)
        let identity = try await Signing.identity(in: p12, password: fixturePassword, now: longAfter)
        XCTAssertFalse(identity.validNow, "twenty-five years on, the fixture certificate has expired")
    }

    // MARK: - Signing, and what checking then says

    func testASignedDocumentChecksOutOnlyWhenItsRootIsTrusted() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        try await signWithFixture(model)
        XCTAssertTrue(model.isEdited, "the open document is now the signed one")

        // Nothing trusted: intact, but nobody vouches for the signer. It must
        // never read as valid.
        var report = try await Signatures.verify(bytes: model.bytes, password: nil, trusted: [])
        XCTAssertEqual(report.signatures.count, 1, "one signature")
        var signature = try XCTUnwrap(report.signatures.first)
        XCTAssertEqual(signature.status, .untrusted, "no trusted root, so the signer is not verified")
        XCTAssertNotEqual(signature.status, .valid)
        XCTAssertTrue(signature.integrity.digestOk, "the file matches what was signed")
        XCTAssertTrue(signature.integrity.signatureOk, "the signature itself verifies")
        XCTAssertNotNil(signature.trustCandidateDER, "there is a certificate the person could trust")
        XCTAssertNotNil(signature.why, "an untrusted signature says why")

        // With the root trusted, the same file is valid.
        try identities.trust([SigningIdentities.Trusted(name: "TEST root", der: try fixture("root-rsa", "cer"))])
        report = try await Signatures.verify(bytes: model.bytes, password: nil, trusted: identities.trusted())
        signature = try XCTUnwrap(report.signatures.first)
        XCTAssertEqual(signature.status, .valid, "trusted root, valid signature")
        XCTAssertEqual(signature.chain?.trust.state, "trusted")
        XCTAssertEqual(signature.chain?.trust.user, true, "trusted by the person, not by a browser's store")
        XCTAssertEqual(signature.chain?.purposeOk, true, "the certificates are for signing documents")
        XCTAssertNil(signature.why, "a valid signature needs no excuse")
        XCTAssertTrue(signature.integrity.coversWholeFile)
        XCTAssertTrue(signature.changes.isEmpty, "nothing changed after signing")
        model.close()
    }

    /// The signature must say who signed — from the certificate, not from
    /// anything typed — and carry what the form put in it.
    func testTheSignatureCarriesTheSignerTheReasonAndThePlace() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        let identity = try await Signing.identity(in: try fixture("signer-rsa-aes", "p12"), password: fixturePassword)
        try await Signing.sign(
            Signing.Request(
                p12: try fixture("signer-rsa-aes", "p12"),
                p12Password: fixturePassword,
                signerName: identity.name,
                reason: "الموافقة على الفاتورة",
                location: "الرياض"
            ),
            on: model,
            undoManager: nil
        )
        try identities.trust([SigningIdentities.Trusted(name: "TEST root", der: try fixture("root-rsa", "cer"))])
        let report = try await Signatures.verify(bytes: model.bytes, password: nil, trusted: identities.trusted())
        let signature = try XCTUnwrap(report.signatures.first)
        XCTAssertEqual(signature.signedBy, identity.name, "who signed is the certificate's name")
        XCTAssertEqual(signature.reason, "الموافقة على الفاتورة")
        XCTAssertEqual(signature.location, "الرياض")
        XCTAssertEqual(signature.kind, "approval")
        XCTAssertTrue(signature.visible, "it was placed on the page")
        XCTAssertEqual(signature.page, 0)
        model.close()
    }

    /// Nothing in the file is signed with a time an authority vouches for: no
    /// timestamp server is asked on this device. The interface must therefore
    /// never call the time anything but the signer's own.
    func testTheTimeIsTheSignersOwnBecauseNoAuthorityIsAsked() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        try await signWithFixture(model)
        let report = try await Signatures.verify(bytes: model.bytes, password: nil, trusted: [])
        let signature = try XCTUnwrap(report.signatures.first)
        XCTAssertNil(signature.timestamp, "no timestamp was fetched")
        XCTAssertNil(signature.stampedTime, "so there is no authority's time to show")
        XCTAssertNotNil(signature.claimedTime, "only the signer's own clock")
        model.close()
    }

    // MARK: - The negatives

    /// A file changed after signing says so, and the change is listed.
    func testAFileChangedAfterSigningIsNotPresentedAsUntouched() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        try await signWithFixture(model)
        try identities.trust([SigningIdentities.Trusted(name: "TEST root", der: try fixture("root-rsa", "cer"))])

        // Another page turned: an edit the core appends after the signature.
        struct Rotate: Encodable { let pages: [Int]; let quarterTurns: Int }
        try await model.apply("pages.rotate", args: Rotate(pages: [0], quarterTurns: 1), undoManager: nil)

        let report = try await Signatures.verify(bytes: model.bytes, password: nil, trusted: identities.trusted())
        let signature = try XCTUnwrap(report.signatures.first)
        XCTAssertNotEqual(signature.status, .valid, "a page was turned after signing")
        XCTAssertEqual(signature.status, .modified)
        XCTAssertFalse(signature.integrity.coversWholeFile, "the file grew after the signature")
        XCTAssertFalse(signature.changes.isEmpty, "the change is named")
        XCTAssertTrue(signature.changes.contains { !$0.allowed }, "and it is not one this signature allows")
        model.close()
    }

    /// A file whose signed bytes were tampered with: the digest no longer
    /// matches, and it is invalid — not merely "untrusted".
    func testATamperedFileIsInvalid() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        try await signWithFixture(model)
        try identities.trust([SigningIdentities.Trusted(name: "TEST root", der: try fixture("root-rsa", "cer"))])

        // One byte of the signed range turned over. The header is inside every
        // signature's byte range, so this is the smallest possible tamper.
        var tampered = model.bytes
        let at = 5
        tampered[at] = tampered[at] == 0x37 ? 0x34 : 0x37

        let report = try await Signatures.verify(bytes: tampered, password: nil, trusted: identities.trusted())
        let signature = try XCTUnwrap(report.signatures.first)
        XCTAssertEqual(signature.status, .invalid, "the bytes do not match what was signed")
        XCTAssertFalse(signature.integrity.digestOk)
        XCTAssertNotNil(signature.why)
        model.close()
    }

    /// The policy the desktop set and this must not weaken: a certificate
    /// issued for a web server is not a document signer, even when the root it
    /// hangs from is one the person trusts.
    func testAWebServerCertificateIsRefusedAsADocumentSigner() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        try await Signing.sign(
            Signing.Request(p12: try fixture("web-server", "p12"), p12Password: fixturePassword, signerName: "attacker"),
            on: model,
            undoManager: nil
        )
        // The root of that certificate, trusted outright — the strongest case
        // the attacker could hope for.
        try identities.trust([SigningIdentities.Trusted(name: "hostile root", der: try fixture("hostile-root", "cer"))])

        let report = try await Signatures.verify(bytes: model.bytes, password: nil, trusted: identities.trusted())
        let signature = try XCTUnwrap(report.signatures.first)
        XCTAssertNotEqual(signature.status, .valid, "a web-server certificate never signs a document")
        XCTAssertEqual(signature.chain?.purposeOk, false, "the certificates are not for this purpose")
        XCTAssertTrue(signature.hasProblem("eku"), "the problem is the extended key usage: \(signature.problems)")
        model.close()
    }

    /// And the same policy, the other way: a certificate that really is for
    /// signing documents, under the same root, does check out. The policy
    /// discriminates; it does not merely refuse everything.
    func testADocumentSigningCertificateUnderTheSameRootIsValid() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        try await Signing.sign(
            Signing.Request(p12: try fixture("docs-signer", "p12"), p12Password: fixturePassword, signerName: "signer"),
            on: model,
            undoManager: nil
        )
        try identities.trust([SigningIdentities.Trusted(name: "hostile root", der: try fixture("hostile-root", "cer"))])
        let report = try await Signatures.verify(bytes: model.bytes, password: nil, trusted: identities.trusted())
        let signature = try XCTUnwrap(report.signatures.first)
        XCTAssertEqual(signature.chain?.purposeOk, true, "this one is for signing documents")
        XCTAssertEqual(signature.status, .valid, "\(signature.problems)")
        model.close()
    }

    /// Checked at a time when the signer's certificate has expired, a
    /// signature with nothing to prove when it was made is not valid.
    func testASignatureIsNotValidOnceItsCertificateHasExpired() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        try await signWithFixture(model)
        try identities.trust([SigningIdentities.Trusted(name: "TEST root", der: try fixture("root-rsa", "cer"))])

        let longAfter = Date().addingTimeInterval(60 * 60 * 24 * 365 * 25)
        let report = try await Signatures.verify(
            bytes: model.bytes,
            password: nil,
            trusted: identities.trusted(),
            now: longAfter
        )
        let signature = try XCTUnwrap(report.signatures.first)
        XCTAssertNotEqual(signature.status, .valid, "the certificate has expired by then")
        XCTAssertEqual(signature.chain?.validAtTime, false, "and the report says exactly that")
        model.close()
    }

    /// Signing with a wrong certificate password changes nothing at all.
    func testSigningWithTheWrongPasswordLeavesTheDocumentAlone() async throws {
        let model = try await PartB.loadedModel("coretext-sfarabic-mixed-invoice", in: folder)
        do {
            try await Signing.sign(
                Signing.Request(p12: try fixture("signer-rsa-aes", "p12"), p12Password: "wrong", signerName: "x"),
                on: model,
                undoManager: nil
            )
            XCTFail("signed with a wrong certificate password")
        } catch let error as CoreError {
            XCTAssertEqual(error.code, "E_P12_PASSWORD")
        }
        XCTAssertFalse(model.isEdited, "nothing was changed")
        model.close()
    }

    /// A document with no signature in it says so, and is not parsed twice to
    /// find that out.
    func testAnUnsignedDocumentHasNoSignatures() async throws {
        let bytes = try PartB.fixture("coretext-sfarabic-mixed-invoice")
        XCTAssertFalse(Signatures.mightBeSigned(bytes), "no /ByteRange anywhere in it")
        let report = try await Signatures.verify(bytes: bytes, password: nil, trusted: [])
        XCTAssertTrue(report.signatures.isEmpty)
        XCTAssertNil(report.overall)
    }

    /// The worst signature in a file is the one that stands for it.
    func testTheWorstSignatureIsTheHeadline() {
        func report(_ statuses: [Signatures.Status]) -> Signatures.Report {
            var made = Signatures.Report()
            made.signatures = statuses.map { status in
                var signature = Signatures.Signature()
                signature.status = status
                signature.field = "f\(status.rawValue)"
                return signature
            }
            return made
        }
        XCTAssertEqual(report([.valid, .valid]).overall, .valid)
        XCTAssertEqual(report([.valid, .untrusted]).overall, .untrusted)
        // One never checked is no better than one whose signer is unknown.
        XCTAssertEqual(report([.untrusted, .unchecked]).overall, .unchecked)
        XCTAssertEqual(report([.untrusted, .modified]).overall, .modified)
        XCTAssertEqual(report([.modified, .invalid]).overall, .invalid)
        XCTAssertNil(report([]).overall)
    }

    /// The visible signature's rectangle sits at the end of the reading
    /// direction, which is the right-hand side of an Arabic page.
    func testTheSignatureIsPlacedAtTheStartOfTheReadingDirection() {
        let a4 = CGSize(width: 595, height: 842)
        let rtl = Signing.Position.bottomStart.rect(onPageOf: a4, rightToLeft: true)
        let ltr = Signing.Position.bottomStart.rect(onPageOf: a4, rightToLeft: false)
        XCTAssertGreaterThan(rtl[0], a4.width / 2, "Arabic signs on the right")
        XCTAssertLessThan(ltr[0], a4.width / 2, "English signs on the left")
        for rect in [rtl, ltr] {
            XCTAssertGreaterThan(rect[2], rect[0], "a rectangle with width")
            XCTAssertGreaterThan(rect[3], rect[1], "a rectangle with height")
            XCTAssertLessThanOrEqual(rect[2], a4.width, "inside the page")
            XCTAssertLessThanOrEqual(rect[3], a4.height)
            XCTAssertGreaterThan(rect[1], a4.height / 2, "at the bottom")
        }
        let top = Signing.Position.topEnd.rect(onPageOf: a4, rightToLeft: true)
        XCTAssertLessThan(top[1], a4.height / 2, "and the top corner is at the top")
    }

    /// The appearance is signed as it is drawn, so the line the core draws is
    /// composed here — with the mark that keeps an Arabic line's date whole.
    func testTheAppearanceLinesSayWhoSignedAndWhen() {
        var request = Signing.Request(p12: Data(), p12Password: "", signerName: "وزارة المالية")
        var lines = Signing.appearanceLines(request, now: Date())
        XCTAssertEqual(lines.count, 2, "who and when, and nothing else was given")
        XCTAssertTrue(lines[0].contains("وزارة المالية"), "\(lines[0])")
        XCTAssertTrue(lines[1].contains("\u{200E}"), "the date carries a left-to-right mark")

        request.reason = "الموافقة"
        request.location = "الرياض"
        lines = Signing.appearanceLines(request, now: Date())
        XCTAssertEqual(lines.count, 4)
        XCTAssertTrue(lines[2].contains("الموافقة"))
        XCTAssertTrue(lines[3].contains("الرياض"))
    }

    // MARK: - Helpers

    private func fixture(_ name: String, _ ext: String) throws -> Data {
        let url = try XCTUnwrap(
            Bundle(for: SigningTests.self).url(forResource: name, withExtension: ext),
            "\(name).\(ext) is in the test bundle"
        )
        return try Data(contentsOf: url)
    }

    /// Signs `model` with the RSA fixture certificate, visibly on page 1.
    private func signWithFixture(_ model: DocumentModel) async throws {
        let p12 = try fixture("signer-rsa-aes", "p12")
        let identity = try await Signing.identity(in: p12, password: fixturePassword)
        try await Signing.sign(
            Signing.Request(p12: p12, p12Password: fixturePassword, signerName: identity.name),
            on: model,
            undoManager: nil
        )
    }
}
