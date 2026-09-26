import Foundation

/// A downloadable GGUF model for the portable (llama.cpp) backend. Pinned to a repository
/// revision, byte size and SHA-256: the download is refused unless every byte matches.
public struct LocalModelSpec: Sendable, Equatable, Identifiable, Codable {
    public let id: String
    public let displayName: String
    public let fileName: String
    public let url: URL
    public let byteCount: Int64
    /// Lower-case hex SHA-256 of the file.
    public let sha256: String
    /// Context size given to llama.cpp.
    public let contextTokens: Int
    public let budget: ModelBudget
    public let licence: String
}

public enum LocalModelCatalog {
    /// Qwen3-1.7B, Q4_K_M quantisation (Apache-2.0). Default on devices with 6 GB of memory or more.
    public static let standard = LocalModelSpec(
        id: "qwen3-1.7b-q4km",
        displayName: "Qwen3 1.7B",
        fileName: "Qwen3-1.7B-Q4_K_M.gguf",
        url: URL(string: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_K_M.gguf")!,
        byteCount: 1_107_409_472,
        sha256: "b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897",
        contextTokens: 8_192,
        budget: .portable,
        licence: "Apache-2.0")

    /// Qwen3-0.6B, Q4_K_M (Apache-2.0): the "light" model for devices with less than 6 GB.
    public static let light = LocalModelSpec(
        id: "qwen3-0.6b-q4km",
        displayName: "Qwen3 0.6B",
        fileName: "Qwen3-0.6B-Q4_K_M.gguf",
        url: URL(string: "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/50968a4468ef4233ed78cd7c3de230dd1d61a56b/Qwen3-0.6B-Q4_K_M.gguf")!,
        byteCount: 396_705_472,
        sha256: "ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a",
        contextTokens: 4_096,
        budget: .portableLight,
        licence: "Apache-2.0")

    public static let all = [standard, light]

    /// Devices below this amount of memory get the light model by default.
    public static let lightThresholdBytes: UInt64 = 6 * 1_024 * 1_024 * 1_024 - 512 * 1_024 * 1_024

    /// `ProcessInfo.physicalMemory` of a "6 GB" iPhone reports a little under 6 GiB, hence the margin.
    public static func recommended(physicalMemory: UInt64) -> LocalModelSpec {
        physicalMemory >= lightThresholdBytes ? standard : light
    }

    public static func spec(id: String) -> LocalModelSpec? { all.first { $0.id == id } }

    /// A .gguf the user imported from Files. A file identical to a catalog model is that model;
    /// any other file gets conservative settings (small ones are treated like the light model).
    public static func imported(fileName: String, byteCount: Int64, sha256: String) -> LocalModelSpec {
        if let known = spec(sha256: sha256) { return known }
        let light = byteCount < 700_000_000
        let base = (fileName as NSString).deletingPathExtension
        return LocalModelSpec(
            id: "imported-" + String(sha256.lowercased().prefix(12)),
            displayName: base.isEmpty ? "GGUF" : base,
            fileName: "imported-" + String(sha256.lowercased().prefix(12)) + ".gguf",
            url: URL(fileURLWithPath: "/"),
            byteCount: byteCount,
            sha256: sha256.lowercased(),
            contextTokens: light ? 4_096 : 8_192,
            budget: light ? .portableLight : .portable,
            licence: "")
    }

    public static func spec(sha256: String) -> LocalModelSpec? {
        let h = sha256.lowercased()
        return all.first { $0.sha256 == h }
    }
}

public enum GGUFFile {
    /// True when `header` (the first bytes of a file) is a GGUF v2/v3 model: magic "GGUF"
    /// followed by a little-endian version. Imported files are checked before use.
    public static func looksValid(header: Data) -> Bool {
        let b = [UInt8](header.prefix(8))
        guard b.count == 8, b[0] == 0x47, b[1] == 0x47, b[2] == 0x55, b[3] == 0x46 else { return false }
        let version = UInt32(b[4]) | UInt32(b[5]) << 8 | UInt32(b[6]) << 16 | UInt32(b[7]) << 24
        return version == 2 || version == 3
    }

    /// Hex string of a digest.
    public static func hex(_ bytes: some Sequence<UInt8>) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
}

/// Qwen3 chat template (ChatML) with thinking switched off, for llama.cpp.
public enum ChatMLTemplate {
    public static func render(system: String, user: String) -> String {
        "<|im_start|>system\n\(clean(system))<|im_end|>\n<|im_start|>user\n\(clean(user))<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
    }

    /// Control tokens are parsed from the template text (`parse_special`), so content must never
    /// contain them.
    static func clean(_ s: String) -> String {
        s.replacingOccurrences(of: "<|", with: "< |").replacingOccurrences(of: "|>", with: "| >")
    }
}

/// Removes `<think>…</think>` blocks from a streamed answer, even when tags are split across
/// chunks (Qwen3 may still emit an empty think block).
public struct ThinkFilter: Sendable {
    private var buffer = ""
    private var inside = false

    public init() {}

    /// Feed a chunk; returns the visible text that is now certain.
    public mutating func feed(_ chunk: String) -> String {
        buffer += chunk
        var out = ""
        while true {
            let tag = inside ? "</think>" : "<think>"
            if let r = buffer.range(of: tag) {
                if !inside { out += buffer[..<r.lowerBound] }
                buffer = String(buffer[r.upperBound...])
                inside.toggle()
                if !inside {
                    // Drop the blank lines that follow a closing tag.
                    while let f = buffer.first, f.isNewline { buffer.removeFirst() }
                }
                continue
            }
            // Keep a possible partial tag at the end.
            let keep = Self.partialSuffix(buffer, of: tag)
            let cut = buffer.index(buffer.endIndex, offsetBy: -keep)
            if !inside { out += buffer[..<cut] }
            buffer = String(buffer[cut...])
            return out
        }
    }

    /// Whatever is left at the end of the stream.
    public mutating func finish() -> String {
        defer { buffer = "" }
        return inside ? "" : buffer
    }

    static func partialSuffix(_ s: String, of tag: String) -> Int {
        var n = min(tag.count - 1, s.count)
        while n > 0 {
            if s.hasSuffix(tag.prefix(n)) { return n }
            n -= 1
        }
        return 0
    }
}

/// llama.cpp hands out token pieces as bytes; one Arabic letter (2 bytes in UTF-8) or emoji can
/// be split across two tokens. This collects bytes and releases only complete characters.
public struct UTF8Assembler: Sendable {
    private var pending: [UInt8] = []

    public init() {}

    public mutating func append(_ bytes: [UInt8]) -> String {
        pending += bytes
        let keep = Self.incompleteTail(pending)
        let ready = pending.count - keep
        guard ready > 0 else { return "" }
        let out = String(decoding: pending[..<ready], as: UTF8.self)
        pending.removeFirst(ready)
        return out
    }

    /// Anything left (invalid bytes become U+FFFD).
    public mutating func finish() -> String {
        defer { pending = [] }
        return String(decoding: pending, as: UTF8.self)
    }

    /// Number of bytes at the end that start a multi-byte character not yet complete.
    static func incompleteTail(_ b: [UInt8]) -> Int {
        var i = b.count - 1
        var continuation = 0
        while i >= 0 && continuation < 3 && b[i] & 0xC0 == 0x80 {
            continuation += 1
            i -= 1
        }
        guard i >= 0 else { return 0 }
        let lead = b[i]
        let needed: Int
        if lead & 0xE0 == 0xC0 {
            needed = 1
        } else if lead & 0xF0 == 0xE0 {
            needed = 2
        } else if lead & 0xF8 == 0xF0 {
            needed = 3
        } else {
            return 0
        }
        return continuation < needed ? continuation + 1 : 0
    }
}

/// Which model runs a request.
public enum AIBackendChoice: Equatable, Sendable {
    /// Apple's on-device Foundation Models.
    case apple
    /// The downloaded or imported Qwen3 model via llama.cpp.
    case portable
    /// Nothing can run yet: the portable model has to be downloaded (or imported) first.
    case needsModel
    /// This build has no portable runtime and Apple's model cannot be used.
    case unavailable
}

public enum AIBackendChooser {
    /// Apple's model is preferred when it is available and supports the language; otherwise the
    /// portable model, which needs a one-time download.
    public static func choose(
        appleAvailable: Bool, appleSupportsLanguage: Bool, portableRuntime: Bool, portableInstalled: Bool
    ) -> AIBackendChoice {
        if appleAvailable && appleSupportsLanguage { return .apple }
        guard portableRuntime else { return .unavailable }
        return portableInstalled ? .portable : .needsModel
    }
}
