// Author: John Grimes

import Foundation

/// A place in the app, mirroring the web app's routes (`src/web/App.tsx`) and their query parameters.
public enum Route: Hashable, Sendable {
    case inbox
    case projects(project: String?, folder: String?)
    case tags(tag: String?)
    case forecast(day: String?)
    case flagged
    case review(project: String?)
    case completed
    case changed
    case search(query: String)
    case perspective(id: String)
    case perspectiveEditor(id: String)
    case settings

    /// Parses a `prana://<path>?<query>` link the way the web app reads its paths. Nil for other schemes, unknown paths
    /// and the home page (see `DeepLink`).
    public init?(url: URL) {
        guard let link = DeepLink(url: url), let route = link.route else { return nil }
        self = route
    }

    /// Parses web path segments and query parameters.
    init?(segments: [String], query: [String: String]) {
        switch segments {
        case ["inbox"]: self = .inbox
        case ["projects"]: self = .projects(project: query["project"], folder: query["folder"])
        case ["tags"]: self = .tags(tag: query["tag"])
        case ["forecast"]: self = .forecast(day: query["day"])
        case ["flagged"]: self = .flagged
        case ["review"]: self = .review(project: query["project"])
        case ["completed"]: self = .completed
        case ["changed"]: self = .changed
        case ["search"]: self = .search(query: query["q"] ?? "")
        case ["settings"]: self = .settings
        default:
            if segments.count == 2, segments[0] == "perspectives" {
                self = .perspective(id: segments[1])
            } else if segments.count == 3, segments[0] == "perspectives", segments[2] == "edit" {
                self = .perspectiveEditor(id: segments[1])
            } else {
                return nil
            }
        }
    }

    /// The web path segments and query of this route.
    private var parts: (segments: [String], query: [(String, String?)]) {
        switch self {
        case .inbox: (["inbox"], [])
        case .projects(let project, let folder): (["projects"], [("project", project), ("folder", folder)])
        case .tags(let tag): (["tags"], [("tag", tag)])
        case .forecast(let day): (["forecast"], [("day", day)])
        case .flagged: (["flagged"], [])
        case .review(let project): (["review"], [("project", project)])
        case .completed: (["completed"], [])
        case .changed: (["changed"], [])
        case .search(let query): (["search"], [("q", query.isEmpty ? nil : query)])
        case .perspective(let id): (["perspectives", id], [])
        case .perspectiveEditor(let id): (["perspectives", id, "edit"], [])
        case .settings: (["settings"], [])
        }
    }

    /// The `prana://` link to this route.
    public var url: URL {
        let (segments, query) = parts
        var components = URLComponents()
        components.scheme = DeepLink.scheme
        components.host = segments[0]
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))
        components.percentEncodedPath = segments.dropFirst().map { "/" + ($0.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0) }.joined()
        let items = query.compactMap { name, value in value.map { URLQueryItem(name: name, value: $0) } }
        if !items.isEmpty { components.queryItems = items }
        return components.url!
    }

    /// The evaluated perspective this route shows, for routes whose outline comes from
    /// `GET /perspectives/{id}/contents` (Forecast, Search, the editor and Settings have none).
    public var contentsKey: ContentsKey? {
        switch self {
        case .inbox: .inbox
        case .projects(let project, let folder): ContentsKey(perspectiveId: "projects", project: project, folder: folder)
        case .tags(let tag): ContentsKey(perspectiveId: "tags", tag: tag)
        case .flagged: ContentsKey(perspectiveId: "flagged")
        case .review(let project): ContentsKey(perspectiveId: "review", project: project)
        case .completed: ContentsKey(perspectiveId: "completed")
        case .changed: ContentsKey(perspectiveId: "changed")
        case .perspective(let id): ContentsKey(perspectiveId: id)
        case .forecast, .search, .perspectiveEditor, .settings: nil
        }
    }
}

/// A parsed app link: the route (nil for the home page, which shows the first favourite perspective) and whether
/// `?quickEntry=1` asked for Quick Entry over it.
public struct DeepLink: Hashable, Sendable {
    /// The app's URL scheme.
    public static let scheme = "prana"

    public var route: Route?
    public var quickEntry: Bool

    /// Creates a link.
    public init(route: Route?, quickEntry: Bool = false) {
        self.route = route
        self.quickEntry = quickEntry
    }

    /// Parses `prana://<path>?<query>`. Nil for other schemes and unknown paths.
    public init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.scheme?.lowercased() == Self.scheme
        else { return nil }
        // Split before decoding, so an encoded `/` inside an id stays part of it.
        var segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: true).map {
            $0.removingPercentEncoding ?? String($0)
        }
        // `prana://forecast` puts the first segment in the host; `prana:///forecast` keeps it in the path.
        if let host = components.host, !host.isEmpty { segments.insert(host, at: 0) }
        var query: [String: String] = [:]
        for item in components.queryItems ?? [] where query[item.name] == nil { query[item.name] = item.value ?? "" }
        quickEntry = query["quickEntry"].map { $0 == "1" || $0 == "true" } ?? false
        if segments.isEmpty {
            route = nil
        } else {
            guard let route = Route(segments: segments, query: query) else { return nil }
            self.route = route
        }
    }
}

/// What the app does with a URL it is asked to open (spec §16 Deep links, Forecast widget).
public enum OpenedURL: Hashable, Sendable {
    /// A `prana://` link: show its page.
    case app(DeepLink)
    /// An http(s) URL, such as the server the widget's "Can't reach" message names: open it in the browser.
    case browser(URL)

    /// Classifies a URL; nil for other schemes and unknown `prana://` paths, which are ignored.
    public init?(_ url: URL) {
        if let link = DeepLink(url: url) {
            self = .app(link)
        } else if let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            self = .browser(url)
        } else {
            return nil
        }
    }
}
