import Foundation
import SwiftUI
import WarraqCore

/// Making a PAdES signature, through the core — the part with no interface in
/// it, so the tests can sign a real document with a real certificate.
///
/// Nothing here touches the network. `signatures.sign` is asked for a
/// signature with no timestamp (`timestamp: false`), so the core answers the
/// signed file in one call and nothing leaves the device. A trusted timestamp
/// would mean sending a digest to an authority; that is the desktop's, and
/// `docs/STATUS.md` says so.
enum Signing {
    /// What a certificate file holds, as `signatures.identity` describes it.
    struct Identity: Decodable, Sendable, Equatable {
        var name = ""
        var issuer = ""
        var notAfter = ""
        /// Valid today. A signature by a certificate that is not will not
        /// check out, and the form says so rather than letting it pass.
        var validNow = false
        /// "RSA 2048", "EC P-256" and so on.
        var key = ""
        var rsa = false
        /// The certificate's key usage allows signing.
        var canSign = false

        enum CodingKeys: String, CodingKey { case name, issuer, notAfter, validNow, key, rsa, canSign }

        init(
            name: String = "",
            issuer: String = "",
            notAfter: String = "",
            validNow: Bool = false,
            key: String = "",
            rsa: Bool = false,
            canSign: Bool = false
        ) {
            self.name = name
            self.issuer = issuer
            self.notAfter = notAfter
            self.validNow = validNow
            self.key = key
            self.rsa = rsa
            self.canSign = canSign
        }

        /// Read leniently, like the verifier's report: a field the core did
        /// not send is its default, and the two that matter — valid today, may
        /// sign — default to no.
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                name: c.value(.name, ""), issuer: c.value(.issuer, ""),
                notAfter: c.value(.notAfter, ""), validNow: c.value(.validNow, false),
                key: c.value(.key, ""), rsa: c.value(.rsa, false), canSign: c.value(.canSign, false)
            )
        }
    }

    /// Which corner of the page the drawn signature sits in. The default is
    /// the bottom of the page at the end of the reading direction, which is
    /// where a signature goes on paper.
    enum Position: String, CaseIterable, Sendable {
        case bottomStart
        case bottomEnd
        case topStart
        case topEnd

        var text: LocalizedStringKey {
            switch self {
            case .bottomStart: "Bottom, at the start of the line"
            case .bottomEnd: "Bottom, at the end of the line"
            case .topStart: "Top, at the start of the line"
            case .topEnd: "Top, at the end of the line"
            }
        }

        /// The rectangle in points from the page's top-left as it is shown,
        /// `[x0, y0, x1, y1]` — what `signatures.sign` takes.
        ///
        /// `rightToLeft` decides which side "the start of the line" is, so an
        /// Arabic document signs on the right.
        func rect(onPageOf size: CGSize, rightToLeft: Bool) -> [Double] {
            let width = min(210, size.width * 0.45)
            let height = min(70, size.height * 0.12)
            let margin = min(36, size.width * 0.06)
            let atStart = (self == .bottomStart || self == .topStart)
            // The start of an Arabic line is the right-hand side.
            let onTheRight = atStart == rightToLeft
            let x0 = onTheRight ? size.width - margin - width : margin
            let y0 = (self == .topStart || self == .topEnd) ? margin : size.height - margin - height
            return [x0, y0, x0 + width, y0 + height]
        }
    }

    /// Everything a signature needs, gathered from the form so that signing
    /// itself has no interface in it.
    struct Request: Sendable {
        var p12: Data
        var p12Password: String
        var visible = true
        var page = 0
        var position = Position.bottomStart
        /// An empty signature field in the document to sign into. When set,
        /// the field decides where the signature is drawn.
        var field: String?
        /// The signer's name as the certificate gives it — not anything typed.
        var signerName = ""
        var reason = ""
        var location = ""
        var contact = ""
        /// `nil` for an approval signature; 1, 2 or 3 for a certification.
        var certify: Int?
        var lockFields = false
        var pss = false
    }

    /// What a certificate file holds. `E_P12_PASSWORD` for a wrong password.
    static func identity(in p12: Data, password: String, now: Date = Date()) async throws -> Identity {
        struct Args: Encodable {
            let p12Password: String
            let now: Int
        }
        let reply = try await Core.callStatic(
            op: "signatures.identity",
            args: Args(p12Password: password, now: Int(now.timeIntervalSince1970)),
            blobs: [p12]
        )
        return try reply.decode(Identity.self)
    }

    /// The document signed, taken into `model` as the open document. Nothing
    /// is written to the file until the person saves.
    ///
    /// On the main actor because the open document is: the heavy work is
    /// `Core.callStatic`, which hops to a task of its own.
    @MainActor
    static func sign(
        _ request: Request,
        on model: DocumentModel,
        undoManager: UndoManager?,
        now: Date = Date()
    ) async throws {
        guard let font = AppFonts.arabic else {
            throw CoreError.font("the bundled font is missing")
        }
        let size = await pageSize(of: model, page: request.page)
        // A visible signature goes where the form said; one placed into an
        // existing field takes the field's own rectangle, so no rect is sent.
        let rect = (request.visible && request.field == nil)
            ? request.position.rect(onPageOf: size, rightToLeft: model.isRightToLeft)
            : nil

        struct Args: Encodable {
            let password: String?
            let p12Password: String
            let field: String?
            let page: Int
            let rect: [Double]?
            let lines: [String]
            let reason: String?
            let location: String?
            let contact: String?
            let time: Int
            let offsetMinutes: Int
            let certify: Int?
            let lockFields: Bool
            let pss: Bool
            /// Never true on this device: a timestamp needs the network.
            let timestamp = false
        }
        let args = Args(
            password: model.password,
            p12Password: request.p12Password,
            field: request.field,
            page: request.page,
            rect: rect,
            lines: appearanceLines(request, now: now),
            reason: request.reason.isEmpty ? nil : request.reason,
            location: request.location.isEmpty ? nil : request.location,
            contact: request.contact.isEmpty ? nil : request.contact,
            time: Int(now.timeIntervalSince1970),
            offsetMinutes: TimeZone.current.secondsFromGMT(for: now) / 60,
            certify: request.certify,
            lockFields: request.lockFields,
            pss: request.pss
        )
        let reply = try await Core.callStatic(
            op: "signatures.sign",
            args: args,
            blobs: [model.bytes, request.p12, font]
        )
        guard reply.object["done"] as? Bool == true, let bytes = reply.blobs.first else {
            // `done: false` means the core prepared a signature for a
            // timestamp, which is never asked for here.
            throw CoreError.badReply("signatures.sign answered no signed file")
        }
        try await model.replace(bytes: bytes, undoManager: undoManager)
    }

    /// The text drawn in a visible signature: at most four lines, in the
    /// interface's language.
    ///
    /// These are bytes that get signed, so they are composed here rather than
    /// laid out by the drawing code. The date carries a leading U+200E LEFT-TO
    /// RIGHT MARK: in an Arabic line the digits would otherwise take the
    /// line's direction — the date split in three and the zone's sign drawn
    /// after it — and the appearance is signed as drawn.
    static func appearanceLines(_ request: Request, now: Date) -> [String] {
        var lines = [
            String(localized: "Digitally signed by \(request.signerName)"),
            String(localized: "Date: \(stamp(now))"),
        ]
        if !request.reason.isEmpty {
            lines.append(String(localized: "Reason: \(request.reason)"))
        }
        if !request.location.isEmpty {
            lines.append(String(localized: "Location: \(request.location)"))
        }
        return lines
    }

    /// `YYYY-MM-DD HH:MM ±HH:MM`, after a left-to-right mark.
    static func stamp(_ when: Date) -> String {
        let parts = Calendar(identifier: .gregorian).dateComponents(
            [.year, .month, .day, .hour, .minute], from: when
        )
        let offset = TimeZone.current.secondsFromGMT(for: when) / 60
        let sign = offset < 0 ? "-" : "+"
        let pad = { (n: Int) in String(format: "%02d", n) }
        let zone = "\(sign)\(pad(abs(offset) / 60)):\(pad(abs(offset) % 60))"
        return "\u{200E}\(parts.year ?? 0)-\(pad(parts.month ?? 1))-\(pad(parts.day ?? 1)) "
            + "\(pad(parts.hour ?? 0)):\(pad(parts.minute ?? 0)) \(zone)"
    }

    /// The sentence to show for a failure. The core's codes arrive as
    /// `CoreError.sign(code:message:)`; anything else is shown as it came.
    static func message(for error: any Error) -> String {
        guard let error = error as? CoreError else { return error.localizedDescription }
        switch error.code {
        case "E_P12_PASSWORD":
            return String(localized: "That is not the certificate's password.")
        case "E_P12":
            return String(localized: "This file could not be read as a certificate.")
        case "E_SIGN_CERTIFY_FIRST":
            return String(localized: "Only the first signature in a file can certify it.")
        case "E_SIGN_CERTIFIED":
            return String(localized: "This document is certified so that no changes are allowed.")
        case "E_SIGNED_TOO_LARGE":
            return String(localized: "This file is too large to sign on this device.")
        default:
            return error.message
        }
    }

    /// The page's size in points as it is shown. A page the core cannot
    /// measure falls back to A4, so a signature is still placed somewhere
    /// sensible rather than at (0, 0).
    @MainActor
    private static func pageSize(of model: DocumentModel, page: Int) async -> CGSize {
        guard let core = await model.readyEngine(), let size = try? await core.pageSize(page) else {
            return CGSize(width: 595, height: 842)
        }
        return CGSize(width: Double(size.width), height: Double(size.height))
    }
}
