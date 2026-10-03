import NMCore
import NMData
import SwiftUI

struct Turn: Identifiable {
    let id = UUID()
    let question: String
    var answer: Answer?
    var citations: [ResolvedCitation] = []
    var related: [ResolvedCitation] = []
}

/// Conversation is kept in memory only: not persisted and never sent anywhere.
@MainActor
@Observable
final class AskModel {
    var turns: [Turn] = []
    var busy = false
    private var task: Task<Void, Never>?

    func ask(_ app: AppModel, _ text: String) {
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !busy, let repo = app.ask else { return }
        let context = turns.suffix(2).map(\.question)
        run(app, q) { try repo.ask(q, context: context) }
    }

    func ask(_ app: AppModel, common q: CommonQuestion, displayed: String) {
        guard let repo = app.ask else { return }
        run(app, displayed) { try repo.answer(for: q, displayed: displayed) }
    }

    private func run(_ app: AppModel, _ question: String, _ block: @escaping @Sendable () throws -> Answer) {
        guard let repo = app.ask else { return }
        let turn = Turn(question: question)
        turns.append(turn)
        busy = true
        let lang = app.l10n.language
        task = Task {
            defer { busy = false }
            guard var answer = try? await Task.detached(operation: block).value else { return }
            let cites = (try? repo.resolve(answer.citations)) ?? []
            let related = (try? repo.resolve(answer.related)) ?? []
            if answer.kind == .passages, let written = await LocalAnswerer.write(question: question, passages: cites, language: lang) {
                answer.generated = written
            }
            guard !Task.isCancelled, let i = turns.firstIndex(where: { $0.id == turn.id }) else { return }
            turns[i].answer = answer
            turns[i].citations = cites
            turns[i].related = related
        }
    }

    func stop() {
        task?.cancel()
        turns.removeAll { $0.answer == nil }
        busy = false
    }

    func reset() { task?.cancel(); turns = []; busy = false }
}

struct AskView: View {
    @Environment(AppModel.self) private var app
    @Environment(Localization.self) private var l10n
    @Binding var showSettings: Bool
    @State private var vm = AskModel()
    @State private var input = ""
    @State private var reading: ResolvedCitation?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
        header.padding(.horizontal, 16)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if vm.turns.isEmpty {
                        // Leaves the mosque skyline on the horizon visible above the intro.
                        Color.clear.frame(height: 130)
                        intro
                    }
                    ForEach(vm.turns) { t in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Spacer(minLength: 40)
                                Text(t.question).padding(.horizontal, 16).padding(.vertical, 12)
                                    .glass(RoundedRectangle(cornerRadius: 20, style: .continuous), tint: Theme.navy.opacity(0.55))
                            }
                            if let a = t.answer {
                                AnswerCard(turn: t, answer: a, onRead: { reading = $0 })
                                    .transition(.move(edge: .bottom).combined(with: .opacity))
                            } else {
                                HStack(spacing: 10) {
                                    ProgressView().tint(.white)
                                    Text(l10n.t("answer_searching"))
                                    Spacer()
                                    Button(l10n.t("stop")) { vm.stop() }.glassButton()
                                }
                                .glassCard(padding: 12)
                            }
                        }
                        .id(t.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
                .animation(Theme.spring, value: vm.turns.map(\.answer?.question))
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: vm.turns.last?.answer?.question) { _, _ in
                if let id = vm.turns.last?.id { withAnimation { proxy.scrollTo(id, anchor: .top) } }
            }
        }
        }
        .foregroundStyle(.white)
        .safeAreaInset(edge: .bottom) { inputBar }
        .skyBackground(horizon: 0.3, skyline: true)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(item: $reading) { ReaderView(citation: $0) }
        #if DEBUG
        .task(id: app.ready) {
            // CI screenshots: `-demoAsk YES` asks the first common question.
            guard app.ready, vm.turns.isEmpty, UserDefaults.standard.bool(forKey: "demoAsk"),
                  let q = try? app.ask?.commonQuestions().first else { return }
            vm.ask(app, common: q, displayed: q.question[l10n.language] ?? q.question["en"] ?? q.id)
        }
        #endif
    }

    private var header: some View {
        HStack {
            if !vm.turns.isEmpty {
                GlassIconButton(systemImage: "square.and.pencil", label: l10n.t("new_conversation")) { withAnimation(Theme.spring) { vm.reset() } }
            } else {
                Color.clear.frame(width: 44, height: 44)
            }
            Spacer()
            Text(l10n.t("ask_title")).font(.headline).lineLimit(1).minimumScaleFactor(0.8)
            Spacer()
            SettingsButton(show: $showSettings)
        }
        .padding(.top, 4)
        .padding(.bottom, 8)
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(l10n.t("ask_title")).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
            Text(l10n.t("ask_subtitle")).foregroundStyle(.white.opacity(0.85))
            if LocalAnswerer.availability(language: l10n.language) != .available {
                Label(l10n.t("ai_pack_not_installed"), systemImage: "lock.shield").font(.footnote).foregroundStyle(.white.opacity(0.75))
            }
            Text(l10n.t("common_questions")).font(.headline).padding(.top, 8).accessibilityAddTraits(.isHeader)
            if !app.ready { ProgressView().tint(.white) }
            let qs = (try? app.ask?.commonQuestions()) ?? []
            GlassGroup(spacing: 8) {
                FlowLayout(spacing: 8) {
                    ForEach(qs) { q in
                        let text = q.question[l10n.language] ?? q.question["en"] ?? q.id
                        Button { vm.ask(app, common: q, displayed: text) } label: {
                            Text(text).font(.subheadline).multilineTextAlignment(.leading)
                                .padding(.horizontal, 14).padding(.vertical, 10)
                                .frame(minHeight: 44)
                                .contentShape(RoundedRectangle(cornerRadius: 18))
                        }
                        .buttonStyle(.plain)
                        .glass(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                }
            }
        }
    }

    private var inputBar: some View {
        GlassGroup(spacing: 10) {
            HStack(spacing: 10) {
                TextField(l10n.t(vm.turns.isEmpty ? "ask_placeholder" : "ask_follow_up_placeholder"), text: $input, axis: .vertical)
                    .lineLimit(1...4)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .glass(RoundedRectangle(cornerRadius: 24, style: .continuous))
                Button(action: send) {
                    Image(systemName: "arrow.up").font(.headline.weight(.bold)).frame(width: 30, height: 30)
                }
                .prominentButton()
                .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty || vm.busy)
                .accessibilityLabel(l10n.t("ask_send"))
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
    }

    private func send() {
        vm.ask(app, input)
        input = ""
    }
}

struct AnswerCard: View {
    @Environment(Localization.self) private var l10n
    @Environment(\.colorScheme) private var scheme
    let turn: Turn
    let answer: Answer
    var onRead: (ResolvedCitation) -> Void
    @State private var more = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch answer.kind {
            case .common:
                let q = answer.commonQuestion!
                Text(q.isReviewed ? l10n.t("answer_common_reviewed", q.reviewedBy ?? "") : l10n.t("answer_common_unreviewed"))
                    .font(.footnote.weight(.semibold)).foregroundStyle(Theme.gold)
                Text(q.summary[l10n.language] ?? q.summary["en"] ?? "")
            case .passages:
                if let g = answer.generated {
                    Text(l10n.t("answer_generated_on_device")).font(.footnote.weight(.semibold)).foregroundStyle(Theme.gold)
                    Text(g)
                } else {
                    Text(l10n.t("answer_from_passages")).font(.headline)
                    Text(l10n.t("answer_from_passages_body")).font(.subheadline)
                }
            case .insufficient:
                Text(l10n.t("answer_insufficient_title")).font(.headline)
                Text(l10n.t("answer_insufficient_body")).font(.subheadline)
            }
            if !turn.citations.isEmpty {
                Text(l10n.t("sources")).font(.subheadline.weight(.semibold)).accessibilityAddTraits(.isHeader)
                ForEach(Array(turn.citations.enumerated()), id: \.element.id) { i, c in SourceCard(index: i + 1, citation: c, onRead: onRead) }
            }
            if !turn.related.isEmpty {
                Button(l10n.t(more ? "show_less_detail" : "show_more_detail")) { withAnimation { more.toggle() } }
                if more {
                    Text(l10n.t("related_passages")).font(.subheadline.weight(.semibold))
                    ForEach(turn.related) { SourceCard(index: nil, citation: $0, onRead: onRead) }
                }
            }
            if !["ar", "en"].contains(l10n.language), answer.kind != .insufficient {
                Text(l10n.t("answer_language_note")).font(.caption).foregroundStyle(.white.opacity(0.7))
            }
            Text(l10n.t("answer_not_fatwa")).font(.caption).foregroundStyle(.white.opacity(0.7))
        }
        .foregroundStyle(.white)
        .glassCard()
    }
}

/// Wraps chips onto multiple lines (mirrors automatically in RTL).
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(ProposedViewSize(width: width, height: nil))
            if x + size.width > width, x > 0 { x = 0; y += rowH + spacing; rowH = 0 }
            x += size.width + spacing
            rowH = max(rowH, size.height)
        }
        return CGSize(width: width == .infinity ? x : width, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x + size.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowH = max(rowH, size.height)
        }
    }
}
