// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// `prana://` links mirror the web app's paths and query parameters (spec §2), so widget taps, intents and shared
/// links open the same views as the web routes.
struct RouteTests {
    private func route(_ text: String) -> Route? { Route(url: URL(string: text)!) }

    @Test(arguments: [
        ("prana://inbox", Route.inbox),
        ("prana://projects", .projects(project: nil, folder: nil)),
        ("prana://projects?project=p1", .projects(project: "p1", folder: nil)),
        ("prana://projects?folder=f1", .projects(project: nil, folder: "f1")),
        ("prana://tags?tag=t%201", .tags(tag: "t 1")),
        ("prana://tags", .tags(tag: nil)),
        ("prana://forecast?day=TODAY", .forecast(day: "TODAY")),
        ("prana://forecast", .forecast(day: nil)),
        ("prana://flagged", .flagged),
        ("prana://review?project=p2", .review(project: "p2")),
        ("prana://completed", .completed),
        ("prana://changed", .changed),
        ("prana://search?q=milk%20run", .search(query: "milk run")),
        ("prana://search", .search(query: "")),
        ("prana://perspectives/abc", .perspective(id: "abc")),
        ("prana://perspectives/abc/edit", .perspectiveEditor(id: "abc")),
        ("prana://settings", .settings),
        ("prana:///inbox", .inbox),
    ])
    func parsesWebPaths(_ text: String, _ expected: Route) {
        #expect(route(text) == expected)
    }

    @Test func rejectsUnknownPathsAndSchemes() {
        #expect(route("prana://nowhere") == nil)
        #expect(route("prana://perspectives") == nil)
        #expect(route("mailto:someone@example.org") == nil)
        #expect(route("prana://login") == nil)
        #expect(route("https://tasks.example.org/forecast?day=2026-11-04") == nil)
    }

    @Test func appLinksNavigateAndWebLinksOpenInTheBrowser() throws {
        let server = try #require(URL(string: "https://tasks.example.org"))
        #expect(OpenedURL(try #require(URL(string: "prana://inbox?quickEntry=1"))) == .app(DeepLink(route: .inbox, quickEntry: true)))
        #expect(OpenedURL(server) == .browser(server))
        #expect(OpenedURL(try #require(URL(string: "http://localhost:3000"))) == .browser(URL(string: "http://localhost:3000")!))
        #expect(OpenedURL(try #require(URL(string: "prana://nowhere"))) == nil)
        #expect(OpenedURL(try #require(URL(string: "mailto:someone@example.org"))) == nil)
    }

    @Test func quickEntryOpensOnAnyRouteAndOnTheHomePage() throws {
        // `?quickEntry=1` opens Quick Entry over whatever the link shows.
        let link = try #require(DeepLink(url: URL(string: "prana://forecast?day=TODAY&quickEntry=1")!))
        #expect(link.route == .forecast(day: "TODAY"))
        #expect(link.quickEntry)
        let home = try #require(DeepLink(url: URL(string: "prana://?quickEntry=1")!))
        #expect(home.route == nil)
        #expect(home.quickEntry)
        #expect(DeepLink(url: URL(string: "prana://inbox")!)?.quickEntry == false)
    }

    @Test(arguments: [
        Route.inbox, .projects(project: "p 1", folder: nil), .projects(project: nil, folder: "f"), .tags(tag: "t"),
        .forecast(day: "TODAY"), .flagged, .review(project: nil), .completed, .changed, .search(query: "a&b"),
        .perspective(id: "x/y"), .perspectiveEditor(id: "x"), .settings,
    ])
    func urlsRoundTrip(_ route: Route) {
        #expect(Route(url: route.url) == route)
    }

    @Test func mapsPerspectiveRoutesToContentsKeys() {
        #expect(Route.inbox.contentsKey == .inbox)
        #expect(Route.projects(project: "p", folder: nil).contentsKey == ContentsKey(perspectiveId: "projects", project: "p"))
        #expect(Route.tags(tag: "t").contentsKey == ContentsKey(perspectiveId: "tags", tag: "t"))
        #expect(Route.perspective(id: "c").contentsKey == ContentsKey(perspectiveId: "c"))
        #expect(Route.settings.contentsKey == nil)
        // Forecast reads `GET /forecast`, not perspective contents; Review evaluates the `review` perspective.
        #expect(Route.forecast(day: "TODAY").contentsKey == nil)
        #expect(Route.review(project: "p").contentsKey == ContentsKey(perspectiveId: "review", project: "p"))
    }
}
