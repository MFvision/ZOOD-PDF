import BackgroundTasks
import Foundation
import UIKit

/// Keeps a batch going when the app leaves the screen, as far as iOS allows.
///
/// From iOS 26 a batch the person started is a continued-processing task
/// (`BGContinuedProcessingTaskRequest`): the system shows its progress
/// outside the app and lets it run on in the background until it finishes —
/// or until the system, or the person from that progress, ends it. Before
/// iOS 26, and wherever the request is refused, the app asks for the few
/// seconds to half a minute iOS gives any app as it leaves the screen
/// (`beginBackgroundTask`). Either way, when the time is taken back
/// `expired` is called, and the batch stops and says that the system
/// stopped it.
@MainActor
final class BatchBackground {
    /// Identifiers are the app's own plus a suffix for each run, as the
    /// wildcard in Info.plist's `BGTaskSchedulerPermittedIdentifiers` allows.
    static let identifierPrefix = "app.warraq.ios.batch."

    /// How the batch is being kept alive, for the screen to say.
    enum Kind: Equatable {
        case none
        case continued
        case shortGrace
    }

    private(set) var kind: Kind = .none
    private var expired: (() -> Void)?
    private var grace: UIBackgroundTaskIdentifier = .invalid
    /// The continued-processing task, once the system has started it.
    private var task: AnyObject?
    private var total: Int64 = 1
    private var completed: Int64 = 0
    private var finished = false

    /// Starts keeping the batch alive. `expired` runs on the main actor when
    /// the system takes the time back.
    func begin(title: String, subtitle: String, total: Int, expired: @escaping () -> Void) {
        self.expired = expired
        self.total = Int64(max(1, total))
        completed = 0
        finished = false
        if #available(iOS 26.0, *), submitContinued(title: title, subtitle: subtitle) {
            kind = .continued
            return
        }
        beginGrace()
    }

    /// The batch moved on: `done` of the files are finished.
    func progress(done: Int, subtitle: String) {
        completed = Int64(done)
        if #available(iOS 26.0, *), let task = task as? BGContinuedProcessingTask {
            task.progress.totalUnitCount = total
            task.progress.completedUnitCount = completed
            task.updateTitle(task.title, subtitle: subtitle)
        }
    }

    /// The batch is over (finished, stopped or failed): the time is given back.
    func end(success: Bool) {
        finished = true
        if #available(iOS 26.0, *), let task = task as? BGContinuedProcessingTask {
            task.progress.completedUnitCount = total
            task.setTaskCompleted(success: success)
        }
        task = nil
        endGrace()
        kind = .none
        expired = nil
    }

    // MARK: - iOS 26: continued processing

    @available(iOS 26.0, *)
    private func submitContinued(title: String, subtitle: String) -> Bool {
        let identifier = Self.identifierPrefix + UUID().uuidString
        // A handler for this run's identifier: continued-processing tasks
        // may register after launch, one identifier each time.
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { [weak self] task in
            let held = HeldTask(task: task)
            MainActor.assumeIsolated {
                self?.started(held.task)
            }
        }
        guard registered else { return false }
        let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: title, subtitle: subtitle)
        // Run now or not at all: a batch queued for later would surprise the person.
        request.strategy = .fail
        do {
            try BGTaskScheduler.shared.submit(request)
            return true
        } catch {
            return false
        }
    }

    @available(iOS 26.0, *)
    private func started(_ task: BGTask) {
        guard let continued = task as? BGContinuedProcessingTask else {
            task.setTaskCompleted(success: false)
            return
        }
        if finished {
            // The batch was over before the system got round to it.
            continued.setTaskCompleted(success: true)
            return
        }
        self.task = continued
        continued.progress.totalUnitCount = total
        continued.progress.completedUnitCount = completed
        continued.expirationHandler = { [weak self] in
            Task { @MainActor in self?.systemStopped() }
        }
    }

    /// A BGTask crosses from the scheduler's queue (the main queue, as
    /// registered) to the main actor; nothing else holds it.
    private struct HeldTask: @unchecked Sendable { let task: BGTask }

    // MARK: - Before iOS 26: the grace period

    private func beginGrace() {
        kind = .shortGrace
        grace = UIApplication.shared.beginBackgroundTask(withName: "Batch") { [weak self] in
            MainActor.assumeIsolated {
                self?.systemStopped()
            }
        }
    }

    private func endGrace() {
        if grace != .invalid {
            UIApplication.shared.endBackgroundTask(grace)
            grace = .invalid
        }
    }

    private func systemStopped() {
        let expired = self.expired
        if #available(iOS 26.0, *), let task = task as? BGContinuedProcessingTask {
            task.setTaskCompleted(success: false)
        }
        task = nil
        endGrace()
        kind = .none
        self.expired = nil
        expired?()
    }
}
