import Foundation

/// What the core can answer instead of a result. Each case is one of the C
/// ABI's `WARRAQ_E_*` codes (`packages/core/warraq-core/include/warraq_core.h`);
/// the message is the core's own English one, with its `E_…` prefix.
public enum CoreError: Error, Sendable, Equatable {
    /// Arguments that do not parse, or text that is not UTF-8.
    case arguments(String)
    /// No tool operation of that name.
    case unknownOperation(String)
    /// Not a PDF, or one too damaged to read.
    case parse(String)
    /// Encrypted; the password is missing or wrong.
    case password
    /// A page index past the last page.
    case page(String)
    /// The page could not be drawn.
    case render(String)
    /// A font that cannot be read or subset.
    case font(String)
    /// An edit that cannot be made as asked.
    case edit(String)
    /// Bytes that could not be written.
    case io(String)
    /// A Library index that cannot be read.
    case index(String)
    /// Signing or verifying failed; the code names which step
    /// (`E_P12_PASSWORD`, `E_TSA`, `E_SIGN`, …).
    case sign(code: String, message: String)
    /// The core panicked on hostile input and was caught. The document has
    /// been closed; open its bytes again.
    case panic(String)
    /// Anything else, by the core's code and message.
    case other(code: String, message: String)
    /// The document was closed, or the core answered with a panic earlier.
    case closed
    /// The core answered JSON the wrapper could not read as the type asked.
    case badReply(String)

    /// Built from a reply's numeric code and its `{"code","message"}` JSON.
    init(code: Int32, codeName: String, message: String) {
        switch code {
        case 1: self = .arguments(message)
        case 2: self = .unknownOperation(message)
        case 3: self = .parse(message)
        case 4: self = .password
        case 5: self = .page(message)
        case 6: self = .render(message)
        case 7: self = .font(message)
        case 8: self = .edit(message)
        case 9: self = .io(message)
        case 10: self = .index(message)
        case 11: self = .sign(code: codeName, message: message)
        case 12: self = .panic(message)
        default: self = .other(code: codeName, message: message)
        }
    }

    /// The stable code, as every other host of the core names it.
    public var code: String {
        switch self {
        case .arguments: "E_ARGS"
        case .unknownOperation: "E_UNKNOWN_OP"
        case .parse: "E_PARSE"
        case .password: "E_PASSWORD"
        case .page: "E_PAGE"
        case .render: "E_RENDER"
        case .font: "E_FONT"
        case .edit: "E_EDIT"
        case .io: "E_IO"
        case .index: "E_INDEX"
        case let .sign(code, _): code
        case .panic: "E_PANIC"
        case let .other(code, _): code
        case .closed: "E_CLOSED"
        case .badReply: "E_REPLY"
        }
    }

    /// The core's message (English, for logs; the interface shows its own).
    public var message: String {
        switch self {
        case let .arguments(m), let .unknownOperation(m), let .parse(m), let .page(m),
             let .render(m), let .font(m), let .edit(m), let .io(m), let .index(m),
             let .panic(m), let .badReply(m):
            m
        case let .sign(_, m), let .other(_, m):
            m
        case .password:
            "E_PASSWORD: the document is encrypted and the password is missing or wrong"
        case .closed:
            "E_CLOSED: the document is closed"
        }
    }
}

extension CoreError: CustomStringConvertible {
    public var description: String { message }
}

extension CoreError {
    /// The paragraph's own font cannot draw the new text: the answer to
    /// `replaceParagraph` with no font, after which the caller draws it in
    /// a font of its choosing.
    public var isOwnFontRefusal: Bool {
        if case .font(let message) = self { return message.hasPrefix("E_OWN_FONT") }
        return false
    }
}
