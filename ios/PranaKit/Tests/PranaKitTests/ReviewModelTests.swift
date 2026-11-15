// Author: John Grimes

import Testing

@testable import PranaKit

/// Ports `src/web/lib/reviewModel.test.ts`, plus the Review session and navigation built on it.
@Suite struct ReviewModelTests {
    private static let october = "2026-10-01T00:00:00.000Z"

    private func project(_ id: String, _ lastReview: String = october) -> Project {
        Project(record: ProjectRecord(id: id, lastReview: lastReview), task: TaskItem(id: id, name: id, isProject: true))
    }

    private func byId(_ projects: Project...) -> [String: Project] {
        Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0) })
    }

    private func items(_ states: (String, Bool)...) -> [ReviewItem] {
        states.map { ReviewItem(project: project($0.0), reviewed: $0.1) }
    }

    // MARK: mergeDue

    @Test func mergeDueKeepsListedProjectsInPlaceAndAppendsNewlyDueOnes() {
        let entries = ReviewModel.mergeDue([], due: [project("a"), project("b")])
        let later = ReviewModel.mergeDue(entries, due: [project("c"), project("b", "2026-10-31T00:00:00.000Z")])
        #expect(
            later == [
                ReviewEntry(id: "a", joinedLastReview: Self.october),
                ReviewEntry(id: "b", joinedLastReview: Self.october),
                ReviewEntry(id: "c", joinedLastReview: Self.october),
            ])
    }

    // MARK: reviewItems

    private let entries = [
        ReviewEntry(id: "a", joinedLastReview: october),
        ReviewEntry(id: "gone", joinedLastReview: october),
        ReviewEntry(id: "b", joinedLastReview: october),
    ]

    @Test func reviewItemsMarksChangedLastReviewAsReviewedAndSkipsDeletedProjects() {
        let result = ReviewModel.items(entries, projects: byId(project("a", "2026-10-31T04:20:00.000Z"), project("b")))
        #expect(result.map(\.project.id) == ["a", "b"])
        #expect(result.map(\.reviewed) == [true, false])
    }

    @Test func reviewItemsUnmarksAProjectOnceItsLastReviewIsRestored() {
        #expect(ReviewModel.items(entries, projects: byId(project("a"))).map(\.reviewed) == [false])
    }

    // MARK: nextUnreviewed

    @Test func nextUnreviewedMovesToTheNextUnreviewedProjectBelow() {
        #expect(ReviewModel.nextUnreviewed(items(("a", true), ("b", true), ("c", false)), from: "a") == "c")
    }

    @Test func nextUnreviewedWrapsRoundToProjectsSkippedEarlier() {
        #expect(ReviewModel.nextUnreviewed(items(("a", false), ("b", true), ("c", true)), from: "c") == "a")
    }

    @Test func nextUnreviewedStartsFromTheTopWithoutACurrentProject() {
        #expect(ReviewModel.nextUnreviewed(items(("a", true), ("b", false)), from: nil) == "b")
    }

    @Test func nextUnreviewedNeverReturnsTheCurrentProjectAndIsNilWhenNothingIsLeft() {
        #expect(ReviewModel.nextUnreviewed(items(("a", false)), from: "a") == nil)
        #expect(ReviewModel.nextUnreviewed(items(("a", true), ("b", true)), from: "b") == nil)
        #expect(ReviewModel.nextUnreviewed([], from: nil) == nil)
    }

    @Test func nextUnreviewedTreatsAnUnlistedCurrentProjectLikeNone() {
        #expect(ReviewModel.nextUnreviewed(items(("a", false), ("b", false)), from: "deleted") == "a")
    }

    // MARK: Session (useReviewSession)

    @Test func sessionStartsFromDueProjectsAndAppendsNewlyDueOnes() {
        var session = ReviewSession()
        #expect(!session.loaded)
        session.absorb(due: [project("a"), project("b")], cleanups: 0)
        #expect(session.loaded)
        session.absorb(due: [project("c")], cleanups: 0)
        #expect(session.entries.map(\.id) == ["a", "b", "c"])
    }

    @Test func sessionRebuildsFromDueProjectsAfterCleanUp() {
        var session = ReviewSession(cleanups: 3)
        session.absorb(due: [project("a"), project("b")], cleanups: 3)
        session.absorb(due: [project("b"), project("c")], cleanups: 4)
        #expect(session.entries.map(\.id) == ["b", "c"])
        session.absorb(due: [project("d")], cleanups: 4)
        #expect(session.entries.map(\.id) == ["b", "c", "d"])
    }

    // MARK: Navigation

    @Test func navigationCountsLeftAndFindsNeighbours() {
        let list = items(("a", true), ("b", false), ("c", false))
        let nav = ReviewNavigation(items: list, current: "b")
        #expect(nav.item?.project.id == "b")
        #expect(nav.previous == "a")
        #expect(nav.next == "c")
        #expect(nav.left == 2)
        #expect(nav.total == 3)
        #expect(nav.progress == "2 of 3 left")
        #expect(ReviewNavigation(items: list, current: "a").previous == nil)
        #expect(ReviewNavigation(items: list, current: "c").next == nil)
    }

    @Test func navigationRedirectsToTheFirstUnreviewedProjectWhenNoneIsOpen() {
        let list = items(("a", true), ("b", false))
        #expect(ReviewNavigation(items: list, current: nil).redirect == .some("b"))
        #expect(ReviewNavigation(items: list, current: "gone").redirect == .some("b"))
        #expect(ReviewNavigation(items: list, current: "a").redirect == nil)
        // Everything reviewed: no project open, and nothing to redirect to once already there.
        let done = items(("a", true))
        #expect(ReviewNavigation(items: done, current: nil).redirect == nil)
        #expect(ReviewNavigation(items: done, current: "gone").redirect == .some(nil))
    }

    @Test func formatsReviewIntervals() {
        #expect(ReviewModel.formatInterval(ReviewInterval(steps: 1, unit: .week)) == "1 week")
        #expect(ReviewModel.formatInterval(ReviewInterval(steps: 2, unit: .month)) == "2 months")
    }
}
