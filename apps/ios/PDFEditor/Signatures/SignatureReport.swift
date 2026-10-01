import Foundation
import SwiftUI
import WarraqCore

/// What `signatures.verify` answers, and the words the interface puts to it.
///
/// This mirrors the core's report exactly (`packages/core/API.md`,
/// `warraq-sign/src/chain.rs` for the trust policy) and the desktop's reading
/// of it (`packages/ui/src/signatures/model.ts`), so a signature reads the same
/// on every host. The trust policy itself is the core's and is not repeated
/// here: this file only puts words to the answer.
///
/// The rule the whole file is built around: **a signature is never presented
/// as valid when it could not be verified.** `untrusted` means intact but
/// nobody the person trusts vouches for the signer; it reads as that, never as
/// "valid".
enum Signatures {
    // MARK: - The core's report

    /// How a signature came out. `unchecked` is worse than `untrusted`: one
    /// never checked is no better than one whose signer is unknown.
    enum Status: String, Codable, Sendable {
        case valid
        case untrusted
        case modified
        case invalid
        case unchecked

        /// What the person reads. Deliberately not "valid"/"invalid"
        /// everywhere: an intact signature by an unknown signer is not valid.
        var text: LocalizedStringKey {
            switch self {
            case .valid: "Valid"
            case .untrusted: "Intact — the signer's identity is not verified"
            case .modified: "Changed after signing"
            case .invalid: "Invalid"
            case .unchecked: "Not checked"
            }
        }

        /// An SF Symbol that repeats the words; it never carries the meaning
        /// on its own.
        var symbol: String {
            switch self {
            case .valid: "checkmark.shield.fill"
            case .untrusted: "questionmark.circle.fill"
            case .modified: "exclamationmark.shield.fill"
            case .invalid: "xmark.shield.fill"
            case .unchecked: "questionmark.circle"
            }
        }

        var tint: Color {
            switch self {
            case .valid: .green
            case .untrusted, .unchecked: .orange
            case .modified, .invalid: .red
            }
        }

        /// Worst first, for the one line that stands for a whole file.
        static let worstFirst: [Status] = [.invalid, .modified, .unchecked, .untrusted, .valid]
    }

    struct Certificate: Decodable, Sendable, Equatable {
        var name = ""
        var subject = ""
        var issuer = ""
        var serial = ""
        var notBefore = ""
        var notAfter = ""
        var ca = false
    }

    /// Where the certificate path ends, and what that is worth. The core's
    /// policy: Mozilla's roots vouch for web sites, not for who signs a
    /// document, so a signer chaining to one is `webRoot`, never `trusted`.
    struct Trust: Decodable, Sendable, Equatable {
        var state = "incomplete"
        var anchor: String?
        var root: String?
        var missing: String?
        var name: String?
        /// The anchor is one the person trusted on this device.
        var user = false

        var text: LocalizedStringKey {
            switch state {
            case "trusted":
                user
                    ? "Trusted: \(isolate(anchor)) (trusted by you on this device)"
                    : "Trusted for timestamps: \(isolate(anchor)) (Mozilla's root store)"
            case "webRoot":
                "Ends at \(isolate(anchor)), which browsers trust for web sites — not for who signs documents"
            case "untrustedRoot":
                "Ends at a root nobody here trusts: \(isolate(root))"
            case "broken":
                "Broken at \(isolate(name)): it may not issue certificates"
            case "incomplete":
                "Incomplete: the certificate of \(isolate(missing)) is missing"
            default:
                "Who signed is not established"
            }
        }
    }

    struct Chain: Decodable, Sendable, Equatable {
        var certs: [Certificate] = []
        var trust = Trust()
        var validAtTime = false
        var problems: [String] = []
        /// The certificates are for this purpose at all — signing documents,
        /// or timestamping.
        var purposeOk = false
    }

    struct Change: Decodable, Sendable, Equatable {
        var kind = ""
        var count = 0
        var allowed = false

        var text: LocalizedStringKey {
            switch kind {
            case "pageContent": "Page content changed"
            case "document": "The document's structure changed"
            case "signatureAltered": "A signature was altered"
            case "lockedField": "A locked form field changed"
            case "formChanged": "The form's fields changed"
            case "comments": "Comments changed"
            case "formFill": "Form fields were filled in"
            case "signatures": "Another signature was added"
            case "validationData": "Validation data was added"
            case "metadata": "The document's information changed"
            default: "Something changed"
            }
        }
    }

    struct Integrity: Decodable, Sendable, Equatable {
        var byteRangeOk = false
        var coversWholeFile = false
        var digestOk = false
        var signatureOk = false
        var algorithm = ""
    }

    struct Timestamp: Decodable, Sendable, Equatable {
        var time = ""
        var authority = ""
        var valid = false
        /// Stamped by an authority trusted for timestamps. Only then is the
        /// time an authority's rather than the signer's own claim.
        var trusted = false
    }

    struct Revocation: Decodable, Sendable, Equatable {
        var embedded = false
        /// `good`, `revoked`, `unknown` or `notChecked`.
        var status = "notChecked"
        var source: String?
        var revokedAt: String?

        /// The wording always says "in the file": the verifier never goes to
        /// the network, so this is what the file itself carries.
        var text: LocalizedStringKey {
            switch status {
            case "good": "Revocation data in the file: not revoked"
            case "revoked": "Revocation data in the file: revoked"
            case "unknown": "Revocation data in the file: status unknown"
            default: "No revocation data in the file for this certificate"
            }
        }
    }

    struct Signature: Decodable, Sendable, Equatable, Identifiable {
        var field = ""
        /// `approval`, `certification` or `timestamp`.
        var kind = "approval"
        var status = Status.unchecked
        var page: Int?
        var visible = false
        var subFilter = ""
        var signer: Certificate?
        /// The signer's certificate's name: who signed, as far as anyone
        /// vouches.
        var signedBy = ""
        /// The name the signature gives itself (`/Name`) — the signer's own
        /// claim, never verified.
        var claimedName: String?
        var reason: String?
        var location: String?
        var contact: String?
        var claimedTime: String?
        var integrity = Integrity()
        var chain: Chain?
        var timestamp: Timestamp?
        var revocation = Revocation()
        var docMdp: Int?
        var locksFields = false
        var changes: [Change] = []
        var problems: [String] = []
        var revisionEnd = 0
        /// The certificate that trusting would trust, base64 DER; only ever
        /// set when the chain is not trusted.
        var trustCandidate: String?

        var id: String { "\(field)-\(revisionEnd)" }

        /// A time is an authority's only when an authority trusted for
        /// timestamps stamped it. Anything else is the signer's own clock.
        var stampedTime: Timestamp? {
            guard let timestamp, timestamp.valid, timestamp.trusted else { return nil }
            return timestamp
        }

        /// What the person may trust, as bytes.
        var trustCandidateDER: Data? {
            guard let trustCandidate else { return nil }
            return Data(base64Encoded: trustCandidate)
        }

        /// Whether a problem code of this prefix is present. Codes are either
        /// bare (`weakHash`) or `prefix:detail`, where the detail names a
        /// certificate.
        func hasProblem(_ prefixes: String...) -> Bool {
            problems.contains { problem in
                let head = problem.split(separator: ":", maxSplits: 1).first.map(String.init) ?? problem
                return prefixes.contains(head)
            }
        }

        /// One sentence saying why it came out as it did. `nil` for a valid
        /// signature, and for a changed one — there the list of changes is the
        /// explanation.
        var why: LocalizedStringKey? {
            switch status {
            case .valid, .modified:
                return nil
            case .unchecked:
                return "This file has more signatures than are checked; this one was not."
            case .invalid:
                if !integrity.byteRangeOk {
                    return hasProblem("notInRevision")
                        ? "The signature does not cover the revision it belongs to."
                        : "The range of the file this signature covers is not right."
                }
                if !integrity.digestOk { return "The file does not match what was signed." }
                if !integrity.signatureOk { return "The signature does not verify against the signer's certificate." }
                if hasProblem("notCa", "pathLen") { return "A certificate on the path may not have issued the one below it." }
                if hasProblem("keyUsage") { return "The signer's certificate is not allowed to sign." }
                if hasProblem("revokedBeforeSigning") { return "The signer's certificate had been revoked before this was signed." }
                if hasProblem("notValidAtSigning") { return "The signer's certificate was not valid when this was signed." }
                return "Something this signature depends on is broken."
            case .untrusted:
                if problems.contains("eku:web") {
                    return "This was signed with a web-server certificate, which says who owns a domain — not who signs documents."
                }
                if hasProblem("eku", "ekuCa") { return "The certificate is not for signing documents." }
                if hasProblem("weakHash") { return "It was signed with a hash that is no longer strong enough." }
                if revocation.status == "revoked" { return "The signer's certificate has since been revoked." }
                if let timestamp, !timestamp.valid { return "Its timestamp does not verify, so when it was signed is not established." }
                switch chain?.trust.state {
                case "webRoot": return "Its certificates end at a root that browsers trust for web sites, not for document signers."
                case "untrustedRoot": return "Its certificates end at a root you have not trusted."
                case "incomplete": return "A certificate in the path is missing, so who signed cannot be established."
                default: break
                }
                if hasProblem("noProofOfTime") { return "Nothing proves when it was signed." }
                return "Nobody you trust vouches for the signer."
            }
        }

        /// What kind of signature it is, and what a certification allows.
        var kindText: LocalizedStringKey {
            switch kind {
            case "timestamp": return "A document timestamp"
            case "certification":
                switch docMdp {
                case 1: return "Certified: no changes allowed"
                case 3: return "Certified: forms, signing and comments allowed"
                default: return "Certified: filling forms and signing allowed"
                }
            default: return "An approval signature"
            }
        }
    }

    /// The whole file's report.
    struct Report: Decodable, Sendable, Equatable {
        struct Dss: Decodable, Sendable, Equatable {
            var certs = 0
            var ocsps = 0
            var crls = 0

            var isEmpty: Bool { certs + ocsps + crls == 0 }
        }

        var signatures: [Signature] = []
        var emptyFields: [String] = []
        var certified: Int?
        var dss = Dss()

        /// The worst of the file's signatures: one bad one is the headline.
        var overall: Status? {
            Status.worstFirst.first { status in signatures.contains { $0.status == status } }
        }
    }

    // MARK: - Checking

    /// Every signature in `bytes`, checked against the certificates the person
    /// trusts. Nothing here reaches the network: revocation is only what the
    /// file itself carries.
    static func verify(
        bytes: Data,
        password: String?,
        trusted: [SigningIdentities.Trusted],
        now: Date = Date()
    ) async throws -> Report {
        struct Args: Encodable {
            let password: String?
            let now: Int
        }
        let reply = try await Core.callStatic(
            op: "signatures.verify",
            args: Args(password: password, now: Int(now.timeIntervalSince1970)),
            blobs: [bytes] + trusted.map(\.der)
        )
        return try reply.decode(Report.self)
    }

    /// A file that never mentions `/ByteRange` has no signatures, and parsing
    /// it again to learn that would cost more than the answer is worth.
    static func mightBeSigned(_ bytes: Data) -> Bool {
        bytes.range(of: Data("/ByteRange".utf8)) != nil
    }

    /// A name wrapped so it reads correctly inside a sentence of the other
    /// direction: U+2068 FIRST STRONG ISOLATE … U+2069 POP DIRECTIONAL
    /// ISOLATE. An Arabic signer's name in an English sentence, and the other
    /// way round, would otherwise reorder around the punctuation.
    static func isolate(_ text: String?) -> String {
        guard let text, !text.isEmpty else { return "—" }
        return "\u{2068}\(text)\u{2069}"
    }
}

/// Free function of the same, so the `LocalizedStringKey` interpolations above
/// read as sentences.
private func isolate(_ text: String?) -> String { Signatures.isolate(text) }

// MARK: - Reading a report that may not say everything

/// Swift's synthesized `init(from:)` throws when a key is absent — even for a
/// property that has a default — so one field the core had nothing to say
/// about (`user` on a trust that is not trusted, the method of a file that is
/// not protected) would lose the whole answer. Everything the core sends is
/// read through this instead: a missing or unreadable field is its default,
/// never an error.
extension KeyedDecodingContainer {
    /// The value at `key`, or `fallback` when it is absent, null or unreadable.
    func value<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }

    /// The value at `key` as something that may be missing, which is how the
    /// core says "there is none".
    func maybe<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }
}

extension Signatures.Certificate {
    enum CodingKeys: String, CodingKey { case name, subject, issuer, serial, notBefore, notAfter, ca }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: c.value(.name, ""), subject: c.value(.subject, ""), issuer: c.value(.issuer, ""),
            serial: c.value(.serial, ""), notBefore: c.value(.notBefore, ""),
            notAfter: c.value(.notAfter, ""), ca: c.value(.ca, false)
        )
    }
}

extension Signatures.Trust {
    enum CodingKeys: String, CodingKey { case state, anchor, root, missing, name, user }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            state: c.value(.state, "incomplete"), anchor: c.maybe(String.self, .anchor),
            root: c.maybe(String.self, .root), missing: c.maybe(String.self, .missing),
            name: c.maybe(String.self, .name), user: c.value(.user, false)
        )
    }
}

extension Signatures.Chain {
    enum CodingKeys: String, CodingKey { case certs, trust, validAtTime, problems, purposeOk }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            certs: c.value(.certs, []), trust: c.value(.trust, Signatures.Trust()),
            validAtTime: c.value(.validAtTime, false), problems: c.value(.problems, []),
            purposeOk: c.value(.purposeOk, false)
        )
    }
}

extension Signatures.Change {
    enum CodingKeys: String, CodingKey { case kind, count, allowed }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(kind: c.value(.kind, ""), count: c.value(.count, 0), allowed: c.value(.allowed, false))
    }
}

extension Signatures.Integrity {
    enum CodingKeys: String, CodingKey { case byteRangeOk, coversWholeFile, digestOk, signatureOk, algorithm }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            byteRangeOk: c.value(.byteRangeOk, false), coversWholeFile: c.value(.coversWholeFile, false),
            digestOk: c.value(.digestOk, false), signatureOk: c.value(.signatureOk, false),
            algorithm: c.value(.algorithm, "")
        )
    }
}

extension Signatures.Timestamp {
    enum CodingKeys: String, CodingKey { case time, authority, valid, trusted }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            time: c.value(.time, ""), authority: c.value(.authority, ""),
            valid: c.value(.valid, false), trusted: c.value(.trusted, false)
        )
    }
}

extension Signatures.Revocation {
    enum CodingKeys: String, CodingKey { case embedded, status, source, revokedAt }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            embedded: c.value(.embedded, false), status: c.value(.status, "notChecked"),
            source: c.maybe(String.self, .source), revokedAt: c.maybe(String.self, .revokedAt)
        )
    }
}

extension Signatures.Signature {
    enum CodingKeys: String, CodingKey {
        case field, kind, status, page, visible, subFilter, signer, signedBy, claimedName
        case reason, location, contact, claimedTime, integrity, chain, timestamp, revocation
        case docMdp, locksFields, changes, problems, revisionEnd, trustCandidate
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            field: c.value(.field, ""), kind: c.value(.kind, "approval"),
            // A status this version does not know is not guessed at: it counts
            // as never checked, which is the safe side of the only rule that
            // matters here.
            status: c.value(.status, Signatures.Status.unchecked),
            page: c.maybe(Int.self, .page), visible: c.value(.visible, false),
            subFilter: c.value(.subFilter, ""), signer: c.maybe(Signatures.Certificate.self, .signer),
            signedBy: c.value(.signedBy, ""), claimedName: c.maybe(String.self, .claimedName),
            reason: c.maybe(String.self, .reason), location: c.maybe(String.self, .location),
            contact: c.maybe(String.self, .contact), claimedTime: c.maybe(String.self, .claimedTime),
            integrity: c.value(.integrity, Signatures.Integrity()),
            chain: c.maybe(Signatures.Chain.self, .chain),
            timestamp: c.maybe(Signatures.Timestamp.self, .timestamp),
            revocation: c.value(.revocation, Signatures.Revocation()),
            docMdp: c.maybe(Int.self, .docMdp), locksFields: c.value(.locksFields, false),
            changes: c.value(.changes, []), problems: c.value(.problems, []),
            revisionEnd: c.value(.revisionEnd, 0), trustCandidate: c.maybe(String.self, .trustCandidate)
        )
    }
}

extension Signatures.Report.Dss {
    enum CodingKeys: String, CodingKey { case certs, ocsps, crls }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(certs: c.value(.certs, 0), ocsps: c.value(.ocsps, 0), crls: c.value(.crls, 0))
    }
}

extension Signatures.Report {
    enum CodingKeys: String, CodingKey { case signatures, emptyFields, certified, dss }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            signatures: c.value(.signatures, []), emptyFields: c.value(.emptyFields, []),
            certified: c.maybe(Int.self, .certified), dss: c.value(.dss, Signatures.Report.Dss())
        )
    }
}
