// Quartz/CoreText PDF generator: produces the kind of PDF that Pages, Preview,
// TextEdit and Safari "Export as PDF" emit on macOS (CoreText shaping, Quartz
// PDF context, system fonts with automatic fallback).
// usage: gen_coretext <truth.txt> <out.pdf> <postscript-font-name> <size>
import Foundation
import CoreGraphics
import CoreText

let args = CommandLine.arguments
guard args.count >= 5 else { fputs("usage: gen_coretext <truth.txt> <out.pdf> <font> <size>\n", stderr); exit(2) }
let lines = try! String(contentsOfFile: args[1], encoding: .utf8)
    .split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
let outURL = URL(fileURLWithPath: args[2])
let fontSize = CGFloat(Double(args[4])!)
let font = CTFontCreateWithName(args[3] as CFString, fontSize, nil)
var mediaBox = CGRect(x: 0, y: 0, width: 595.28, height: 841.89)
let meta: [String: Any] = [kCGPDFContextTitle as String: "وثيقة اختبار عربية",
                           kCGPDFContextCreator as String: "Warraq corpus generator (CoreText)"]
guard let ctx = CGContext(outURL as CFURL, mediaBox: &mediaBox, meta as CFDictionary) else { exit(1) }

var alignment = CTTextAlignment.right
var direction = CTWritingDirection.rightToLeft
var lineSpacing = fontSize * 0.7
var paraSpacing = fontSize * 0.8
let settings = [
    CTParagraphStyleSetting(spec: .alignment, valueSize: MemoryLayout<CTTextAlignment>.size, value: &alignment),
    CTParagraphStyleSetting(spec: .baseWritingDirection, valueSize: MemoryLayout<CTWritingDirection>.size, value: &direction),
    CTParagraphStyleSetting(spec: .lineSpacingAdjustment, valueSize: MemoryLayout<CGFloat>.size, value: &lineSpacing),
    CTParagraphStyleSetting(spec: .paragraphSpacing, valueSize: MemoryLayout<CGFloat>.size, value: &paraSpacing),
]
let style = CTParagraphStyleCreate(settings, settings.count)
let attrs: [NSAttributedString.Key: Any] = [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTParagraphStyleAttributeName as String): style,
]
let attr = NSAttributedString(string: lines.joined(separator: "\n"), attributes: attrs)
let framesetter = CTFramesetterCreateWithAttributedString(attr)
var pos = 0
var pages = 0
while pos < attr.length {
    ctx.beginPDFPage(nil)
    let path = CGPath(rect: mediaBox.insetBy(dx: 56, dy: 60), transform: nil)
    let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: pos, length: 0), path, nil)
    CTFrameDraw(frame, ctx)
    let visible = CTFrameGetVisibleStringRange(frame)
    ctx.endPDFPage(); pages += 1
    if visible.length == 0 { break }
    pos += visible.length
}
ctx.closePDF()
print("ok  \(outURL.lastPathComponent) pages=\(pages)")
