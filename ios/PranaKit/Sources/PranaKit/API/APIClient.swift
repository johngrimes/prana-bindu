// Author: John Grimes

import Foundation

/// HTTP methods the REST API uses.
public enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
}

/// A file sent as multipart form data (attachment uploads, spec §3 Inspector).
public struct UploadFile: Sendable, Hashable {
    /// File name shown in the attachment list.
    public var name: String
    /// MIME type; `application/octet-stream` when unknown.
    public var contentType: String
    /// The file's bytes.
    public var data: Data

    /// Creates a file to upload.
    public init(name: String, contentType: String = "application/octet-stream", data: Data) {
        self.name = name
        self.contentType = contentType
        self.data = data
    }
}

/// A request body.
public enum RequestBody: Sendable, Hashable {
    case none
    /// Encoded JSON.
    case json(Data)
    /// One file in the multipart field `field`.
    case multipart(field: String, file: UploadFile)
}

/// One REST request whose successful response decodes as `T`. Build them with `Endpoints`.
public struct APIRequest<T: Decodable & Sendable>: Sendable {
    public var method: HTTPMethod
    /// Path relative to `/api/v1`, with path segments already percent-encoded.
    public var path: String
    public var query: [URLQueryItem]
    public var body: RequestBody

    /// Creates a request.
    public init(method: HTTPMethod, path: String, query: [URLQueryItem] = [], body: RequestBody = .none) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
    }
}

/// Response type of requests that answer with no body (204).
public struct EmptyResponse: Codable, Sendable, Hashable {
    /// Creates an empty response.
    public init() {}
}

/// Undo bookkeeping headers a journaled write returns (spec §9): `X-Undo-Steps` (steps the write added, 0 when it
/// changed nothing, -1 when it erased one), `X-Undo-Step` (the step it recorded) and `X-Undo-Previous` (the step
/// before it, 0 for none).
public struct UndoHeaders: Sendable, Equatable, Hashable {
    public let steps: Int?
    public let step: Int?
    public let previous: Int?

    /// Creates headers.
    public init(steps: Int?, step: Int?, previous: Int?) {
        self.steps = steps
        self.step = step
        self.previous = previous
    }

    /// No undo headers.
    public static let none = UndoHeaders(steps: nil, step: nil, previous: nil)
}

/// A decoded response with its undo headers.
public struct APIResponse<T: Sendable>: Sendable {
    public let value: T
    public let undo: UndoHeaders

    /// Creates a response.
    public init(value: T, undo: UndoHeaders) {
        self.value = value
        self.undo = undo
    }
}

/// Why a request failed.
public enum APIError: Error, Sendable, Equatable {
    /// The server answered 4xx/5xx with `{error:{code,message}}` (or a non-JSON body: code `http_<status>`).
    case server(status: Int, code: String, message: String)
    /// The server answered 401: the token is missing, invalid or revoked.
    case unauthorized(message: String)
    /// The server could not be reached (URLError etc.); worth retrying.
    case transport(String)
    /// The response could not be decoded.
    case decoding(String)
    /// The request was cancelled (its task was cancelled, e.g. the view that asked went away): not a failure to show
    /// or retry.
    case cancelled

    /// Network errors and 5xx: another attempt may succeed (spec §2 "Instant writes").
    public var isTransient: Bool {
        switch self {
        case .transport: true
        case .server(let status, _, _): status >= 500
        case .unauthorized, .decoding, .cancelled: false
        }
    }

    /// A message for the user.
    public var message: String {
        switch self {
        case .server(_, _, let message), .unauthorized(let message), .transport(let message), .decoding(let message): message
        case .cancelled: "Cancelled"
        }
    }
}

/// Talks to a prana-bindu server's REST API (`<origin>/api/v1`) with a bearer token.
public struct APIClient: Sendable {
    /// The server origin, e.g. `https://tasks.example.org`.
    public let origin: URL
    /// The API token (`pb_…`).
    public let token: String
    private let session: URLSession

    /// Creates a client.
    public init(origin: URL, token: String, session: URLSession = .shared) {
        self.origin = origin
        self.token = token
        self.session = session
    }

    /// The JSON decoder for server responses.
    public static var decoder: JSONDecoder { JSONDecoder() }

    /// The JSON encoder for request bodies (sorted keys keep bodies stable).
    public static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    /// The full URL of `request`.
    public func url<T>(for request: APIRequest<T>) -> URL {
        var base = origin.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        var components = URLComponents(string: base + "/api/v1" + request.path)!
        if !request.query.isEmpty { components.queryItems = request.query }
        return components.url!
    }

    /// Sends `request`; writes pass an `Idempotency-Key` so a retry applies once.
    public func send<T: Decodable & Sendable>(_ request: APIRequest<T>, idempotencyKey: String? = nil) async throws(APIError) -> APIResponse<T> {
        var urlRequest = URLRequest(url: url(for: request))
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if let idempotencyKey { urlRequest.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        switch request.body {
        case .none:
            break
        case .json(let data):
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = data
        case .multipart(let field, let file):
            let boundary = "PranaBoundary-\(UUID().uuidString)"
            urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = Self.multipart(field: field, file: file, boundary: boundary)
        }

        // A task cancelled before it sends sends nothing (URLSession may otherwise complete it anyway).
        if Task.isCancelled { throw .cancelled }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch let error as URLError where error.code == .cancelled {
            throw .cancelled
        } catch is CancellationError {
            throw .cancelled
        } catch {
            throw .transport((error as? URLError)?.localizedDescription ?? "Network error")
        }
        guard let http = response as? HTTPURLResponse else { throw .transport("Network error") }
        let undo = UndoHeaders(
            steps: http.value(forHTTPHeaderField: "X-Undo-Steps").flatMap { Int($0) },
            step: http.value(forHTTPHeaderField: "X-Undo-Step").flatMap { Int($0) },
            previous: http.value(forHTTPHeaderField: "X-Undo-Previous").flatMap { Int($0) })

        guard (200..<300).contains(http.statusCode) else {
            let body = try? Self.decoder.decode(ErrorBody.self, from: data)
            if http.statusCode == 401 { throw .unauthorized(message: body?.error.message ?? "Token rejected") }
            throw .server(
                status: http.statusCode, code: body?.error.code ?? "http_\(http.statusCode)",
                message: body?.error.message ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode).capitalized)
        }
        if T.self == EmptyResponse.self, let empty = EmptyResponse() as? T {
            return APIResponse(value: empty, undo: undo)
        }
        if T.self == Data.self, let raw = data as? T {
            return APIResponse(value: raw, undo: undo)
        }
        do {
            return APIResponse(value: try Self.decoder.decode(T.self, from: data), undo: undo)
        } catch {
            throw .decoding("Unexpected response from the server: \(error)")
        }
    }

    /// A `multipart/form-data` body with one file part.
    static func multipart(field: String, file: UploadFile, boundary: String) -> Data {
        // Quotes and line breaks cannot appear in a quoted header parameter.
        let safeName = file.name.replacingOccurrences(of: "\"", with: "%22").replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"\(field)\"; filename=\"\(safeName)\"\r\n".utf8))
        body.append(Data("Content-Type: \(file.contentType)\r\n\r\n".utf8))
        body.append(file.data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }
}
