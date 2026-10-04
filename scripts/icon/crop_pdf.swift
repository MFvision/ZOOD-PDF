// Cuts one page of a PDF — or of an Illustrator file saved PDF-compatible,
// as ZOOD's identity package is — down to a box, and writes it as a PDF of
// its own (vectors, drawn by CoreGraphics; Illustrator's private data is not
// carried over) or as a PNG on transparency, to look at.
//
//   xcrun swift scripts/icon/crop_pdf.swift in.ai <page> <x0> <y0> <x1> <y1> out.pdf
//   xcrun swift scripts/icon/crop_pdf.swift in.ai <page> <x0> <y0> <x1> <y1> out.png <width-px>
//
// The box is in the page's own points, y up, as the file's ArtBox gives it.
import AppKit
import CoreGraphics

let arguments = CommandLine.arguments
guard arguments.count >= 8,
      let document = CGPDFDocument(URL(fileURLWithPath: arguments[1]) as CFURL),
      let number = Int(arguments[2]),
      let page = document.page(at: number),
      let x0 = Double(arguments[3]), let y0 = Double(arguments[4]),
      let x1 = Double(arguments[5]), let y1 = Double(arguments[6])
else {
    FileHandle.standardError.write(Data("usage: crop_pdf.swift in.pdf page x0 y0 x1 y1 out.pdf|out.png [width]\n".utf8))
    exit(2)
}
let box = CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
let destination = URL(fileURLWithPath: arguments[7])

func draw(in context: CGContext) {
    context.translateBy(x: -box.minX, y: -box.minY)
    context.clip(to: box)
    context.drawPDFPage(page)
}

if destination.pathExtension == "png" {
    let width = Int(arguments.count > 8 ? arguments[8] : "512") ?? 512
    let height = Int((Double(width) * box.height / box.width).rounded())
    let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.scaleBy(x: CGFloat(width) / box.width, y: CGFloat(height) / box.height)
    draw(in: context)
    let image = NSBitmapImageRep(cgImage: context.makeImage()!)
    try! image.representation(using: .png, properties: [:])!.write(to: destination)
} else {
    var media = CGRect(origin: .zero, size: box.size)
    let context = CGContext(destination as CFURL, mediaBox: &media, nil)!
    context.beginPDFPage(nil)
    draw(in: context)
    context.endPDFPage()
    context.closePDF()
}
print(destination.lastPathComponent, Int(box.width), "×", Int(box.height))
