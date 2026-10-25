import Foundation
import Observation

extension Notification.Name {
    /// A document was written over its file (`DocumentModel.save`); the
    /// object is the file's URL.
    static let zoodDocumentSaved = Notification.Name("app.warraq.ios.documentSaved")
}

/// The cloud files opened on this iPhone: each one's copy here, and the
/// drive file and version it came from, so a save goes back to the drive —
/// over that version only. When someone changed the file in the cloud in
/// the meantime, nothing is overwritten: the iPhone's version is saved
/// beside it as a copy.
@MainActor @Observable
final class CloudCenter {
    static let shared = CloudCenter()

    struct Link: Codable, Hashable {
        let provider: CloudProvider
        var saved: CloudSaved
    }

    enum Status: Equatable {
        case idle
        case saving(String)
        case saved(String)
        case failed(String)
    }

    /// Path of the copy here → where it came from.
    private(set) var links: [String: Link] = [:]
    private(set) var status: Status = .idle
    /// The accounts signed in, by provider, with the e-mail shown.
    private(set) var accounts: [CloudProvider: String] = [:]

    private let storeURL: URL
    private var observer: (any NSObjectProtocol)?

    init() {
        storeURL = Self.root.appending(path: "links.json")
        if let data = try? Data(contentsOf: storeURL), let saved = try? JSONDecoder().decode([String: Link].self, from: data) {
            links = saved
        }
        accounts = (try? JSONDecoder().decode([CloudProvider: String].self, from: Data(contentsOf: Self.root.appending(path: "accounts.json")))) ?? [:]
        for provider in CloudProvider.allCases where !CloudAuth.isSignedIn(provider) {
            accounts[provider] = nil
        }
        observer = NotificationCenter.default.addObserver(forName: .zoodDocumentSaved, object: nil, queue: .main) { note in
            guard let url = note.object as? URL else { return }
            MainActor.assumeIsolated { CloudCenter.shared.saved(url) }
        }
    }

    /// Where the cloud copies live: Application Support, out of iCloud backups.
    static var root: URL {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        let url = base.appending(path: "Cloud", directoryHint: .isDirectory)
        if !FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var copy = url
            try? copy.setResourceValues(values)
        }
        return url
    }

    func signedIn(_ provider: CloudProvider, as email: String) {
        accounts[provider] = email
        persistAccounts()
    }

    func signOut(_ provider: CloudProvider) {
        CloudAuth.signOut(provider)
        accounts[provider] = nil
        persistAccounts()
    }

    private func persistAccounts() {
        if let data = try? JSONEncoder().encode(accounts) {
            try? data.write(to: Self.root.appending(path: "accounts.json"), options: .atomic)
        }
    }

    /// Fetches a drive's PDF into its copy here and answers the copy.
    func fetch(_ entry: CloudEntry, from provider: CloudProvider) async throws -> URL {
        let (saved, bytes) = try await CloudDrives.drive(provider).open(entry.key)
        let folder = Self.root.appending(path: provider.rawValue, directoryHint: .isDirectory)
            .appending(path: PKCE.base64url(Data(entry.key.utf8)).prefix(60).description, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = saved.name.lowercased().hasSuffix(".pdf") ? saved.name : saved.name + ".pdf"
        let file = folder.appending(path: name.replacingOccurrences(of: "/", with: "-"))
        try bytes.write(to: file, options: .atomic)
        links[file.standardizedFileURL.path] = Link(provider: provider, saved: saved)
        persist()
        return file
    }

    func link(for url: URL?) -> Link? {
        guard let url else { return nil }
        return links[url.standardizedFileURL.path]
    }

    /// A copy here was saved: it goes back to its drive.
    private func saved(_ url: URL) {
        guard let link = link(for: url) else { return }
        Task { await upload(url, link: link) }
    }

    func upload(_ url: URL, link: Link) async {
        guard let bytes = try? Data(contentsOf: url) else { return }
        let drive = CloudDrives.drive(link.provider)
        status = .saving(link.provider.title)
        do {
            let saved = try await drive.saveRevision(link.saved.key, bytes: bytes, expected: link.saved.version)
            links[url.standardizedFileURL.path] = Link(provider: link.provider, saved: saved)
            persist()
            status = .saved(String(localized: "Saved to \(link.provider.title)"))
        } catch CloudError.conflict {
            // Never over someone else's change: the iPhone's version goes beside it.
            let base = link.saved.name.replacingOccurrences(of: ".pdf", with: "", options: [.caseInsensitive, .backwards])
            let copyName = String(localized: "\(base) (from iPhone).pdf")
            if let saved = try? await drive.saveNew(folder: link.saved.parentKey, name: copyName, bytes: bytes) {
                links[url.standardizedFileURL.path] = Link(provider: link.provider, saved: saved)
                persist()
                status = .failed(CloudError.conflict.localizedDescription)
            } else {
                status = .failed(CloudError.conflict.localizedDescription)
            }
        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    /// Saves a file of the iPhone's as a new file in a drive's folder.
    func saveCopy(_ url: URL, to provider: CloudProvider, folder: String?) async throws {
        let bytes = try Data(contentsOf: url)
        status = .saving(provider.title)
        do {
            _ = try await CloudDrives.drive(provider).saveNew(folder: folder, name: url.lastPathComponent, bytes: bytes)
            status = .saved(String(localized: "Saved to \(provider.title)"))
        } catch {
            status = .failed(error.localizedDescription)
            throw error
        }
    }

    func clearStatus() {
        if case .saving = status { return }
        status = .idle
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(links) {
            try? data.write(to: storeURL, options: .atomic)
        }
    }
}
