import CWarraq
import Foundation

/// An engine error: `{ "code": "…", "message": "…" }` from warraq-core. The UI localises by `code`.
public struct WarraqError: Error, Sendable, Equatable, Codable, LocalizedError {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }

    static func decoding(_ what: String, _ error: any Error) -> WarraqError {
        WarraqError(code: "bad_reply", message: "could not decode \(what): \(error)")
    }
}

/// JSON + blobs, copied out of the C reply (which is freed immediately).
public struct EngineReply: Sendable {
    public let json: Data
    public let blobs: [Data]

    public func decode<T: Decodable>(_ type: T.Type = T.self) throws(WarraqError) -> T {
        do {
            return try JSONDecoder().decode(T.self, from: json)
        } catch {
            throw WarraqError.decoding(String(describing: T.self), error)
        }
    }

    /// The first blob or an error (mutating methods return the new file as blobs[0]).
    public func blob0() throws(WarraqError) -> Data {
        guard let b = blobs.first else {
            throw WarraqError(code: "bad_reply", message: "the engine returned no file")
        }
        return b
    }
}

/// Params for methods that take none.
public struct NoParams: Encodable, Sendable {
    public init() {}
}

/// Owns the C handle; closes it exactly once.
final class DocumentHandle: @unchecked Sendable {
    // Only ever touched from the owning WarraqEngine actor (and deinit, when no one else can).
    let pointer: OpaquePointer

    init(pointer: OpaquePointer) {
        self.pointer = pointer
    }

    deinit {
        warraq_close(pointer)
    }
}

/// One open PDF inside the Rust engine. An actor, so every call on a document is serialised
/// (the engine's `Document` is `&mut`), while different documents run in parallel.
///
/// ```swift
/// let engine = try WarraqEngine(data: bytes)
/// let info = try await engine.info()
/// let rotated = try await engine.rotate(pages: [0], degrees: 90)   // incremental update
/// ```
public actor WarraqEngine {
    private let handle: DocumentHandle

    /// Open a PDF. Throws `password_required` / `wrong_password` / `parse_error` … as WarraqError.
    public init(data: Data, password: String? = nil) throws(WarraqError) {
        handle = try FFI.open(data, password: password)
    }

    /// Raw call with already-encoded params (`nil` = no params).
    public func call(_ method: String, json params: String?, blobs: [Data] = []) throws(WarraqError) -> EngineReply {
        let doc = handle.pointer
        return try FFI.withCStrings(method, params) { m, p in
            FFI.withBlobs(blobs) { ptrs, lens, count in
                FFI.take(warraq_call(doc, m, p, ptrs, lens, count))
            }
        }.get()
    }

    /// Call with Encodable params.
    public func call<P: Encodable & Sendable>(_ method: String, _ params: P, blobs: [Data] = []) throws(WarraqError) -> EngineReply {
        try call(method, json: try FFI.encode(params), blobs: blobs)
    }

    public func call(_ method: String, blobs: [Data] = []) throws(WarraqError) -> EngineReply {
        try call(method, json: nil, blobs: blobs)
    }

    /// A method without a document (`pdf.merge`, `pdf.isEncrypted`, `methods.list`).
    public static func callStatic(_ method: String, json params: String?, blobs: [Data] = []) throws(WarraqError) -> EngineReply {
        try FFI.withCStrings(method, params) { m, p in
            FFI.withBlobs(blobs) { ptrs, lens, count in
                FFI.take(warraq_call_static(m, p, ptrs, lens, count))
            }
        }.get()
    }

    public static func callStatic<P: Encodable & Sendable>(_ method: String, _ params: P, blobs: [Data] = []) throws(WarraqError) -> EngineReply {
        try callStatic(method, json: try FFI.encode(params), blobs: blobs)
    }
}

/// The unsafe corner: pointer plumbing to warraq.h. Every pointer handed to C lives only for the
/// duration of the call, as the header requires.
enum FFI {
    static func open(_ data: Data, password: String?) throws(WarraqError) -> DocumentHandle {
        var errorOut: UnsafeMutablePointer<CWarraq.WarraqReply>?
        let doc: OpaquePointer? = data.withUnsafeBytes { raw in
            let base = raw.bindMemory(to: UInt8.self).baseAddress
            if let password {
                return password.withCString { warraq_open(base, raw.count, $0, &errorOut) }
            }
            return warraq_open(base, raw.count, nil, &errorOut)
        }
        if let doc { return DocumentHandle(pointer: doc) }
        switch take(errorOut) {
        case .failure(let e): throw e
        case .success: throw WarraqError(code: "internal", message: "warraq_open failed without an error")
        }
    }

    static func encode<P: Encodable>(_ params: P) throws(WarraqError) -> String {
        do {
            let data = try JSONEncoder().encode(params)
            return String(decoding: data, as: UTF8.self)
        } catch {
            throw WarraqError(code: "invalid_params", message: "could not encode params: \(error)")
        }
    }

    static func withCStrings<R>(
        _ a: String, _ b: String?, _ body: (UnsafePointer<CChar>, UnsafePointer<CChar>?) -> R
    ) -> R {
        a.withCString { pa in
            guard let b else { return body(pa, nil) }
            return b.withCString { pb in body(pa, pb) }
        }
    }

    /// Pin every blob without copying (recursively nested `withUnsafeBytes`) and pass the
    /// pointer/length arrays to `body`.
    static func withBlobs<R>(
        _ blobs: [Data],
        _ body: (UnsafePointer<UnsafePointer<UInt8>?>?, UnsafePointer<Int>?, Int) -> R
    ) -> R {
        let lens = blobs.map(\.count)
        return pin(blobs[...], []) { ptrs in
            ptrs.withUnsafeBufferPointer { p in
                lens.withUnsafeBufferPointer { l in
                    body(p.baseAddress, l.baseAddress, blobs.count)
                }
            }
        }
    }

    private static func pin<R>(
        _ rest: ArraySlice<Data>, _ acc: [UnsafePointer<UInt8>?], _ body: ([UnsafePointer<UInt8>?]) -> R
    ) -> R {
        guard let first = rest.first else { return body(acc) }
        return first.withUnsafeBytes { raw in
            pin(rest.dropFirst(), acc + [raw.bindMemory(to: UInt8.self).baseAddress], body)
        }
    }

    /// Copy a reply out and free it.
    static func take(_ reply: UnsafeMutablePointer<CWarraq.WarraqReply>?) -> Result<EngineReply, WarraqError> {
        guard let reply else {
            return .failure(WarraqError(code: "internal", message: "the engine returned no reply"))
        }
        defer { warraq_free_reply(reply) }
        let r = reply.pointee
        let json: Data = r.json.map { Data(bytes: $0, count: r.json_len) } ?? Data("null".utf8)
        var blobs: [Data] = []
        blobs.reserveCapacity(r.blob_count)
        if r.blob_count > 0, let ptrs = r.blobs, let lens = r.blob_lens {
            for i in 0..<r.blob_count {
                let len = lens[i]
                if len > 0, let p = ptrs[i] {
                    blobs.append(Data(bytes: p, count: len))
                } else {
                    blobs.append(Data())
                }
            }
        }
        if r.is_error != 0 {
            let err = (try? JSONDecoder().decode(WarraqError.self, from: json))
                ?? WarraqError(code: "internal", message: String(decoding: json, as: UTF8.self))
            return .failure(err)
        }
        return .success(EngineReply(json: json, blobs: blobs))
    }
}
