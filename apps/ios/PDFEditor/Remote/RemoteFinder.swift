import Foundation
import Network

/// Finds the computer on the Wi-Fi by its name when its address changed
/// (a new DHCP lease, another network, a restart on another port), so the
/// remote opens again without a new QR code. The computer says where it is
/// only while its remote is on (`remote/announce.rs`); an announcement counts
/// only when it carries this phone's tag (`RemoteTag`).
@MainActor
final class RemoteFinder {
    static let service = "_zoodremote._tcp"

    private var browser: NWBrowser?
    private var found: ((URL) -> Void)?

    /// Looks for `pc` until `stop`; `found` hears each address it is at.
    func look(for pc: String, pairing: RemotePairings.Pairing, found: @escaping (URL) -> Void) {
        stop()
        guard let key = pairing.keyBytes else { return }
        self.found = found
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.service, domain: nil), using: .tcp)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            for result in results {
                guard case .bonjour(let record) = result.metadata,
                      let url = RemoteFinder.verified(record.dictionary, pc: pc, key: key)
                else { continue }
                // The browser runs on the main queue (below).
                MainActor.assumeIsolated { self?.found?(url) }
                return
            }
        }
        browser.start(queue: .main)
        self.browser = browser
    }

    func stop() {
        browser?.cancel()
        browser = nil
        found = nil
    }

    /// The remote's address from an announcement, when it is `pc`'s, on the
    /// local network, and carries this phone's tag for that address.
    nonisolated static func verified(_ record: [String: String], pc: String, key: Data) -> URL? {
        guard record["v"] == "1", record["pc"] == pc,
              let address = record["addr"], let port = record["port"].flatMap({ UInt16($0) }), port > 0,
              let seen = record["seen"],
              RemoteTag.seen(seen, key: key, address: "\(address):\(port)"),
              let url = URL(string: "http://\(address):\(port)/"),
              RemoteAddress.isLocal(url)
        else { return nil }
        return url
    }
}
