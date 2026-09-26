import SwiftUI
import UniformTypeIdentifiers
import ZoodCore
import ZoodEngine

/// Combine several PDFs (in the order shown) into a new file with the engine's `pdf.merge`.
/// Password-protected inputs ask for their password first.
struct CombineView: View {
    let seed: [URL]
    let onDone: (URL) -> Void

    struct Item: Identifiable {
        let id = UUID()
        let url: URL
        let data: Data
        var password: String?
        var needsPassword: Bool
        var pageCount: Int?
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(Library.self) private var library
    @State private var items: [Item] = []
    @State private var picking = false
    @State private var working = false
    @State private var error: String?
    @State private var passwordFor: Item.ID?
    @State private var passwordText = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(items) { item in
                        HStack {
                            Image(systemName: item.needsPassword ? "lock.doc" : "doc.richtext")
                                .foregroundStyle(item.needsPassword ? Color.orange : Color.accentColor)
                            VStack(alignment: .leading) {
                                Text(verbatim: item.url.lastPathComponent).lineLimit(1)
                                if let n = item.pageCount {
                                    Text("combine.pages \(n)").font(.caption).foregroundStyle(.secondary)
                                } else if item.needsPassword {
                                    Button("combine.enterPassword") { passwordFor = item.id }.font(.caption)
                                }
                            }
                        }
                    }
                    .onMove { items.move(fromOffsets: $0, toOffset: $1) }
                    .onDelete { items.remove(atOffsets: $0) }
                    Button("combine.add", systemImage: "plus") { picking = true }
                        .accessibilityIdentifier("combine.add")
                } footer: {
                    Text("combine.footer")
                }
                if let error {
                    Text(verbatim: error).foregroundStyle(.red)
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle(Text(ToolKind.combine.title))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("common.cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if working {
                        ProgressView()
                    } else {
                        Button("combine.run", action: run)
                            .disabled(items.count < 2 || items.contains { $0.needsPassword && $0.pageCount == nil })
                            .accessibilityIdentifier("combine.run")
                    }
                }
            }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.pdf], allowsMultipleSelection: true) { result in
                if case .success(let urls) = result { Task { await add(urls) } }
            }
            .alert(Text("doc.password.title"), isPresented: Binding(get: { passwordFor != nil }, set: { if !$0 { passwordFor = nil } })) {
                SecureField("doc.password.placeholder", text: $passwordText)
                Button("doc.password.open") { applyPassword() }
                Button("common.cancel", role: .cancel) { passwordText = "" }
            }
            .task { await add(seed) }
        }
    }

    private func add(_ urls: [URL]) async {
        for url in urls {
            do {
                let data = try await DocumentLibrary.read(url)
                let check = try WarraqEngine.isEncrypted(data)
                var pages: Int?
                if !check.needsPassword { pages = try? await WarraqEngine(data: data).info().pageCount }
                items.append(Item(url: url, data: data, needsPassword: check.needsPassword, pageCount: pages))
            } catch let e as WarraqError {
                error = "\(url.lastPathComponent): \(EngineMessages.text(for: e))"
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func applyPassword() {
        guard let id = passwordFor, let i = items.firstIndex(where: { $0.id == id }) else { return }
        let pw = passwordText
        passwordText = ""
        let data = items[i].data
        Task {
            if let n = try? await WarraqEngine(data: data, password: pw).info().pageCount {
                items[i].password = pw
                items[i].pageCount = n
            } else {
                error = String(localized: "engine.error.wrongPassword")
            }
        }
    }

    private func run() {
        working = true
        error = nil
        let datas = items.map(\.data)
        let passwords = items.map(\.password)
        Task {
            defer { working = false }
            do {
                let (_, bytes) = try await Task.detached(priority: .userInitiated) {
                    try WarraqEngine.merge(datas, passwords: passwords)
                }.value
                let name = String(localized: "combine.fileName \(Date.now.formatted(date: .numeric, time: .omitted))")
                let url = try DocumentLibrary.saveNew(bytes, name: FileNaming.sanitize(name))
                await library.record(url: url, data: bytes)
                onDone(url)
            } catch let e as WarraqError {
                error = EngineMessages.text(for: e)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
