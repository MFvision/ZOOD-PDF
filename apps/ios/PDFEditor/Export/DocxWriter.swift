import Foundation
import WarraqCore

/// Word, text only, as the web app writes it: the document as flowing
/// paragraphs in reading order — the core's reading of each page, Arabic
/// in logical order and right-to-left — never its layout, which Word
/// cannot hold the way a PDF placed it. Each PDF page starts a Word page;
/// five small XML parts in a zip are all a .docx needs.
struct DocxWriter {
    struct Paragraph: Equatable {
        let text: String
        let rightToLeft: Bool
        /// "start", "end", "center" or "justify".
        let alignment: String
        let fontSize: Float?
        let pageBreakBefore: Bool
    }

    struct Page {
        let width: Float
        let height: Float
        let paragraphs: [Paragraph]
    }

    /// Installed with Word on every platform, with Arabic and Latin letters.
    static let font = "Arial"

    /// The pages read from the core: paragraphs where it finds them, the
    /// page's lines as one paragraph each where it finds none.
    static func pages(of core: Core) async throws -> [Page] {
        var pages: [Page] = []
        let count = await core.pageCount
        for index in 0..<count {
            let size = try await core.pageSize(index)
            let found = try await core.paragraphs(page: index)
            var paragraphs: [Paragraph] = []
            if found.isEmpty {
                let text = try await core.extractText(page: index)
                for (n, line) in text.split(separator: "\n", omittingEmptySubsequences: true).enumerated() {
                    paragraphs.append(Paragraph(text: clean(String(line)), rightToLeft: ScriptDirection.isRightToLeft(String(line)) ?? false,
                                                alignment: "start", fontSize: nil, pageBreakBefore: n == 0 && index > 0))
                }
            } else {
                for (n, paragraph) in found.enumerated() {
                    let text = clean(paragraph.text.replacingOccurrences(of: "\n", with: " "))
                    guard !text.isEmpty else { continue }
                    let size = paragraph.fontSize >= 4 && paragraph.fontSize <= 96 ? paragraph.fontSize : nil
                    paragraphs.append(Paragraph(text: text, rightToLeft: paragraph.direction == "rtl", alignment: paragraph.alignment,
                                                fontSize: size, pageBreakBefore: n == 0 && index > 0))
                }
            }
            if paragraphs.isEmpty, index > 0 {
                paragraphs.append(Paragraph(text: "", rightToLeft: false, alignment: "start", fontSize: nil, pageBreakBefore: true))
            }
            pages.append(Page(width: size.width, height: size.height, paragraphs: paragraphs))
        }
        return pages
    }

    /// The .docx bytes.
    static func docx(pages: [Page], title: String) -> Data {
        var zip = ZipWriter()
        zip.add("[Content_Types].xml", text: contentTypes)
        zip.add("_rels/.rels", text: rootRels)
        zip.add("word/_rels/document.xml.rels", text: documentRels)
        zip.add("word/styles.xml", text: styles)
        zip.add("docProps/core.xml", text: coreProperties(title: title))
        zip.add("word/document.xml", text: document(pages: pages))
        return zip.data()
    }

    // MARK: - The parts

    private static let declaration = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
    private static let w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    private static let rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

    static func document(pages: [Page]) -> String {
        var body = ""
        for page in pages {
            for paragraph in page.paragraphs {
                body += paragraphXML(paragraph)
            }
        }
        let first = pages.first
        let width = twips(clampSide(first?.width ?? 595.28))
        let height = twips(clampSide(first?.height ?? 841.89))
        let margin = twips(56.7)
        let section = "<w:sectPr><w:pgSz w:w=\"\(width)\" w:h=\"\(height)\"\(width > height ? " w:orient=\"landscape\"" : "")/><w:pgMar w:top=\"\(margin)\" w:right=\"\(margin)\" w:bottom=\"\(margin)\" w:left=\"\(margin)\" w:header=\"0\" w:footer=\"0\" w:gutter=\"0\"/>\(pages.first?.paragraphs.first?.rightToLeft == true ? "<w:bidi/>" : "")</w:sectPr>"
        return declaration + "<w:document xmlns:w=\"\(w)\" xmlns:r=\"\(rel)\"><w:body>\(body)\(section)</w:body></w:document>"
    }

    /// Element order inside `w:pPr` and `w:rPr` is fixed by the schema
    /// (pageBreakBefore before bidi before jc; sz before szCs before rtl).
    /// `w:jc` is logical: in a right-to-left paragraph "right" is its end.
    static func paragraphXML(_ p: Paragraph) -> String {
        var properties = ""
        if p.pageBreakBefore { properties += "<w:pageBreakBefore/>" }
        if p.rightToLeft { properties += "<w:bidi/>" }
        switch p.alignment {
        case "center": properties += "<w:jc w:val=\"center\"/>"
        case "end": properties += "<w:jc w:val=\"right\"/>"
        case "justify": properties += "<w:jc w:val=\"both\"/>"
        default: break
        }
        var runProperties = ""
        if let size = p.fontSize {
            let half = halfPoints(size)
            runProperties += "<w:sz w:val=\"\(half)\"/><w:szCs w:val=\"\(half)\"/>"
        }
        if p.rightToLeft { runProperties += "<w:rtl/>" }
        let run = p.text.isEmpty ? "" : "<w:r>\(runProperties.isEmpty ? "" : "<w:rPr>\(runProperties)</w:rPr>")\(runContent(p.text))</w:r>"
        return "<w:p>\(properties.isEmpty ? "" : "<w:pPr>\(properties)</w:pPr>")\(run)</w:p>"
    }

    /// Tabs become Word tabs; everything else is kept, spaces included.
    private static func runContent(_ text: String) -> String {
        text.split(separator: "\t", omittingEmptySubsequences: false)
            .map { piece in piece.isEmpty ? "" : "<w:t xml:space=\"preserve\">\(xmlText(String(piece)))</w:t>" }
            .joined(separator: "<w:tab/>")
    }

    static func xmlText(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    /// Characters XML forbids outright — a broken ToUnicode maps glyphs to
    /// U+0000, and one of them makes Word refuse the whole document.
    static func clean(_ text: String) -> String {
        String(text.unicodeScalars.filter { scalar in
            switch scalar.value {
            case 0x9, 0xA, 0xD: true
            case 0x0...0x1F, 0x7F, 0xFFFE, 0xFFFF: false
            default: true
            }
        }.map(Character.init))
    }

    private static func halfPoints(_ points: Float) -> Int {
        Int((min(72, max(6, points)) * 2).rounded())
    }

    private static func twips(_ points: Float) -> Int {
        Int((points * 20).rounded())
    }

    /// Word's own limits on a page side (1 to 22 inches).
    private static func clampSide(_ points: Float) -> Float {
        points.isFinite ? min(1584, max(72, points)) : 595.28
    }

    private static let contentTypes = declaration + """
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>
    """

    private static let rootRels = declaration + """
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>
    """

    private static let documentRels = declaration + """
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>
    """

    private static let styles = declaration + """
    <w:styles xmlns:w="\(w)"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="\(font)" w:hAnsi="\(font)" w:cs="\(font)"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>
    """

    private static func coreProperties(title: String) -> String {
        declaration + "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>\(xmlText(title))</dc:title></cp:coreProperties>"
    }
}
