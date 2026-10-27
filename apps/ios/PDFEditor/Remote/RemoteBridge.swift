import CryptoKit
import Foundation
import UIKit
import WebKit

/// What the app does for the computer's remote page that a page on the local
/// network cannot do by itself (`packages/ui/src/remote/phone/native.ts`):
///
/// - `copy`: what the computer copied goes on the iPhone's clipboard at once;
/// - `paste`: "Paste on the computer" takes what the iPhone copied in one tap;
/// - `paired`: the pairing is kept in the Keychain by the computer's name, so
///   the app can bring it to the page when the computer's address changes;
/// - `lost`: the page can't reach the computer, so the app looks for it on
///   the Wi-Fi by its name (`RemoteFinder`).
///
/// Only the main frame of a page on the local network is heard.
@MainActor
final class RemoteBridge: NSObject, WKScriptMessageHandler {
    static let name = "zood"

    weak var webView: WKWebView?
    var onPaired: (String) -> Void = { _ in }
    var onLost: () -> Void = {}
    private let pairings: RemotePairings

    init(pairings: RemotePairings = RemotePairings()) {
        self.pairings = pairings
    }

    /// The script the page finds before it runs: the app is here, and, when
    /// the computer turned up at a new address, the pairing for that address
    /// alone (the page keeps its pairing per address).
    static func script(bringing pairing: RemotePairings.Pairing?, to host: String?) -> WKUserScript {
        var source = "window.zoodApp = { version: 1 };"
        if let pairing, let host,
           let value = try? String(decoding: JSONEncoder().encode(pairing), as: UTF8.self),
           let quotedValue = quoted(value), let quotedHost = quoted(host) {
            source += """

            try {
              if (location.host === \(quotedHost) && !localStorage.getItem('zood.remote.pairing')) {
                localStorage.setItem('zood.remote.pairing', \(quotedValue));
              }
            } catch (e) {}
            """
        }
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    /// `text` as a JavaScript string literal.
    private static func quoted(_ text: String) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: [text]),
              let array = String(data: data, encoding: .utf8) else { return nil }
        return String(array.dropFirst().dropLast())
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              Self.isRemote(message.frameInfo.securityOrigin),
              let body = message.body as? [String: Any],
              let kind = body["kind"] as? String
        else { return }
        let id = body["id"] as? Int
        switch kind {
        case "copy":
            answer(id, Self.copy(body))
        case "paste":
            answer(id, Self.paste())
        case "paired":
            guard let pc = body["pc"] as? String, let pairing = RemotePairings.Pairing(body) else { return }
            pairings.keep(pairing, for: pc)
            onPaired(pc)
        case "lost":
            onLost()
        default:
            break
        }
    }

    private static func isRemote(_ origin: WKSecurityOrigin) -> Bool {
        guard origin.protocol == "http", let url = URL(string: "http://\(origin.host):\(origin.port)/") else { return false }
        return RemoteAddress.isLocal(url)
    }

    private func answer(_ id: Int?, _ value: Any) {
        guard let id, let webView else { return }
        webView.callAsyncJavaScript(
            "window.zoodApp && window.zoodApp.answer && window.zoodApp.answer(id, value)",
            arguments: ["id": id, "value": value],
            in: nil,
            in: .page,
            completionHandler: nil
        )
    }

    /// The biggest picture handed either way (base64 makes it a third larger).
    private static let biggestPicture = 20 * 1024 * 1024

    private static func copy(_ body: [String: Any]) -> Bool {
        if let text = body["text"] as? String {
            UIPasteboard.general.string = text
            return true
        }
        if let png = body["png"] as? String, png.count <= biggestPicture * 4 / 3 + 4,
           let data = Data(base64Encoded: png), let image = UIImage(data: data) {
            UIPasteboard.general.image = image
            return true
        }
        return false
    }

    /// iOS asks once whether ZOOD may paste; the person just tapped Paste.
    private static func paste() -> [String: Any] {
        let board = UIPasteboard.general
        if board.hasStrings, let text = board.string, !text.isEmpty {
            return ["text": text]
        }
        if board.hasImages, let png = board.image?.pngData(), png.count <= biggestPicture {
            return ["png": png.base64EncodedString()]
        }
        return ["none": true]
    }
}

/// Each computer's pairing with this iPhone, in the Keychain by the
/// computer's name. Only this device: a backup does not carry it.
struct RemotePairings: Sendable {
    struct Pairing: Codable, Equatable, Sendable {
        let device: String
        let key: String

        /// The key's 32 bytes, or nil when it is not one.
        var keyBytes: Data? {
            guard let data = Data(base64Encoded: key), data.count == 32 else { return nil }
            return data
        }

        init(device: String, key: String) {
            self.device = device
            self.key = key
        }

        /// From the page's message, when it is a real pairing.
        init?(_ body: [String: Any]) {
            guard let device = body["device"] as? String, let key = body["key"] as? String,
                  (1...64).contains(device.count), device.allSatisfy(\.isHexDigit)
            else { return nil }
            self.init(device: device, key: key)
            if keyBytes == nil { return nil }
        }
    }

    private let keychain: SignatureKeychain

    init(service: String = "app.warraq.ios.remote") {
        keychain = SignatureKeychain(service: service)
    }

    func pairing(for pc: String) -> Pairing? {
        guard !pc.isEmpty, let data = keychain.read(pc) else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    func keep(_ pairing: Pairing, for pc: String) {
        guard !pc.isEmpty, pc.count <= 100, let data = try? JSONEncoder().encode(pairing) else { return }
        try? keychain.write(data, to: pc)
    }

    func forget(_ pc: String) {
        keychain.delete(pc)
    }
}

/// The tag the computer's announcement carries for each paired phone
/// (`seal::here_tag` in apps/desktop/src-tauri/src/remote/seal.rs): only a
/// holder of the phone's key can make it for that address, so a device that
/// merely uses the computer's name is never handed the pairing.
enum RemoteTag {
    static func make(key: Data, address: String) -> [UInt8] {
        var hash = SHA256()
        hash.update(data: Data("zood-remote/1 here".utf8))
        hash.update(data: key)
        hash.update(data: Data(address.utf8))
        return Array(hash.finalize().prefix(8))
    }

    /// The announcement's `seen` (tags one after the other, URL-safe base64)
    /// holds this key's tag for `address`.
    static func seen(_ text: String, key: Data, address: String) -> Bool {
        var padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded += "=" }
        guard text.count <= 200, let data = Data(base64Encoded: padded) else { return false }
        let bytes = [UInt8](data)
        let tag = make(key: key, address: address)
        return stride(from: 0, to: bytes.count - 7, by: 8).contains { Array(bytes[$0..<($0 + 8)]) == tag }
    }
}
