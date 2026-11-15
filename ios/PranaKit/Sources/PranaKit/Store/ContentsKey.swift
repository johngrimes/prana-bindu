// Author: John Grimes

import Foundation

/// Identifies one evaluated perspective view: the perspective plus the query parameters of
/// `GET /perspectives/{id}/contents` (a sidebar selection, a Forecast day, a search).
public struct ContentsKey: Hashable, Sendable, Codable {
    public var perspectiveId: String
    /// Project selected in the sidebar (or the project being reviewed).
    public var project: String?
    /// Folder selected in the sidebar.
    public var folder: String?
    /// Tag selected in the sidebar.
    public var tag: String?
    /// Forecast day: `PAST`, `TODAY`, `YYYY-MM-DD` or `FUTURE`.
    public var day: String?
    /// Search text.
    public var q: String?

    /// Creates a key.
    public init(perspectiveId: String, project: String? = nil, folder: String? = nil, tag: String? = nil, day: String? = nil, q: String? = nil) {
        self.perspectiveId = perspectiveId
        self.project = project
        self.folder = folder
        self.tag = tag
        self.day = day
        self.q = q
    }

    /// The Inbox.
    public static let inbox = ContentsKey(perspectiveId: "inbox")

    /// The query items for the contents request.
    public var queryItems: [URLQueryItem] {
        [("project", project), ("folder", folder), ("tag", tag), ("day", day), ("q", q)].compactMap { name, value in
            value.map { URLQueryItem(name: name, value: $0) }
        }
    }
}
