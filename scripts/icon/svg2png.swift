// Rasterizes an SVG into a PNG with AppKit, which reads SVG documents on
// macOS. The repo has no SVG rasterizer of its own and no ImageMagick, and
// the app icons Xcode needs are PNGs.
//
//   xcrun swift scripts/icon/svg2png.swift in.svg out.png 1024 [--opaque #0a0e1c]
//
// `--opaque` draws the artwork over a solid colour first: an iOS app icon
// may not carry an alpha channel.
import AppKit

let arguments = CommandLine.arguments
guard arguments.count >= 4, let side = Int(arguments[3]) else {
    FileHandle.standardError.write(Data("usage: svg2png.swift in.svg out.png <side> [--opaque #rrggbb]\n".utf8))
    exit(2)
}
let source = arguments[1]
let destination = arguments[2]

/// `#rrggbb`, the only form this script is given.
func colour(_ text: String) -> NSColor {
    var value: UInt64 = 0
    Scanner(string: text.hasPrefix("#") ? String(text.dropFirst()) : text).scanHexInt64(&value)
    return NSColor(
        srgbRed: CGFloat((value >> 16) & 0xff) / 255,
        green: CGFloat((value >> 8) & 0xff) / 255,
        blue: CGFloat(value & 0xff) / 255,
        alpha: 1
    )
}

var background: NSColor?
if let index = arguments.firstIndex(of: "--opaque"), arguments.count > index + 1 {
    background = colour(arguments[index + 1])
}

guard let image = NSImage(contentsOfFile: source) else {
    FileHandle.standardError.write(Data("cannot read \(source)\n".utf8))
    exit(1)
}
image.size = NSSize(width: side, height: side)

// An icon over a solid colour is drawn into a context with no alpha channel
// at all (`noneSkipLast`): an iOS app icon that carries one is rejected at
// upload. On transparency the context keeps its alpha.
let frame = NSRect(x: 0, y: 0, width: side, height: side)
let info: CGImageAlphaInfo = background == nil ? .premultipliedLast : .noneSkipLast
guard let context = CGContext(
    data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info.rawValue
) else { exit(1) }

NSGraphicsContext.saveGraphicsState()
let graphics = NSGraphicsContext(cgContext: context, flipped: false)
graphics.imageInterpolation = .high
NSGraphicsContext.current = graphics
if let background {
    background.setFill()
    frame.fill()
}
image.draw(in: frame, from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()

guard let rendered = context.makeImage() else { exit(1) }
let bitmap = NSBitmapImageRep(cgImage: rendered)
bitmap.size = frame.size
guard let data = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
try data.write(to: URL(fileURLWithPath: destination))
print("\(destination) \(side)\u{00d7}\(side)")
