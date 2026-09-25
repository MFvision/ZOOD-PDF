import Foundation

/// A small valid PDF with `pages` pages (one line of text each), written by hand with a correct
/// xref table so the engine opens it without repair.
enum SamplePDF {
    static func make(pages: Int) -> Data {
        var objects: [String] = []
        // 1: catalog, 2: pages, 3: font, then page/content pairs.
        let kids = (0..<pages).map { "\(4 + $0 * 2) 0 R" }.joined(separator: " ")
        objects.append("<< /Type /Catalog /Pages 2 0 R >>")
        objects.append("<< /Type /Pages /Kids [\(kids)] /Count \(pages) >>")
        objects.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        for i in 0..<pages {
            let content = "BT /F1 24 Tf 72 720 Td (Page \(i + 1)) Tj ET"
            objects.append(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents \(5 + i * 2) 0 R >>")
            objects.append("<< /Length \(content.utf8.count) >>\nstream\n\(content)\nendstream")
        }
        var out = "%PDF-1.7\n%\u{00E2}\u{00E3}\u{00CF}\u{00D3}\n"
        var body = Data(out.utf8)
        var offsets: [Int] = []
        for (i, obj) in objects.enumerated() {
            offsets.append(body.count)
            body.append(Data("\(i + 1) 0 obj\n\(obj)\nendobj\n".utf8))
        }
        let xref = body.count
        out = "xref\n0 \(objects.count + 1)\n0000000000 65535 f \n"
        for o in offsets {
            out += String(repeating: "0", count: 10 - String(o).count) + "\(o) 00000 n \n"
        }
        out += "trailer\n<< /Size \(objects.count + 1) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n"
        body.append(Data(out.utf8))
        return body
    }
}
