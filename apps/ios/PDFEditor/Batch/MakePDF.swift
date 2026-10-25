import UIKit
import UniformTypeIdentifiers
import WebKit

/// A PDF from a Word, Excel or PowerPoint file, a web page or plain text,
/// as the desktop's "Make a PDF from Office" does: the system's own viewer
/// lays the file out (on this iPhone, nothing sent), and its print
/// formatter cuts it into A4 pages.
@MainActor
enum MakePDF {
    static let types: [UTType] = [
        UTType("org.openxmlformats.wordprocessingml.document"), UTType("com.microsoft.word.doc"),
        UTType("org.openxmlformats.spreadsheetml.sheet"), UTType("com.microsoft.excel.xls"),
        UTType("org.openxmlformats.presentationml.presentation"), UTType("com.microsoft.powerpoint.ppt"),
        UTType.html, UTType.plainText, UTType.rtf,
    ].compactMap { $0 }

    enum Failure: Error { case unreadable }

    static func pdf(from url: URL) async throws -> Data {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 794, height: 1123))
        let loader = Loader()
        web.navigationDelegate = loader
        let type = UTType(filenameExtension: url.pathExtension.lowercased())
        if type?.conforms(to: .plainText) == true, type?.conforms(to: .html) != true {
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { throw Failure.unreadable }
            let escaped = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            web.loadHTMLString("""
            <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
            <style>body{font:14px -apple-system,"Geeza Pro",sans-serif;white-space:pre-wrap;unicode-bidi:plaintext}</style></head>
            <body dir="auto">\(escaped)</body></html>
            """, baseURL: nil)
        } else {
            // A copy the web view may read: the picked file can sit outside the sandbox.
            let copy = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: copy, withIntermediateDirectories: true)
            let file = copy.appending(path: url.lastPathComponent)
            try FileManager.default.copyItem(at: url, to: file)
            web.loadFileURL(file, allowingReadAccessTo: copy)
        }
        try await loader.finished()
        // Office files are drawn a moment after the page says it has loaded.
        try await Task.sleep(for: .milliseconds(600))

        let renderer = UIPrintPageRenderer()
        renderer.addPrintFormatter(web.viewPrintFormatter(), startingAtPageAt: 0)
        let paper = CGRect(x: 0, y: 0, width: 595.28, height: 841.89)
        renderer.setValue(paper, forKey: "paperRect")
        renderer.setValue(paper.insetBy(dx: 36, dy: 42), forKey: "printableRect")
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: renderer.numberOfPages))
        let pages = renderer.numberOfPages
        guard pages > 0 else { throw Failure.unreadable }
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, paper, nil)
        for page in 0..<pages {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: page, in: UIGraphicsGetPDFContextBounds())
        }
        UIGraphicsEndPDFContext()
        return data as Data
    }

    @MainActor
    private final class Loader: NSObject, WKNavigationDelegate {
        private var continuation: CheckedContinuation<Void, Error>?
        private var result: Result<Void, Error>?

        func finished() async throws {
            if let result { return try result.get() }
            try await withCheckedThrowingContinuation { continuation = $0 }
        }

        private func finish(_ result: Result<Void, Error>) {
            guard self.result == nil else { return }
            self.result = result
            continuation?.resume(with: result)
            continuation = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(.success(())) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    }
}
