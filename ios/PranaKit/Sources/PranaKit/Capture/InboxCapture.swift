// Author: John Grimes

import Foundation

/// A new inbox item's name and note, as captured by Siri, the share extension or the watch.
public struct CaptureDraft: Sendable, Hashable {
    public var name: String
    public var note: String

    /// Creates a draft.
    public init(name: String, note: String) {
        self.name = name
        self.note = note
    }

    /// The draft for a shared item: the first non-empty line of the text (or the page title, the URL or the file
    /// names) as the name; the rest of the text and the URL as the note. Text that only repeats the URL is dropped.
    public init(text: String?, url: URL?, title: String?, fileNames: [String] = []) {
        let link = url?.absoluteString
        let trimmedText = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let lines = (trimmedText == link ? "" : trimmedText).split(separator: "\n", omittingEmptySubsequences: false)
        let first = lines.firstIndex { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let firstLine = first.map { lines[$0].trimmingCharacters(in: .whitespaces) }
        let rest = first.map { lines[($0 + 1)...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
        let pageTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty

        let name = pageTitle ?? firstLine ?? link ?? fileNames.joined(separator: ", ")
        // When the title named the item, the first line of text is part of the note.
        let textNote = pageTitle != nil ? [firstLine, rest.nonEmpty].compactMap { $0 }.joined(separator: "\n") : rest
        let noteLink = name == link ? nil : link
        self.init(name: name, note: [textNote.nonEmpty, noteLink].compactMap { $0 }.joined(separator: "\n"))
    }
}

extension String {
    /// Nil when empty.
    fileprivate var nonEmpty: String? { isEmpty ? nil : self }
}

/// The result of adding an inbox item.
public enum CaptureOutcome: Sendable, Hashable {
    /// Created (and every file attached).
    case added(id: String)
    /// Created, but attaching `file` failed.
    case attachmentsFailed(id: String, file: String, reason: String)
    /// Not created; `reason` is the server's error message (empty when it gave none).
    case failed(reason: String)
    /// No credentials: nothing was sent.
    case signedOut
    /// Empty text: nothing was sent.
    case empty

    /// Whether the item was created.
    public var isAdded: Bool {
        switch self {
        case .added, .attachmentsFailed: true
        default: false
        }
    }

    /// What Siri says (spec §15 "Feedback"): `Added "X" to your inbox.` or `Couldn't add "X": <message>`.
    public func dialog(for name: String) -> String {
        switch self {
        case .added: "Added \"\(name)\" to your inbox."
        case .attachmentsFailed(_, let file, let reason): "Added \"\(name)\" to your inbox, but couldn't attach \(file): \(reason)"
        case .failed(let reason): "Couldn't add \"\(name)\": \(reason)"
        case .signedOut: InboxCapture.signedOutMessage
        case .empty: "Nothing to add."
        }
    }
}

/// Adds inbox items for Siri (App Intents), the share extension and the watch app (spec §15): `POST /tasks` with the
/// name verbatim (no date, tag or flag parsing), then any files as attachments. Nothing is queued for a retry.
public struct InboxCapture: Sendable {
    /// Shown when no credentials are saved.
    public static let signedOutMessage: String = {
        #if os(watchOS)
            "Open Prana on your iPhone to sign in."
        #else
            "Open Prana and sign in first."
        #endif
    }()

    public let credentials: Credentials?
    public let session: URLSession

    /// Creates a capture for `credentials` (nil when signed out).
    public init(credentials: Credentials?, session: URLSession = .shared) {
        self.credentials = credentials
        self.session = session
    }

    /// Adds an item named `text` (exactly as given) to the end of the inbox.
    public func add(_ text: String) async -> CaptureOutcome {
        await add(CaptureDraft(name: text, note: ""), files: [])
    }

    /// Adds an item with the draft's name and note, then uploads `files` to it in order.
    public func add(_ draft: CaptureDraft, files: [UploadFile]) async -> CaptureOutcome {
        guard !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .empty }
        guard let credentials else { return .signedOut }
        let client = APIClient(origin: credentials.origin, token: credentials.token, session: session)
        let id: String
        do throws(APIError) {
            id = try await client.send(Endpoints.createTask(TaskCreate(name: draft.name, note: draft.note.isEmpty ? nil : draft.note))).value.id
        } catch {
            return .failed(reason: Self.reason(error))
        }
        for file in files {
            do throws(APIError) {
                _ = try await client.send(Endpoints.uploadAttachment(taskId: id, file: file))
            } catch {
                return .attachmentsFailed(id: id, file: file.name, reason: Self.reason(error))
            }
        }
        return .added(id: id)
    }

    /// The server's error message; empty for a response without one (such as a proxy's error page).
    static func reason(_ error: APIError) -> String {
        switch error {
        case .server(_, let code, let message): code.hasPrefix("http_") ? "" : message
        case .unauthorized(let message), .transport(let message): message
        case .decoding, .cancelled: ""
        }
    }
}
