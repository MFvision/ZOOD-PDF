import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

public struct PackFile: Codable, Sendable { public let path: String; public let bytes: Int; public let sha256: String }
public struct PackLicense: Codable, Sendable { public let id: String; public let name: String; public let url: String; public let attribution: String }
public struct PackSource: Codable, Sendable { public let name: String; public let url: String; public var snapshot: String?; public var builtAt: String? }
public struct PackBBox: Codable, Sendable { public let minLat, minLng, maxLat, maxLng: Double }
public struct PackCoverage: Codable, Sendable { public let name: String; public let bbox: PackBBox }

public struct PackManifest: Codable, Sendable {
    public let id: String
    public let kind: String
    public let schemaVersion: Int
    public let version: Int
    public let title: [String: String]
    public var coverage: PackCoverage?
    public var languages: [String]?
    public var recordCount: Int?
    public let source: PackSource
    public let license: PackLicense
    public let files: [PackFile]

    public func title(_ lang: String) -> String { title[lang] ?? title["en"] ?? id }
}

public enum PackError: Error, Equatable {
    case format(String)
    case checksum(String)
    case newerSchema(Int)
}

public enum PackVerifier {
    public static let supportedSchema = 1
    public static let kinds: Set<String> = ["mosques", "sources", "cities"]

    public static func parseManifest(_ data: Data) throws -> PackManifest {
        let m: PackManifest
        do { m = try JSONDecoder().decode(PackManifest.self, from: data) } catch { throw PackError.format("manifest") }
        guard kinds.contains(m.kind) else { throw PackError.format("kind \(m.kind)") }
        guard m.schemaVersion <= supportedSchema else { throw PackError.newerSchema(m.schemaVersion) }
        guard !m.files.contains(where: { $0.path.contains("..") || $0.path.hasPrefix("/") }) else { throw PackError.format("unsafe path") }
        return m
    }

    /// Hash every listed file before anything is installed.
    public static func verify(_ m: PackManifest, read: (String) -> Data?) throws {
        for f in m.files {
            guard let data = read(f.path) else { throw PackError.format("missing \(f.path)") }
            guard Sha256.hex(data) == f.sha256.lowercased() else { throw PackError.checksum(f.path) }
        }
    }
}

/// SHA-256: CryptoKit on Apple platforms, a self-contained FIPS 180-4 implementation elsewhere
/// (Linux test runners). Both are checked against the same pack manifests.
public enum Sha256 {
    private static let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    public static func hex(_ data: Data) -> String {
        #if canImport(CryptoKit)
        return CryptoKit.SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        #else
        return portableHex(data)
        #endif
    }

    public static func portableHex(_ data: Data) -> String {
        var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
        var msg = [UInt8](data)
        let bitLen = UInt64(msg.count) * 8
        msg.append(0x80)
        while msg.count % 64 != 56 { msg.append(0) }
        for i in (0..<8).reversed() { msg.append(UInt8((bitLen >> (UInt64(i) * 8)) & 0xff)) }
        var w = [UInt32](repeating: 0, count: 64)
        for chunk in stride(from: 0, to: msg.count, by: 64) {
            for i in 0..<16 {
                let b = chunk + i * 4
                w[i] = UInt32(msg[b]) << 24 | UInt32(msg[b + 1]) << 16 | UInt32(msg[b + 2]) << 8 | UInt32(msg[b + 3])
            }
            for i in 16..<64 {
                let s0 = w[i - 15].rotr(7) ^ w[i - 15].rotr(18) ^ (w[i - 15] >> 3)
                let s1 = w[i - 2].rotr(17) ^ w[i - 2].rotr(19) ^ (w[i - 2] >> 10)
                w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
            }
            var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
            for i in 0..<64 {
                let t1 = hh &+ (e.rotr(6) ^ e.rotr(11) ^ e.rotr(25)) &+ ((e & f) ^ (~e & g)) &+ k[i] &+ w[i]
                let t2 = (a.rotr(2) ^ a.rotr(13) ^ a.rotr(22)) &+ ((a & b) ^ (a & c) ^ (b & c))
                hh = g; g = f; f = e; e = d &+ t1; d = c; c = b; b = a; a = t1 &+ t2
            }
            h[0] = h[0] &+ a; h[1] = h[1] &+ b; h[2] = h[2] &+ c; h[3] = h[3] &+ d
            h[4] = h[4] &+ e; h[5] = h[5] &+ f; h[6] = h[6] &+ g; h[7] = h[7] &+ hh
        }
        return h.map { String(format: "%08x", $0) }.joined()
    }
}

private extension UInt32 {
    func rotr(_ n: UInt32) -> UInt32 { (self >> n) | (self << (32 - n)) }
}
