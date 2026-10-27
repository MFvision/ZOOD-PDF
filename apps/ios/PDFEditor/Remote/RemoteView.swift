import SwiftUI
import VisionKit
import WebKit

/// The phone remote for ZOOD PDF on a computer, from inside the app. The
/// computer's app shows a QR code (Phone remote, in its toolbar); this
/// screen scans it and opens the remote the computer serves, the same page a
/// phone's browser would. Everything stays on the local network, sealed with
/// the key in the code (apps/desktop/src-tauri/src/remote/).
///
/// The page keeps its pairing in the web view's own storage, so the next
/// time the remote opens straight on the computer it was paired with.
///
/// A file the computer sends is saved by the page as a download; a web view
/// does nothing with one by itself, so it is taken here: a PDF goes to
/// `onPDF` (the Library keeps and opens it), anything else to the share sheet.
///
/// Inside the app the page can also reach the iPhone's clipboard and keep its
/// pairing in the Keychain (`RemoteBridge`). When the computer can't be
/// reached where it was, the app looks for it on the Wi-Fi by its name
/// (`RemoteFinder`) and opens it at its new address with the same pairing.
struct RemoteView: View {
    var onPDF: (URL) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    /// The last computer's address, without its key: paired phones need no code.
    @AppStorage("remote.lastAddress") private var lastAddress = ""
    /// The computer paired last, by the name it gives (its pairing is in the
    /// Keychain, `RemotePairings`).
    @AppStorage("remote.lastPC") private var lastPC = ""
    @State private var address: URL?
    /// The pairing handed to the page at `address`, when it was found there.
    @State private var bringing: RemotePairings.Pairing?
    @State private var finder = RemoteFinder()
    /// Where the finder last saw the computer.
    @State private var seenAt: URL?
    /// The page can't reach the computer where it is.
    @State private var lost = false
    @State private var scanning = false
    @State private var problem: LocalizedStringKey?
    @State private var received: ReceivedFile?

    var body: some View {
        NavigationStack {
            Group {
                if let address {
                    RemoteWebView(
                        url: address,
                        bringing: bringing,
                        onFile: { file in
                            if file.pathExtension.lowercased() == "pdf" {
                                onPDF(file)
                            } else {
                                received = ReceivedFile(url: file)
                            }
                        },
                        onPaired: { pc in
                            lastPC = pc
                            look()
                        },
                        onLost: {
                            lost = true
                            moveIfFound()
                        }
                    )
                    .ignoresSafeArea(edges: .bottom)
                } else {
                    start
                }
            }
            .navigationTitle("Phone remote")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                if address != nil {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Scan a new code", systemImage: "qrcode.viewfinder") {
                            scanning = true
                        }
                    }
                }
            }
        }
        .sheet(item: $received) { file in
            ReceivedSheet(file: file)
                .presentationDetents([.medium])
        }
        .sheet(isPresented: $scanning) {
            RemoteScanner { text in
                scanning = false
                take(text)
            }
            .ignoresSafeArea()
        }
        .onAppear {
            if address == nil, let saved = URL(string: lastAddress), RemoteAddress.isLocal(saved) {
                address = saved
            }
            look()
        }
        .onDisappear { finder.stop() }
    }

    private var start: some View {
        VStack(spacing: 20) {
            Image(systemName: "iphone.radiowaves.left.and.right")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("Control ZOOD PDF on your computer")
                .font(.title3.bold())
                .multilineTextAlignment(.center)
            Text("On the computer, open ZOOD PDF and choose Phone remote in the toolbar. Then scan the QR code it shows. Your phone and computer need to be on the same Wi-Fi.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            if let problem {
                Text(problem)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Button {
                scanning = true
            } label: {
                Label("Scan the QR code", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!RemoteScanner.available)
            if !RemoteScanner.available {
                Text("This device can’t scan codes. Scan the code with the Camera app instead.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(24)
        .frame(maxWidth: 480)
    }

    private func take(_ text: String) {
        guard let url = RemoteAddress.parse(text) else {
            problem = "That code isn’t a ZOOD PDF remote code. Scan the code from Phone remote on your computer."
            return
        }
        problem = nil
        lastAddress = RemoteAddress.withoutKey(url).absoluteString
        bringing = nil
        lost = false
        address = url
    }

    /// Looks for the computer paired last, if there is one.
    private func look() {
        guard let pairing = RemotePairings().pairing(for: lastPC) else { return }
        finder.look(for: lastPC, pairing: pairing) { url in
            seenAt = url
            moveIfFound()
        }
    }

    /// Opens the computer where the finder saw it, when the page can't reach
    /// it where it is (or there is no page yet). The same address is left
    /// alone: the computer's remote is only off for now.
    private func moveIfFound() {
        guard let seenAt, address == nil || lost,
              address.map(RemoteAddress.withoutKey) != seenAt,
              let pairing = RemotePairings().pairing(for: lastPC)
        else { return }
        lost = false
        bringing = pairing
        lastAddress = seenAt.absoluteString
        address = seenAt
    }
}

/// What a remote QR code may hold: the computer's page on the local network,
/// `http://<private address>:<port>/#k=<key>`. Anything else is turned away,
/// so a code stuck over the real one can't open some other site.
enum RemoteAddress {
    static func parse(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              isLocal(url),
              let fragment = url.fragment,
              fragment.range(of: #"(^|&)k=[A-Za-z0-9_-]{43}($|&)"#, options: .regularExpression) != nil
        else { return nil }
        return url
    }

    /// A page on this network: plain http to a private IPv4 address, with a port.
    static func isLocal(_ url: URL) -> Bool {
        guard url.scheme == "http", url.port != nil, let host = url.host(), url.user == nil else { return false }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false).compactMap { UInt8($0) }
        guard parts.count == 4 else { return false }
        switch (parts[0], parts[1]) {
        case (10, _), (192, 168), (169, 254): return true
        case (172, let second): return (16...31).contains(second)
        default: return false
        }
    }

    static func withoutKey(_ url: URL) -> URL {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        parts?.fragment = nil
        return parts?.url ?? url
    }
}

/// The QR code scanner: VisionKit's live scanner, QR codes only.
struct RemoteScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    @MainActor static var available: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .fast,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        private var done = false

        init(found: @escaping (String) -> Void) { self.found = found }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for item in items {
                if case .barcode(let code) = item, let text = code.payloadStringValue {
                    done = true
                    scanner.stopScanning()
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    found(text)
                    return
                }
            }
        }
    }
}

/// A file the computer sent that is not a PDF, to keep with the share sheet.
struct ReceivedFile: Identifiable {
    let url: URL
    var id: URL { url }
}

private struct ReceivedSheet: View {
    let file: ReceivedFile

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "arrow.down.doc")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
            Text(file.url.lastPathComponent)
                .font(.headline)
                .multilineTextAlignment(.center)
            ShareLink(item: file.url) {
                Label("Save or share", systemImage: "square.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(24)
    }
}

/// The computer's remote page. Links that would leave it open in Safari;
/// a file the page saves (one sent from the computer) lands in `onFile`.
/// A page that can't be loaded at all tells `onLost`.
struct RemoteWebView: UIViewRepresentable {
    let url: URL
    /// The pairing the page at `url` is given, when it was found there.
    var bringing: RemotePairings.Pairing?
    var onFile: (URL) -> Void = { _ in }
    var onPaired: (String) -> Void = { _ in }
    var onLost: () -> Void = {}

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let bridge = context.coordinator.bridge
        configuration.userContentController.add(bridge, name: RemoteBridge.name)
        configuration.userContentController.addUserScript(RemoteBridge.script(bringing: bringing, to: Self.host(url)))
        let view = WKWebView(frame: .zero, configuration: configuration)
        bridge.webView = view
        bridge.onPaired = onPaired
        bridge.onLost = onLost
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = UIColor(red: 4 / 255, green: 30 / 255, blue: 66 / 255, alpha: 1)
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.load(URLRequest(url: url))
        context.coordinator.loaded = url
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onFile = onFile
        coordinator.onLost = onLost
        coordinator.bridge.onPaired = onPaired
        coordinator.bridge.onLost = onLost
        // A new code scanned, or the computer found somewhere new: open it.
        if coordinator.loaded != url {
            coordinator.loaded = url
            let scripts = view.configuration.userContentController
            scripts.removeAllUserScripts()
            scripts.addUserScript(RemoteBridge.script(bringing: bringing, to: Self.host(url)))
            view.load(URLRequest(url: url))
        }
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: RemoteBridge.name)
    }

    /// `address:port`, as the page's `location.host` says it.
    private static func host(_ url: URL) -> String? {
        guard let host = url.host(), let port = url.port else { return nil }
        return "\(host):\(port)"
    }

    func makeCoordinator() -> Coordinator { Coordinator(onFile: onFile, onLost: onLost) }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKDownloadDelegate {
        var loaded: URL?
        var onFile: (URL) -> Void
        var onLost: () -> Void
        let bridge = RemoteBridge()
        /// Where each download is being written, until it finishes.
        private var destinations: [ObjectIdentifier: URL] = [:]

        init(onFile: @escaping (URL) -> Void, onLost: @escaping () -> Void) {
            self.onFile = onFile
            self.onLost = onLost
        }

        /// Nothing answered at the address: the computer may be somewhere new.
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            if (error as NSError).code != NSURLErrorCancelled { onLost() }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let target = action.request.url else { return .cancel }
            if action.shouldPerformDownload { return .download }
            if RemoteAddress.isLocal(target) || ["blob", "data", "about"].contains(target.scheme ?? "") {
                return .allow
            }
            await UIApplication.shared.open(target)
            return .cancel
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            response.canShowMIMEType ? .allow : .download
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
            // A folder of its own per file, so the name stays the sender's.
            let folder = FileManager.default.temporaryDirectory
                .appending(path: "remote-received", directoryHint: .isDirectory)
                .appending(path: UUID().uuidString, directoryHint: .isDirectory)
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let name = (suggestedFilename as NSString).lastPathComponent
            let destination = folder.appending(path: name.isEmpty ? "file" : name)
            destinations[ObjectIdentifier(download)] = destination
            return destination
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let destination = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
            onFile(destination)
        }

        func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
            destinations.removeValue(forKey: ObjectIdentifier(download))
        }
    }
}
