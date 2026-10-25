import Foundation
import UIKit
import WarraqCore

/// Excel, PowerPoint, JPG and WebP, as the desktop makes them — from what
/// the shared core reads on each page (`export.tables`, `export.lines`,
/// `export.picture`, `export.image`), so a file converted on the iPhone is
/// the same file the computer makes, Arabic in reading order.
enum OfficeExport {
    // MARK: - Excel

    struct Cell {
        var text: String
        var rows = 1
        var columns = 1
    }

    struct Sheet {
        var name: String
        var rows: [[Cell?]] = []
        var rtl = false
    }

    private struct Item: Decodable {
        struct LineCell: Decodable { let text: String }
        struct TableCell: Decodable { let text: String; let rows: Int?; let columns: Int? }
        let kind: String
        let text: String?
        let direction: String?
        let cells: [LineCell]?
        let rows: [[TableCell?]]?
    }

    private struct Items: Decodable { let items: [Item] }
    private struct Page: Encodable { let page: Int }

    /// A sheet for each page: its tables as tables, its other lines a row
    /// each (cut at their wide gaps into cells).
    static func sheets(core: Core, pageLabel: @Sendable (Int) -> String) async throws -> [Sheet] {
        var sheets: [Sheet] = []
        let count = await core.pageCount
        for index in 0..<count {
            let items: Items = try await core.call(op: "export.tables", args: Page(page: index)).decode()
            var sheet = Sheet(name: pageLabel(index + 1))
            var rtl = 0
            var ltr = 0
            for item in items.items {
                if item.direction == "rtl" { rtl += 1 } else { ltr += 1 }
                if item.kind == "table", let rows = item.rows {
                    if !sheet.rows.isEmpty { sheet.rows.append([]) }
                    for row in rows {
                        sheet.rows.append(row.map { cell in
                            cell.map { Cell(text: $0.text, rows: max(1, $0.rows ?? 1), columns: max(1, $0.columns ?? 1)) }
                        })
                    }
                    sheet.rows.append([])
                } else {
                    let cells = (item.cells ?? []).map(\.text).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                    let row = cells.isEmpty ? [item.text ?? ""] : cells
                    sheet.rows.append(row.map { Cell(text: $0) })
                }
            }
            sheet.rtl = rtl > ltr
            sheets.append(sheet)
        }
        return sheets
    }

    static func columnName(_ index: Int) -> String {
        var name = ""
        var n = index + 1
        while n > 0 {
            let rest = (n - 1) % 26
            name = String(UnicodeScalar(UInt8(65 + rest))) + name
            n = (n - 1) / 26
        }
        return name
    }

    /// A number as written ("1,250.50", "١٢٣", "15%"), or nil for text.
    static func number(_ text: String) -> (value: Double, percent: Bool)? {
        var s = text.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty, s.count <= 24 else { return nil }
        let arabicDigits: [Character: Character] = ["٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9", "٫": ".", "٬": ","]
        s = String(s.map { arabicDigits[$0] ?? $0 })
        let percent = s.hasSuffix("%") || s.hasSuffix("٪")
        if percent { s.removeLast() }
        guard s.range(of: #"^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$"#, options: .regularExpression) != nil,
              let value = Double(s.replacingOccurrences(of: ",", with: "")) else { return nil }
        // A long run of digits is an ID or a phone number, not a quantity.
        if !s.contains(","), !s.contains("."), s.count > 9 { return nil }
        return (percent ? value / 100 : value, percent)
    }

    static func xlsx(_ sheets: [Sheet]) -> Data {
        let main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        let rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        let packageRel = "http://schemas.openxmlformats.org/package/2006/relationships"
        let declaration = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
        var zip = ZipWriter()
        var taken = Set<String>()
        let names = sheets.enumerated().map { index, sheet -> String in
            var base = sheet.name
            for ch in "[]:*?/\\" { base = base.replacingOccurrences(of: String(ch), with: " ") }
            base = String(base.trimmingCharacters(in: .whitespaces).prefix(31))
            if base.isEmpty { base = "Sheet\(index + 1)" }
            var name = base
            var n = 2
            while taken.contains(name.lowercased()) { name = String(base.prefix(26)) + " (\(n))"; n += 1 }
            taken.insert(name.lowercased())
            return name
        }
        for (k, sheet) in sheets.enumerated() {
            var rowsXML = ""
            var merges: [String] = []
            var last = 0
            for (r, row) in sheet.rows.enumerated() {
                var cells = ""
                for (c, cell) in row.enumerated() {
                    guard let cell, !cell.text.isEmpty else { continue }
                    let ref = "\(columnName(c))\(r + 1)"
                    last = max(last, c + cell.columns - 1)
                    if cell.rows > 1 || cell.columns > 1 {
                        merges.append("<mergeCell ref=\"\(ref):\(columnName(c + cell.columns - 1))\(r + cell.rows)\"/>")
                    }
                    if let number = number(cell.text) {
                        cells += "<c r=\"\(ref)\"\(number.percent ? " s=\"1\"" : "")><v>\(number.value)</v></c>"
                    } else {
                        cells += "<c r=\"\(ref)\" t=\"inlineStr\"><is><t xml:space=\"preserve\">\(PptxWriter.xml(String(cell.text.prefix(32_767))))</t></is></c>"
                    }
                }
                if !cells.isEmpty { rowsXML += "<row r=\"\(r + 1)\">\(cells)</row>" }
            }
            let mergeXML = merges.isEmpty ? "" : "<mergeCells count=\"\(merges.count)\">\(merges.joined())</mergeCells>"
            zip.add("xl/worksheets/sheet\(k + 1).xml", text: declaration
                + "<worksheet xmlns=\"\(main)\" xmlns:r=\"\(rel)\"><dimension ref=\"A1:\(columnName(last))\(max(1, sheet.rows.count))\"/>"
                + "<sheetViews><sheetView\(k == 0 ? " tabSelected=\"1\"" : "")\(sheet.rtl ? " rightToLeft=\"1\"" : "") workbookViewId=\"0\"/></sheetViews>"
                + "<sheetFormatPr defaultRowHeight=\"15\"/><sheetData>\(rowsXML)</sheetData>\(mergeXML)"
                + "<pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/></worksheet>")
        }
        let overrides = (1...max(1, sheets.count)).prefix(sheets.count).map {
            "<Override PartName=\"/xl/worksheets/sheet\($0).xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
        }.joined()
        zip.add("[Content_Types].xml", text: declaration + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
            + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>"
            + "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>"
            + "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>\(overrides)</Types>")
        zip.add("_rels/.rels", text: declaration + "<Relationships xmlns=\"\(packageRel)\"><Relationship Id=\"rId1\" Type=\"\(rel)/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>")
        let sheetList = names.enumerated().map { "<sheet name=\"\(PptxWriter.xml($0.element))\" sheetId=\"\($0.offset + 1)\" r:id=\"rId\($0.offset + 1)\"/>" }.joined()
        zip.add("xl/workbook.xml", text: declaration + "<workbook xmlns=\"\(main)\" xmlns:r=\"\(rel)\"><bookViews><workbookView/></bookViews><sheets>\(sheetList)</sheets></workbook>")
        let rels = (0..<sheets.count).map { "<Relationship Id=\"rId\($0 + 1)\" Type=\"\(rel)/worksheet\" Target=\"worksheets/sheet\($0 + 1).xml\"/>" }.joined()
        zip.add("xl/_rels/workbook.xml.rels", text: declaration + "<Relationships xmlns=\"\(packageRel)\">\(rels)<Relationship Id=\"rId\(sheets.count + 1)\" Type=\"\(rel)/styles\" Target=\"styles.xml\"/></Relationships>")
        zip.add("xl/styles.xml", text: declaration + "<styleSheet xmlns=\"\(main)\">"
            + "<fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Arial\"/><family val=\"2\"/></font></fonts>"
            + "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>"
            + "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>"
            + "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>"
            + "<cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"9\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/></cellXfs>"
            + "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>")
        return zip.data()
    }

    // MARK: - PowerPoint from the pages

    private struct LineData: Decodable {
        let text: String
        let x: Double
        let y: Double
        let width: Double
        let height: Double
        let direction: String
    }

    private struct Lines: Decodable { let lines: [LineData] }
    private struct LinesArgs: Encodable { let page: Int }
    private struct PictureArgs: Encodable { let page: Int; let scale: Float }
    private struct PictureReply: Decodable { let width: Int; let height: Int; let textHidden: Bool }

    /// Each page a slide: the page drawn without its text behind (a scan as
    /// it is), and each line of its text a box you can edit, where it was.
    static func powerPoint(core: Core, progress: (@Sendable (Int, Int) -> Void)? = nil) async throws -> Data {
        var slides: [PptxWriter.Slide] = []
        let count = await core.pageCount
        for index in 0..<count {
            let size = try await core.pageSize(index)
            let width = Double(size.width)
            let height = Double(size.height)
            let lines: Lines = try await core.call(op: "export.lines", args: LinesArgs(page: index)).decode()
            // About 144 dpi, inside a picture budget a phone keeps in memory.
            let scale: Float = min(2, Float((16_000_000 / max(1, width * height)).squareRoot()))
            let reply = try await core.call(op: "export.picture", args: PictureArgs(page: index, scale: scale))
            let info: PictureReply = try reply.decode()
            var picture: Data?
            if let rgba = reply.blobs.first {
                picture = jpeg(rgba: rgba, width: info.width, height: info.height)
            }
            let texts = lines.lines.compactMap { line -> PptxWriter.Text? in
                let text = line.text.trimmingCharacters(in: .whitespaces)
                guard !text.isEmpty else { return nil }
                return PptxWriter.Text(x: line.x, y: line.y, width: max(line.width, 4), height: max(line.height, 4),
                                       lines: [text], rtl: line.direction == "rtl",
                                       size: max(4, min(96, line.height / 1.2)), hidden: info.textHidden)
            }
            slides.append(PptxWriter.Slide(width: width, height: height, picture: picture, pictureIsJPEG: true, texts: texts))
            progress?(index + 1, count)
        }
        return PptxWriter.pptx(slides)
    }

    /// RGBA pixels (over white) as a JPEG.
    static func jpeg(rgba: Data, width: Int, height: Int, quality: CGFloat = 0.85) -> Data? {
        guard width > 0, height > 0, rgba.count >= width * height * 4,
              let provider = CGDataProvider(data: rgba as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { return nil }
        return UIImage(cgImage: image).jpegData(compressionQuality: quality)
    }

    // MARK: - JPG and WebP

    private struct ImageArgs: Encodable { let page: Int; let scale: Float; let format: String; let quality: Int }

    /// Each page as a JPG or a lossless WebP at 150 dpi, written by the core
    /// (the same file the desktop writes).
    static func pictures(core: Core, format: String) async throws -> [Data] {
        var out: [Data] = []
        let count = await core.pageCount
        for index in 0..<count {
            let reply = try await core.call(op: "export.image", args: ImageArgs(page: index, scale: 150 / 72, format: format, quality: 90))
            if let data = reply.blobs.first { out.append(data) }
        }
        return out
    }
}

extension Exporter {
    static func excel(_ model: DocumentModel) async throws -> URL {
        guard let core = await model.readyEngine() else { throw CoreError.closed }
        let sheets = try await OfficeExport.sheets(core: core) { String(localized: "Page \($0)") }
        let url = try folder().appending(path: "\(model.name).xlsx")
        try OfficeExport.xlsx(sheets).write(to: url)
        return url
    }

    static func powerPoint(_ model: DocumentModel) async throws -> URL {
        guard let core = await model.readyEngine() else { throw CoreError.closed }
        let url = try folder().appending(path: "\(model.name).pptx")
        try await OfficeExport.powerPoint(core: core).write(to: url)
        return url
    }

    /// `jpeg` or `webp`.
    static func pictures(_ model: DocumentModel, format: String) async throws -> [URL] {
        guard let core = await model.readyEngine() else { throw CoreError.closed }
        let data = try await OfficeExport.pictures(core: core, format: format)
        let folder = try folder()
        let digits = max(2, String(data.count).count)
        return try data.enumerated().map { index, bytes in
            let number = String(format: "%0\(digits)d", index + 1)
            let url = folder.appending(path: "\(model.name) \(number).\(format == "jpeg" ? "jpg" : format)")
            try bytes.write(to: url)
            return url
        }
    }
}
