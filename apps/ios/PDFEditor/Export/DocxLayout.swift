import Foundation
import ImageIO
import UniformTypeIdentifiers
import WarraqCore

/// Word with the layout kept, as the desktop writes it (`docxLayout.ts`):
/// each PDF page a Word page of its own size. Behind it, the page drawn
/// without its text — logos, pictures, shapes, rules and fills, as they
/// are — and on it, each paragraph as a text box where it was, in its
/// lines, face, size, weight and colour, right to left where it is
/// Arabic. A scanned page keeps its picture, and its recognised text
/// rides on it invisibly, as it does in the PDF.
///
/// The boxes are what Word itself writes for a text box (a
/// WordprocessingML shape, in the AlternateContent Word puts around one),
/// so Word, LibreOffice and Pages open them as text boxes to edit.
enum DocxLayout {
    struct Font: Equatable {
        let family: String
        /// 100–900.
        let weight: Int
        let italic: Bool
    }

    /// One paragraph's box on the page, in points, y down.
    struct Box: Equatable {
        var x: Float
        var y: Float
        var width: Float
        var height: Float
        var lines: [String]
        var rightToLeft: Bool
        /// "start", "end", "center" or "justify".
        var alignment: String
        var size: Float
        /// Top to top, between its lines; nil for one line.
        var pitch: Float?
        /// Six hex digits.
        var colour: String
        var vertical: Bool
        var font: Font?
        /// Drawn into the picture already: there to find and copy, not to see twice.
        var hidden: Bool
    }

    struct Page {
        let width: Float
        let height: Float
        /// PNG of the page without its text; nil for plain paper.
        let picture: Data?
        let boxes: [Box]
        /// A scan's text layer: all its text was invisible.
        let hiddenText: Bool
    }

    /// The page pictures: sharp enough to read at 144 dpi, within the pixel budget.
    static let pictureScale: Float = 2
    /// A3 at 300 dpi fits; a poster is drawn at the resolution that does.
    static let maxPagePixels: Float = 25_000_000

    // MARK: - Reading the pages

    /// Each page as the core reads it: lines (`export.lines`), the editor's
    /// paragraphs, the picture without text (`export.picture`), and the
    /// page as drawn, for the text's colour.
    static func pages(of core: Core) async throws -> [Page] {
        struct LinesArgs: Encodable { let page: Int }
        struct Lines: Decodable { let lines: [TextLine] }
        struct PictureArgs: Encodable { let page: Int; let scale: Float }
        struct Picture: Decodable { let width: Int; let height: Int; let textHidden: Bool }
        var pages: [Page] = []
        let count = await core.pageCount
        for index in 0..<count {
            let size = try await core.pageSize(index)
            let fits = (maxPagePixels / max(1, size.width * pictureScale * size.height * pictureScale)).squareRoot()
            let scale = fits < 1 ? pictureScale * fits : pictureScale
            let lines: Lines = try await core.call(op: "export.lines", args: LinesArgs(page: index)).decode()
            let blocks = try await core.paragraphs(page: index)
            let reply = try await core.call(op: "export.picture", args: PictureArgs(page: index, scale: scale))
            let picture: Picture = try reply.decode()
            let bare = reply.blobs.first ?? Data()
            let (w, h) = (picture.width, picture.height)
            let paragraphs = group(lines.lines, blocks: blocks)
            // Only for the text's colour; a scan's text is invisible anyway.
            let full = !picture.textHidden && !paragraphs.isEmpty ? try? await core.renderPage(index, scale: scale) : nil
            let boxes = paragraphs.map { paragraph -> Box in
                var box = layout(paragraph)
                if let full, full.width == w, full.height == h, bare.count >= w * h * 4 {
                    let ink = inkOf(full: full.rgba, bare: bare, width: w, height: h,
                                    box: (box.x * scale, box.y * scale, box.width * scale, box.height * scale))
                    box.colour = ink ?? "000000"
                    box.hidden = ink == nil
                }
                return box
            }
            let hasPicture = w > 0 && h > 0 && bare.count >= w * h * 4 && (picture.textHidden || !blank(bare))
            pages.append(Page(width: size.width, height: size.height,
                              picture: hasPicture ? png(width: w, height: h, rgba: bare, dpi: Double(scale * 72)) : nil,
                              boxes: boxes, hiddenText: picture.textHidden))
        }
        return pages
    }

    /// A paragraph's box, size and line spacing from its own lines.
    static func layout(_ paragraph: LayoutParagraph) -> Box {
        let own = paragraph.lines
        let x = own.map(\.x).min() ?? 0
        let y = own.map(\.y).min() ?? 0
        let width = (own.map { $0.x + $0.width }.max() ?? 0) - x
        let height = (own.map { $0.y + $0.height }.max() ?? 0) - y
        // Text set up the page has boxes far taller than wide: its size is its thickness.
        let vertical = own.allSatisfy { $0.height > $0.width * 2.5 } && own.contains { $0.text.trimmingCharacters(in: .whitespaces).count > 2 }
        let size: Float = vertical
            ? max(4, min(96, (own.map(\.width).min() ?? 12) / 1.2))
            : (paragraph.fontSize ?? max(4, min(96, (own.first?.height ?? 12) / 1.2)))
        let steps = zip(own.dropFirst(), own).map { $0.y - $1.y }
        let pitch = steps.isEmpty ? nil : steps.reduce(0, +) / Float(steps.count)
        return Box(x: x, y: y, width: width, height: height,
                   lines: own.map { $0.text.trimmingCharacters(in: .whitespaces) },
                   rightToLeft: paragraph.rightToLeft, alignment: paragraph.alignment, size: size, pitch: pitch,
                   colour: "000000", vertical: vertical, font: paragraph.font, hidden: false)
    }

    /// The colour a paragraph's text is drawn in: the page drawn with its
    /// text and without it differ exactly where the letters are. Nil where
    /// they do not differ — the text is part of the picture itself.
    static func inkOf(full: Data, bare: Data, width: Int, height: Int, box: (Float, Float, Float, Float)) -> String? {
        let x0 = max(0, Int(box.0.rounded(.down)))
        let y0 = max(0, Int(box.1.rounded(.down)))
        let x1 = min(width, Int((box.0 + box.2).rounded(.up)))
        let y1 = min(height, Int((box.1 + box.3).rounded(.up)))
        guard x1 > x0, y1 > y0, full.count >= width * height * 4, bare.count >= width * height * 4 else { return nil }
        var strong = (sum: [0, 0, 0], count: 0)
        var faint = (sum: [0, 0, 0], count: 0)
        full.withUnsafeBytes { (f: UnsafeRawBufferPointer) in
            bare.withUnsafeBytes { (b: UnsafeRawBufferPointer) in
                for y in y0..<y1 {
                    for x in x0..<x1 {
                        let p = (y * width + x) * 4
                        let r = Int(f[p]), g = Int(f[p + 1]), bl = Int(f[p + 2])
                        let difference = abs(r - Int(b[p])) + abs(g - Int(b[p + 1])) + abs(bl - Int(b[p + 2]))
                        if difference > 300 {
                            strong.sum[0] += r; strong.sum[1] += g; strong.sum[2] += bl; strong.count += 1
                        } else if difference > 60 {
                            faint.sum[0] += r; faint.sum[1] += g; faint.sum[2] += bl; faint.count += 1
                        }
                    }
                }
            }
        }
        let ink = strong.count >= 4 ? strong : faint
        guard ink.count > 0 else { return nil }
        return ink.sum.map { String(format: "%02x", Int((Double($0) / Double(ink.count)).rounded())) }.joined()
    }

    /// White paper and nothing else: no use behind the text.
    static func blank(_ rgba: Data) -> Bool {
        rgba.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            var p = 0
            while p + 2 < bytes.count {
                if bytes[p] < 248 || bytes[p + 1] < 248 || bytes[p + 2] < 248 { return false }
                p += 4
            }
            return true
        }
    }

    /// RGBA (premultiplied over white, so opaque) as a PNG.
    static func png(width: Int, height: Int, rgba: Data, dpi: Double) -> Data? {
        guard let provider = CGDataProvider(data: rgba as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
        else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return out as Data
    }

    // MARK: - Writing the .docx

    private static let declaration = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
    private static let w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    private static let r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    private static let wp = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
    private static let a = "http://schemas.openxmlformats.org/drawingml/2006/main"
    private static let pic = "http://schemas.openxmlformats.org/drawingml/2006/picture"
    private static let wps = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
    private static let w14 = "http://schemas.microsoft.com/office/word/2010/wordml"
    private static let mc = "http://schemas.openxmlformats.org/markup-compatibility/2006"
    private static let packageRel = "http://schemas.openxmlformats.org/package/2006/relationships"
    private static let namespaces = "xmlns:w=\"\(w)\" xmlns:r=\"\(r)\" xmlns:wp=\"\(wp)\" xmlns:a=\"\(a)\" xmlns:pic=\"\(pic)\" xmlns:wps=\"\(wps)\" xmlns:w14=\"\(w14)\" xmlns:mc=\"\(mc)\" mc:Ignorable=\"w14\""

    /// Room a box is given beyond its text, for a face a little wider than the PDF's.
    private static let slack: Float = 0.25

    /// The .docx bytes.
    static func docx(pages: [Page], title: String) -> Data {
        let (xml, pictures) = document(pages: pages)
        var zip = ZipWriter()
        zip.add("[Content_Types].xml", text: contentTypes)
        zip.add("_rels/.rels", text: rootRels)
        zip.add("word/document.xml", text: xml)
        zip.add("word/styles.xml", text: styles)
        zip.add("word/_rels/document.xml.rels", text: documentRels(pictures))
        zip.add("docProps/core.xml", text: declaration + "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>\(DocxWriter.xmlText(title))</dc:title></cp:coreProperties>")
        for picture in pictures {
            zip.add("word/\(picture.target)", picture.bytes)
        }
        return zip.data()
    }

    /// A page within Word's limits (1 to 22 inches a side), and how much it was scaled to fit them.
    static func wordPage(width: Float, height: Float) -> (width: Float, height: Float, scale: Float) {
        let w = width.isFinite && width > 0 ? width : 595.28
        let h = height.isFinite && height > 0 ? height : 841.89
        let down = min(1, 1584 / w, 1584 / h)
        let up = max(1, 72 / (w * down), 72 / (h * down))
        let scale = min(down * up, 1584 / w, 1584 / h)
        return (w * scale, h * scale, scale)
    }

    /// `word/document.xml`, and the pictures it refers to.
    static func document(pages: [Page]) -> (xml: String, pictures: [(relId: String, target: String, bytes: Data)]) {
        var pictures: [(relId: String, target: String, bytes: Data)] = []
        var body = ""
        var id = 1
        for (index, page) in pages.enumerated() {
            let size = wordPage(width: page.width, height: page.height)
            var runs = ""
            if let picture = page.picture {
                let relId = "rIdPicture\(index + 1)"
                pictures.append((relId, "media/page\(index + 1).png", picture))
                let graphic = pictureGraphic(id: id, relId: relId, width: size.width, height: size.height)
                runs += "<w:r><w:drawing>\(anchor(id: id, name: "Page \(index + 1)", x: 0, y: 0, width: size.width, height: size.height, behind: true, graphic: graphic))</w:drawing></w:r>"
                id += 1
            }
            for box in page.boxes {
                let place = place(box, scale: size.scale)
                let paragraph = boxParagraph(box, scale: size.scale, hidden: page.hiddenText || box.hidden)
                let graphic = textBoxGraphic(paragraph, width: place.width, height: place.height, turned: place.turned)
                let drawing = "<w:drawing>\(anchor(id: id, name: "Text \(id)", x: place.x, y: place.y, width: place.width, height: place.height, behind: false, graphic: graphic))</w:drawing>"
                runs += "<w:r><mc:AlternateContent><mc:Choice Requires=\"wps\">\(drawing)</mc:Choice><mc:Fallback/></mc:AlternateContent></w:r>"
                id += 1
            }
            // One small paragraph per page holds its objects; the page's section ends with it.
            let last = index == pages.count - 1
            body += "<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"20\" w:lineRule=\"exact\"/><w:rPr><w:sz w:val=\"2\"/><w:szCs w:val=\"2\"/></w:rPr>\(last ? "" : section(size))</w:pPr>\(runs)</w:p>"
            if last { body += section(size) }
        }
        return (declaration + "<w:document \(namespaces)><w:body>\(body)</w:body></w:document>", pictures)
    }

    private static func section(_ size: (width: Float, height: Float, scale: Float)) -> String {
        let orient = size.width > size.height ? " w:orient=\"landscape\"" : ""
        return "<w:sectPr><w:pgSz w:w=\"\(twips(size.width))\" w:h=\"\(twips(size.height))\"\(orient)/><w:pgMar w:top=\"0\" w:right=\"0\" w:bottom=\"0\" w:left=\"0\" w:header=\"0\" w:footer=\"0\" w:gutter=\"0\"/></w:sectPr>"
    }

    /// Where a box goes: its text's box, widened on the side its lines run to.
    static func place(_ box: Box, scale: Float) -> (x: Float, y: Float, width: Float, height: Float, turned: Bool) {
        var (x, y, width, height) = (box.x * scale, box.y * scale, box.width * scale, box.height * scale)
        if box.vertical {
            // Unturned, the box is as long as the text and as thick as a line, about the same centre.
            let (cx, cy) = (x + width / 2, y + height / 2)
            (width, height) = (height, width)
            (x, y) = (cx - width / 2, cy - height / 2)
        }
        let extra = width * slack + 4
        if !box.vertical {
            if box.alignment == "center" { x -= extra / 2 } else if box.rightToLeft != (box.alignment == "end") { x -= extra }
        }
        return (x, y, width + extra, height, box.vertical)
    }

    /// A run's properties, in the schema's order (rFonts, b, bCs, i, iCs, color, sz, szCs, rtl, then w14).
    private static func runProperties(_ box: Box, scale: Float, hidden: Bool) -> String {
        let family = box.font?.family.trimmingCharacters(in: .whitespaces) ?? ""
        let face = attribute(family.isEmpty ? DocxWriter.font : family)
        let bold = (box.font?.weight ?? 400) >= 600
        let italic = box.font?.italic ?? false
        let size = Int((min(400, max(1, box.size * scale)) * 2).rounded())
        let colour = box.colour.count == 6 && box.colour.allSatisfy(\.isHexDigit) ? box.colour.uppercased() : "000000"
        return "<w:rPr><w:rFonts w:ascii=\"\(face)\" w:hAnsi=\"\(face)\" w:eastAsia=\"\(face)\" w:cs=\"\(face)\"/>"
            + (bold ? "<w:b/><w:bCs/>" : "")
            + (italic ? "<w:i/><w:iCs/>" : "")
            + "<w:color w:val=\"\(colour)\"/><w:sz w:val=\"\(size)\"/><w:szCs w:val=\"\(size)\"/>"
            + (box.rightToLeft ? "<w:rtl/>" : "")
            // A scan's text: there to find and copy, not to see.
            + (hidden ? "<w14:textFill><w14:noFill/></w14:textFill>" : "")
            + "</w:rPr>"
    }

    /// The box's paragraph: its lines, broken where the page broke them.
    static func boxParagraph(_ box: Box, scale: Float, hidden: Bool) -> String {
        let rPr = runProperties(box, scale: scale, hidden: hidden)
        let runs = box.lines.enumerated().map { k, line in
            let text = DocxWriter.clean(line).replacingOccurrences(of: "[\t\n\r]+", with: " ", options: .regularExpression)
            return "<w:r>\(rPr)\(k > 0 ? "<w:br/>" : "")<w:t xml:space=\"preserve\">\(DocxWriter.xmlText(text))</w:t></w:r>"
        }.joined()
        let pitch = box.pitch.map { $0 > 0 ? $0 : box.size * 1.2 } ?? box.size * 1.2
        // Word's `w:jc` is logical: in a right-to-left paragraph "right" is its end.
        let jc = box.alignment == "center" ? "<w:jc w:val=\"center\"/>" : box.alignment == "end" ? "<w:jc w:val=\"right\"/>" : ""
        // The schema's order: bidi, spacing, jc, rPr.
        return "<w:p><w:pPr>" + (box.rightToLeft ? "<w:bidi/>" : "")
            + "<w:spacing w:before=\"0\" w:after=\"0\" w:line=\"\(max(20, twips(pitch * scale)))\" w:lineRule=\"exact\"/>"
            + jc + rPr + "</w:pPr>" + runs + "</w:p>"
    }

    /// A floating object placed on the page by its top-left corner, with nothing wrapping round it.
    private static func anchor(id: Int, name: String, x: Float, y: Float, width: Float, height: Float, behind: Bool, graphic: String) -> String {
        "<wp:anchor distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\" simplePos=\"0\" relativeHeight=\"\(id + 1)\" behindDoc=\"\(behind ? 1 : 0)\" locked=\"\(behind ? 1 : 0)\" layoutInCell=\"1\" allowOverlap=\"1\">"
            + "<wp:simplePos x=\"0\" y=\"0\"/>"
            + "<wp:positionH relativeFrom=\"page\"><wp:posOffset>\(coordinate(x))</wp:posOffset></wp:positionH>"
            + "<wp:positionV relativeFrom=\"page\"><wp:posOffset>\(coordinate(y))</wp:posOffset></wp:positionV>"
            + "<wp:extent cx=\"\(emu(width))\" cy=\"\(emu(height))\"/>"
            + "<wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/><wp:wrapNone/>"
            + "<wp:docPr id=\"\(id)\" name=\"\(attribute(name))\"/><wp:cNvGraphicFramePr/>\(graphic)</wp:anchor>"
    }

    private static func pictureGraphic(id: Int, relId: String, width: Float, height: Float) -> String {
        "<a:graphic><a:graphicData uri=\"\(pic)\"><pic:pic>"
            + "<pic:nvPicPr><pic:cNvPr id=\"\(id)\" name=\"page\(id).png\"/><pic:cNvPicPr/></pic:nvPicPr>"
            + "<pic:blipFill><a:blip r:embed=\"\(relId)\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>"
            + "<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"\(emu(width))\" cy=\"\(emu(height))\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>"
            + "</pic:pic></a:graphicData></a:graphic>"
    }

    private static func textBoxGraphic(_ paragraph: String, width: Float, height: Float, turned: Bool) -> String {
        "<a:graphic><a:graphicData uri=\"\(wps)\"><wps:wsp><wps:cNvSpPr txBox=\"1\"/>"
            + "<wps:spPr><a:xfrm\(turned ? " rot=\"16200000\"" : "")><a:off x=\"0\" y=\"0\"/><a:ext cx=\"\(emu(width))\" cy=\"\(emu(height))\"/></a:xfrm>"
            + "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>"
            + "<wps:txbx><w:txbxContent>\(paragraph)</w:txbxContent></wps:txbx>"
            // No wrapping: the lines break where the page broke them; the box grows to its text.
            + "<wps:bodyPr rot=\"0\" vert=\"horz\" wrap=\"none\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\" anchor=\"t\" anchorCtr=\"0\"><a:spAutoFit/></wps:bodyPr>"
            + "</wps:wsp></a:graphicData></a:graphic>"
    }

    private static func attribute(_ text: String) -> String {
        DocxWriter.xmlText(text).replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// English Metric Units: 12,700 to a point.
    private static func emu(_ points: Float) -> Int { max(0, Int((points * 12_700).rounded())) }
    private static func coordinate(_ points: Float) -> Int { Int((points * 12_700).rounded()) }
    private static func twips(_ points: Float) -> Int { Int((points * 20).rounded()) }

    private static let contentTypes = declaration + """
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>
    """

    private static let rootRels = declaration + """
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>
    """

    private static func documentRels(_ pictures: [(relId: String, target: String, bytes: Data)]) -> String {
        declaration + "<Relationships xmlns=\"\(packageRel)\"><Relationship Id=\"rId1\" Type=\"\(r)/styles\" Target=\"styles.xml\"/>"
            + pictures.map { "<Relationship Id=\"\($0.relId)\" Type=\"\(r)/image\" Target=\"\($0.target)\"/>" }.joined()
            + "</Relationships>"
    }

    private static let styles = declaration + """
    <w:styles xmlns:w="\(w)"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="\(DocxWriter.font)" w:eastAsia="\(DocxWriter.font)" w:hAnsi="\(DocxWriter.font)" w:cs="\(DocxWriter.font)"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>
    """
}

/// One paragraph as a person sees it: the core's lines grouped again.
struct LayoutParagraph: Equatable {
    let lines: [TextLine]
    let rightToLeft: Bool
    let alignment: String
    /// Points; nil when the page gives no believable size.
    let fontSize: Float?
    let font: DocxLayout.Font?
}

extension DocxLayout {
    /// Paragraphs of a page, from the core's lines (in reading order) and
    /// the paragraphs its editor finds — the desktop's `paragraphsOf`. The
    /// editor's paragraphs are blocks for editing (a whole page of body
    /// text can come back as one), so the lines are grouped again: a new
    /// paragraph starts where a line ended early, where there is more
    /// space than the lines' own spacing, where the type changes size, and
    /// where the text changes direction or column.
    static func group(_ lines: [TextLine], blocks: [Paragraph]) -> [LayoutParagraph] {
        let usable = lines.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let owners = usable.map { finite($0) ? blockOf($0, blocks) : -1 }
        let pitches: [Float?] = blocks.indices.map { index in
            linePitch(zip(usable, owners).filter { $0.1 == index }.map(\.0))
        }
        var groups: [(lines: [TextLine], owners: [Int])] = []
        for (line, owner) in zip(usable, owners) {
            if let last = groups.indices.last, continues(groups[last], line, owner, blocks: blocks, pitches: pitches) {
                groups[last].lines.append(line)
                groups[last].owners.append(owner)
            } else {
                groups.append(([line], [owner]))
            }
        }
        return groups.map { group in
            let owner = group.owners.first { $0 >= 0 }
            let block = owner.map { blocks[$0] }
            let size = block?.fontSize
            let font = block?.fontFamily.flatMap { family in
                family.isEmpty ? nil : Font(family: family, weight: block?.fontWeight ?? 400, italic: block?.fontItalic ?? false)
            }
            return LayoutParagraph(lines: group.lines, rightToLeft: dominantRightToLeft(group.lines, fallback: block?.direction),
                                   alignment: block?.alignment ?? "start",
                                   fontSize: size.flatMap { $0 >= 4 && $0 <= 96 ? $0 : nil }, font: font)
        }
    }

    /// Combining marks (tashkeel) and format controls take no room on the line.
    private static func roomTaking(_ text: String) -> Int {
        text.unicodeScalars.filter { scalar in
            switch scalar.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark, .format: false
            default: true
            }
        }.count
    }

    private static func finite(_ line: TextLine) -> Bool {
        [line.x, line.y, line.width, line.height].allSatisfy(\.isFinite) && line.height > 0
    }

    /// The smallest of the core's paragraphs around the line's middle whose
    /// text contains the line's, or failing that the smallest; -1 for none.
    private static func blockOf(_ line: TextLine, _ blocks: [Paragraph]) -> Int {
        let (cx, cy) = (line.x + line.width / 2, line.y + line.height / 2)
        let trimmed = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
        var best = -1
        var bestArea = Float.infinity
        var bestHasText = false
        for (index, block) in blocks.enumerated() {
            guard cx >= block.x - 1, cx <= block.x + block.width + 1, cy >= block.y - 1, cy <= block.y + block.height + 1 else { continue }
            let hasText = block.text.contains(trimmed)
            let area = block.width * block.height
            if (hasText && !bestHasText) || (hasText == bestHasText && area < bestArea) {
                (best, bestArea, bestHasText) = (index, area, hasText)
            }
        }
        return best
    }

    /// The usual distance from one line to the next, top to top.
    private static func linePitch(_ lines: [TextLine]) -> Float? {
        let steps = zip(lines.dropFirst(), lines).map { $0.y - $1.y }.filter { $0 > 0 }.sorted()
        return steps.isEmpty ? nil : steps[(steps.count - 1) / 2]
    }

    /// Whether `prev` stopped early: the first word of `next` would have fitted in the room left.
    private static func endedEarly(_ prev: TextLine, _ next: TextLine, rightToLeft: Bool, left: Float, right: Float) -> Bool {
        let room = rightToLeft ? prev.x - left : right - (prev.x + prev.width)
        let chars = roomTaking(next.text)
        guard room > 0, chars > 0 else { return false }
        let perChar = next.width / Float(chars)
        let firstWord = next.text.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
        let needed = Float(roomTaking(firstWord) + 1) * perChar
        return room > needed * 1.2 + 1
    }

    private static func continues(_ group: (lines: [TextLine], owners: [Int]), _ next: TextLine, _ nextOwner: Int,
                                  blocks: [Paragraph], pitches: [Float?]) -> Bool {
        guard let prev = group.lines.last, let prevOwner = group.owners.last else { return false }
        let prevBlock = prevOwner >= 0 ? blocks[prevOwner] : nil
        let nextBlock = nextOwner >= 0 ? blocks[nextOwner] : nil
        let sameBlock = prevOwner >= 0 && prevOwner == nextOwner
        guard finite(prev), finite(next) else { return false }
        // Inside one of the core's paragraphs a change of direction is no break; anywhere else it is.
        if !sameBlock, next.direction != prev.direction { return false }
        if let prevBlock, let nextBlock, prevBlock.direction != nextBlock.direction { return false }
        // Below the previous line and in the same column.
        if next.y < prev.y + prev.height * 0.5 { return false }
        if min(prev.x + prev.width, next.x + next.width) <= max(prev.x, next.x) { return false }
        // The same size of type.
        let tall = max(prev.height, next.height)
        if abs(prev.height - next.height) > tall * 0.3 { return false }
        // No more space above it than between the paragraph's own lines.
        let known = [prevOwner, nextOwner].compactMap { $0 >= 0 ? pitches[$0] : nil }
        let usual = (sameBlock ? pitches[prevOwner] : known.min()) ?? linePitch(group.lines) ?? tall * 1.5
        if next.y - prev.y > usual * (sameBlock ? 1.3 : 1.15) + 0.5 { return false }
        // Centred or end-aligned text shows no short last line: there the spacing alone decides.
        let alignment = (prevBlock ?? nextBlock)?.alignment ?? "start"
        if alignment != "start", alignment != "justify" { return true }
        var lefts = (group.lines + [next]).map(\.x)
        var rights = (group.lines + [next]).map { $0.x + $0.width }
        for block in [prevBlock, nextBlock].compactMap({ $0 }) {
            lefts.append(block.x)
            rights.append(block.x + block.width)
        }
        let rightToLeft = ((prevBlock ?? nextBlock)?.direction ?? prev.direction) == "rtl"
        return !endedEarly(prev, next, rightToLeft: rightToLeft, left: lefts.min() ?? 0, right: rights.max() ?? 0)
    }

    /// The direction most of the paragraph's text runs in.
    private static func dominantRightToLeft(_ lines: [TextLine], fallback: String?) -> Bool {
        var rtl = 0
        var ltr = 0
        for line in lines {
            if line.direction == "rtl" { rtl += roomTaking(line.text) } else { ltr += roomTaking(line.text) }
        }
        if rtl == ltr { return (fallback ?? lines.first?.direction ?? "rtl") == "rtl" }
        return rtl > ltr
    }
}
