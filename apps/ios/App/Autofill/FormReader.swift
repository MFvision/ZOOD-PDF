import PDFKit
import ZoodCore

/// Reads the form fields of a PDF from PDFKit's widget annotations and writes values back.
/// Several widgets can belong to one field (same full name); they are filled together.
@MainActor
enum FormReader {
    struct Entry {
        let field: FormField
        let widgets: [PDFAnnotation]
    }

    static func entries(in document: PDFDocument) -> [Entry] {
        var order: [String] = []
        var byID: [String: (FormField, [PDFAnnotation])] = [:]
        for pageIndex in 0..<document.pageCount {
            guard let page = document.page(at: pageIndex) else { continue }
            for (i, a) in page.annotations.enumerated() where isWidget(a) {
                let name = a.fieldName ?? ""
                let id = name.isEmpty ? "p\(pageIndex + 1)-\(i)" : name
                if var existing = byID[id] {
                    existing.1.append(a)
                    byID[id] = existing
                    continue
                }
                order.append(id)
                byID[id] = (field(for: a, id: id, page: page, pageIndex: pageIndex), [a])
            }
        }
        return order.compactMap { id in byID[id].map { Entry(field: $0.0, widgets: $0.1) } }
    }

    static func isWidget(_ a: PDFAnnotation) -> Bool {
        a.type == "Widget" || a.type == "/Widget"
    }

    private static func field(for a: PDFAnnotation, id: String, page: PDFPage, pageIndex: Int) -> FormField {
        let kind: FormField.Kind
        switch a.widgetFieldType {
        case .text: kind = .text
        case .choice: kind = .choice
        case .signature: kind = .signature
        case .button: kind = a.widgetControlType == .checkBoxControl ? .checkbox : .other
        default: kind = .other
        }
        let current: String
        switch kind {
        case .checkbox: current = a.buttonWidgetState == .onState ? "on" : ""
        default: current = a.widgetStringValue ?? ""
        }
        return FormField(
            id: id, name: a.fieldName ?? "", label: label(for: a, on: page), kind: kind,
            options: a.choices ?? [], maxLength: a.maximumLength > 0 ? a.maximumLength : nil,
            multiline: a.isMultiline, currentValue: current, page: pageIndex, readOnly: a.isReadOnly)
    }

    /// The field's tooltip (/TU) if it has one, else the text printed beside it on the same
    /// line (both sides, for Arabic and English forms), else the text just above it.
    static func label(for a: PDFAnnotation, on page: PDFPage) -> String {
        if let tu = a.value(forAnnotationKey: PDFAnnotationKey(rawValue: "/TU")) as? String,
           !tu.trimmingCharacters(in: .whitespaces).isEmpty {
            return tu
        }
        let b = a.bounds
        let line = CGRect(x: b.minX - 220, y: b.minY, width: b.width + 440, height: b.height)
        let beside = page.selection(for: line)?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !beside.isEmpty { return String(beside.prefix(120)) }
        let above = CGRect(x: b.minX, y: b.maxY, width: b.width, height: 16)
        let text = page.selection(for: above)?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return String(text.prefix(120))
    }

    /// Write one accepted value into every widget of the field.
    static func write(_ value: String, kind: FormField.Kind, to widgets: [PDFAnnotation]) {
        for w in widgets {
            switch kind {
            case .checkbox:
                w.buttonWidgetState = value == "on" ? .onState : .offState
            default:
                w.widgetStringValue = value
            }
        }
    }
}
