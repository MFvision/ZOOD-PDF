@testable import PDFEditor
import XCTest

/// What signing keeps on the device: the certificate files to sign with, and
/// the certificates the person trusts. Both in the Keychain, and neither in a
/// file the Files app can reach.
final class SigningIdentitiesTests: XCTestCase {
    private var identities: SigningIdentities!

    override func setUpWithError() throws {
        identities = SigningIdentities(keychain: SignatureKeychain(service: "app.warraq.ios.tests.\(UUID().uuidString)"))
    }

    override func tearDownWithError() throws {
        identities.deleteEverything()
    }

    /// A certificate file goes in, comes back byte for byte, and nothing of it
    /// is written into the app's own container — where the Files app would
    /// show it.
    func testACertificateFileIsKeptInTheKeychainAndNotOnDisk() throws {
        XCTAssertTrue(identities.identities().isEmpty)
        let p12 = try fixture("signer-rsa-aes", "p12")
        let entry = try identities.importIdentity(p12, name: "signer-rsa-aes.p12")
        XCTAssertEqual(identities.identities().map(\.id), [entry.id])
        XCTAssertEqual(identities.bytes(of: entry), p12, "byte for byte")

        // Nothing anywhere in the app's containers holds those bytes.
        let manager = FileManager.default
        for place in [FileManager.SearchPathDirectory.documentDirectory, .applicationSupportDirectory, .cachesDirectory] {
            guard let root = manager.urls(for: place, in: .userDomainMask).first else { continue }
            let found = manager.enumerator(at: root, includingPropertiesForKeys: nil)?
                .compactMap { $0 as? URL }
                .first { (try? Data(contentsOf: $0))?.starts(with: p12.prefix(32)) == true }
            XCTAssertNil(found, "the certificate is not in a file at \(place): \(found?.path ?? "")")
        }

        try identities.forgetIdentity(entry)
        XCTAssertTrue(identities.identities().isEmpty)
        XCTAssertNil(identities.bytes(of: entry), "and its bytes are gone too")
    }

    /// Another service's store cannot read this one's: the Keychain separates
    /// them, which is what lets the tests run without touching the person's.
    func testAnotherStoreCannotReadThisOnes() throws {
        let entry = try identities.importIdentity(try fixture("signer-ec", "p12"), name: "signer-ec.p12")
        let other = SigningIdentities(keychain: SignatureKeychain(service: "app.warraq.ios.tests.other.\(UUID().uuidString)"))
        XCTAssertTrue(other.identities().isEmpty)
        XCTAssertNil(other.bytes(of: entry))
        other.deleteEverything()
    }

    /// Trusting the same certificate twice trusts it once.
    func testTrustedCertificatesAreKeptOnceAndCanBeForgotten() throws {
        XCTAssertTrue(identities.trusted().isEmpty, "nothing is trusted to begin with")
        let root = SigningIdentities.Trusted(name: "TEST root", der: try fixture("root-rsa", "cer"))
        XCTAssertEqual(try identities.trust([root]), 1)
        XCTAssertEqual(try identities.trust([root]), 0, "the same certificate is not trusted twice")
        XCTAssertEqual(identities.trusted(), [root])

        try identities.forgetTrusted(root.der)
        XCTAssertTrue(identities.trusted().isEmpty)
    }

    /// The certificates in a file are the core's reading of it, and a file
    /// that holds none says none rather than trusting something by mistake.
    func testCertificatesAreReadFromDerAndPemAndNotFromRubbish() async throws {
        let fromDer = try await SigningIdentities.certificates(in: try fixture("root-rsa", "cer"))
        XCTAssertEqual(fromDer.count, 1)
        XCTAssertFalse(fromDer[0].name.isEmpty)

        let fromPem = try await SigningIdentities.certificates(in: try fixture("root-rsa", "pem"))
        XCTAssertEqual(fromPem.map(\.der), fromDer.map(\.der), "PEM and DER of the same certificate")

        for rubbish in [Data(), Data("%PDF-1.7\n".utf8), Data(repeating: 0, count: 512)] {
            let found = try await SigningIdentities.certificates(in: rubbish)
            XCTAssertTrue(found.isEmpty, "nothing is trusted from a file with no certificate in it")
        }
    }

    /// Forgetting everything leaves nothing behind — what Settings' "Delete
    /// everything" must be able to promise.
    func testDeletingEverythingLeavesNothing() throws {
        let entry = try identities.importIdentity(try fixture("signer-rsa-aes", "p12"), name: "a.p12")
        try identities.trust([SigningIdentities.Trusted(name: "root", der: try fixture("root-rsa", "cer"))])
        identities.deleteEverything()
        XCTAssertTrue(identities.identities().isEmpty)
        XCTAssertTrue(identities.trusted().isEmpty)
        XCTAssertNil(identities.bytes(of: entry))
    }

    private func fixture(_ name: String, _ ext: String) throws -> Data {
        let url = try XCTUnwrap(
            Bundle(for: SigningIdentitiesTests.self).url(forResource: name, withExtension: ext),
            "\(name).\(ext) is in the test bundle"
        )
        return try Data(contentsOf: url)
    }
}
