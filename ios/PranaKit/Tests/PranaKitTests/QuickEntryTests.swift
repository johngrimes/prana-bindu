// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Quick Entry (spec §4, `src/web/components/QuickEntry.tsx`): the due date is parsed before saving, an unparseable
/// one keeps the sheet open, and the item goes to the Inbox or the start of the chosen project.
struct QuickEntryTests {
    private let settings: Settings = {
        var s = Settings.defaults(timeZone: "Australia/Brisbane")
        s.defaultDueTime = "17:00"
        s.dateFormat = .dayMonthYear
        return s
    }()

    /// 2026-11-04 09:00 in Brisbane (UTC+10).
    private let now = Date(timeIntervalSince1970: 1_793_746_800)

    @Test func savesToTheInboxWithAParsedDueDate() throws {
        var draft = QuickEntryDraft()
        draft.name = "  Call Sam "
        draft.due = "tomorrow 5pm"
        draft.flagged = true
        draft.tags = [MatchItem(id: "t1", name: "Phone")]
        let task = try draft.makeTask(id: "abc", settings: settings, now: now).get()
        #expect(task.id == "abc")
        #expect(task.name == "Call Sam")
        #expect(task.inbox == true)
        #expect(task.projectId == nil)
        #expect(task.position == nil)
        #expect(task.dueDate == .some("2026-11-05T17:00:00.000"))
        #expect(task.flagged == true)
        #expect(task.tagIds == ["t1"])
        #expect(task.note == nil)
        #expect(draft.confirmation == "Added to Inbox")
        #expect(draft.title == "Inbox")
    }

    @Test func savesToTheStartOfAChosenProject() throws {
        var draft = QuickEntryDraft()
        draft.name = "Buy paint"
        draft.note = "Blue"
        draft.project = MatchItem(id: "p1", name: "Renovation")
        let task = try draft.makeTask(id: "abc", settings: settings, now: now).get()
        #expect(task.projectId == "p1")
        #expect(task.position == .start)
        #expect(task.inbox == nil)
        #expect(task.dueDate == .some(nil))
        #expect(task.note == "Blue")
        #expect(draft.confirmation == "Added to Renovation")
        #expect(draft.title == "Renovation")
    }

    @Test func anUnparseableDueDateKeepsTheSheetOpen() {
        var draft = QuickEntryDraft()
        draft.name = "Thing"
        draft.due = "someday maybe"
        #expect(draft.makeTask(id: "abc", settings: settings, now: now) == .failure(.unparseableDue))
        #expect(QuickEntryError.unparseableDue.message == "Unable to parse date")
        #expect(draft.duePreview(settings: settings, now: now) == .invalid)
    }

    @Test func anEmptyTitleCannotBeSaved() {
        var draft = QuickEntryDraft()
        draft.name = "   "
        #expect(!draft.canSave)
        #expect(draft.makeTask(id: "abc", settings: settings, now: now) == .failure(.emptyTitle))
    }

    @Test func duePreviewShowsTheParsedDate() {
        var draft = QuickEntryDraft()
        draft.due = "tomorrow 5pm"
        #expect(draft.duePreview(settings: settings, now: now) == .parsed("Thu 05/11/2026 5:00 PM"))
        draft.due = ""
        #expect(draft.duePreview(settings: settings, now: now) == .none)
    }

    @Test func tagsCanBeAddedOnceAndRemoved() {
        var draft = QuickEntryDraft()
        draft.addTag(MatchItem(id: "t1", name: "A"))
        draft.addTag(MatchItem(id: "t1", name: "A"))
        draft.addTag(MatchItem(id: "t2", name: "B"))
        draft.removeTag("t1")
        #expect(draft.tags.map(\.id) == ["t2"])
    }
}
