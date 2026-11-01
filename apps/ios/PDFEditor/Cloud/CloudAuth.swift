import CryptoKit
import Foundation
import Network

// Signing in to OneDrive and Google Drive the way the desktop app does
// (packages/ui/src/cloud, apps/desktop/src-tauri/src/cloud.rs): the person
// signs in on the provider's own page — never in a form of ZOOD's — in the
// system's web sign-in sheet; the provider sends the browser back to
// http://127.0.0.1:<port>/callback, which a listener inside the app answers
// for exactly one request carrying this sign-in's state; the code is redeemed
// with the PKCE verifier only this sign-in knows (RFC 8252, RFC 7636).
//
// The same registered apps as the desktop: Microsoft Entra app
// 4c561684-… (public client, loopback redirects) and Google's Desktop
// client 808968607590-…, with drive.file only, so ZOOD sees only the files
// the person picks in Google's picker or saves from ZOOD. Google's token
// endpoint wants that Desktop client's secret (docs/cloud.md says why it is
// not one); it is put into the build from the environment
// (WARRAQ_GOOGLE_CLIENT_SECRET → Info.plist), never into the repository,
// and without it the build offers no Google Drive.

enum CloudProvider: String, CaseIterable, Identifiable, Codable, Sendable {
    case onedrive
    case gdrive

    var id: String { rawValue }

    var title: String {
        switch self {
        case .onedrive: "OneDrive"
        case .gdrive: "Google Drive"
        }
    }

    var symbol: String {
        switch self {
        case .onedrive: "cloud"
        case .gdrive: "externaldrive.connected.to.line.below"
        }
    }

    /// Whether this build can sign in to it.
    var isOffered: Bool { CloudConfig.server(self) != nil }
}

/// The registered apps, as this build has them.
enum CloudConfig {
    static let oneDriveClientID = "4c561684-3bf8-48e7-b4dc-ca1d7c8f9472"
    static let googleClientID = "808968607590-d1urs760af3bgfpgph8rhaaujk5tce50.apps.googleusercontent.com"

    /// Google's Desktop client secret from the build (empty when it was not given).
    static var googleClientSecret: String? {
        let value = (Bundle.main.object(forInfoDictionaryKey: "ZOODGoogleClientSecret") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // An unexpanded "$(…)" is no secret either.
        return value.isEmpty || value.hasPrefix("$(") ? nil : value
    }

    struct Server: Sendable {
        let provider: CloudProvider
        let authorize: URL
        let token: URL
        let clientID: String
        let scope: String
        let extra: [String: String]
        let secret: String?
    }

    static func server(_ provider: CloudProvider) -> Server? {
        switch provider {
        case .onedrive:
            let base = "https://login.microsoftonline.com/common/oauth2/v2.0"
            return Server(provider: .onedrive,
                          authorize: URL(string: "\(base)/authorize")!,
                          token: URL(string: "\(base)/token")!,
                          clientID: oneDriveClientID,
                          scope: "Files.ReadWrite User.Read offline_access",
                          extra: ["response_mode": "query", "prompt": "select_account"],
                          secret: nil)
        case .gdrive:
            guard let secret = googleClientSecret else { return nil }
            return Server(provider: .gdrive,
                          authorize: URL(string: "https://accounts.google.com/o/oauth2/v2/auth")!,
                          token: URL(string: "https://oauth2.googleapis.com/token")!,
                          clientID: googleClientID,
                          scope: "https://www.googleapis.com/auth/drive.file",
                          extra: ["access_type": "offline", "prompt": "consent"],
                          secret: secret)
        }
    }

    /// Microsoft's page for one kind of account. One e-mail address can be
    /// both a personal Microsoft account and a work account, each with its
    /// own OneDrive (owner, 2026-11-01: ZOOD showed his personal OneDrive,
    /// with Personal Vault, not the work one his OneDrive app shows).
    static let oneDriveWork: [String: String] = ["domain_hint": "organizations"]
    static let oneDrivePersonal: [String: String] = ["domain_hint": "consumers"]

    /// Google's picker inside its consent screen: PDFs and folders to open.
    static let googlePicker: [String: String] = [
        "trigger_onepick": "true",
        "allow_multiple": "true",
        "allow_folder_selection": "true",
        "mimetypes": "application/pdf,application/vnd.google-apps.folder",
    ]
}

enum CloudError: Error, LocalizedError, Equatable {
    case cancelled
    case denied
    case timeout
    case notSignedIn
    case notFound
    case conflict
    case offline
    case server(String)

    var errorDescription: String? {
        switch self {
        case .cancelled: String(localized: "Sign-in was cancelled.")
        case .denied: String(localized: "The account did not allow ZOOD to reach its files.")
        case .timeout: String(localized: "Sign-in took too long. Try again.")
        case .notSignedIn: String(localized: "Sign in again to reach these files.")
        case .notFound: String(localized: "That file is no longer there.")
        case .conflict: String(localized: "Someone changed this file in the cloud since you opened it. Your version was saved as a copy beside it.")
        case .offline: String(localized: "No connection. Check the internet and try again.")
        case let .server(message): String(localized: "The cloud drive answered with a problem: \(message)")
        }
    }
}

/// PKCE's verifier and challenge (S256), and a state.
struct PKCE: Sendable {
    let verifier: String
    let challenge: String
    let state: String

    init() {
        verifier = Self.random(48)
        challenge = Self.base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
        state = Self.random(24)
    }

    static func random(_ count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return base64url(Data(bytes))
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// One answer on 127.0.0.1: the first request to /callback carrying this
/// sign-in's state. The browser is then sent on to `zoodsignin://done`,
/// which closes the sign-in sheet.
final class LoopbackListener: @unchecked Sendable {
    static let doneScheme = "zoodsignin"

    private let listener: NWListener
    private let queue = DispatchQueue(label: "app.warraq.ios.signin")
    private let lock = NSLock()
    private var answer: [String: String]?
    private var waiters: [CheckedContinuation<[String: String], any Error>] = []
    private var finished = false
    private let state: String

    init(state: String) throws {
        self.state = state
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        parameters.allowLocalEndpointReuse = true
        listener = try NWListener(using: parameters)
    }

    /// Starts listening and answers the port.
    func start() async throws -> UInt16 {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, any Error>) in
            let once = OnceFlag()
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    if once.take(), let port = self?.listener.port?.rawValue { continuation.resume(returning: port) }
                case let .failed(error):
                    if once.take() { continuation.resume(throwing: error) }
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                self?.serve(connection)
            }
            listener.start(queue: queue)
        }
    }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, _, _ in
            guard let self else { connection.cancel(); return }
            let request = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let firstLine = request.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
            let parts = firstLine.split(separator: " ")
            var params: [String: String] = [:]
            if parts.count >= 2, parts[0] == "GET", let url = URLComponents(string: "http://127.0.0.1" + parts[1]), url.path == "/callback" {
                for item in url.queryItems ?? [] { params[item.name] = item.value ?? "" }
            }
            let ours = params["state"] == self.state
            let response: String
            if ours {
                response = "HTTP/1.1 302 Found\r\nLocation: \(Self.doneScheme)://done\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            } else {
                response = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            }
            connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
            if ours { self.finish(.success(params)) }
        }
    }

    private func finish(_ result: Result<[String: String], any Error>) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        if case let .success(params) = result { answer = params }
        let waiting = waiters
        waiters = []
        lock.unlock()
        for waiter in waiting { waiter.resume(with: result) }
        listener.cancel()
    }

    /// The answer, once it has come (or right away when it already has).
    func wait() async throws -> [String: String] {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let answer {
                lock.unlock()
                continuation.resume(returning: answer)
            } else if finished {
                lock.unlock()
                continuation.resume(throwing: CloudError.cancelled)
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }

    func cancel() {
        finish(.failure(CloudError.cancelled))
    }
}

private final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var taken = false
    func take() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if taken { return false }
        taken = true
        return true
    }
}

/// Tokens for one account.
struct CloudTokens: Codable, Sendable {
    var access: String
    var refresh: String?
    var expires: Date
}

/// The OAuth half: sign in, redeem, refresh, forget. Refresh tokens are kept
/// in the Keychain (this device only); access tokens only in memory.
@MainActor
enum CloudAuth {
    private static let keychain = SignatureKeychain(service: "app.warraq.ios.cloud")

    /// Signs in through `authenticate` (the system's web sign-in sheet,
    /// which returns once the browser reaches `zoodsignin://done`). Answers
    /// the tokens and every parameter the redirect carried (Google's
    /// picker sends `picked_file_ids`).
    static func signIn(
        _ provider: CloudProvider,
        extra: [String: String] = [:],
        authenticate: (URL) async throws -> URL
    ) async throws -> (tokens: CloudTokens, params: [String: String]) {
        guard let server = CloudConfig.server(provider) else { throw CloudError.server("not offered in this build") }
        let pkce = PKCE()
        let listener = try LoopbackListener(state: pkce.state)
        let port = try await listener.start()
        let redirect = "http://127.0.0.1:\(port)/callback"
        var components = URLComponents(url: server.authorize, resolvingAgainstBaseURL: false)!
        var items: [String: String] = [
            "client_id": server.clientID,
            "response_type": "code",
            "redirect_uri": redirect,
            "scope": server.scope,
            "state": pkce.state,
            "code_challenge": pkce.challenge,
            "code_challenge_method": "S256",
        ]
        items.merge(server.extra) { _, new in new }
        items.merge(extra) { _, new in new }
        components.queryItems = items.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        do {
            _ = try await authenticate(components.url!)
        } catch {
            // The sheet closed: the answer may still have arrived just before.
            listener.cancel()
            throw CloudError.cancelled
        }
        let params = try await listener.wait()
        if let error = params["error"] {
            throw error == "access_denied" ? CloudError.cancelled : CloudError.denied
        }
        guard let code = params["code"], !code.isEmpty else { throw CloudError.denied }
        var form = [
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect,
            "client_id": server.clientID,
            "code_verifier": pkce.verifier,
        ]
        if let secret = server.secret { form["client_secret"] = secret }
        if provider == .onedrive { form["scope"] = server.scope }
        let tokens = try await token(server, form: form, previousRefresh: nil)
        save(tokens, for: provider)
        return (tokens, params)
    }

    private static var memory: [CloudProvider: CloudTokens] = [:]

    /// A valid access token, refreshed when it is (nearly) out of date.
    static func accessToken(_ provider: CloudProvider) async throws -> String {
        let cached = memory[provider]
        if let cached, cached.expires.timeIntervalSinceNow > 60 { return cached.access }
        guard let server = CloudConfig.server(provider),
              let refresh = cached?.refresh ?? storedRefresh(provider) else { throw CloudError.notSignedIn }
        var form = ["grant_type": "refresh_token", "refresh_token": refresh, "client_id": server.clientID]
        if let secret = server.secret { form["client_secret"] = secret }
        if provider == .onedrive { form["scope"] = server.scope }
        let tokens = try await token(server, form: form, previousRefresh: refresh)
        save(tokens, for: provider)
        return tokens.access
    }

    static func isSignedIn(_ provider: CloudProvider) -> Bool {
        storedRefresh(provider) != nil
    }

    static func signOut(_ provider: CloudProvider) {
        keychain.delete(provider.rawValue)
        memory[provider] = nil
    }

    private static func storedRefresh(_ provider: CloudProvider) -> String? {
        keychain.read(provider.rawValue).flatMap { String(data: $0, encoding: .utf8) }
    }

    private static func save(_ tokens: CloudTokens, for provider: CloudProvider) {
        memory[provider] = tokens
        if let refresh = tokens.refresh {
            try? keychain.write(Data(refresh.utf8), to: provider.rawValue)
        }
    }

    private static func token(_ server: CloudConfig.Server, form: [String: String], previousRefresh: String?) async throws -> CloudTokens {
        var request = URLRequest(url: server.token)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(formEncode(form).utf8)
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw CloudError.offline
        }
        struct Answer: Decodable {
            let access_token: String?
            let refresh_token: String?
            let expires_in: Double?
            let error: String?
            let error_description: String?
        }
        let answer = try? JSONDecoder().decode(Answer.self, from: data)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let access = answer?.access_token else {
            if answer?.error == "invalid_grant" {
                signOut(server.provider)
                throw CloudError.notSignedIn
            }
            throw CloudError.server(answer?.error_description ?? answer?.error ?? "HTTP \(status)")
        }
        // Google keeps the refresh token it gave first; Microsoft sends a new one.
        return CloudTokens(access: access, refresh: answer?.refresh_token ?? previousRefresh,
                           expires: Date().addingTimeInterval(answer?.expires_in ?? 3000))
    }

    static func formEncode(_ form: [String: String]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return form.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }
            .joined(separator: "&")
    }
}
