// Author: John Grimes

import Foundation
import Synchronization
import Testing

@testable import PranaKit

// Swift Testing also declares `Tag` and `Attachment`; in these tests they mean the app's models.
typealias Tag = PranaKit.Tag
typealias Attachment = PranaKit.Attachment

/// Waits (up to about two seconds) until `condition` holds, letting queued work run meanwhile.
@MainActor
func until(_ what: String = "condition", _ condition: () -> Bool, sourceLocation: SourceLocation = #_sourceLocation) async {
    for _ in 0..<2000 {
        if condition() { return }
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(1))
    }
    Issue.record("Timed out waiting for \(what)", sourceLocation: sourceLocation)
}

/// Lets queued work run for a moment (the equivalent of vitest's `advanceTimersByTimeAsync(0)`).
@MainActor
func settle() async {
    for _ in 0..<20 {
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(1))
    }
}

/// A send whose answers the test controls; records the idempotency key of every attempt.
final class DeferredSend: Sendable {
    private struct Call {
        var key: String
        var continuation: CheckedContinuation<Result<WriteOutcome, APIError>, Never>?
    }

    private let calls = Mutex<[Call]>([])

    /// Number of attempts so far.
    var count: Int { calls.withLock { $0.count } }
    /// The idempotency keys of all attempts.
    var keys: [String] { calls.withLock { $0.map(\.key) } }

    /// The send closure to put in a `WriteSpec`.
    var send: WriteSpec.Send {
        { [self] _, key throws(APIError) in
            let result = await withCheckedContinuation { continuation in
                calls.withLock { $0.append(Call(key: key, continuation: continuation)) }
            }
            return try result.get()
        }
    }

    /// Answers attempt `index` successfully.
    func resolve(_ index: Int, _ outcome: WriteOutcome = WriteOutcome()) {
        answer(index, .success(outcome))
    }

    /// Fails attempt `index`.
    func reject(_ index: Int, _ error: APIError) {
        answer(index, .failure(error))
    }

    private func answer(_ index: Int, _ result: Result<WriteOutcome, APIError>) {
        let continuation = calls.withLock { calls -> CheckedContinuation<Result<WriteOutcome, APIError>, Never>? in
            guard index < calls.count else { return nil }
            defer { calls[index].continuation = nil }
            return calls[index].continuation
        }
        continuation?.resume(returning: result)
    }
}

/// A sleep the test releases by hand, so retry timing is tested without real waiting.
final class ManualSleeper: Sendable {
    private let pending = Mutex<[(Duration, CheckedContinuation<Void, Never>)]>([])
    private let history = Mutex<[Duration]>([])

    /// Durations of every sleep requested so far.
    var requested: [Duration] { history.withLock { $0 } }
    /// Durations of the sleeps still waiting.
    var waiting: [Duration] { pending.withLock { $0.map(\.0) } }

    /// The sleep closure to inject.
    var sleep: @Sendable (Duration) async -> Void {
        { [self] duration in
            history.withLock { $0.append(duration) }
            await withCheckedContinuation { continuation in
                pending.withLock { $0.append((duration, continuation)) }
            }
        }
    }

    /// Ends every pending sleep of `duration` (or all of them when nil).
    func release(_ duration: Duration? = nil) {
        let due = pending.withLock { pending -> [CheckedContinuation<Void, Never>] in
            let matching = pending.filter { duration == nil || $0.0 == duration }
            pending.removeAll { duration == nil || $0.0 == duration }
            return matching.map(\.1)
        }
        for continuation in due { continuation.resume() }
    }
}

/// A clock the test moves by hand.
final class ManualClock: Sendable {
    private let current = Mutex(Date(timeIntervalSince1970: 1_793_880_000))

    var now: @Sendable () -> Date { { [self] in current.withLock { $0 } } }

    func advance(_ seconds: TimeInterval) { current.withLock { $0 += seconds } }
}

/// A state reader backed by closures, like the TS tests' `reader` objects.
struct StubReader: StateReader {
    var readTask: @MainActor (String) -> TaskItem? = { _ in nil }
    var readProjectRecord: @MainActor (String) -> ProjectRecord? = { _ in nil }
    var readOutline: @MainActor () -> [OutlineGroup]? = { nil }
    var readItem: @MainActor (ListName, String) -> ListItem?? = { _, _ in .none }
    var readSettings: @MainActor () -> Settings? = { nil }
    var readAttachment: @MainActor (String, String) -> Attachment?? = { _, _ in .none }

    func task(_ id: String) -> TaskItem? { readTask(id) }
    func projectRecord(_ id: String) -> ProjectRecord? { readProjectRecord(id) }
    func outline() -> [OutlineGroup]? { readOutline() }
    func item(_ list: ListName, _ id: String) -> ListItem?? { readItem(list, id) }
    func settings() -> Settings? { readSettings() }
    func attachment(taskId: String, id: String) -> Attachment?? { readAttachment(taskId, id) }
}

/// Settings used by preview tests (UTC, dd/MM/yyyy, two days due soon).
let testSettings = Settings(
    timeZone: "UTC", dateFormat: .dayMonthYear, firstWeekday: 1, use24HourTime: false, defaultDeferTime: "00:00",
    defaultDueTime: "17:00", defaultPlannedTime: "09:00", dueSoonSeconds: 172_800, theme: .system, forecastTagId: nil)
