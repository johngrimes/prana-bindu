// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// "Add to inbox" (spec §15) and the share extension: the text becomes the name of a new inbox item verbatim, and the
/// feedback reads exactly as the Siri Shortcut's.
struct InboxCaptureTests {
    private let token = "pb_siri"

    private func created(_ name: String) -> String {
        String(decoding: try! APIClient.encoder.encode(TaskItem(id: "newitem0001", name: name)), as: UTF8.self)
    }

    @Test func postsTheTextVerbatimAsTheNameAndConfirms() async throws {
        // Arrange
        let text = "buy milk tomorrow #errands !"
        let origin = StubURLProtocol.register { _ in .json(created(text), status: 201) }
        let capture = InboxCapture(credentials: Credentials(origin: origin, token: token), session: StubURLProtocol.session())
        // Act
        let outcome = await capture.add(text)
        // Assert
        let request = try #require(StubURLProtocol.requests(for: origin).first)
        #expect(request.method == "POST")
        #expect(request.url.path() == "/api/v1/tasks")
        #expect(request.headers["Authorization"] == "Bearer \(token)")
        #expect(request.json == .object(["name": .string(text)]))
        #expect(outcome == .added(id: "newitem0001"))
        #expect(outcome.dialog(for: text) == #"Added "buy milk tomorrow #errands !" to your inbox."#)
    }

    @Test func reportsTheServersErrorMessage() async throws {
        // Arrange
        let origin = StubURLProtocol.register { _ in
            .json(#"{"error":{"code":"unauthorized","message":"The bearer token is invalid or revoked"}}"#, status: 401)
        }
        let capture = InboxCapture(credentials: Credentials(origin: origin, token: token), session: StubURLProtocol.session())
        // Act
        let outcome = await capture.add("Milk")
        // Assert
        #expect(outcome == .failed(reason: "The bearer token is invalid or revoked"))
        #expect(outcome.dialog(for: "Milk") == #"Couldn't add "Milk": The bearer token is invalid or revoked"#)
    }

    @Test func aResponseWithoutAnErrorMessageLeavesTheReasonEmpty() async throws {
        // A proxy's error page.
        let origin = StubURLProtocol.register { _ in StubResponse(status: 502, body: Data("<html>Bad Gateway</html>".utf8)) }
        let capture = InboxCapture(credentials: Credentials(origin: origin, token: token), session: StubURLProtocol.session())
        let outcome = await capture.add("Milk")
        #expect(outcome.dialog(for: "Milk") == #"Couldn't add "Milk": "#)
    }

    @Test func withoutCredentialsAsksToSignInWithoutARequest() async {
        let outcome = await InboxCapture(credentials: nil).add("Milk")
        #expect(outcome == .signedOut)
        #expect(outcome.dialog(for: "Milk") == InboxCapture.signedOutMessage)
    }

    @Test func anEmptyAnswerStopsWithoutARequest() async {
        let origin = StubURLProtocol.register { _ in .json(created(""), status: 201) }
        let capture = InboxCapture(credentials: Credentials(origin: origin, token: token), session: StubURLProtocol.session())
        #expect(await capture.add("  \n") == .empty)
        #expect(StubURLProtocol.requests(for: origin).isEmpty)
    }

    @Test func addsANoteAndUploadsFilesAsAttachments() async throws {
        // Arrange
        let origin = StubURLProtocol.register { request in
            request.url.path().hasSuffix("/attachments")
                ? .json(#"{"id":"att1","taskId":"newitem0001","name":"photo.jpg","contentType":"image/jpeg","size":3,"sha256":"x","added":"2026-10-31T04:20:00.000Z"}"#, status: 201)
                : .json(created("Article"), status: 201)
        }
        let capture = InboxCapture(credentials: Credentials(origin: origin, token: token), session: StubURLProtocol.session())
        let file = UploadFile(name: "photo.jpg", contentType: "image/jpeg", data: Data([1, 2, 3]))
        // Act
        let outcome = await capture.add(CaptureDraft(name: "Article", note: "https://example.com/a"), files: [file])
        // Assert
        let requests = StubURLProtocol.requests(for: origin)
        #expect(requests.map(\.url.path) == ["/api/v1/tasks", "/api/v1/tasks/newitem0001/attachments"])
        #expect(requests[0].json == .object(["name": .string("Article"), "note": .string("https://example.com/a")]))
        #expect(String(decoding: requests[1].body, as: UTF8.self).contains(#"filename="photo.jpg""#))
        #expect(outcome == .added(id: "newitem0001"))
    }

    @Test func aFailedUploadIsReportedAfterTheItemWasAdded() async throws {
        let origin = StubURLProtocol.register { request in
            request.url.path().hasSuffix("/attachments")
                ? .json(#"{"error":{"code":"too_large","message":"The file is larger than 100 MB."}}"#, status: 413)
                : .json(created("Big"), status: 201)
        }
        let capture = InboxCapture(credentials: Credentials(origin: origin, token: token), session: StubURLProtocol.session())
        let outcome = await capture.add(
            CaptureDraft(name: "Big", note: ""), files: [UploadFile(name: "big.mov", contentType: "video/quicktime", data: Data([0]))])
        #expect(outcome == .attachmentsFailed(id: "newitem0001", file: "big.mov", reason: "The file is larger than 100 MB."))
        #expect(outcome.dialog(for: "Big") == #"Added "Big" to your inbox, but couldn't attach big.mov: The file is larger than 100 MB."#)
    }
}

/// The share extension's compose sheet: what a shared item becomes.
struct CaptureDraftTests {
    @Test func textGivesTheFirstLineAsNameAndTheRestAsNote() {
        let draft = CaptureDraft(text: "\n  Call the plumber  \nabout the leak\nunder the sink\n", url: nil, title: nil)
        #expect(draft == CaptureDraft(name: "Call the plumber", note: "about the leak\nunder the sink"))
    }

    @Test func aPageGivesItsTitleAsNameAndTheURLAsNote() {
        let url = URL(string: "https://example.com/article")!
        #expect(CaptureDraft(text: nil, url: url, title: "An article") == CaptureDraft(name: "An article", note: url.absoluteString))
        #expect(CaptureDraft(text: nil, url: url, title: nil) == CaptureDraft(name: url.absoluteString, note: ""))
    }

    @Test func textSharedWithAURLKeepsBoth() {
        // Safari shares the page title as text alongside the URL.
        let url = URL(string: "https://example.com/a")!
        #expect(CaptureDraft(text: "A page", url: url, title: nil) == CaptureDraft(name: "A page", note: url.absoluteString))
        #expect(
            CaptureDraft(text: "Read this\nIt is good", url: url, title: nil)
                == CaptureDraft(name: "Read this", note: "It is good\n\(url.absoluteString)"))
        // Text that is just the URL again is not repeated.
        #expect(CaptureDraft(text: url.absoluteString, url: url, title: "T") == CaptureDraft(name: "T", note: url.absoluteString))
    }

    @Test func onlyFilesGiveTheFileNamesAsName() {
        #expect(CaptureDraft(text: nil, url: nil, title: nil, fileNames: ["IMG_0001.jpg", "notes.pdf"]) == CaptureDraft(name: "IMG_0001.jpg, notes.pdf", note: ""))
    }
}
