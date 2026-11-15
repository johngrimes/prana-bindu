// Author: John Grimes

import Foundation

/// A project in the Review list, with the `lastReview` it had when it joined the list.
public struct ReviewEntry: Hashable, Sendable {
    public var id: String
    public var joinedLastReview: String

    /// Creates an entry.
    public init(id: String, joinedLastReview: String) {
        self.id = id
        self.joinedLastReview = joinedLastReview
    }
}

/// A listed project and whether it has been marked reviewed since it joined the list.
public struct ReviewItem: Hashable, Sendable, Identifiable {
    public var project: Project
    /// Marked reviewed since it joined the list (undoing Mark Reviewed clears it again).
    public var reviewed: Bool

    /// The project id.
    public var id: String { project.id }

    /// Creates an item.
    public init(project: Project, reviewed: Bool) {
        self.project = project
        self.reviewed = reviewed
    }
}

/// The Review perspective's frozen project list (spec §4 Review). Port of `src/web/lib/reviewModel.ts`.
public enum ReviewModel {
    /// Appends due projects that are not listed yet. Listed projects keep their place even when they stop being due,
    /// so nothing leaves the list until Clean Up or leaving Review.
    public static func mergeDue(_ entries: [ReviewEntry], due: [Project]) -> [ReviewEntry] {
        let listed = Set(entries.map(\.id))
        return entries + due.filter { !listed.contains($0.id) }.map { ReviewEntry(id: $0.id, joinedLastReview: $0.lastReview) }
    }

    /// Listed projects that still exist, in list order.
    public static func items(_ entries: [ReviewEntry], projects: [String: Project]) -> [ReviewItem] {
        entries.compactMap { entry in
            projects[entry.id].map { ReviewItem(project: $0, reviewed: $0.lastReview != entry.joinedLastReview) }
        }
    }

    /// The first unreviewed project after `from`, wrapping round to ones skipped earlier; with no `from` (or one no
    /// longer listed), the first unreviewed project. Nil when every listed project is reviewed.
    public static func nextUnreviewed(_ items: [ReviewItem], from: String?) -> String? {
        guard !items.isEmpty else { return nil }
        let start = from.flatMap { id in items.firstIndex { $0.project.id == id } } ?? -1
        for step in 1...items.count {
            let item = items[(start + step) % items.count]
            if !item.reviewed && item.project.id != from { return item.project.id }
        }
        return nil
    }

    /// "1 week", "2 months".
    public static func formatInterval(_ interval: ReviewInterval) -> String {
        "\(interval.steps) \(interval.steps == 1 ? interval.unit.rawValue : interval.unit.rawValue + "s")"
    }
}

/// The list kept while the Review page is shown (`useReviewSession` in `src/web/lib/review.ts`): started from the due
/// projects, extended with projects that become due, and rebuilt after Clean Up.
public struct ReviewSession: Hashable, Sendable {
    /// The listed projects, in order.
    public private(set) var entries: [ReviewEntry] = []
    /// True once the due list has been read for this visit to Review.
    public private(set) var loaded = false
    /// The store's Clean Up count when the list was last built.
    private var seenCleanups: Int

    /// Starts an empty session; `cleanups` is the store's current Clean Up count.
    public init(cleanups: Int = 0) {
        seenCleanups = cleanups
    }

    /// Takes in a freshly read due list. A Clean Up since the last read rebuilds the list from it.
    public mutating func absorb(due: [Project], cleanups: Int) {
        let rebuild = cleanups != seenCleanups
        seenCleanups = cleanups
        entries = ReviewModel.mergeDue(rebuild ? [] : entries, due: due)
        loaded = true
    }
}

/// Where the Review page is in its list: the open project, its neighbours and progress.
public struct ReviewNavigation: Sendable {
    public let items: [ReviewItem]
    /// The project in the route, if any.
    public let current: String?
    /// The open project's index, if it is listed.
    public let index: Int?

    /// Creates the navigation state for `current` in `items`.
    public init(items: [ReviewItem], current: String?) {
        self.items = items
        self.current = current
        index = current.flatMap { id in items.firstIndex { $0.project.id == id } }
    }

    /// The open project's item.
    public var item: ReviewItem? { index.map { items[$0] } }
    /// The project above, for Previous (⌘[).
    public var previous: String? { index.flatMap { $0 > 0 ? items[$0 - 1].project.id : nil } }
    /// The project below, for Next (⌘]).
    public var next: String? { index.flatMap { $0 + 1 < items.count ? items[$0 + 1].project.id : nil } }
    /// Projects still to review.
    public var left: Int { items.filter { !$0.reviewed }.count }
    /// Projects listed.
    public var total: Int { items.count }
    /// "3 of 7 left".
    public var progress: String { "\(left) of \(total) left" }

    /// With no project open (or one no longer listed), the project to open instead: `.some(id)` for the first
    /// unreviewed one, `.some(nil)` to drop the parameter (everything reviewed). Nil when nothing should change.
    public var redirect: String?? {
        guard item == nil else { return nil }
        let first = ReviewModel.nextUnreviewed(items, from: nil)
        return first == current ? nil : .some(first)
    }
}
