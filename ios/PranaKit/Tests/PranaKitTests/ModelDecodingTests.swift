// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Loads a captured server response from the test bundle's `Fixtures` folder.
func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
}

/// Decodes a fixture as `T` with the decoder the API client uses.
func decodeFixture<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
    try APIClient.decoder.decode(T.self, from: fixture(name))
}

/// Every model must decode real responses captured from a running server (`/tmp/pb-ios`), so the native client and the
/// server agree on field names and shapes.
struct ModelDecodingTests {
    @Test func decodesInboxContentsWithTaskRows() throws {
        // Act
        let contents = try decodeFixture(OutlineContents.self, "inbox_contents")
        // Assert: the inbox has one group of task rows carrying their tasks.
        #expect(contents.perspectiveId == "inbox")
        let group = try #require(contents.groups.first)
        #expect(group.key == "inbox")
        #expect(group.kind == .none)
        #expect(group.rows.allSatisfy { $0.kind == .task && $0.task != nil })
    }

    @Test func decodesProjectContentsWithProjectHeaders() throws {
        let contents = try decodeFixture(OutlineContents.self, "perspectives_projects_contents")
        let row = try #require(contents.groups.first?.rows.first)
        // A project header row carries the project with its root task.
        #expect(row.kind == .project)
        #expect(row.project?.task.isProject == true)
        #expect(row.project?.id == row.id)
    }

    @Test func decodesOtherContents() throws {
        _ = try decodeFixture(OutlineContents.self, "forecast_contents")
        let tags = try decodeFixture(OutlineContents.self, "tags_contents")
        #expect(!tags.groups.isEmpty)
    }

    @Test func decodesListsOfEntities() throws {
        let folders = try decodeFixture(Items<Folder>.self, "folders").items
        let tags = try decodeFixture(Items<PranaKit.Tag>.self, "tags").items
        let projects = try decodeFixture(Items<Project>.self, "projects").items
        let perspectives = try decodeFixture(Items<Perspective>.self, "perspectives").items
        let review = try decodeFixture(Items<Project>.self, "review").items
        #expect(!folders.isEmpty && !tags.isEmpty && !projects.isEmpty && !review.isEmpty)
        let inbox = try #require(perspectives.first { $0.id == "inbox" })
        #expect(inbox.builtin)
        #expect(inbox.viewOptions.filter == .remaining)
        #expect(inbox.presentation.layout == .projects)
    }

    @Test func keepsCustomPerspectiveRulesAsJSON() throws {
        let perspectives = try decodeFixture(Items<Perspective>.self, "perspectives").items
        // Custom perspectives carry rule JSON that must round-trip untouched.
        let custom = try #require(perspectives.first { !$0.builtin && !$0.rules.isEmpty })
        let again = try APIClient.decoder.decode(Perspective.self, from: APIClient.encoder.encode(custom))
        #expect(again == custom)
    }

    @Test func decodesTaskDetailWithAlarmsAndAttachments() throws {
        let detail = try decodeFixture(TaskDetail.self, "task_detail_attachments")
        #expect(detail.alarms.count == 2)
        #expect(detail.attachments.count == 2)
        #expect(detail.attachments.allSatisfy { $0.taskId == detail.id })
        let project = try decodeFixture(TaskDetail.self, "task_detail")
        #expect(project.project != nil)
        #expect(project.children.count == 6)
        #expect(project.task.isProject)
    }

    @Test func taskDetailEncodesFlat() throws {
        // The detail extends Task: its JSON is flat, not nested under `task`.
        let detail = try decodeFixture(TaskDetail.self, "task_detail")
        let json = try APIClient.decoder.decode(JSONValue.self, from: APIClient.encoder.encode(detail))
        #expect(json["name"] == .string(detail.name))
        #expect(json["task"] == nil)
    }

    @Test func decodesForecast() throws {
        let forecast = try decodeFixture(ForecastResponse.self, "forecast_days_5")
        #expect(forecast.days.first?.key == "PAST")
        #expect(forecast.days.first?.badge == .overdue)
        #expect(!forecast.calendar.isEmpty)
    }

    @Test func decodesSearchQuickOpenHistoryAndSettings() throws {
        let search = try decodeFixture(SearchResults.self, "search")
        #expect(search.query == "a")
        let quick = try decodeFixture(Items<QuickOpenResult>.self, "quick_open").items
        #expect(quick.allSatisfy { $0.matches.allSatisfy { $0.count == 2 } })
        let history = try decodeFixture(History.self, "history")
        #expect(history.canUndo == false && history.undoId == nil)
        _ = try decodeFixture(Settings.self, "settings")
    }

    @Test func decodesTaskPageImportAndAuth() throws {
        let page = try decodeFixture(TaskPage.self, "tasks_page")
        #expect(page.items.count == 5)
        let last = try decodeFixture(LastImport.self, "import_last")
        #expect(last.run?.counts["tasks"] == 16)
        let session = try decodeFixture(AuthSession.self, "session")
        #expect(session.via == "token")
        let tokens = try decodeFixture(Items<ApiToken>.self, "tokens").items
        #expect(tokens.first?.prefix.hasPrefix("pb_") == true)
        _ = try decodeFixture(Items<Passkey>.self, "passkeys")
    }

    @Test func decodesPasskey() throws {
        let json = #"{"id":"p1","name":"MacBook","createdAt":"2026-01-01T00:00:00.000Z","lastUsedAt":null,"deviceType":"multiDevice","backedUp":true}"#
        let passkey = try APIClient.decoder.decode(Passkey.self, from: Data(json.utf8))
        #expect(passkey.name == "MacBook" && passkey.backedUp && passkey.lastUsedAt == nil)
    }

    @Test func toleratesUnknownEnumValues() throws {
        // The server may add statuses later: decoding must not fail, and the raw value survives a round trip.
        let status = try APIClient.decoder.decode(TaskStatus.self, from: Data(#""someday""#.utf8))
        #expect(status.rawValue == "someday")
        #expect(String(decoding: try APIClient.encoder.encode(status), as: UTF8.self) == #""someday""#)
    }

    @Test func keepsDatesAsServerStrings() throws {
        // Dates are never reformatted: floating values keep their exact text.
        let page = try decodeFixture(TaskPage.self, "tasks_page")
        let raw = try APIClient.decoder.decode(JSONValue.self, from: fixture("tasks_page"))
        guard case .array(let items) = raw["items"] else { Issue.record("no items"); return }
        for (task, json) in zip(page.items, items) {
            #expect(json["added"] == .string(task.added))
            if let due = task.dueDate { #expect(json["dueDate"] == .string(due)) }
        }
    }

    @Test func decodesChanged() throws {
        let page = try decodeFixture(TaskPage.self, "tasks_page")
        let body = try APIClient.encoder.encode(Changed(changed: page.items))
        #expect(try APIClient.decoder.decode(Changed.self, from: body).changed == page.items)
    }
}

/// Request bodies must encode exactly the keys the caller set, with explicit nulls for clears.
struct InputEncodingTests {
    private func json(_ value: some Encodable) throws -> JSONValue {
        try APIClient.decoder.decode(JSONValue.self, from: APIClient.encoder.encode(value))
    }

    @Test func taskPatchOmitsUnsetFieldsAndSendsNullForClears() throws {
        // Arrange: set the name, clear the due date, leave the rest untouched.
        let patch = TaskPatch(name: "Call", dueDate: .some(nil))
        // Act
        let body = try json(patch)
        // Assert
        #expect(body == .object(["name": .string("Call"), "dueDate": .null]))
    }

    @Test func positionsEncodeAsStringsOrAnchors() throws {
        #expect(try json(Position.start) == .string("start"))
        #expect(try json(Position.end) == .string("end"))
        #expect(try json(Position.before("x")) == .object(["before": .string("x")]))
        #expect(try json(Position.after("y")) == .object(["after": .string("y")]))
        let decoded = try APIClient.decoder.decode(Position.self, from: Data(#"{"after":"y"}"#.utf8))
        #expect(decoded == .after("y"))
    }

    @Test func taskCreateEncodesClientIdAndInbox() throws {
        let body = try json(TaskCreate(id: "abcdefghijk", name: "Milk", inbox: true))
        #expect(body == .object(["id": .string("abcdefghijk"), "name": .string("Milk"), "inbox": .bool(true)]))
    }

    @Test func projectPatchEncodesProjectFields() throws {
        let body = try json(ProjectPatch(status: .onHold, folderId: .some(nil), reviewInterval: ReviewInterval(steps: 2, unit: .week)))
        #expect(body["status"] == .string("onHold"))
        #expect(body["folderId"] == .null)
        #expect(body["reviewInterval"] == .object(["steps": .number(2), "unit": .string("week")]))
    }
}
