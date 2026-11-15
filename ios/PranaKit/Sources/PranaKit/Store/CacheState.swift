// Author: John Grimes

import Foundation

/// Data from the server (in memory only), or the same with pending writes' previews applied. A value type: copies are
/// cheap until changed.
public struct CacheState: Sendable, Equatable {
    public var settings: Settings?
    public var perspectives: [Perspective]?
    public var folders: [Folder]?
    public var projects: [Project]?
    public var tags: [Tag]?
    /// Evaluated perspectives, per view.
    public var contents: [ContentsKey: OutlineContents] = [:]
    /// Task details, by task id.
    public var details: [String: TaskDetail] = [:]
    public var forecast: ForecastResponse?
    /// The Review queue.
    public var review: [Project]?
    /// The latest search results.
    public var search: SearchResults?
    /// The server's undo history (not previewed; see `AppStore.history`).
    public var history: History?

    /// An empty cache.
    public init() {}

    /// This state with `changes` applied, as shown (`now` decides due-soon/overdue of previewed dates).
    public func applying(_ changes: [Change], fallbackTimeZone: String = TimeZone.current.identifier, now: Date) -> CacheState {
        if changes.isEmpty { return self }
        var out = self
        out.settings = settings.map { Optimistic.previewSettings($0, changes) }
        let shown = out.settings ?? Settings.defaults(timeZone: fallbackTimeZone)
        out.perspectives = perspectives.map { Optimistic.previewList($0, changes, settings: shown, now: now) }
        out.folders = folders.map { Optimistic.previewList($0, changes, settings: shown, now: now) }
        out.projects = projects.map { Optimistic.previewList($0, changes, settings: shown, now: now) }
        out.tags = tags.map { Optimistic.previewList($0, changes, settings: shown, now: now) }
        out.contents = contents.mapValues { contents in
            var contents = contents
            contents.groups = Optimistic.previewGroups(contents.groups, changes, settings: shown, now: now)
            return contents
        }
        out.details = details.mapValues { Optimistic.previewDetail($0, changes, settings: shown, now: now) }
        // Edits and removals only: projects created here join the queue when the server says they are due.
        let reviewChanges = changes.filter { change in
            if case .item(let item) = change, case .remove = item.edit { return true }
            if case .item = change { return false }
            return true
        }
        out.review = review.map { Optimistic.previewList($0, reviewChanges, settings: shown, now: now) }
        out.search = search.map { Optimistic.previewSearch($0, changes, settings: shown, now: now) }
        return out
    }
}
