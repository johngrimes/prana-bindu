// Author: John Grimes

import Foundation
import Observation

/// Which queue a write runs in.
public enum Lane: Sendable, Hashable {
    /// The serial queue, in gesture order.
    case main
    /// Attachment uploads, beside the main queue so they never hold it up.
    case upload
}

/// What a landed write returned: its undo headers and decoded response.
public struct WriteOutcome: Sendable {
    public var undo: UndoHeaders
    /// The decoded response (`Changed`, `TaskItem`, `History`, `Attachment`, …), when there is one.
    public var value: (any Sendable)?

    /// Creates an outcome.
    public init(undo: UndoHeaders = .none, value: (any Sendable)? = nil) {
        self.undo = undo
        self.value = value
    }
}

/// One write: its preview and how to send it (port of `WriteSpec` in `src/web/lib/writes.ts`).
public struct WriteSpec: Sendable {
    /// Sends the request with the given client and Idempotency-Key.
    public typealias Send = @Sendable (APIClient, String) async throws(APIError) -> WriteOutcome

    /// The server's undo label when the write is journaled; records an instant-undo snapshot. Nil: not undoable.
    public var label: String?
    /// Shown from now until the refresh after the write lands; reverted if it fails.
    public var changes: [Change]
    public var send: Send
    /// Replaces `changes` once the write lands (e.g. an upload's stand-in id swapped for the server's).
    public var landed: (@Sendable (WriteOutcome) -> [Change])?
    /// Ids this write creates: uploads (and requests) about them wait until it lands.
    public var creates: [String]
    /// The write erases the newest undo step instead of adding one (discarding a just-created item).
    public var erases: Bool
    public var lane: Lane
    /// Uploads start after the writes creating these ids land.
    public var waitFor: [String]
    /// Checked when the write's turn comes: true finishes it without sending.
    public var skip: (@MainActor @Sendable () -> Bool)?
    /// Called on the main actor when the write lands, before later writes waiting for it are let through.
    public var onSuccess: (@MainActor @Sendable (WriteOutcome) -> Void)?

    /// Whether the write records an undo step.
    public var undoable: Bool { label != nil }

    /// Creates a write.
    public init(
        label: String? = nil, changes: [Change] = [], send: @escaping Send, landed: (@Sendable (WriteOutcome) -> [Change])? = nil,
        creates: [String] = [], erases: Bool = false, lane: Lane = .main, waitFor: [String] = [],
        skip: (@MainActor @Sendable () -> Bool)? = nil, onSuccess: (@MainActor @Sendable (WriteOutcome) -> Void)? = nil
    ) {
        self.label = label
        self.changes = changes
        self.send = send
        self.landed = landed
        self.creates = creates
        self.erases = erases
        self.lane = lane
        self.waitFor = waitFor
        self.skip = skip
        self.onSuccess = onSuccess
    }

    /// A send for one REST request: the response value and undo headers become the outcome.
    public static func sending<T: Decodable & Sendable>(_ request: APIRequest<T>) -> Send {
        { client, key throws(APIError) in
            let response = try await client.send(request, idempotencyKey: key)
            return WriteOutcome(undo: response.undo, value: response.value)
        }
    }
}

/// Why a write did not land.
public enum WriteError: Error, Sendable, Equatable {
    /// The server rejected it (4xx), or its retries ran out.
    case failed(APIError)
    /// An earlier write failed, so this one was discarded unsent.
    case discarded
}

/// A queued write's progress.
public enum WriteState: Sendable, Hashable {
    case queued, sending, done
}

/// A queued, in-flight or landed write (until the refresh after it lands releases its preview).
@MainActor
public final class PendingWrite: Identifiable {
    /// Stable identity.
    public let id = UUID()
    /// The write.
    public let spec: WriteSpec
    /// The Idempotency-Key every attempt carries.
    public let key: String
    public internal(set) var state: WriteState = .queued
    /// The preview shown for it now.
    public internal(set) var changes: [Change]
    /// When its attempts started failing transiently (nil while not retrying).
    public internal(set) var retryingSince: Date?
    /// What it returned, once it landed.
    public internal(set) var outcome: WriteOutcome?
    private var result: Result<WriteOutcome, WriteError>?
    private var waiters: [CheckedContinuation<Result<WriteOutcome, WriteError>, Never>] = []

    init(spec: WriteSpec, key: String) {
        self.spec = spec
        self.key = key
        self.changes = spec.changes
    }

    func finish(_ result: Result<WriteOutcome, WriteError>) {
        guard self.result == nil else { return }
        self.result = result
        let waiting = waiters
        waiters = []
        for waiter in waiting { waiter.resume(returning: result) }
    }

    func wait() async -> Result<WriteOutcome, WriteError> {
        if let result { return result }
        return await withCheckedContinuation { waiters.append($0) }
    }
}

/// Lets a caller await a queued write (callers need not: the queue reports failures itself).
@MainActor
public struct WriteTicket {
    let entry: PendingWrite

    /// The write's outcome once it lands; throws when it is rejected or discarded.
    public func value() async throws(WriteError) -> WriteOutcome {
        try await entry.wait().get()
    }
}

/// One step of this device's undo history: changes that show the state before (undo) and after (redo) it.
public struct UndoStep: Sendable {
    public var label: String
    public var undo: [Change]
    public var redo: [Change]
    public var creates: [String]
    /// The write that made the step.
    public let entry: PendingWrite
}

/// Undo or redo.
public enum UndoDirection: Sendable {
    case undo, redo
}

/// Kinds of toast.
public enum ToastKind: Sendable, Hashable {
    case info, error
}

/// The instant-write queue (port of `src/web/lib/writes.ts`, spec §2 "Instant writes"). Every write shows its changes
/// at once and is sent from one serial queue, in gesture order. Network errors and 5xx retry with backoff (an
/// Idempotency-Key makes a retry apply once). A 4xx, or running out of retries, discards that write and every write
/// queued after it, reverts their previews and refetches. Previews of landed writes stay until a refresh after the
/// queue drains has succeeded. Uploads run in their own lane.
@MainActor
@Observable
public final class WriteQueue {
    /// Waits between attempts of a write that failed transiently: about 5 s in all.
    public static let retryDelays: [Duration] = [.milliseconds(500), .milliseconds(1500), .milliseconds(3000)]
    /// How long writes may be retrying before the header shows "Saving…".
    public static let stalledAfter: Duration = .seconds(2)
    /// How long to wait before refreshing again when a refresh could not reach the server.
    public static let refreshRetryDelay: Duration = .seconds(3)
    private static let maxUndo = 200

    /// What the queue needs from its owner.
    public struct Dependencies {
        /// The client to send with (nil when signed out).
        public var client: @MainActor () -> APIClient?
        /// Refetches all data; false when the server could not be reached for it.
        public var refresh: @MainActor () async -> Bool
        /// The state as shown, for undo snapshots.
        public var reader: any StateReader
        /// Shows a toast.
        public var toast: @MainActor (String, ToastKind) -> Void
        /// Called with the server's message when a write is answered 401.
        public var unauthorized: @MainActor (String) -> Void
        /// Sleeps (injectable so tests control retry timing).
        public var sleep: @Sendable (Duration) async -> Void
        /// The current time.
        public var now: @Sendable () -> Date

        /// Creates dependencies.
        public init(
            client: @escaping @MainActor () -> APIClient?, refresh: @escaping @MainActor () async -> Bool,
            reader: any StateReader, toast: @escaping @MainActor (String, ToastKind) -> Void,
            unauthorized: @escaping @MainActor (String) -> Void,
            sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
            now: @escaping @Sendable () -> Date = { Date() }
        ) {
            self.client = client
            self.refresh = refresh
            self.reader = reader
            self.toast = toast
            self.unauthorized = unauthorized
            self.sleep = sleep
            self.now = now
        }
    }

    @ObservationIgnored public var dependencies: Dependencies
    /// Called whenever `changes` may have changed (the store recomputes what it shows).
    @ObservationIgnored public var onChangesUpdated: (@MainActor () -> Void)?

    /// Queued, in-flight and landed-awaiting-refresh writes, in order.
    public private(set) var entries: [PendingWrite] = []
    /// Every pending preview, in write order.
    public private(set) var changes: [Change] = []
    /// Ids created by writes that have not landed.
    public private(set) var unconfirmed: Set<String> = []
    /// True while any write has not landed.
    public private(set) var busy = false
    /// When the longest-retrying pending write started retrying (nil when none is).
    public private(set) var retryingSince: Date?
    /// True once writes have been retrying for longer than `stalledAfter` (the header shows "Saving…").
    public private(set) var isSaving = false
    /// This device's undo steps, oldest first.
    public private(set) var undoStack: [UndoStep] = []
    /// This device's redo steps, oldest first.
    public private(set) var redoStack: [UndoStep] = []
    /// When this device last queued a journaled write (the server's redo list is gone after it).
    public private(set) var journaledAt: Date = .distantPast
    /// How many writes have been queued so far.
    public private(set) var queuedCount = 0

    @ObservationIgnored private var created: Set<String> = []
    @ObservationIgnored private var draining = false
    @ObservationIgnored private var pendingUploadSteps: [UUID: UndoStep] = [:]
    @ObservationIgnored private var ownSteps: [Int: Int] = [:]
    @ObservationIgnored private var ownStepOrder: [Int] = []
    @ObservationIgnored private var newestOwnStep = 0
    @ObservationIgnored private var refreshRetry: Task<Void, Never>?
    @ObservationIgnored private var stallTimer: Task<Void, Never>?
    @ObservationIgnored private var idleWaiters: [CheckedContinuation<Void, Never>] = []

    /// Creates a queue.
    public init(_ dependencies: Dependencies) {
        self.dependencies = dependencies
    }

    private func update() {
        changes = entries.flatMap(\.changes)
        unconfirmed = Set(entries.filter { $0.state != .done }.flatMap(\.spec.creates))
        busy = entries.contains { $0.state != .done }
        let since = entries.compactMap(\.retryingSince).min()
        if since != retryingSince {
            retryingSince = since
            watchStall()
        }
        if !busy, !idleWaiters.isEmpty {
            let waiting = idleWaiters
            idleWaiters = []
            for waiter in waiting { waiter.resume() }
        }
        onChangesUpdated?()
    }

    /// Shows "Saving…" once the current retry spell has lasted `stalledAfter`.
    private func watchStall() {
        stallTimer?.cancel()
        isSaving = false
        guard let since = retryingSince else { return }
        let elapsed = dependencies.now().timeIntervalSince(since)
        let remaining = elapsed <= 0 ? Self.stalledAfter : max(.zero, Self.stalledAfter - .seconds(elapsed))
        let sleep = dependencies.sleep
        stallTimer = Task { [weak self] in
            await sleep(remaining)
            guard let self, !Task.isCancelled, self.retryingSince == since else { return }
            self.isSaving = true
        }
    }

    /// Queues a write; its preview shows at once.
    @discardableResult
    public func write(_ spec: WriteSpec) -> WriteTicket {
        let entry = PendingWrite(spec: spec, key: UUID().uuidString)
        queuedCount += 1
        if let label = spec.label {
            let step = UndoStep(
                label: label, undo: Optimistic.invertChanges(spec.changes, reader: dependencies.reader), redo: spec.changes,
                creates: spec.creates, entry: entry)
            redoStack = []
            journaledAt = dependencies.now()
            if spec.lane == .upload {
                pendingUploadSteps[entry.id] = step
            } else {
                undoStack = Array((undoStack + [step]).suffix(Self.maxUndo))
            }
        }
        entries.append(entry)
        created.formUnion(spec.creates)
        update()
        if spec.lane == .upload {
            Task { await sendUpload(entry) }
        } else {
            Task { await drain() }
        }
        return WriteTicket(entry: entry)
    }

    /// Whether this device created the item `id` (it may be saved by now).
    public func createdHere(_ id: String) -> Bool { created.contains(id) }

    private func drain() async {
        if draining { return }
        draining = true
        while let entry = entries.first(where: { $0.state == .queued && $0.spec.lane == .main }) {
            setState(entry, .sending)
            do {
                let outcome = entry.spec.skip?() == true ? WriteOutcome() : try await sendWithRetry(entry)
                reconcileUndo(entry, outcome)
                succeed(entry, outcome)
            } catch {
                fail(entry, error)
            }
        }
        draining = false
        Task { await refreshAndRelease() }
    }

    private func sendUpload(_ entry: PendingWrite) async {
        defer {
            pendingUploadSteps[entry.id] = nil
            Task { await refreshAndRelease() }
        }
        do throws(WriteError) {
            for id in entry.spec.waitFor { try await whenCreated(id) }
            setState(entry, .sending)
            let outcome: WriteOutcome
            do { outcome = try await sendWithRetry(entry) } catch { throw .failed(error) }
            if let queued = pendingUploadSteps[entry.id], outcome.undo.steps != 0 {
                // The landed attachment has the server's id: undo removes it and redo shows it under that id.
                let redo = entry.spec.landed?(outcome) ?? queued.redo
                let added = Optimistic.invertChanges(
                    redo.filter { if case .attachment = $0 { true } else { false } }, reader: dependencies.reader)
                var step = queued
                step.redo = redo
                step.undo = queued.undo + added
                // The server journaled the upload now: it goes below the steps of writes that have not landed yet.
                var undo = undoStack
                let at = undo.firstIndex { $0.entry.state != .done } ?? undo.count
                undo.insert(step, at: at)
                undoStack = Array(undo.suffix(Self.maxUndo))
            }
            succeed(entry, outcome)
        } catch {
            entries.removeAll { $0 === entry }
            update()
            entry.finish(.failure(error))
            // A discarded upload was counted in its task's failure report.
            if case .failed(let apiError) = error { report(apiError, later: 0) }
        }
    }

    private func setState(_ entry: PendingWrite, _ state: WriteState) {
        entry.state = state
        update()
    }

    private func sendWithRetry(_ entry: PendingWrite) async throws(APIError) -> WriteOutcome {
        guard let client = dependencies.client() else { throw .unauthorized(message: "Signed out") }
        var attempt = 0
        while true {
            do {
                let outcome = try await entry.spec.send(client, entry.key)
                entry.retryingSince = nil
                return outcome
            } catch {
                // Only network errors and 5xx are worth another attempt.
                guard error.isTransient, attempt < Self.retryDelays.count else { throw error }
                if entry.retryingSince == nil {
                    entry.retryingSince = dependencies.now()
                    update()
                }
                await dependencies.sleep(Self.retryDelays[attempt])
                attempt += 1
            }
        }
    }

    /// Keeps this device's undo history in line with the server's: a write that recorded no step (nothing changed)
    /// loses its snapshot; any other surprise (e.g. a discard that deleted instead of erasing) leaves undo to the server.
    private func reconcileUndo(_ entry: PendingWrite, _ outcome: WriteOutcome) {
        guard let recorded = outcome.undo.steps else { return }
        let expected = entry.spec.label != nil ? 1 : entry.spec.erases ? -1 : 0
        if recorded == expected { return }
        if expected == 1 && recorded == 0 {
            undoStack.removeAll { $0.entry === entry }
            redoStack.removeAll { $0.entry === entry }
        } else {
            forgetUndoHistory()
        }
    }

    private func succeed(_ entry: PendingWrite, _ outcome: WriteOutcome) {
        // First, so caches it seeds are in place when requests waiting for this write are let through.
        entry.spec.onSuccess?(outcome)
        if let landed = entry.spec.landed { entry.changes = landed(outcome) }
        entry.outcome = outcome
        if let step = outcome.undo.step { recordOwnStep(id: step, previous: outcome.undo.previous ?? 0) }
        setState(entry, .done)
        entry.finish(.success(outcome))
    }

    /// Discards `failed` and every main-lane write queued after it (and uploads waiting for them), then reports once.
    private func fail(_ failed: PendingWrite, _ error: APIError) {
        let from = entries.firstIndex { $0 === failed } ?? 0
        let discarded = entries.enumerated().filter { i, e in
            e === failed || (i > from && e.state == .queued && e.spec.lane == .main)
        }.map(\.element)
        let lost = Set(discarded.flatMap(\.spec.creates))
        let uploads = entries.filter { e in
            e.spec.lane == .upload && e.state == .queued && e.spec.waitFor.contains { lost.contains($0) }
        }
        entries.removeAll { e in discarded.contains { $0 === e } }
        // This device's undo snapshots no longer match the server's journal.
        undoStack = []
        redoStack = []
        update()
        failed.finish(.failure(.failed(error)))
        for e in discarded where e !== failed { e.finish(.failure(.discarded)) }
        report(error, later: discarded.count - 1 + uploads.count)
    }

    private func report(_ error: APIError, later: Int) {
        switch error {
        case .unauthorized(let message):
            dependencies.unauthorized(message)
            return
        case .cancelled:
            // Only a write that was itself cancelled fails this way; that is not news to the user.
            return
        default:
            break
        }
        var reason = error.message
        if reason.hasSuffix(".") { reason.removeLast() }
        let tail = later > 0 ? " \(later) later change\(later == 1 ? " was" : "s were") undone." : ""
        dependencies.toast("Couldn't save: \(reason).\(tail)", .error)
    }

    /// Once the main queue is idle, refetches, then drops the previews of writes that had landed when the refetch
    /// started. When the refetch cannot reach the server, the previews stay (they are what was saved) and it tries again.
    private func refreshAndRelease() async {
        if entries.contains(where: { $0.state != .done && $0.spec.lane == .main }) { return }
        let landed = entries.filter { $0.state == .done }
        refreshRetry?.cancel()
        refreshRetry = nil
        if await dependencies.refresh() {
            entries.removeAll { e in landed.contains { $0 === e } }
            update()
        } else {
            let sleep = dependencies.sleep
            refreshRetry = Task { [weak self] in
                await sleep(Self.refreshRetryDelay)
                guard let self, !Task.isCancelled else { return }
                // This task runs the retry: clear its handle first, so the retry does not cancel itself.
                self.refreshRetry = nil
                await self.refreshAndRelease()
            }
        }
    }

    /// Returns once the write creating `id` has landed (at once when none is pending); throws if it was discarded.
    public func whenCreated(_ id: String) async throws(WriteError) {
        guard let entry = entries.first(where: { $0.state != .done && $0.spec.creates.contains(id) }) else { return }
        if case .failure = await entry.wait() { throw .discarded }
    }

    /// Returns when no write is pending (e.g. before signing out).
    public func whenIdle() async {
        if !busy { return }
        await withCheckedContinuation { idleWaiters.append($0) }
    }

    /// The server's id for a step of this device's history (nil until its write has landed).
    public func serverStepId(_ step: UndoStep) -> Int? {
        step.entry.outcome?.undo.step
    }

    private func recordOwnStep(id: Int, previous: Int) {
        if ownSteps[id] == nil { ownStepOrder.append(id) }
        ownSteps[id] = previous
        newestOwnStep = max(newestOwnStep, id)
        // The server keeps 200 steps; older ones can no longer be walked through anyway.
        if ownSteps.count > Self.maxUndo * 2, let oldest = ownStepOrder.first {
            ownStepOrder.removeFirst()
            ownSteps[oldest] = nil
        }
    }

    /// Whether `step` is still what the server would undo or redo next: false when a step made elsewhere (MCP, another
    /// device) lies between it and the newest step the server has (`serverNewest`, or this device's own newest).
    public func stepIsCurrent(_ step: UndoStep, serverNewest: Int?) -> Bool {
        guard let id = serverStepId(step) else { return true }
        var at: Int? = max(serverNewest ?? 0, newestOwnStep)
        while let current = at, current > id {
            guard let previous = ownSteps[current] else { return false }
            at = previous
        }
        return true
    }

    /// Forgets this device's undo history: undo and redo then wait for the server.
    public func forgetUndoHistory() {
        undoStack = []
        redoStack = []
    }

    /// Takes the newest undo step (moving it to the redo list), or the next redo step (moving it back), or nil when the
    /// server must decide: when there is none, or when a later step was made elsewhere.
    public func takeStep(_ direction: UndoDirection, serverNewest: Int?) -> UndoStep? {
        guard let step = (direction == .undo ? undoStack : redoStack).last else { return nil }
        if !stepIsCurrent(step, serverNewest: serverNewest) {
            forgetUndoHistory()
            return nil
        }
        if direction == .undo {
            undoStack.removeLast()
            redoStack.append(step)
        } else {
            redoStack.removeLast()
            undoStack.append(step)
        }
        return step
    }

    /// Forgets the undo step that created `id` when it is the newest one (the server erases that creation).
    public func forgetCreation(_ id: String) -> Bool {
        guard let top = undoStack.last, top.creates.contains(id) else { return false }
        undoStack.removeLast()
        return true
    }
}
