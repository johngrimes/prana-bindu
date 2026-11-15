// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Port of `src/web/lib/writes.test.ts`: the instant-write queue (spec §2 "Instant writes") and this device's undo
/// history (spec §2/§9).
@MainActor
struct WriteQueueTests {
    /// Counts refreshes; each answers from `results` (true when empty), or hangs while `hang` is set. Like a real
    /// refresh (URLSession), one run in a cancelled task fails.
    @MainActor final class RefreshSpy {
        var calls = 0
        var cancelledCalls = 0
        var results: [Bool] = []
        var hang = false
        private var hung: [CheckedContinuation<Bool, Never>] = []

        func refresh() async -> Bool {
            calls += 1
            if Task.isCancelled {
                cancelledCalls += 1
                return false
            }
            if hang { return await withCheckedContinuation { hung.append($0) } }
            return results.isEmpty ? true : results.removeFirst()
        }

        func finish(_ ok: Bool) {
            let waiting = hung
            hung = []
            for c in waiting { c.resume(returning: ok) }
        }
    }

    let refresh = RefreshSpy()
    let sleeper = ManualSleeper()
    let clock = ManualClock()
    var toasts: [String] { toastLog.messages }
    let toastLog = ToastLog()

    @MainActor final class ToastLog { var messages: [String] = [] }

    /// The TS tests' reader: every task is named "old" and unflagged.
    static let reader = StubReader(readTask: { TaskItem(id: $0, name: "old") })

    func makeQueue() -> WriteQueue {
        let refresh = self.refresh
        let toastLog = self.toastLog
        return WriteQueue(
            WriteQueue.Dependencies(
                client: { APIClient(origin: URL(string: "https://queue.test")!, token: "t") },
                refresh: { await refresh.refresh() },
                reader: Self.reader,
                toast: { message, _ in toastLog.messages.append(message) },
                unauthorized: { _ in },
                sleep: sleeper.sleep,
                now: clock.now))
    }

    func rename(_ id: String, _ name: String) -> [Change] { [.taskFields([id], ["name": .string(name)])] }

    static let ok: WriteSpec.Send = { _, _ in WriteOutcome() }

    static func recorded(_ steps: Int, _ step: Int? = nil, _ previous: Int? = nil) -> WriteSpec.Send {
        { _, _ in WriteOutcome(undo: UndoHeaders(steps: steps, step: step, previous: previous)) }
    }

    @Test func showsPreviewsAtOnceAndSendsOneWriteAtATimeInOrder() async {
        // Arrange
        let queue = makeQueue()
        let a = DeferredSend()
        let b = DeferredSend()
        // Act
        queue.write(WriteSpec(changes: rename("t", "A"), send: a.send))
        queue.write(WriteSpec(changes: rename("t", "B"), send: b.send))
        // Assert: both previews show at once, but only the first write is sent.
        #expect(queue.changes.count == 2)
        await until { a.count == 1 }
        await settle()
        #expect(b.count == 0)
        a.resolve(0)
        await until { b.count == 1 }
    }

    @Test func keepsLandedPreviewsUntilTheRefreshAfterTheQueueDrainsHasLanded() async {
        let queue = makeQueue()
        refresh.hang = true
        let a = DeferredSend()
        queue.write(WriteSpec(changes: rename("t", "A"), send: a.send))
        await until { a.count == 1 }
        a.resolve(0)
        await until { refresh.calls == 1 }
        // The write landed, but its preview stays until the refresh shows the server's state.
        #expect(queue.changes.count == 1)
        #expect(queue.busy == false)
        refresh.finish(true)
        await until { queue.changes.isEmpty }
    }

    @Test func retriesNetworkErrorsAnd5xxWithTheSameKeyFlaggingTheStallMeanwhile() async throws {
        let queue = makeQueue()
        let a = DeferredSend()
        let ticket = queue.write(WriteSpec(changes: rename("t", "A"), send: a.send))
        await until { a.count == 1 }
        a.reject(0, .transport("Network error"))
        await until { queue.retryingSince != nil }
        #expect(sleeper.waiting.contains(WriteQueue.retryDelays[0]))
        sleeper.release(WriteQueue.retryDelays[0])
        await until { a.count == 2 }
        a.reject(1, .server(status: 503, code: "unavailable", message: "Down"))
        await until { sleeper.waiting.contains(WriteQueue.retryDelays[1]) }
        sleeper.release(WriteQueue.retryDelays[1])
        await until { a.count == 3 }
        a.resolve(2)
        _ = try await ticket.value()
        // Every attempt carried the same idempotency key, so the server applies the write once.
        #expect(Set(a.keys).count == 1)
        #expect(queue.retryingSince == nil)
        #expect(toasts.isEmpty)
    }

    @Test func showsSavingOnceRetryingLongerThanTwoSeconds() async {
        let queue = makeQueue()
        let a = DeferredSend()
        queue.write(WriteSpec(changes: rename("t", "A"), send: a.send))
        await until { a.count == 1 }
        a.reject(0, .transport("Network error"))
        await until { sleeper.waiting.contains(WriteQueue.stalledAfter) }
        #expect(queue.isSaving == false)
        sleeper.release(WriteQueue.stalledAfter)
        await until { queue.isSaving }
        // Once the write lands, "Saving…" goes away.
        sleeper.release(WriteQueue.retryDelays[0])
        await until { a.count == 2 }
        a.resolve(1)
        await until { !queue.isSaving }
    }

    @Test func on4xxDiscardsTheWriteAndLaterOnesRevertingPreviewsWithOneToast() async {
        let queue = makeQueue()
        refresh.hang = true  // The refresh after the failure never lands, so the landed write's preview stays.
        let a = DeferredSend()
        let b = DeferredSend()
        let c = DeferredSend()
        queue.write(WriteSpec(changes: rename("t", "A"), send: a.send))
        let failing = queue.write(WriteSpec(label: "Edit Action", changes: rename("t", "B"), send: b.send))
        let later = queue.write(WriteSpec(label: "Edit Action", changes: rename("u", "C"), send: c.send))
        await until { a.count == 1 }
        a.resolve(0)
        await until { b.count == 1 }
        b.reject(0, .server(status: 422, code: "invalid", message: "Bad date."))
        await #expect(throws: WriteError.failed(.server(status: 422, code: "invalid", message: "Bad date."))) { try await failing.value() }
        await #expect(throws: WriteError.discarded) { try await later.value() }
        #expect(c.count == 0)
        #expect(queue.changes == rename("t", "A"))
        #expect(queue.undoStack.isEmpty)
        #expect(toasts == ["Couldn't save: Bad date. 1 later change was undone."])
    }

    @Test func givesUpAfterTheRetriesRunOut() async {
        let queue = makeQueue()
        let a = DeferredSend()
        let ticket = queue.write(WriteSpec(changes: rename("t", "A"), send: a.send))
        for i in 0...WriteQueue.retryDelays.count {
            await until { a.count == i + 1 }
            a.reject(i, .server(status: 502, code: "bad_gateway", message: "Bad gateway"))
            if i < WriteQueue.retryDelays.count {
                await until { sleeper.waiting.contains(WriteQueue.retryDelays[i]) }
                sleeper.release(WriteQueue.retryDelays[i])
            }
        }
        await #expect(throws: WriteError.failed(.server(status: 502, code: "bad_gateway", message: "Bad gateway"))) { try await ticket.value() }
        #expect(a.count == WriteQueue.retryDelays.count + 1)
        #expect(queue.changes.isEmpty)
        #expect(toasts == ["Couldn't save: Bad gateway."])
    }

    @Test func recordsUndoStepsWithOverwrittenValuesAndClearsRedoOnANewWrite() async {
        let queue = makeQueue()
        queue.write(WriteSpec(label: "Edit Action", changes: rename("t", "new"), send: Self.ok))
        #expect(queue.undoStack.count == 1)
        let step = queue.takeStep(.undo, serverNewest: nil)
        // The snapshot restores what was shown before the write.
        #expect(step?.undo == [.taskFields(["t"], ["name": .string("old")])])
        #expect(queue.redoStack.count == 1)
        queue.write(WriteSpec(label: "Edit Action", changes: rename("t", "other"), send: Self.ok))
        #expect(queue.redoStack.isEmpty)
    }

    @Test func keepsUsingOwnSnapshotsWhileTheServersNewestStepIsOurs() async {
        let queue = makeQueue()
        queue.write(WriteSpec(label: "Edit Action", changes: rename("t", "A"), send: Self.recorded(1, 5, 0)))
        queue.write(WriteSpec(label: "Edit Action", changes: rename("t", "B"), send: Self.recorded(1, 6, 5)))
        await until { !queue.busy }
        // History read before either undo still names step 6, which this device made.
        #expect(queue.takeStep(.undo, serverNewest: 6)?.redo == rename("t", "B"))
        #expect(queue.takeStep(.undo, serverNewest: 6)?.redo == rename("t", "A"))
        #expect(queue.takeStep(.redo, serverNewest: 6)?.redo == rename("t", "A"))
        // Step 9 was made elsewhere: the server will act on that one, so these snapshots no longer apply.
        #expect(queue.takeStep(.redo, serverNewest: 9) == nil)
        #expect(queue.undoStack.isEmpty && queue.redoStack.isEmpty)
    }

    @Test func stopsUsingOwnSnapshotsPastAStepMadeElsewhereBetweenTwoOfOurs() async {
        let queue = makeQueue()
        queue.write(WriteSpec(label: "Edit Action", changes: rename("t", "A"), send: Self.recorded(1, 5, 0)))
        // Step 6 was made elsewhere, then this device recorded step 7 on top of it.
        queue.write(WriteSpec(label: "Edit Action", changes: rename("t", "C"), send: Self.recorded(1, 7, 6)))
        await until { !queue.busy }
        #expect(queue.takeStep(.undo, serverNewest: 7)?.redo == rename("t", "C"))
        // The server's next undo is step 6, not this device's step 5.
        #expect(queue.takeStep(.undo, serverNewest: 7) == nil)
    }

    @Test func seesAStepMadeElsewhereEvenBeforeHistoryHasCaughtUp() async {
        let queue = makeQueue()
        queue.write(WriteSpec(label: "Edit Action", changes: rename("t", "A"), send: Self.recorded(1, 5, 0)))
        queue.write(WriteSpec(label: "Edit Action", changes: rename("t", "C"), send: Self.recorded(1, 7, 6)))
        await until { !queue.busy }
        // History still names step 5, but this device knows the server has step 7, which follows step 6.
        #expect(queue.takeStep(.undo, serverNewest: 5)?.redo == rename("t", "C"))
        #expect(queue.takeStep(.undo, serverNewest: 5) == nil)
    }

    @Test func followsTheServersUndoHistory() async {
        let queue = makeQueue()
        queue.write(WriteSpec(label: "Edit Action", changes: rename("t", "A"), send: Self.recorded(1)))
        queue.write(WriteSpec(label: "Clean Up", changes: [], send: Self.recorded(0)))
        #expect(queue.undoStack.map(\.label) == ["Edit Action", "Clean Up"])
        await until { !queue.busy }
        // A write the server recorded no step for loses its own.
        #expect(queue.undoStack.map(\.label) == ["Edit Action"])
        // A discard expected to erase the creation step deleted the item instead: a surprise clears everything.
        queue.write(WriteSpec(changes: [], send: Self.recorded(1), erases: true))
        await until { queue.undoStack.isEmpty }
    }

    @Test func keepsLandedPreviewsWhileTheRefreshCannotReachTheServerAndTriesAgain() async {
        let queue = makeQueue()
        refresh.results = [false]
        queue.write(WriteSpec(changes: rename("t", "A"), send: Self.ok))
        await until { refresh.calls == 1 }
        #expect(queue.changes.count == 1)
        await until { sleeper.waiting.contains(WriteQueue.refreshRetryDelay) }
        sleeper.release(WriteQueue.refreshRetryDelay)
        await until { refresh.calls == 2 }
        await settle()
        #expect(refresh.cancelledCalls == 0, "the retry refresh ran in a cancelled task")
        #expect(queue.changes.isEmpty, "landed previews were not released by the retry")
    }

    @Test func startsAnUploadOnlyAfterTheWriteCreatingItsTaskHasLanded() async {
        let queue = makeQueue()
        let create = DeferredSend()
        let upload = DeferredSend()
        queue.write(WriteSpec(changes: [], send: create.send, creates: ["n"]))
        #expect(queue.unconfirmed.contains("n"))
        queue.write(WriteSpec(changes: [], send: upload.send, lane: .upload, waitFor: ["n"]))
        await until { create.count == 1 }
        await settle()
        #expect(upload.count == 0)
        create.resolve(0)
        await until { upload.count == 1 }
        #expect(!queue.unconfirmed.contains("n"))
    }

    @Test func countsAnUploadWaitingForARejectedCreateInTheOneFailureReport() async {
        let queue = makeQueue()
        let create = DeferredSend()
        queue.write(WriteSpec(changes: rename("n", "N"), send: create.send, creates: ["n"]))
        let upload = queue.write(WriteSpec(changes: [], send: Self.ok, lane: .upload, waitFor: ["n"]))
        await until { create.count == 1 }
        create.reject(0, .server(status: 422, code: "invalid", message: "Nope."))
        await #expect(throws: WriteError.discarded) { try await upload.value() }
        #expect(toasts == ["Couldn't save: Nope. 1 later change was undone."])
    }

    @Test func stopsFlaggingAStallOnceAnUploadGivesUp() async {
        let queue = makeQueue()
        let upload = queue.write(
            WriteSpec(changes: [], send: { _, _ throws(APIError) in throw .server(status: 503, code: "down", message: "Storage down") }, lane: .upload))
        await until { queue.retryingSince != nil }
        for delay in WriteQueue.retryDelays {
            await until { sleeper.waiting.contains(delay) }
            sleeper.release(delay)
        }
        await #expect(throws: WriteError.failed(.server(status: 503, code: "down", message: "Storage down"))) { try await upload.value() }
        #expect(queue.retryingSince == nil)
    }

    @Test func skipsAWriteWhoseSkipSaysSo() async {
        // An undo of a step the server never recorded sends nothing.
        let queue = makeQueue()
        let a = DeferredSend()
        let ticket = queue.write(WriteSpec(changes: [], send: a.send, skip: { true }))
        _ = try? await ticket.value()
        #expect(a.count == 0)
    }

    @Test func reportsUnauthorisedWithoutAToast() async {
        var signedOut: [String] = []
        let queue = WriteQueue(
            WriteQueue.Dependencies(
                client: { APIClient(origin: URL(string: "https://queue.test")!, token: "t") },
                refresh: { true }, reader: Self.reader, toast: { message, _ in self.toastLog.messages.append(message) },
                unauthorized: { signedOut.append($0) }, sleep: sleeper.sleep, now: clock.now))
        let ticket = queue.write(WriteSpec(changes: rename("t", "A"), send: { _, _ throws(APIError) in throw .unauthorized(message: "Token rejected") }))
        _ = try? await ticket.value()
        #expect(signedOut == ["Token rejected"])
        #expect(toasts.isEmpty)
    }

    @Test func failsACancelledWriteAtOnceWithoutRetryingOrToasting() async {
        let queue = makeQueue()
        let a = DeferredSend()
        let ticket = queue.write(WriteSpec(changes: rename("t", "A"), send: a.send))
        await until { a.count == 1 }
        a.reject(0, .cancelled)
        await #expect(throws: WriteError.failed(.cancelled)) { try await ticket.value() }
        await settle()
        #expect(a.count == 1)
        #expect(sleeper.waiting.isEmpty)
        #expect(queue.changes.isEmpty)
        #expect(toasts.isEmpty)
    }

    @Test func forgetsTheCreationStepWhenItIsNewest() async {
        let queue = makeQueue()
        queue.write(WriteSpec(label: "Add Action", changes: [], send: Self.ok, creates: ["n"]))
        #expect(queue.forgetCreation("x") == false)
        #expect(queue.forgetCreation("n"))
        #expect(queue.undoStack.isEmpty)
        #expect(queue.createdHere("n"))
    }
}
