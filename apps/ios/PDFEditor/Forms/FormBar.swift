import SwiftUI

/// Prepare form's bar over the pages, in the dark chrome of the other
/// tools: undo and redo, the kind of field a drag draws, Detect, the fields
/// (on a phone, where no inspector sits beside the pages), Create, Done.
struct FormBar: View {
    @Bindable var form: FormModel
    let undoManager: UndoManager?
    let inspectorShown: Bool
    let openFields: () -> Void
    let done: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Space.x1) {
                    tools
                }
                .padding(.horizontal, Space.x3)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .accessibilityIdentifier("form.bar")
            if form.working {
                ProgressView()
                    .tint(.white)
                    .padding(.horizontal, Space.x3)
                    .accessibilityIdentifier("form.working")
            }
            Button {
                Task { await form.create() }
            } label: {
                Text("Create")
                    .font(TextStyle.headline)
                    .foregroundStyle(form.drafts.isEmpty ? Color.white.opacity(0.35) : Color.accentColor)
                    .padding(.horizontal, Space.x3)
                    .frame(height: 44)
            }
            .disabled(form.drafts.isEmpty || form.working)
            .keyboardShortcut(.return, modifiers: .command)
            .accessibilityIdentifier("form.create")
            Button("Done", action: done)
                .font(TextStyle.headline)
                .foregroundStyle(.white)
                .padding(.horizontal, Space.x4)
                .frame(height: 44)
                .fixedSize()
                .accessibilityIdentifier("form.done")
        }
        .frame(height: 44)
        .themedSurface(.bar, in: Rectangle(), shadowed: false)
        .overlay(alignment: .bottom) {
            Rectangle().fill(.white.opacity(0.12)).frame(height: 0.5)
        }
        .environment(\.colorScheme, .dark)
    }

    @ViewBuilder
    private var tools: some View {
        barButton("Undo", "arrow.uturn.backward", id: "form.undo", enabled: undoManager?.canUndo == true) {
            undoManager?.undo()
        }
        barButton("Redo", "arrow.uturn.forward", id: "form.redo", enabled: undoManager?.canRedo == true) {
            undoManager?.redo()
        }
        divider
        ForEach(FormModel.Kind.drawn) { kind in
            barButton(kind.title, kind.symbol, id: "form.kind.\(kind.rawValue)", selected: form.placing == kind) {
                withAnimation(Motion.travel(reduceMotion: reduceMotion)) {
                    form.placing = form.placing == kind ? nil : kind
                }
            }
        }
        divider
        barButton("Detect fields", "wand.and.stars", id: "form.detect") {
            Task { await form.detect() }
        }
        if !inspectorShown {
            barButton("Fields", "list.bullet.rectangle", id: "form.fields", action: openFields)
        }
        if form.placing != nil {
            Text("Drag a box on the page to draw the field.")
                .font(TextStyle.caption)
                .foregroundStyle(.white.opacity(0.8))
                .padding(.horizontal, Space.x3)
                .accessibilityIdentifier("form.hint")
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(.white.opacity(0.18))
            .frame(width: 0.5, height: 22)
            .padding(.horizontal, Space.x2)
    }

    private func barButton(_ title: LocalizedStringKey, _ symbol: String, id: String, selected: Bool = false, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
        }
        .buttonStyle(.markupTool(selected: selected))
        .disabled(!enabled || form.working)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(id)
    }
}

/// Prepare form's inspector — beside the pages on iPad, a sheet on a phone:
/// the picked draft's name, kind, help text, direction, date pattern, a
/// list's options or what a radio button stands for, and Delete; then
/// every draft to pick, and the fields the file already has.
struct FormInspector: View {
    @Bindable var form: FormModel

    var body: some View {
        List {
            if let draft = form.picked {
                editor(draft)
            }
            Section {
                if form.drafts.isEmpty {
                    Text("Choose a kind of field in the bar and drag a box on the page, or let Detect fields find where this form expects writing.")
                        .font(TextStyle.caption)
                        .foregroundStyle(Surface.secondaryLabel)
                }
                ForEach(Array(form.drafts.enumerated()), id: \.element.id) { index, draft in
                    Button {
                        form.selected = draft.id
                    } label: {
                        HStack {
                            Image(systemName: draft.kind.symbol)
                                .foregroundStyle(Color.accentColor)
                            VStack(alignment: .leading, spacing: Space.x1) {
                                Text(verbatim: draft.kind == .radio ? "\(draft.name) · \(draft.label)" : draft.name)
                                    .font(TextStyle.callout)
                                Text("\(Text(draft.kind.title)), page \(draft.page + 1)")
                                    .font(TextStyle.caption)
                                    .foregroundStyle(Surface.secondaryLabel)
                            }
                            Spacer()
                            if draft.id == form.selected {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                    .accessibilityIdentifier("form.draft.\(index)")
                }
            } header: {
                Text("New fields")
            } footer: {
                if let problem = form.problem, !form.drafts.isEmpty {
                    Text(problem)
                        .foregroundStyle(Color(.systemRed))
                } else if !form.drafts.isEmpty {
                    Text("Create makes them real fields in the file. You can undo until you save.")
                }
            }
            if !form.fields.isEmpty {
                Section("Fields in the file") {
                    ForEach(form.fields) { field in
                        HStack {
                            Text(verbatim: field.name)
                                .font(TextStyle.callout)
                            Spacer()
                            Text(Self.title(of: field.type))
                                .font(TextStyle.caption)
                                .foregroundStyle(Surface.secondaryLabel)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("form.field.\(field.name)")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("form.inspector")
    }

    @ViewBuilder
    private func editor(_ draft: FormModel.Draft) -> some View {
        let binding = Binding<FormModel.Draft>(
            get: { form.picked ?? draft },
            set: { form.update($0) }
        )
        Section("The picked field") {
            TextField("Name", text: binding.name)
                .autocorrectionDisabled()
                .accessibilityIdentifier("form.name")
            Picker("Kind", selection: binding.kind) {
                ForEach(FormModel.Kind.allCases) { kind in
                    Label { Text(kind.title) } icon: { Image(systemName: kind.symbol) }.tag(kind)
                }
            }
            .accessibilityIdentifier("form.kind")
            if draft.kind != .checkbox, draft.kind != .radio, draft.kind != .signature {
                Toggle("Right to left", isOn: binding.rtl)
                    .accessibilityIdentifier("form.rtl")
            }
            TextField("Help text", text: binding.tooltip)
                .accessibilityIdentifier("form.tooltip")
            switch draft.kind {
            case .date, .hijri:
                TextField("Date pattern", text: binding.pattern)
                    .environment(\.layoutDirection, .leftToRight)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("form.pattern")
            case .choice:
                VStack(alignment: .leading, spacing: Space.x2) {
                    Text("Options, one a line")
                        .font(TextStyle.caption)
                        .foregroundStyle(Surface.secondaryLabel)
                    TextEditor(text: binding.options)
                        .frame(minHeight: 88)
                        .accessibilityIdentifier("form.options")
                }
            case .radio:
                TextField("What this button stands for", text: binding.label)
                    .accessibilityIdentifier("form.label")
            default:
                EmptyView()
            }
            Button(role: .destructive) {
                form.remove(draft.id)
            } label: {
                Label("Delete this field", systemImage: "trash")
            }
            .keyboardShortcut(.delete, modifiers: [])
            .accessibilityIdentifier("form.delete")
        }
    }

    static func title(of type: String) -> LocalizedStringKey {
        switch type {
        case "text": "Text field"
        case "checkbox": "Check box"
        case "radio": "Radio button"
        case "choice": "List"
        case "signature": "Signature field"
        case "button": "Button"
        default: LocalizedStringKey(type)
        }
    }
}
