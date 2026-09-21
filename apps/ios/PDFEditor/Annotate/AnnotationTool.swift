import PDFKit
import SwiftUI

/// The markup tools. Each is a PDFKit annotation kind the page keeps, drawn
/// where the finger or the Pencil says; the stamp and the signature go
/// through the core instead (a page mark, a picture) and are placed from
/// their own sheets.
enum AnnotationTool: String, CaseIterable, Identifiable {
    case highlight
    case underline
    case strikeout
    case ink
    case note
    case rectangle
    case ellipse
    case arrow
    case freeText

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .highlight: "Highlight"
        case .underline: "Underline"
        case .strikeout: "Strike through"
        case .ink: "Draw"
        case .note: "Note"
        case .rectangle: "Rectangle"
        case .ellipse: "Ellipse"
        case .arrow: "Arrow"
        case .freeText: "Text"
        }
    }

    var symbol: String {
        switch self {
        case .highlight: "highlighter"
        case .underline: "underline"
        case .strikeout: "strikethrough"
        case .ink: "pencil.tip"
        case .note: "text.bubble"
        case .rectangle: "rectangle"
        case .ellipse: "circle"
        case .arrow: "arrow.up.right"
        case .freeText: "textformat"
        }
    }

    /// Tools that mark text the person drags over.
    var isTextMarkup: Bool {
        switch self {
        case .highlight, .underline, .strikeout: true
        default: false
        }
    }

    /// Tools that take a dragged box.
    var takesBox: Bool {
        switch self {
        case .rectangle, .ellipse, .arrow, .freeText: true
        default: false
        }
    }

    var subtype: PDFAnnotationSubtype {
        switch self {
        case .highlight: .highlight
        case .underline: .underline
        case .strikeout: .strikeOut
        case .ink: .ink
        case .note: .text
        case .rectangle: .square
        case .ellipse: .circle
        case .arrow: .line
        case .freeText: .freeText
        }
    }
}

/// The colours a mark can take: named, so they read in VoiceOver and in
/// both appearances; the PDF gets the exact RGB.
enum MarkupColor: String, CaseIterable, Identifiable {
    case yellow
    case green
    case blue
    case pink
    case red
    case black

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .yellow: "Yellow"
        case .green: "Green"
        case .blue: "Blue"
        case .pink: "Pink"
        case .red: "Red"
        case .black: "Black"
        }
    }

    var uiColor: UIColor {
        switch self {
        case .yellow: UIColor(red: 1.0, green: 0.86, blue: 0.20, alpha: 1)
        case .green: UIColor(red: 0.30, green: 0.80, blue: 0.40, alpha: 1)
        case .blue: UIColor(red: 0.25, green: 0.55, blue: 1.0, alpha: 1)
        case .pink: UIColor(red: 1.0, green: 0.45, blue: 0.70, alpha: 1)
        case .red: UIColor(red: 0.90, green: 0.20, blue: 0.20, alpha: 1)
        case .black: UIColor(white: 0.1, alpha: 1)
        }
    }

    var color: Color { Color(uiColor: uiColor) }

    /// "#rrggbb", as the core's marks take a colour.
    var hex: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        uiColor.getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(format: "#%02x%02x%02x", Int(r * 255), Int(g * 255), Int(b * 255))
    }
}

/// What a PDFKit annotation is called on screen.
extension PDFAnnotation {
    var kindTitle: LocalizedStringKey {
        switch PDFAnnotationSubtype(rawValue: "/" + (type ?? "")) {
        case .highlight: "Highlight"
        case .underline: "Underline"
        case .strikeOut: "Strike through"
        case .ink: "Drawing"
        case .text: "Note"
        case .square: "Rectangle"
        case .circle: "Ellipse"
        case .line: "Arrow"
        case .freeText: "Text"
        case .stamp: "Stamp"
        case .link: "Link"
        case .widget: "Form field"
        default: "Mark"
        }
    }

    var kindSymbol: String {
        switch PDFAnnotationSubtype(rawValue: "/" + (type ?? "")) {
        case .highlight: "highlighter"
        case .underline: "underline"
        case .strikeOut: "strikethrough"
        case .ink: "pencil.tip"
        case .text: "text.bubble"
        case .square: "rectangle"
        case .circle: "circle"
        case .line: "arrow.up.right"
        case .freeText: "textformat"
        case .stamp: "seal"
        case .link: "link"
        default: "pencil.and.outline"
        }
    }

    /// Annotations a person made, as opposed to links and form fields the
    /// file came with.
    var isMarkup: Bool {
        switch PDFAnnotationSubtype(rawValue: "/" + (type ?? "")) {
        case .link, .widget, .popup: false
        default: true
        }
    }
}
