// Author: John Grimes

import Observation
import PranaKit

/// State the perspective pages share with their sidebars: the Review session and the tag picked in the Tags sidebar of
/// perspectives whose route has no `tag` parameter (Flagged, Completed, Changed and custom perspectives).
@MainActor
@Observable
final class PagesModel {
    /// The app's pages state (one window's worth; pages and sidebars are separate views reading the same state).
    static let shared = PagesModel()

    /// The Review list while Review is shown (spec §4 Review).
    private(set) var review = ReviewSession()
    /// Tag picked in the sidebar per perspective id (`untagged` for Untagged).
    var tagFilter: [String: String] = [:]

    /// The listed projects as they are now, or nil until the due list has been read for this visit.
    func reviewItems(_ store: AppStore) -> [ReviewItem]? {
        guard review.loaded, let projects = store.state.projects else { return nil }
        let byId = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ReviewModel.items(review.entries, projects: byId)
    }

    /// Starts a visit to Review: reads fresh due projects and projects (whose `lastReview` decides what counts as
    /// reviewed), then builds the list.
    func startReview(_ store: AppStore) async {
        review = ReviewSession(cleanups: store.cleanupCount)
        async let due: Void = store.loadReview()
        async let shared: Void = store.loadShared()
        _ = await (due, shared)
        absorbDue(store)
    }

    /// Takes in the due list the store holds now (appending newly due projects; rebuilding after Clean Up).
    func absorbDue(_ store: AppStore) {
        guard let due = store.state.review else { return }
        review.absorb(due: due, cleanups: store.cleanupCount)
    }

    /// After Clean Up: once the queued writes (Mark Reviewed among them) have landed, rebuild from the projects now due.
    func rebuildAfterCleanUp(_ store: AppStore) async {
        await store.writes.whenIdle()
        await store.loadReview()
        absorbDue(store)
    }

    /// Leaving Review forgets the list.
    func endReview() {
        review = ReviewSession()
    }

    /// Mark Reviewed (review bar, ⌘⇧R and the inspector): on the Review page, then opens the next unreviewed project
    /// below, wrapping round, or the "All projects reviewed" screen when none is left.
    func markReviewedAndAdvance(_ id: String, store: AppStore, navigator: Navigator) {
        store.markReviewed(id)
        guard case .review = navigator.route, let items = reviewItems(store) else { return }
        navigator.navigate(to: .review(project: ReviewModel.nextUnreviewed(items, from: id)))
    }
}
