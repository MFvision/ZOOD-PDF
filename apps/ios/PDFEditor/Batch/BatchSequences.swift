import Foundation

/// A sequence of steps the person named and kept, to run again.
struct SavedSequence: Codable, Identifiable, Equatable, Sendable {
    var name: String
    var steps: [BatchStep]
    var savedAt: Date

    var id: String { name }
}

/// Saved sequences, on this device only, in the app's defaults — the
/// desktop keeps its "actions" the same way. A step holds no password by
/// construction (Protect asks when it runs), so none can be saved. Read back,
/// every step is checked (`BatchStep.init(from:)`) and a damaged entry is
/// dropped rather than breaking the screen.
struct BatchSequenceStore {
    static let maxSequences = 50
    static let maxSteps = 30
    static let maxName = 80

    let defaults: UserDefaults
    let key: String

    init(defaults: UserDefaults = .standard, key: String = "batch.sequences") {
        self.defaults = defaults
        self.key = key
    }

    /// A name as typed: spaces collapsed, trimmed, cut to length.
    static func clean(_ name: String) -> String {
        let collapsed = name.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return String(collapsed.prefix(maxName))
    }

    /// Newest first.
    func load() -> [SavedSequence] {
        guard let data = defaults.data(forKey: key),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
        var out: [SavedSequence] = []
        let decoder = JSONDecoder()
        for entry in raw.prefix(Self.maxSequences) {
            guard let object = entry as? [String: Any], let name = object["name"] as? String else { continue }
            let clean = Self.clean(name)
            guard !clean.isEmpty, !out.contains(where: { $0.name == clean }) else { continue }
            let steps = ((object["steps"] as? [Any]) ?? []).prefix(Self.maxSteps).compactMap { step -> BatchStep? in
                guard JSONSerialization.isValidJSONObject(step), let bytes = try? JSONSerialization.data(withJSONObject: step) else { return nil }
                return try? decoder.decode(BatchStep.self, from: bytes)
            }
            guard !steps.isEmpty else { continue }
            let seconds = object["savedAt"] as? Double ?? 0
            out.append(SavedSequence(name: clean, steps: steps, savedAt: Date(timeIntervalSince1970: seconds)))
        }
        return out
    }

    /// Saves `steps` as `name`, replacing one of that name; answers every sequence.
    @discardableResult
    func save(name: String, steps: [BatchStep], now: Date = .now) -> [SavedSequence] {
        let clean = Self.clean(name)
        guard !clean.isEmpty, !steps.isEmpty else { return load() }
        let saved = SavedSequence(name: clean, steps: Array(steps.prefix(Self.maxSteps)), savedAt: now)
        let all = Array(([saved] + load().filter { $0.name != clean }).prefix(Self.maxSequences))
        write(all)
        return all
    }

    @discardableResult
    func delete(name: String) -> [SavedSequence] {
        let all = load().filter { $0.name != name }
        write(all)
        return all
    }

    private func write(_ sequences: [SavedSequence]) {
        let entries: [[String: Any]] = sequences.compactMap { sequence in
            guard let steps = try? JSONEncoder().encode(sequence.steps),
                  let list = try? JSONSerialization.jsonObject(with: steps) else { return nil }
            return ["name": sequence.name, "steps": list, "savedAt": sequence.savedAt.timeIntervalSince1970]
        }
        if let data = try? JSONSerialization.data(withJSONObject: entries) {
            defaults.set(data, forKey: key)
        }
    }
}
