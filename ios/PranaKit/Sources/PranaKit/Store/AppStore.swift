// Author: John Grimes

import Foundation
import Observation

/// A short message shown over the UI.
public struct Toast: Identifiable, Sendable, Hashable {
    public let id: Int
    public let message: String
    public let kind: ToastKind
    /// A button on the toast (e.g. "Undo" after deleting rows), or nil.
    public var action: ToastAction? = nil
}

/// What a toast's button does.
public enum ToastAction: Sendable, Hashable {
    /// "Undo": undoes the newest change.
    case undo

    /// The button's title.
    public var label: String {
        switch self {
        case .undo: "Undo"
        }
    }
}

/// Tasks a landed write returned, and the write's place in queue order (the outline keeps such rows visible until
/// Clean Up, spec §3).
public typealias TaskListener = @MainActor ([TaskItem], Int) -> Void

/// The app's data and writes (spec §2 "Instant writes"). Owns the last server data (`base`), the pending writes
/// (`writes`) and what views show (`state` = `base` with the pending writes' previews applied). Caches are in memory
/// only. Views use `@Environment(AppStore.self)` and read `state`.
@MainActor
@Observable
public final class AppStore {
    // MARK: Configuration

    @ObservationIgnored public let credentialStore: any CredentialStore
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored let sleep: @Sendable (Duration) async -> Void
    @ObservationIgnored let now: @Sendable () -> Date

    // MARK: Observable state

    /// The signed-in server and token, or nil when signed out.
    public private(set) var credentials: Credentials?
    /// Shown on the sign-in screen after being signed out by the server ("Token rejected").
    public private(set) var signInMessage: String?
    /// The server last signed in to (kept after signing out, so sign-in offers it again; the token is not kept).
    public private(set) var lastOrigin: URL?
    /// Last server data.
    public private(set) var base = CacheState()
    /// What views show: `base` with every pending write's preview applied.
    public private(set) var state = CacheState()
    /// Visible toasts, oldest first.
    public private(set) var toasts: [Toast] = []
    /// The instant-write queue.
    public let writes: WriteQueue
    /// The view whose outline is on screen: undo snapshots and status previews read its rows.
    public var activeContentsKey: ContentsKey?
    /// Bumped on undo/redo: rows kept visible stay put, but locally hidden deletions are forgotten.
    public private(set) var journalEpoch = 0
    /// Bumped when rows kept visible after completion should be dropped (Clean Up, navigation).
    public private(set) var stickyEpoch = 0
    /// Counts explicit Clean Ups (the Review list rebuilds on it).
    public private(set) var cleanupCount = 0

    @ObservationIgnored private var historyFetchedAt: Date = .distantPast
    @ObservationIgnored private var contentsOrder: [ContentsKey] = []
    @ObservationIgnored private var forecastParams: (from: String?, days: Int?)?
    @ObservationIgnored private var searchParams: (q: String, availability: Availability?)?
    @ObservationIgnored private var taskListeners: [UUID: TaskListener] = [:]
    @ObservationIgnored private var nextToastId = 0
    private static let maxCachedContents = 12

    /// Creates a store, signed in when `credentialStore` holds credentials.
    public init(
        credentialStore: any CredentialStore, session: URLSession = .shared,
        sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.credentialStore = credentialStore
        self.session = session
        self.sleep = sleep
        self.now = now
        let credentials = credentialStore.load()
        self.credentials = credentials
        self.lastOrigin = credentials?.origin
        self.writes = WriteQueue(
            WriteQueue.Dependencies(
                client: { nil }, refresh: { true }, reader: StoreReader(), toast: { _, _ in }, unauthorized: { _ in },
                sleep: sleep, now: now))
        let reader = StoreReader()
        reader.store = self
        writes.dependencies = WriteQueue.Dependencies(
            client: { [weak self] in self?.client },
            refresh: { [weak self] in await self?.refreshAll(quiet: true) ?? true },
            reader: reader,
            toast: { [weak self] message, kind in self?.toast(message, kind: kind) },
            unauthorized: { [weak self] _ in self?.handleUnauthorized() },
            sleep: sleep, now: now)
        writes.onChangesUpdated = { [weak self] in self?.recompute() }
    }

    /// The API client for the signed-in server, or nil when signed out.
    public var client: APIClient? {
        credentials.map { APIClient(origin: $0.origin, token: $0.token, session: session) }
    }

    /// Whether credentials are present.
    public var isSignedIn: Bool { credentials != nil }

    /// True once writes have been retrying for more than 2 s (the header shows "Saving…").
    public var isSaving: Bool { writes.isSaving }

    /// Queued, in-flight and landed-awaiting-refresh writes.
    public var pending: [PendingWrite] { writes.entries }

    /// Every pending preview, in write order.
    public var pendingChanges: [Change] { writes.changes }

    /// Settings as shown (server defaults in this device's time zone until loaded).
    public var settings: Settings { state.settings ?? Settings.defaults(timeZone: TimeZone.current.identifier) }

    private func recompute() {
        state = base.applying(writes.changes, now: now())
    }

    private func updateBase(_ change: (inout CacheState) -> Void) {
        change(&base)
        recompute()
    }

    // MARK: Toasts

    /// Shows a toast, with an optional button (`action`); it dismisses itself after `duration` (errors 7 s, others
    /// 5 s, as the web app). At most four show at once: the oldest goes first.
    public func toast(_ message: String, kind: ToastKind = .info, duration: Duration? = nil, action: ToastAction? = nil) {
        nextToastId += 1
        let id = nextToastId
        toasts = toasts.suffix(3) + [Toast(id: id, message: message, kind: kind, action: action)]
        let wait = duration ?? (kind == .error ? .seconds(7) : .seconds(5))
        let sleep = self.sleep
        Task { [weak self] in
            await sleep(wait)
            self?.dismissToast(id)
        }
    }

    /// Removes a toast.
    public func dismissToast(_ id: Int) {
        toasts.removeAll { $0.id == id }
    }

    // MARK: Sign-in

    /// Validates the token with `GET /settings`, then saves the credentials and loads the shared lists. Throws (and
    /// saves nothing) when the server rejects the token or cannot be reached.
    public func signIn(origin: URL, token: String) async throws(APIError) {
        let client = APIClient(origin: origin, token: token, session: session)
        let settings = try await client.send(Endpoints.settings()).value
        let credentials = Credentials(origin: origin, token: token)
        do {
            try credentialStore.save(credentials)
        } catch {
            // Still signed in for this session; the next launch asks again.
            toast("Couldn't save the token in the Keychain.", kind: .error)
        }
        self.credentials = credentials
        lastOrigin = origin
        signInMessage = nil
        updateBase {
            $0 = CacheState()
            $0.settings = settings
        }
        await loadShared()
    }

    /// Signs out once unsent changes have gone, forgetting the credentials and every cache.
    public func signOut() async {
        await writes.whenIdle()
        credentialStore.delete()
        clearSession(message: nil)
    }

    /// The server rejected the token: back to the sign-in screen with a message.
    func handleUnauthorized() {
        guard credentials != nil else { return }
        credentialStore.delete()
        clearSession(message: "Token rejected")
    }

    private func clearSession(message: String?) {
        credentials = nil
        signInMessage = message
        activeContentsKey = nil
        contentsOrder = []
        forecastParams = nil
        searchParams = nil
        writes.forgetUndoHistory()
        updateBase { $0 = CacheState() }
    }

    // MARK: Requests that wait for the server

    /// Sends a request that is not an instant write (passkeys, API tokens, Quick Open…). A 401 signs out.
    public func send<T: Decodable & Sendable>(_ request: APIRequest<T>) async throws(APIError) -> T {
        guard let client else { throw .unauthorized(message: "Signed out") }
        do {
            return try await client.send(request).value
        } catch {
            if case .unauthorized = error { handleUnauthorized() }
            throw error
        }
    }

    /// Fetches, toasting failures other than 401 (which signs out), 404 and cancellation unless `quiet`. Nil on
    /// failure; `transient` tells whether the data could not be refreshed for now (the server could not be reached, or
    /// the request was cancelled).
    private func fetch<T: Decodable & Sendable>(_ request: APIRequest<T>, quiet: Bool) async -> (value: T?, transient: Bool) {
        do {
            return (try await send(request), false)
        } catch {
            switch error {
            case .unauthorized, .cancelled: break
            case .server(404, _, _): break
            default: if !quiet { toast(error.message, kind: .error) }
            }
            return (nil, error.isTransient || error == .cancelled)
        }
    }

    // MARK: Loading

    /// Loads settings, perspectives, folders, projects, tags and history.
    public func loadShared() async {
        _ = await reloadShared(quiet: false)
    }

    private func reloadShared(quiet: Bool) async -> Bool {
        async let settings = fetch(Endpoints.settings(), quiet: quiet)
        async let perspectives = fetch(Endpoints.perspectives(), quiet: quiet)
        async let folders = fetch(Endpoints.folders(), quiet: quiet)
        async let projects = fetch(Endpoints.projects(), quiet: quiet)
        async let tags = fetch(Endpoints.tags(), quiet: quiet)
        let history = await reloadHistory(quiet: quiet)
        let results = await (settings, perspectives, folders, projects, tags)
        guard isSignedIn else { return true }
        updateBase {
            if let v = results.0.value { $0.settings = v }
            if let v = results.1.value { $0.perspectives = v.items }
            if let v = results.2.value { $0.folders = v.items }
            if let v = results.3.value { $0.projects = v.items }
            if let v = results.4.value { $0.tags = v.items }
        }
        return history && ![results.0.transient, results.1.transient, results.2.transient, results.3.transient, results.4.transient].contains(true)
    }

    private func reloadHistory(quiet: Bool) async -> Bool {
        let started = now()
        let result = await fetch(Endpoints.history(), quiet: quiet)
        if let history = result.value {
            historyFetchedAt = started
            updateBase { $0.history = history }
        }
        return !result.transient
    }

    /// Loads one evaluated perspective. A view of a project, folder, tag or perspective created here shows a
    /// placeholder (a project's own row, otherwise nothing) until its create lands, then loads; when the create is
    /// discarded, the placeholder goes. A project created here keeps its placeholder until its view first loads, even
    /// once saved, so the title being typed into it stays put (`useContents` in `src/web/api/queries.ts`).
    public func load(_ key: ContentsKey) async {
        let pending = unconfirmedIds(key)
        if base.contents[key] == nil, !pending.isEmpty || key.project.map(writes.createdHere) == true {
            updateBase { $0.contents[key] = placeholder(key) }
        }
        do {
            for id in pending { try await writes.whenCreated(id) }
        } catch {
            if !contentsOrder.contains(key) { updateBase { $0.contents[key] = nil } }
            return
        }
        _ = await reload(key, quiet: false)
    }

    /// The ids `key` names that writes not landed yet create (the server does not know them).
    private func unconfirmedIds(_ key: ContentsKey) -> [String] {
        [key.perspectiveId, key.project, key.folder, key.tag].compactMap { $0 }.filter(writes.unconfirmed.contains)
    }

    /// What a view of something created here shows before the server has it.
    private func placeholder(_ key: ContentsKey) -> OutlineContents {
        let project = key.project.flatMap { id in state.projects?.first { $0.id == id } }
        let groups = project.map { project in
            [OutlineGroup(
                key: project.id, title: project.task.name, kind: .project,
                rows: [OutlineRow(kind: .project, id: project.id, depth: 0, project: project)])]
        }
        return OutlineContents(perspectiveId: key.perspectiveId, groups: groups ?? [], emptyText: "No items")
    }

    private func reload(_ key: ContentsKey, quiet: Bool) async -> Bool {
        if !unconfirmedIds(key).isEmpty { return true }
        let result = await fetch(Endpoints.contents(key), quiet: quiet)
        guard let contents = result.value, isSignedIn else { return !result.transient }
        contentsOrder.removeAll { $0 == key }
        contentsOrder.append(key)
        var evicted: [ContentsKey] = []
        while contentsOrder.count > Self.maxCachedContents, let oldest = contentsOrder.first(where: { $0 != activeContentsKey }) {
            contentsOrder.removeAll { $0 == oldest }
            evicted.append(oldest)
        }
        updateBase {
            $0.contents[key] = contents
            for k in evicted { $0.contents[k] = nil }
        }
        return true
    }

    /// Loads a task's detail (an item created here and not saved yet shows from its preview).
    public func loadDetail(_ id: String) async {
        _ = await reloadDetail(id, quiet: false)
    }

    private func reloadDetail(_ id: String, quiet: Bool) async -> Bool {
        if writes.unconfirmed.contains(id) { return true }
        let result = await fetch(Endpoints.task(id), quiet: quiet)
        if let detail = result.value, isSignedIn { updateBase { $0.details[id] = detail } }
        return !result.transient
    }

    /// A task's detail as shown; for an item created here and not saved yet, a draft from its preview.
    public func detail(_ id: String) -> TaskDetail? {
        if let detail = state.details[id] { return detail }
        guard writes.unconfirmed.contains(id) else { return nil }
        if let project = state.projects?.first(where: { $0.id == id }) {
            return TaskDetail(task: project.task, project: project.record)
        }
        return StoreReader(store: self).task(id).map { TaskDetail(task: $0) }
    }

    /// Loads the Forecast.
    public func loadForecast(from: String? = nil, days: Int? = nil) async {
        forecastParams = (from, days)
        _ = await reloadForecast(quiet: false)
    }

    private func reloadForecast(quiet: Bool) async -> Bool {
        guard let params = forecastParams else { return true }
        let result = await fetch(Endpoints.forecast(from: params.from, days: params.days), quiet: quiet)
        if let forecast = result.value, isSignedIn { updateBase { $0.forecast = forecast } }
        return !result.transient
    }

    /// Loads the Review queue.
    public func loadReview() async {
        _ = await reloadReview(quiet: false)
    }

    private func reloadReview(quiet: Bool) async -> Bool {
        let result = await fetch(Endpoints.review(), quiet: quiet)
        if let review = result.value, isSignedIn { updateBase { $0.review = review.items } }
        return !result.transient
    }

    /// Searches (results in `state.search`); an empty query clears the results.
    public func search(_ q: String, availability: Availability? = nil) async {
        guard !q.trimmingCharacters(in: .whitespaces).isEmpty else {
            searchParams = nil
            updateBase { $0.search = nil }
            return
        }
        searchParams = (q, availability)
        _ = await reloadSearch(quiet: false)
    }

    private func reloadSearch(quiet: Bool) async -> Bool {
        guard let params = searchParams else { return true }
        let result = await fetch(Endpoints.search(params.q, availability: params.availability), quiet: quiet)
        if let results = result.value, isSignedIn, searchParams?.q == params.q { updateBase { $0.search = results } }
        return !result.transient
    }

    /// Quick Open matches (not cached).
    public func quickOpen(_ q: String) async -> [QuickOpenResult] {
        guard !q.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
        return await fetch(Endpoints.quickOpen(q), quiet: true).value?.items ?? []
    }

    /// Refetches everything loaded. Returns false when the server could not be reached for some of it. `announce`
    /// shows a "Refreshed" toast (the S shortcut).
    @discardableResult
    public func refresh(announce: Bool = false) async -> Bool {
        let ok = await refreshAll(quiet: false)
        if announce { toast("Refreshed", duration: .milliseconds(1500)) }
        return ok
    }

    func refreshAll(quiet: Bool) async -> Bool {
        guard isSignedIn else { return true }
        // Views the server has given, not placeholders: `load` fetches those once their create lands, and a
        // placeholder whose create was discarded names something the server never had.
        let keys = contentsOrder
        let details = Array(base.details.keys)
        let hasForecast = base.forecast != nil
        let hasReview = base.review != nil
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask { await self.reloadShared(quiet: quiet) }
            for key in keys { group.addTask { await self.reload(key, quiet: quiet) } }
            for id in details { group.addTask { await self.reloadDetail(id, quiet: quiet) } }
            if hasForecast { group.addTask { await self.reloadForecast(quiet: quiet) } }
            if hasReview { group.addTask { await self.reloadReview(quiet: quiet) } }
            group.addTask { await self.reloadSearch(quiet: quiet) }
            var ok = true
            for await result in group { ok = ok && result }
            return ok
        }
    }

    // MARK: Undo history

    /// Undo/redo availability: this device's own steps first (unless the server's history has a newer step made
    /// elsewhere), then the server's (its redo list is stale once this device writes).
    public var history: History? {
        let server = base.history ?? History(canUndo: false, canRedo: false, undoLabel: nil, redoLabel: nil, undoId: nil, redoId: nil)
        if base.history == nil && writes.undoStack.isEmpty && writes.redoStack.isEmpty { return nil }
        let undo = writes.undoStack.last.flatMap { writes.stepIsCurrent($0, serverNewest: server.undoId) ? $0.label : nil }
        let redo = writes.redoStack.last.flatMap { writes.stepIsCurrent($0, serverNewest: server.undoId) ? $0.label : nil }
        let stale = writes.journaledAt > historyFetchedAt
        return History(
            canUndo: undo != nil || server.canUndo, canRedo: redo != nil || (!stale && server.canRedo),
            undoLabel: undo ?? server.undoLabel, redoLabel: redo ?? (stale ? nil : server.redoLabel),
            undoId: server.undoId, redoId: server.redoId)
    }

    /// Whether Undo is available.
    public var canUndo: Bool { history?.canUndo ?? false }
    /// Whether Redo is available.
    public var canRedo: Bool { history?.canRedo ?? false }
    /// What Undo would revert ("Edit Action"), when known.
    public var undoLabel: String? { history?.undoLabel }
    /// What Redo would reapply, when known.
    public var redoLabel: String? { history?.redoLabel }

    /// Undoes the newest change: this device's own steps show at once from their snapshot; a change made elsewhere
    /// shows when the server answers.
    public func undo() { travel(.undo) }

    /// Redoes the newest undone change.
    public func redo() { travel(.redo) }

    private func travel(_ direction: UndoDirection) {
        let verb = direction == .undo ? "Undid" : "Redid"
        let request = direction == .undo ? Endpoints.undo() : Endpoints.redo()
        let announce: @MainActor @Sendable (History) -> Void = { [weak self] history in
            guard let self else { return }
            journalEpoch += 1
            let label = direction == .undo ? history.redoLabel : history.undoLabel
            toast(label.map { "\(verb) \($0)" } ?? (direction == .undo ? "Undone" : "Redone"))
        }
        guard let step = writes.takeStep(direction, serverNewest: base.history?.undoId) else {
            writes.write(WriteSpec(send: WriteSpec.sending(request), onSuccess: { outcome in
                if let history = outcome.value as? History { announce(history) }
            }))
            return
        }
        let id = writes.serverStepId(step)
        let changes = direction == .undo ? step.undo : step.redo
        // The step the server's answer says it acted on.
        let actedOn: @Sendable (History) -> Int? = { direction == .undo ? $0.redoId : $0.undoId }
        let entry = step.entry
        writes.write(
            WriteSpec(
                changes: changes, send: WriteSpec.sending(request),
                landed: { outcome in
                    guard let history = outcome.value as? History, let id else { return changes }
                    return actedOn(history) == id ? changes : []
                },
                skip: { entry.outcome?.undo.steps == 0 },
                onSuccess: { [weak self] outcome in
                    // The server reverted a different (newer) step than this device's: show what it did instead.
                    guard let history = outcome.value as? History, let id, actedOn(history) != id else { return }
                    self?.writes.forgetUndoHistory()
                    announce(history)
                }))
        journalEpoch += 1
        toast("\(verb) \(step.label)")
    }

    // MARK: Listeners

    /// Subscribes to tasks returned by writes (the outline keeps completed rows visible). Returns a token for
    /// `removeTaskListener`.
    public func onTasksChanged(_ listener: @escaping TaskListener) -> UUID {
        let id = UUID()
        taskListeners[id] = listener
        return id
    }

    /// Unsubscribes a task listener.
    public func removeTaskListener(_ token: UUID) {
        taskListeners[token] = nil
    }

    /// How many writes have been queued so far: a write reported with a lower number was queued before now.
    public var writesQueued: Int { writes.queuedCount }

    func reportTasks(_ tasks: [TaskItem], queued: Int) {
        guard !tasks.isEmpty else { return }
        for listener in taskListeners.values { listener(tasks, queued) }
    }

    /// Caches a just-created item's detail from the create response.
    func seedDetail(_ task: TaskItem, project: ProjectRecord?) {
        guard base.details[task.id] == nil else { return }
        updateBase { $0.details[task.id] = TaskDetail(task: task, project: project) }
    }

    /// Bumps `stickyEpoch` (rows kept visible after completion are dropped, e.g. on navigation).
    public func resetSticky() {
        stickyEpoch += 1
    }

    func noteCleanUp() {
        stickyEpoch += 1
        cleanupCount += 1
    }
}

/// Reads the state as shown, for undo snapshots and previews (`reader` in `src/web/api/queries.ts`).
@MainActor
final class StoreReader: StateReader {
    weak var store: AppStore?

    init(store: AppStore? = nil) {
        self.store = store
    }

    private static func task(in rows: [OutlineRow], _ id: String) -> TaskItem? {
        guard let row = rows.first(where: { $0.id == id }) else { return nil }
        return row.task ?? row.project?.task
    }

    func task(_ id: String) -> TaskItem? {
        guard let store else { return nil }
        let state = store.state
        if let groups = outline() {
            for g in groups { if let task = Self.task(in: g.rows, id) { return task } }
        }
        if let detail = state.details[id] { return detail.task }
        for detail in state.details.values { if let child = detail.children.first(where: { $0.id == id }) { return child } }
        for contents in state.contents.values {
            for g in contents.groups { if let task = Self.task(in: g.rows, id) { return task } }
        }
        for day in state.forecast?.days ?? [] { if let task = Self.task(in: day.rows, id) { return task } }
        if let task = state.search?.tasks.first(where: { $0.id == id }) ?? state.search?.projects.first(where: { $0.id == id })?.task {
            return task
        }
        if let project = state.projects?.first(where: { $0.id == id }) { return project.task }
        // Created here and not shown anywhere yet.
        for change in store.writes.changes {
            if case .row(let row) = change, row.id == id, let task = row.rows?.first?.task { return task }
            if case .item(let item) = change, item.id == id, case .replace(.project(let project)) = item.edit { return project.task }
        }
        return nil
    }

    func projectRecord(_ id: String) -> ProjectRecord? {
        guard let store else { return nil }
        return store.state.projects?.first { $0.id == id }?.record ?? store.state.details[id]?.project
    }

    func outline() -> [OutlineGroup]? {
        guard let store, let key = store.activeContentsKey else { return nil }
        return store.state.contents[key]?.groups
    }

    func item(_ list: ListName, _ id: String) -> ListItem?? {
        guard let state = store?.state else { return .none }
        let items: [ListItem]? =
            switch list {
            case .folders: state.folders?.map(\.listItem)
            case .tags: state.tags?.map(\.listItem)
            case .perspectives: state.perspectives?.map(\.listItem)
            case .projects: state.projects?.map(\.listItem)
            }
        guard let items else { return .none }
        return .some(items.first { $0.id == id })
    }

    func settings() -> Settings? {
        guard let store, store.base.settings != nil else { return nil }
        return store.state.settings
    }

    func attachment(taskId: String, id: String) -> Attachment?? {
        guard let detail = store?.state.details[taskId] else { return .none }
        return .some(detail.attachments.first { $0.id == id })
    }
}
