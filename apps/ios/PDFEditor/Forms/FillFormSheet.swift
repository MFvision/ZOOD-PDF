import SwiftUI

/// Fill form: every field the file has, each with the control its kind
/// takes — text typed (in its own direction), a check box switched, a radio
/// button or a list item chosen — and Fill, which writes what changed
/// through the core (`forms.fill`): the values stored, the form's
/// calculations run, and each value drawn into its field, Arabic shaped, so
/// any reader shows it. One step of undo. A signature field is signed from
/// Signatures in the More menu, not typed into.
struct FillFormSheet: View {
    @Bindable var form: FormModel
    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: String] = [:]
    @State private var loaded = false

    /// The fields a person fills here.
    private var fillable: [FormModel.Field] {
        form.fields.filter { !$0.readOnly && ["text", "checkbox", "radio", "choice"].contains($0.type) }
    }

    private var changed: [String: String] {
        values.filter { name, value in form.fields.first { $0.name == name }?.value != value }
    }

    var body: some View {
        NavigationStack {
            Form {
                if !loaded {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else if form.fields.isEmpty {
                    Section {
                        Text("This document has no form fields. Make some with Prepare form.")
                            .foregroundStyle(Surface.secondaryLabel)
                            .accessibilityIdentifier("fill.none")
                    }
                } else {
                    Section {
                        ForEach(fillable) { field in
                            row(field)
                        }
                    } footer: {
                        Text("Arabic is drawn shaped into each field, so every reader shows it.")
                    }
                    let others = form.fields.filter { !fillable.contains($0) }
                    if !others.isEmpty {
                        Section {
                            ForEach(others) { field in
                                LabeledContent {
                                    Text(field.type == "signature" ? "Signed from Signatures" : "Cannot be changed")
                                        .foregroundStyle(Surface.secondaryLabel)
                                } label: {
                                    Text(verbatim: field.name)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Fill form")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("fill.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if form.working {
                        ProgressView()
                    } else {
                        Button("Fill") {
                            Task {
                                if await form.fill(changed) { dismiss() }
                            }
                        }
                        .disabled(changed.isEmpty)
                        .accessibilityIdentifier("fill.apply")
                    }
                }
            }
            .alert("Could not fill the form", isPresented: Binding(get: { form.error != nil }, set: { if !$0 { form.clearError() } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(form.error ?? "")
            }
        }
        .presentationDetents([.large])
        .task {
            await form.readFields()
            values = Dictionary(uniqueKeysWithValues: form.fields.map { ($0.name, $0.value) })
            loaded = true
        }
    }

    @ViewBuilder
    private func row(_ field: FormModel.Field) -> some View {
        let value = Binding<String>(
            get: { values[field.name] ?? field.value },
            set: { values[field.name] = $0 }
        )
        switch field.type {
        case "checkbox":
            Toggle(isOn: Binding(
                get: { let v = value.wrappedValue; return !v.isEmpty && v != "Off" },
                set: { value.wrappedValue = $0 ? (field.states?.first ?? "Yes") : "Off" }
            )) {
                Text(verbatim: field.tooltip?.isEmpty == false ? field.tooltip! : field.name)
            }
            .accessibilityIdentifier("fill.\(field.name)")
        case "radio", "choice":
            let states = field.type == "radio" ? (field.states ?? []) : (field.options ?? [])
            let labels = field.options ?? states
            Picker(selection: value) {
                Text("None").tag(field.type == "radio" ? "Off" : "")
                ForEach(Array(states.enumerated()), id: \.offset) { index, state in
                    Text(verbatim: index < labels.count ? labels[index] : state).tag(state)
                }
            } label: {
                Text(verbatim: field.tooltip?.isEmpty == false ? field.tooltip! : field.name)
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("fill.\(field.name)")
        default:
            VStack(alignment: .leading, spacing: Space.x1) {
                Text(verbatim: field.tooltip?.isEmpty == false ? field.tooltip! : field.name)
                    .font(TextStyle.caption)
                    .foregroundStyle(Surface.secondaryLabel)
                TextField(text: value) {
                    Text(verbatim: field.name)
                }
                .autocorrectionDisabled()
                .accessibilityIdentifier("fill.\(field.name)")
            }
        }
    }
}
