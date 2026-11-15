// Author: John Grimes

import Foundation
import Synchronization

@testable import PranaKit

/// A canned HTTP answer for `StubURLProtocol`.
struct StubResponse: Sendable {
    var status: Int = 200
    var headers: [String: String] = [:]
    var body: Data = Data()
    /// When set, the request fails with this transport error instead.
    var failure: URLError.Code?

    static func json(_ text: String, status: Int = 200, headers: [String: String] = [:]) -> StubResponse {
        StubResponse(status: status, headers: headers.merging(["Content-Type": "application/json"]) { a, _ in a }, body: Data(text.utf8))
    }
}

/// A request as the stub saw it, with its body read from the stream URLSession hands protocols.
struct RecordedRequest: Sendable {
    var method: String
    var url: URL
    var headers: [String: String]
    var body: Data

    var json: JSONValue? { try? JSONDecoder().decode(JSONValue.self, from: body) }
}

/// Answers requests without a network. Each test uses its own host, so tests running in parallel do not share handlers.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (RecordedRequest) -> StubResponse

    private static let handlers = Mutex<[String: Handler]>([:])
    private static let recorded = Mutex<[String: [RecordedRequest]]>([:])

    /// Registers a handler for a fresh host and returns an origin pointing at it.
    static func register(_ handler: @escaping Handler) -> URL {
        let host = "stub-\(UUID().uuidString.lowercased()).test"
        handlers.withLock { $0[host] = handler }
        return URL(string: "https://\(host)")!
    }

    /// Requests received for `origin`, in order.
    static func requests(for origin: URL) -> [RecordedRequest] {
        recorded.withLock { $0[origin.host() ?? ""] ?? [] }
    }

    /// A session whose requests all go to this stub.
    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host() ?? ""
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        }
        let seen = RecordedRequest(
            method: request.httpMethod ?? "GET", url: request.url!, headers: request.allHTTPHeaderFields ?? [:], body: body)
        Self.recorded.withLock { $0[host, default: []].append(seen) }
        guard let handler = Self.handlers.withLock({ $0[host] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let answer = handler(seen)
        if let failure = answer.failure {
            client?.urlProtocol(self, didFailWithError: URLError(failure))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: answer.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
