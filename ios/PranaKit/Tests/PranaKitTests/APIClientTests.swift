// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// The API client sends authenticated requests to `/api/v1`, maps the server's error bodies, and reports the undo
/// headers writes return (spec §2 "Instant writes", §9).
struct APIClientTests {
    private func client(_ handler: @escaping StubURLProtocol.Handler) -> (APIClient, URL) {
        let origin = StubURLProtocol.register(handler)
        return (APIClient(origin: origin, token: "pb_secret", session: StubURLProtocol.session()), origin)
    }

    @Test func sendsBearerTokenToApiV1AndDecodes() async throws {
        // Arrange
        let settings = String(decoding: try fixture("settings"), as: UTF8.self)
        let (api, origin) = client { _ in .json(settings) }
        // Act
        let response = try await api.send(Endpoints.settings())
        // Assert
        let request = try #require(StubURLProtocol.requests(for: origin).first)
        #expect(request.method == "GET")
        #expect(request.url.path() == "/api/v1/settings")
        #expect(request.headers["Authorization"] == "Bearer pb_secret")
        #expect(request.headers["Idempotency-Key"] == nil)
        #expect(response.value.dateFormat.rawValue.isEmpty == false)
        #expect(response.undo == UndoHeaders(steps: nil, step: nil, previous: nil))
    }

    @Test func sendsJsonBodyIdempotencyKeyAndParsesUndoHeaders() async throws {
        // Arrange: the server reports the undo step the write recorded.
        let task = String(decoding: try APIClient.encoder.encode(TaskItem(id: "abcdefghijk", name: "Milk")), as: UTF8.self)
        let (api, origin) = client { _ in .json(task, status: 201, headers: ["X-Undo-Steps": "1", "X-Undo-Step": "42", "X-Undo-Previous": "41"]) }
        // Act
        let response = try await api.send(Endpoints.createTask(TaskCreate(id: "abcdefghijk", name: "Milk", inbox: true)), idempotencyKey: "key-1")
        // Assert
        let request = try #require(StubURLProtocol.requests(for: origin).first)
        #expect(request.method == "POST")
        #expect(request.url.path() == "/api/v1/tasks")
        #expect(request.headers["Idempotency-Key"] == "key-1")
        #expect(request.headers["Content-Type"] == "application/json")
        #expect(request.json == .object(["id": .string("abcdefghijk"), "name": .string("Milk"), "inbox": .bool(true)]))
        #expect(response.undo == UndoHeaders(steps: 1, step: 42, previous: 41))
        #expect(response.value.name == "Milk")
    }

    @Test func treats204AsEmptyResponse() async throws {
        let (api, origin) = client { _ in StubResponse(status: 204, headers: ["X-Undo-Steps": "1"]) }
        let response = try await api.send(Endpoints.deleteTask("a/b c"))
        #expect(response.undo.steps == 1)
        // Path segments are percent-encoded so an id can never change the route.
        let request = try #require(StubURLProtocol.requests(for: origin).first)
        #expect(request.method == "DELETE")
        #expect(request.url.absoluteString.hasSuffix("/api/v1/tasks/a%2Fb%20c"))
    }

    @Test func encodesQueryItems() async throws {
        let contents = String(decoding: try fixture("inbox_contents"), as: UTF8.self)
        let (api, origin) = client { _ in .json(contents) }
        _ = try await api.send(Endpoints.contents(ContentsKey(perspectiveId: "forecast", tag: "t 1", day: "TODAY")))
        let request = try #require(StubURLProtocol.requests(for: origin).first)
        #expect(request.url.path() == "/api/v1/perspectives/forecast/contents")
        let items = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(Set(items) == [URLQueryItem(name: "day", value: "TODAY"), URLQueryItem(name: "tag", value: "t 1")])
    }

    @Test func mapsErrorBodies() async throws {
        let (api, _) = client { _ in .json(#"{"error":{"code":"invalid","message":"Bad date.","details":{"field":"dueDate"}}}"#, status: 422) }
        await #expect(throws: APIError.server(status: 422, code: "invalid", message: "Bad date.")) {
            _ = try await api.send(Endpoints.patchTask("t", TaskPatch(dueDate: "nonsense")))
        }
    }

    @Test func mapsUnauthorised() async throws {
        let body = String(decoding: try fixture("error_401"), as: UTF8.self)
        let (api, _) = client { _ in .json(body, status: 401) }
        await #expect(throws: APIError.unauthorized(message: "The bearer token is invalid or revoked")) {
            _ = try await api.send(Endpoints.settings())
        }
    }

    @Test func mapsNonJsonServerErrors() async throws {
        let (api, _) = client { _ in StubResponse(status: 502, body: Data("<html>Bad gateway</html>".utf8)) }
        do {
            _ = try await api.send(Endpoints.history())
            Issue.record("expected an error")
        } catch {
            guard case .server(let status, _, _) = error else { Issue.record("wrong error \(error)"); return }
            #expect(status == 502)
            #expect(error.isTransient)
        }
    }

    @Test func mapsTransportFailures() async throws {
        let (api, _) = client { _ in StubResponse(failure: .notConnectedToInternet) }
        do {
            _ = try await api.send(Endpoints.history())
            Issue.record("expected an error")
        } catch {
            guard case .transport = error else { Issue.record("wrong error \(error)"); return }
            #expect(error.isTransient)
        }
    }

    @Test func mapsACancelledRequestToCancelledNotTransport() async {
        let (api, _) = client { _ in StubResponse(failure: .cancelled) }
        do {
            _ = try await api.send(Endpoints.history())
            Issue.record("expected an error")
        } catch {
            #expect(error == .cancelled)
            #expect(!error.isTransient)
        }
    }

    @Test func mapsASendInACancelledTaskToCancelled() async {
        let (api, _) = client { _ in .json("{}") }
        let task = Task { () -> APIError? in
            withUnsafeCurrentTask { $0?.cancel() }
            do throws(APIError) {
                _ = try await api.send(Endpoints.history())
                return nil
            } catch {
                return error
            }
        }
        #expect(await task.value == .cancelled)
    }

    @Test func mapsUndecodableBodies() async throws {
        let (api, _) = client { _ in .json(#"{"nope":true}"#) }
        do {
            _ = try await api.send(Endpoints.history())
            Issue.record("expected an error")
        } catch {
            guard case .decoding = error else { Issue.record("wrong error \(error)"); return }
            #expect(!error.isTransient)
        }
    }

    @Test func clientErrorsAreNotTransient() {
        #expect(!APIError.server(status: 409, code: "conflict", message: "x").isTransient)
        #expect(APIError.server(status: 503, code: "down", message: "x").isTransient)
        #expect(!APIError.unauthorized(message: "x").isTransient)
        #expect(APIError.server(status: 422, code: "invalid", message: "Bad date.").message == "Bad date.")
    }

    @Test func uploadsMultipartFile() async throws {
        // Arrange
        let attachment = #"{"id":"att1","taskId":"t1","name":"a.txt","contentType":"text/plain","size":5,"sha256":"x","added":"2026-01-01T00:00:00.000Z"}"#
        let (api, origin) = client { _ in .json(attachment, status: 201) }
        let file = UploadFile(name: "a \"quoted\".txt", contentType: "text/plain", data: Data("hello".utf8))
        // Act
        let response = try await api.send(Endpoints.uploadAttachment(taskId: "t1", file: file), idempotencyKey: "k")
        // Assert
        let request = try #require(StubURLProtocol.requests(for: origin).first)
        let contentType = try #require(request.headers["Content-Type"])
        #expect(contentType.hasPrefix("multipart/form-data; boundary="))
        let boundary = String(contentType.dropFirst("multipart/form-data; boundary=".count))
        let text = String(decoding: request.body, as: UTF8.self)
        #expect(text.hasPrefix("--\(boundary)\r\n"))
        #expect(text.contains("Content-Disposition: form-data; name=\"file\"; filename=\"a %22quoted%22.txt\"\r\n"))
        #expect(text.contains("Content-Type: text/plain\r\n\r\nhello\r\n--\(boundary)--\r\n"))
        #expect(response.value.id == "att1")
    }

    @Test func joinsOriginWithTrailingSlashOrPath() async throws {
        let (api, origin) = client { _ in .json(#"{"canUndo":false,"canRedo":false,"undoLabel":null,"redoLabel":null,"undoId":null,"redoId":null}"#) }
        let slashed = APIClient(origin: origin.appending(path: "/"), token: "t", session: StubURLProtocol.session())
        _ = try await api.send(Endpoints.history())
        _ = try await slashed.send(Endpoints.history())
        #expect(StubURLProtocol.requests(for: origin).map { $0.url.path() } == ["/api/v1/history", "/api/v1/history"])
    }

    @Test func authEndpointsUseAuthPrefix() {
        #expect(Endpoints.passkeys().path == "/auth/passkeys")
        #expect(Endpoints.renamePasskey("p1", name: "Phone").method == .patch)
        #expect(Endpoints.revokeToken("tok").path == "/auth/tokens/tok")
        #expect(Endpoints.createToken(name: "iPhone").method == .post)
        #expect(Endpoints.session().path == "/auth/session")
    }
}
