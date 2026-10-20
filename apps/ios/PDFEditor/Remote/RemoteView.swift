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
struct RemoteView: View {
    @Environment(\.dismiss) private var dismiss
    /// The last computer's address, without its key: paired phones need no code.
    @AppStorage("remote.lastAddress") private var lastAddress = ""
    @State private var address: URL?
    @State private var scanning = false
    @State private var problem: LocalizedStringKey?

    var body: some View {
        NavigationStack {
            Group {
                if let address {
                    RemoteWebView(url: address)
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
        }
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
        address = url
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

/// The computer's remote page. Links that would leave it open in Safari.
struct RemoteWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = UIColor(red: 4 / 255, green: 30 / 255, blue: 66 / 255, alpha: 1)
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.load(URLRequest(url: url))
        context.coordinator.loaded = url
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        // A new code scanned: open it.
        if context.coordinator.loaded != url {
            context.coordinator.loaded = url
            view.load(URLRequest(url: url))
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var loaded: URL?

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let target = action.request.url else { return .cancel }
            if RemoteAddress.isLocal(target) || ["blob", "data", "about"].contains(target.scheme ?? "") {
                return .allow
            }
            UIApplication.shared.open(target)
            return .cancel
        }
    }
}
