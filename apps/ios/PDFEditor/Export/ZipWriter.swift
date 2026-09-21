import Foundation
import zlib

/// A ZIP archive written by hand, entries stored (not deflated): all a
/// .docx needs, and readable by anything. Built the same way the web app's
/// writer builds one, minus the compression.
struct ZipWriter {
    private var entries: [(name: String, data: Data)] = []

    mutating func add(_ name: String, _ data: Data) {
        entries.append((name, data))
    }

    mutating func add(_ name: String, text: String) {
        add(name, Data(text.utf8))
    }

    /// The archive's bytes.
    func data() -> Data {
        var out = Data()
        var central = Data()
        var count: UInt16 = 0
        for entry in entries {
            let name = Data(entry.name.utf8)
            let crc = ZipWriter.crc32(entry.data)
            let offset = UInt32(truncatingIfNeeded: out.count)
            // Local file header.
            out.append(le32(0x0403_4B50))
            out.append(le16(20)) // version needed
            out.append(le16(0x0800)) // flags: names are UTF-8
            out.append(le16(0)) // stored
            out.append(le16(0)) // time
            out.append(le16(0x21)) // date: 1980-01-01
            out.append(le32(crc))
            out.append(le32(UInt32(truncatingIfNeeded: entry.data.count)))
            out.append(le32(UInt32(truncatingIfNeeded: entry.data.count)))
            out.append(le16(UInt16(truncatingIfNeeded: name.count)))
            out.append(le16(0))
            out.append(name)
            out.append(entry.data)
            // Central directory record.
            central.append(le32(0x0201_4B50))
            central.append(le16(20))
            central.append(le16(20))
            central.append(le16(0x0800))
            central.append(le16(0))
            central.append(le16(0))
            central.append(le16(0x21))
            central.append(le32(crc))
            central.append(le32(UInt32(truncatingIfNeeded: entry.data.count)))
            central.append(le32(UInt32(truncatingIfNeeded: entry.data.count)))
            central.append(le16(UInt16(truncatingIfNeeded: name.count)))
            central.append(le16(0))
            central.append(le16(0))
            central.append(le16(0))
            central.append(le16(0))
            central.append(le32(0))
            central.append(le32(offset))
            central.append(name)
            count += 1
        }
        let centralOffset = UInt32(truncatingIfNeeded: out.count)
        out.append(central)
        out.append(le32(0x0605_4B50))
        out.append(le16(0))
        out.append(le16(0))
        out.append(le16(count))
        out.append(le16(count))
        out.append(le32(UInt32(truncatingIfNeeded: central.count)))
        out.append(le32(centralOffset))
        out.append(le16(0))
        return out
    }

    static func crc32(_ data: Data) -> UInt32 {
        data.withUnsafeBytes { buffer -> UInt32 in
            guard let base = buffer.baseAddress else { return 0 }
            return UInt32(zlib.crc32(0, base.assumingMemoryBound(to: Bytef.self), uInt(buffer.count)))
        }
    }

    private func le16(_ v: UInt16) -> Data {
        Data([UInt8(v & 0xFF), UInt8(v >> 8)])
    }

    private func le32(_ v: UInt32) -> Data {
        Data([UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8(v >> 24)])
    }
}

/// Reads a stored entry back out of an archive this writer made (tests,
/// and the Word export's own check): the local headers are walked in order.
enum ZipReader {
    static func entry(named wanted: String, in archive: Data) -> Data? {
        var offset = 0
        let bytes = [UInt8](archive)
        func u16(_ at: Int) -> Int { Int(bytes[at]) | Int(bytes[at + 1]) << 8 }
        func u32(_ at: Int) -> Int { u16(at) | u16(at + 2) << 16 }
        while offset + 30 <= bytes.count, u32(offset) == 0x0403_4B50 {
            let method = u16(offset + 8)
            let size = u32(offset + 18)
            let nameLength = u16(offset + 26)
            let extraLength = u16(offset + 28)
            let nameStart = offset + 30
            guard nameStart + nameLength + extraLength + size <= bytes.count else { return nil }
            let name = String(decoding: bytes[nameStart..<nameStart + nameLength], as: UTF8.self)
            let dataStart = nameStart + nameLength + extraLength
            if name == wanted, method == 0 {
                return Data(bytes[dataStart..<dataStart + size])
            }
            offset = dataStart + size
        }
        return nil
    }
}
