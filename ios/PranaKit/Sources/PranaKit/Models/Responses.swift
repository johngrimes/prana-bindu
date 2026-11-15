// Author: John Grimes

import Foundation

/// A list response `{ items: [...] }`.
public struct Items<Item: Codable & Sendable>: Codable, Sendable {
    public var items: [Item]

    /// Creates a list response.
    public init(items: [Item]) { self.items = items }
}

extension Items: Equatable where Item: Equatable {}

/// One day (or the Past/Future bucket) of the Forecast (spec §5).
public struct ForecastDay: Codable, Sendable, Hashable, Identifiable {
    /// `PAST`, `TODAY`, `YYYY-MM-DD` or `FUTURE`.
    public var key: String
    /// `YYYY-MM-DD` for real days, nil for the buckets.
    public var date: String?
    public var title: String
    public var dueCount: Int
    public var count: Int
    public var deferredCount: Int
    public var badge: ForecastBadge?
    public var rows: [OutlineRow]

    /// The day key.
    public var id: String { key }
}

/// Item counts of one calendar day in the Forecast strip.
public struct ForecastCalendarDay: Codable, Sendable, Hashable {
    /// `YYYY-MM-DD`.
    public var date: String
    public var dueCount: Int
    public var count: Int
}

/// `GET /forecast`. Mirrors `Forecast`.
public struct ForecastResponse: Codable, Sendable, Hashable {
    /// Today's `YYYY-MM-DD` in the user's time zone.
    public var today: String
    public var days: [ForecastDay]
    public var calendar: [ForecastCalendarDay]
}

/// `GET /search`. Mirrors `SearchResults`.
public struct SearchResults: Codable, Sendable, Hashable {
    public var query: String
    public var tasks: [TaskItem]
    public var projects: [Project]
    public var folders: [Folder]
    public var tags: [Tag]

    /// Creates results.
    public init(query: String, tasks: [TaskItem] = [], projects: [Project] = [], folders: [Folder] = [], tags: [Tag] = []) {
        self.query = query
        self.tasks = tasks
        self.projects = projects
        self.folders = folders
        self.tags = tags
    }
}

/// One Quick Open match. Mirrors `QuickOpenResult`.
public struct QuickOpenResult: Codable, Sendable, Hashable, Identifiable {
    public var type: QuickOpenType
    public var id: String
    public var name: String
    public var score: Double
    /// Character index ranges `[start, end]` in `name` that matched.
    public var matches: [[Int]]
}

/// The server's undo history (`GET /history`, spec §2/§9). Mirrors `History`.
public struct History: Codable, Sendable, Hashable {
    public var canUndo: Bool
    public var canRedo: Bool
    public var undoLabel: String?
    public var redoLabel: String?
    /// The step Undo would revert (ids as in `X-Undo-Step`).
    public var undoId: Int?
    /// The step Redo would reapply.
    public var redoId: Int?

    /// Creates a history.
    public init(canUndo: Bool, canRedo: Bool, undoLabel: String?, redoLabel: String?, undoId: Int?, redoId: Int?) {
        self.canUndo = canUndo
        self.canRedo = canRedo
        self.undoLabel = undoLabel
        self.redoLabel = redoLabel
        self.undoId = undoId
        self.redoId = redoId
    }
}

/// An OmniFocus import run. Mirrors `ImportRun`.
public struct ImportRun: Codable, Sendable, Hashable, Identifiable {
    public var id: Int
    public var importedAt: String
    public var source: String
    public var appId: String?
    public var appVersion: String?
    public var counts: [String: Int]
    public var warnings: [String]
}

/// `GET /import/last`.
public struct LastImport: Codable, Sendable, Hashable {
    public var run: ImportRun?
}

/// Response of multi-entity mutations: the tasks they changed. Mirrors `Changed`.
public struct Changed: Codable, Sendable, Hashable {
    public var changed: [TaskItem]

    /// Creates a response.
    public init(changed: [TaskItem]) { self.changed = changed }
}

/// A page of `GET /tasks`; pass `nextCursor` back as `cursor`. Mirrors `TaskPage`.
public struct TaskPage: Codable, Sendable, Hashable {
    public var items: [TaskItem]
    public var nextCursor: String?
}

/// `POST /parse` response: a date value string or a duration in minutes.
public struct ParseResponse: Codable, Sendable, Hashable {
    /// The parsed value.
    public enum Value: Codable, Sendable, Hashable {
        case date(String)
        case minutes(Int)

        /// Decodes either form.
        public init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let minutes = try? c.decode(Int.self) { self = .minutes(minutes) } else { self = .date(try c.decode(String.self)) }
        }

        /// Encodes the bare value.
        public func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .date(let value): try c.encode(value)
            case .minutes(let value): try c.encode(value)
            }
        }
    }

    public var value: Value
}

/// `GET /auth/session`. Mirrors `AuthSession`.
public struct AuthSession: Codable, Sendable, Hashable {
    public var authenticated: Bool
    /// `session` or `token`.
    public var via: String
}

/// A registered passkey (spec §6). Mirrors `AuthPasskey`.
public struct Passkey: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var createdAt: String
    public var lastUsedAt: String?
    public var deviceType: String?
    public var backedUp: Bool
}

/// An API token as listed (the plaintext is never returned again). Mirrors `ApiTokenInfo`.
public struct ApiToken: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    /// Leading characters of the plaintext, e.g. `pb_AbC123`.
    public var prefix: String
    public var createdAt: String
    public var lastUsedAt: String?
}

/// `POST /auth/tokens` response: the token and its plaintext, shown once. Mirrors `ApiTokenCreated`.
public struct ApiTokenCreated: Codable, Sendable, Hashable {
    public var token: ApiToken
    public var plaintext: String
}

/// The server's error body `{ error: { code, message, details } }`.
public struct ErrorBody: Codable, Sendable, Hashable {
    /// The error.
    public struct Detail: Codable, Sendable, Hashable {
        public var code: String
        public var message: String
        public var details: JSONValue?
    }

    public var error: Detail
}
