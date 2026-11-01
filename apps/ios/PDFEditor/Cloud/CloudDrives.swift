import Foundation

// The two drives' file APIs, as the desktop speaks them
// (packages/ui/src/cloud/onedrive.ts, gdrive.ts): list a folder, search,
// open a PDF, save it back over the version it was opened at (a conflict is
// refused, never overwritten), save a new file.

struct CloudEntry: Identifiable, Hashable, Sendable {
    enum Kind: Sendable { case folder, pdf }
    let key: String
    let name: String
    let kind: Kind
    var size: Int64?
    var modified: Date?
    var id: String { key }
}

struct CloudListing: Sendable {
    var entries: [CloudEntry]
    var next: String?
}

/// A file as it was opened or saved: what a later save is checked against.
struct CloudSaved: Codable, Hashable, Sendable {
    let key: String
    let name: String
    let version: String
    let parentKey: String?
}

protocol CloudDrive: Sendable {
    var provider: CloudProvider { get }
    func account() async throws -> String
    func list(folder: String?, next: String?) async throws -> CloudListing
    func search(_ text: String, next: String?) async throws -> CloudListing
    func open(_ key: String) async throws -> (saved: CloudSaved, bytes: Data)
    func saveRevision(_ key: String, bytes: Data, expected: String?) async throws -> CloudSaved
    func saveNew(folder: String?, name: String, bytes: Data) async throws -> CloudSaved
}

enum CloudDrives {
    static func drive(_ provider: CloudProvider) -> any CloudDrive {
        switch provider {
        case .onedrive: OneDriveClient()
        case .gdrive: GoogleDriveClient()
        }
    }
}

/// One request with the account's token; 401 refreshes once.
struct CloudHTTP: Sendable {
    let provider: CloudProvider

    func send(_ request: URLRequest, authorized: Bool = true) async throws -> (Data, HTTPURLResponse) {
        var request = request
        if authorized {
            request.setValue("Bearer \(try await CloudAuth.accessToken(provider))", forHTTPHeaderField: "Authorization")
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw CloudError.offline
        }
        guard let http = response as? HTTPURLResponse else { throw CloudError.server("no answer") }
        switch http.statusCode {
        case 200...299: return (data, http)
        case 401: throw CloudError.notSignedIn
        case 404: throw CloudError.notFound
        case 409, 412: throw CloudError.conflict
        default:
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { ($0["error"] as? [String: Any])?["message"] as? String }
            throw CloudError.server(message ?? "HTTP \(http.statusCode)")
        }
    }

    func json<T: Decodable>(_ type: T.Type, _ request: URLRequest) async throws -> T {
        let (data, _) = try await send(request)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private func date(_ text: String?) -> Date? {
    guard let text else { return nil }
    let full = ISO8601DateFormatter()
    full.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return full.date(from: text) ?? ISO8601DateFormatter().date(from: text)
}

private func percent(_ text: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text
}

// MARK: - OneDrive (Microsoft Graph)

struct OneDriveClient: CloudDrive {
    let provider = CloudProvider.onedrive
    private var http: CloudHTTP { CloudHTTP(provider: .onedrive) }
    static let graph = "https://graph.microsoft.com/v1.0"
    static let select = "id,name,size,file,folder,package,remoteItem,parentReference,lastModifiedDateTime,eTag"
    /// Upload pieces must be multiples of 320 KiB.
    static let uploadRange = 32 * 320 * 1024

    struct Item: Decodable {
        struct File: Decodable { let mimeType: String? }
        struct Folder: Decodable { let childCount: Int? }
        struct Parent: Decodable { let driveId: String?; let id: String?; let name: String? }
        let id: String
        let name: String
        let eTag: String?
        let size: Int64?
        let lastModifiedDateTime: String?
        let file: File?
        let folder: Folder?
        let parentReference: Parent?
        let downloadUrl: String?
        let remote: Remote?
        let isPackage: Bool

        struct Remote: Decodable {
            let id: String
            let size: Int64?
            let file: File?
            let folder: Folder?
            let parentReference: Parent?
        }

        enum CodingKeys: String, CodingKey {
            case id, name, eTag, size, lastModifiedDateTime, file, folder, parentReference
            case downloadUrl = "@microsoft.graph.downloadUrl"
            case remote = "remoteItem"
            case package
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
            eTag = try c.decodeIfPresent(String.self, forKey: .eTag)
            size = try c.decodeIfPresent(Int64.self, forKey: .size)
            lastModifiedDateTime = try c.decodeIfPresent(String.self, forKey: .lastModifiedDateTime)
            file = try c.decodeIfPresent(File.self, forKey: .file)
            folder = try c.decodeIfPresent(Folder.self, forKey: .folder)
            parentReference = try c.decodeIfPresent(Parent.self, forKey: .parentReference)
            downloadUrl = try c.decodeIfPresent(String.self, forKey: .downloadUrl)
            remote = try c.decodeIfPresent(Remote.self, forKey: .remote)
            isPackage = c.contains(.package)
        }
    }

    /// "<driveId or me>!<itemId>", as the desktop keys them.
    static func key(drive: String?, item: String) -> String { "\(drive ?? "me")!\(item)" }

    static func path(ofKey key: String) -> String? {
        let at = key.hasPrefix("b!") ? key.lastIndex(of: "!") : key.firstIndex(of: "!")
        guard let at, at != key.startIndex, key.index(after: at) != key.endIndex else { return nil }
        let drive = String(key[..<at])
        let item = String(key[key.index(after: at)...])
        return drive == "me" ? "/me/drive/items/\(percent(item))" : "/drives/\(percent(drive))/items/\(percent(item))"
    }

    static func entry(_ item: Item) -> CloudEntry? {
        if item.isPackage { return nil }
        let id = item.remote?.id ?? item.id
        let drive = item.remote?.parentReference?.driveId ?? item.parentReference?.driveId
        let key = key(drive: drive, item: id)
        if item.folder != nil || item.remote?.folder != nil {
            return CloudEntry(key: key, name: item.name, kind: .folder, modified: date(item.lastModifiedDateTime))
        }
        let mime = item.file?.mimeType ?? item.remote?.file?.mimeType
        if (item.file != nil || item.remote?.file != nil), mime == "application/pdf" || item.name.lowercased().hasSuffix(".pdf") {
            return CloudEntry(key: key, name: item.name, kind: .pdf, size: item.remote?.size ?? item.size, modified: date(item.lastModifiedDateTime))
        }
        return nil
    }

    static func saved(_ item: Item, drive fallback: String?) -> CloudSaved {
        let drive = item.parentReference?.driveId ?? fallback
        return CloudSaved(key: key(drive: drive, item: item.id), name: item.name, version: item.eTag ?? "",
                          parentKey: item.parentReference?.id.map { key(drive: drive, item: $0) })
    }

    func account() async throws -> String {
        struct Me: Decodable { let displayName: String?; let mail: String?; let userPrincipalName: String? }
        let me = try await http.json(Me.self, URLRequest(url: URL(string: "\(Self.graph)/me?$select=displayName,mail,userPrincipalName")!))
        return me.mail ?? me.userPrincipalName ?? me.displayName ?? ""
    }

    /// "personal" (a personal Microsoft account's OneDrive) or "business"
    /// (OneDrive for work or school).
    func driveType() async throws -> String {
        struct Drive: Decodable { let driveType: String? }
        let drive = try await http.json(Drive.self, URLRequest(url: URL(string: "\(Self.graph)/me/drive?$select=driveType")!))
        return drive.driveType ?? ""
    }

    private func listing(_ url: URL) async throws -> CloudListing {
        struct Page: Decodable {
            let value: [Item]?
            let next: String?
            enum CodingKeys: String, CodingKey { case value; case next = "@odata.nextLink" }
        }
        let page = try await http.json(Page.self, URLRequest(url: url))
        let next = page.next.flatMap { $0.hasPrefix(Self.graph + "/") ? $0 : nil }
        return CloudListing(entries: (page.value ?? []).compactMap(Self.entry), next: next)
    }

    func list(folder: String?, next: String?) async throws -> CloudListing {
        if let next, let url = URL(string: next) { return try await listing(url) }
        let base = try folder.map { key -> String in
            guard let path = Self.path(ofKey: key) else { throw CloudError.notFound }
            return path
        } ?? "/me/drive/root"
        return try await listing(URL(string: "\(Self.graph)\(base)/children?$select=\(Self.select)&$top=200")!)
    }

    func search(_ text: String, next: String?) async throws -> CloudListing {
        if let next, let url = URL(string: next) { return try await listing(url) }
        let quoted = text.replacingOccurrences(of: "'", with: "''")
        return try await listing(URL(string: "\(Self.graph)/me/drive/root/search(q='\(percent(quoted))')?$select=\(Self.select)&$top=200")!)
    }

    func open(_ key: String) async throws -> (saved: CloudSaved, bytes: Data) {
        guard let path = Self.path(ofKey: key) else { throw CloudError.notFound }
        let item = try await http.json(Item.self, URLRequest(url: URL(string: "\(Self.graph)\(path)")!))
        guard item.file != nil, let download = item.downloadUrl, let url = URL(string: download), url.scheme == "https" else {
            throw CloudError.notFound
        }
        let (bytes, _) = try await http.send(URLRequest(url: url), authorized: false)
        let drive = key.split(separator: "!").first.map(String.init).flatMap { $0 == "me" ? nil : $0 }
        return (Self.saved(item, drive: drive), bytes)
    }

    func saveRevision(_ key: String, bytes: Data, expected: String?) async throws -> CloudSaved {
        guard let path = Self.path(ofKey: key) else { throw CloudError.notFound }
        var request = URLRequest(url: URL(string: "\(Self.graph)\(path)/createUploadSession")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let expected, !expected.isEmpty { request.setValue(expected, forHTTPHeaderField: "If-Match") }
        request.httpBody = Data(#"{"item":{"@microsoft.graph.conflictBehavior":"replace"}}"#.utf8)
        return try await upload(session: request, bytes: bytes)
    }

    func saveNew(folder: String?, name: String, bytes: Data) async throws -> CloudSaved {
        let parent = try folder.map { key -> String in
            guard let path = Self.path(ofKey: key) else { throw CloudError.notFound }
            return path
        } ?? "/me/drive/root"
        let safe = Self.safeName(name)
        var request = URLRequest(url: URL(string: "\(Self.graph)\(parent):/\(percent(safe)):/createUploadSession")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["item": ["@microsoft.graph.conflictBehavior": "rename", "name": safe]]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await upload(session: request, bytes: bytes)
    }

    private func upload(session request: URLRequest, bytes: Data) async throws -> CloudSaved {
        struct Session: Decodable { let uploadUrl: String? }
        let session = try await http.json(Session.self, request)
        guard let address = session.uploadUrl, let url = URL(string: address), url.scheme == "https" else {
            throw CloudError.server("no upload address")
        }
        let total = bytes.count
        guard total > 0 else { throw CloudError.server("nothing to upload") }
        var start = 0
        while start < total {
            let end = min(start + Self.uploadRange, total)
            var put = URLRequest(url: url)
            put.httpMethod = "PUT"
            put.setValue("bytes \(start)-\(end - 1)/\(total)", forHTTPHeaderField: "Content-Range")
            put.httpBody = bytes.subdata(in: start..<end)
            let (data, response) = try await http.send(put, authorized: false)
            if response.statusCode == 202, end < total {
                start = end
                continue
            }
            let item = try JSONDecoder().decode(Item.self, from: data)
            return Self.saved(item, drive: nil)
        }
        throw CloudError.server("the upload never completed")
    }

    /// A name OneDrive takes: no reserved letters, ends in .pdf.
    static func safeName(_ name: String) -> String {
        var cleaned = String(name.unicodeScalars.filter { $0.value >= 0x20 }.map(Character.init))
        for ch in "\"*:<>?/\\|" { cleaned = cleaned.replacingOccurrences(of: String(ch), with: "-") }
        cleaned = cleaned.trimmingCharacters(in: .whitespaces)
        while cleaned.hasSuffix(".") || cleaned.hasSuffix(" ") { cleaned.removeLast() }
        if cleaned.isEmpty { cleaned = "document" }
        return cleaned.lowercased().hasSuffix(".pdf") ? cleaned : cleaned + ".pdf"
    }
}

// MARK: - Google Drive (Drive API v3, drive.file)

struct GoogleDriveClient: CloudDrive {
    let provider = CloudProvider.gdrive
    private var http: CloudHTTP { CloudHTTP(provider: .gdrive) }
    static let drive = "https://www.googleapis.com/drive/v3"
    static let upload = "https://www.googleapis.com/upload/drive/v3"
    static let fields = "id,name,mimeType,size,version,headRevisionId,modifiedTime,parents,trashed"
    static let folderType = "application/vnd.google-apps.folder"

    struct File: Decodable {
        let id: String
        let name: String
        let mimeType: String?
        let size: String?
        let version: String?
        let headRevisionId: String?
        let modifiedTime: String?
        let parents: [String]?
        let trashed: Bool?

        var versionTag: String { headRevisionId ?? version.map { "v\($0)" } ?? "" }
        var saved: CloudSaved { CloudSaved(key: id, name: name, version: versionTag, parentKey: parents?.first) }
    }

    static func checked(_ id: String) throws -> String {
        guard id.range(of: #"^[A-Za-z0-9_-]{10,200}$"#, options: .regularExpression) != nil else { throw CloudError.notFound }
        return id
    }

    static func quoted(_ text: String) -> String {
        "'" + text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'") + "'"
    }

    func account() async throws -> String {
        struct About: Decodable { struct User: Decodable { let displayName: String?; let emailAddress: String? }; let user: User? }
        let about = try await http.json(About.self, URLRequest(url: URL(string: "\(Self.drive)/about?fields=user(displayName,emailAddress)")!))
        return about.user?.emailAddress ?? about.user?.displayName ?? ""
    }

    private func query(_ terms: [String], next: String?) async throws -> CloudListing {
        var components = URLComponents(string: "\(Self.drive)/files")!
        var items = [
            URLQueryItem(name: "q", value: terms.joined(separator: " and ")),
            URLQueryItem(name: "fields", value: "nextPageToken,files(\(Self.fields))"),
            URLQueryItem(name: "orderBy", value: "folder,modifiedTime desc"),
            URLQueryItem(name: "pageSize", value: "100"),
            URLQueryItem(name: "spaces", value: "drive"),
            URLQueryItem(name: "supportsAllDrives", value: "true"),
            URLQueryItem(name: "includeItemsFromAllDrives", value: "true"),
        ]
        if let next { items.append(URLQueryItem(name: "pageToken", value: next)) }
        components.queryItems = items
        struct Page: Decodable { let files: [File]?; let nextPageToken: String? }
        let page = try await http.json(Page.self, URLRequest(url: components.url!))
        let entries = (page.files ?? []).map { file in
            file.mimeType == Self.folderType
                ? CloudEntry(key: file.id, name: file.name, kind: .folder, modified: date(file.modifiedTime))
                : CloudEntry(key: file.id, name: file.name, kind: .pdf, size: file.size.flatMap { Int64($0) }, modified: date(file.modifiedTime))
        }
        return CloudListing(entries: entries, next: page.nextPageToken)
    }

    private var base: [String] { ["(mimeType = 'application/pdf' or mimeType = '\(Self.folderType)')", "trashed = false"] }

    func list(folder: String?, next: String?) async throws -> CloudListing {
        var terms = base
        if let folder { terms.append("\(Self.quoted(try Self.checked(folder))) in parents") }
        return try await query(terms, next: next)
    }

    func search(_ text: String, next: String?) async throws -> CloudListing {
        try await query(base + ["name contains \(Self.quoted(text))"], next: next)
    }

    func metadata(_ id: String) async throws -> File {
        try await http.json(File.self, URLRequest(url: URL(string: "\(Self.drive)/files/\(try Self.checked(id))?fields=\(Self.fields)&supportsAllDrives=true")!))
    }

    /// What the picker gave back, as entries.
    func entries(_ ids: [String]) async throws -> [CloudEntry] {
        var found: [CloudEntry] = []
        for id in ids.prefix(20) {
            guard let file = try? await metadata(id), file.trashed != true else { continue }
            if file.mimeType == Self.folderType {
                found.append(CloudEntry(key: file.id, name: file.name, kind: .folder))
            } else if file.mimeType == "application/pdf" {
                found.append(CloudEntry(key: file.id, name: file.name, kind: .pdf))
            }
        }
        return found
    }

    func open(_ key: String) async throws -> (saved: CloudSaved, bytes: Data) {
        let file = try await metadata(key)
        guard file.trashed != true, file.mimeType == "application/pdf" else { throw CloudError.notFound }
        let (bytes, _) = try await http.send(URLRequest(url: URL(string: "\(Self.drive)/files/\(file.id)?alt=media&supportsAllDrives=true")!))
        return (file.saved, bytes)
    }

    func saveRevision(_ key: String, bytes: Data, expected: String?) async throws -> CloudSaved {
        // Drive has no conditional write: the head revision is read first.
        if let expected, !expected.isEmpty, try await metadata(key).versionTag != expected { throw CloudError.conflict }
        var request = URLRequest(url: URL(string: "\(Self.upload)/files/\(try Self.checked(key))?uploadType=media&supportsAllDrives=true&fields=\(Self.fields)")!)
        request.httpMethod = "PATCH"
        request.setValue("application/pdf", forHTTPHeaderField: "Content-Type")
        request.httpBody = bytes
        return try await http.json(File.self, request).saved
    }

    func saveNew(folder: String?, name: String, bytes: Data) async throws -> CloudSaved {
        var metadata: [String: Any] = ["name": name.lowercased().hasSuffix(".pdf") ? name : name + ".pdf", "mimeType": "application/pdf"]
        if let folder { metadata["parents"] = [try Self.checked(folder)] }
        let boundary = "zood-\(PKCE.random(18).filter { $0.isLetter || $0.isNumber })"
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".utf8))
        body.append(try JSONSerialization.data(withJSONObject: metadata))
        body.append(Data("\r\n--\(boundary)\r\nContent-Type: application/pdf\r\n\r\n".utf8))
        body.append(bytes)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = URLRequest(url: URL(string: "\(Self.upload)/files?uploadType=multipart&supportsAllDrives=true&fields=\(Self.fields)")!)
        request.httpMethod = "POST"
        request.setValue("multipart/related; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return try await http.json(File.self, request).saved
    }
}
