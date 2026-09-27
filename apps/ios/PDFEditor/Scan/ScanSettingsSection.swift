import SwiftUI

extension SettingsKey {
    /// The colour mode new scans start in.
    static let scanColorMode = "scanColorMode"
    /// The OCR languages chosen, comma-separated ("ar,en").
    static let ocrLanguages = "ocrLanguages"
}

/// The scanner's settings: the colour mode new scans start in, and which of
/// the languages this device's text recognition supports to read with —
/// the device's own list, asked at runtime, with Arabic's absence said
/// plainly where it is absent.
struct ScanSettingsSection: View {
    @AppStorage(SettingsKey.scanColorMode) private var colorMode: ScanColorMode = .color
    @AppStorage(SettingsKey.ocrLanguages) private var languages = "ar,en"
    @State private var supported: [String] = []

    private var chosen: Set<String> {
        Set(languages.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
    }

    var body: some View {
        Section {
            Picker("New scans", selection: $colorMode) {
                Text("Colour").tag(ScanColorMode.color)
                Text("Grey").tag(ScanColorMode.grey)
                Text("Black and white").tag(ScanColorMode.blackAndWhite)
            }
            .accessibilityIdentifier("settings.scanColorMode")
        } header: {
            Text("Scan")
        }
        Section {
            if supported.isEmpty {
                Text("This device's text recognition reports no languages.")
                    .foregroundStyle(Surface.secondaryLabel)
            }
            ForEach(supported, id: \.self) { code in
                Toggle(isOn: binding(for: code)) {
                    Text(TextRecognizer.name(of: code))
                }
                .accessibilityIdentifier("settings.ocr.\(code)")
            }
        } header: {
            Text("Text recognition")
        } footer: {
            if TextRecognizer.supports("ar", in: supported) {
                Text("The languages Vision reads on this device. Scans are read with the ones switched on.")
            } else {
                Text("Arabic is not among the languages this device's text recognition supports; scans of Arabic pages get no searchable text here. The languages listed are the device's own answer.")
            }
        }
        .task {
            supported = TextRecognizer.supportedLanguages()
        }
    }

    /// A language is chosen by its short code ("ar" for "ar-SA").
    private func binding(for code: String) -> Binding<Bool> {
        let short = String(code.split(separator: "-").first ?? Substring(code)).lowercased()
        return Binding(
            get: { chosen.contains(short) || chosen.contains(code) },
            set: { on in
                var set = chosen
                set.remove(code)
                if on { set.insert(short) } else { set.remove(short) }
                languages = set.sorted().joined(separator: ",")
            }
        )
    }
}
