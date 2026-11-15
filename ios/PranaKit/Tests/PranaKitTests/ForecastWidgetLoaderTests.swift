// Author: John Grimes

import Foundation
import Testing

@testable import PranaKit

/// Ports the loading and failure behaviour of `scriptable/prana-bindu-forecast.test.ts` (spec §13 "Failures"): the
/// widget fetches `/forecast?days=5` and `/settings`, caches what it draws (never the token), falls back to the cache
/// unless the token was rejected, and names the server when nothing is cached.
struct ForecastWidgetLoaderTests {
    private let token = "pb_secret_widget"

    private func scenario() throws -> WidgetScenario { try WidgetScenario.load("typical") }

    /// A stub server answering the two widget requests from the scenario.
    private func server(_ scenario: WidgetScenario) throws -> URL {
        let forecast = String(decoding: try APIClient.encoder.encode(scenario.forecast), as: UTF8.self)
        let settings = String(decoding: try APIClient.encoder.encode(scenario.settings), as: UTF8.self)
        return StubURLProtocol.register { request in
            request.url.path() == "/api/v1/settings" ? .json(settings) : .json(forecast)
        }
    }

    private func tempDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "widget-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func loader(_ directory: URL) -> ForecastWidgetLoader {
        ForecastWidgetLoader(cacheStore: ForecastWidgetCacheStore(directory: directory), session: StubURLProtocol.session())
    }

    @Test func fetchesForecastAndSettingsWithTheTokenAndCachesWithoutIt() async throws {
        // Arrange
        let scenario = try scenario()
        let origin = try server(scenario)
        let directory = tempDirectory()
        // Act
        let state = await loader(directory).load(credentials: Credentials(origin: origin, token: token), now: scenario.nowDate)
        // Assert
        let requests = StubURLProtocol.requests(for: origin)
        #expect(requests.map { "\($0.url.path())?\($0.url.query() ?? "")" }.sorted() == ["/api/v1/forecast?days=5", "/api/v1/settings?"])
        for request in requests { #expect(request.headers["Authorization"] == "Bearer \(token)") }
        guard case .forecast(let cache, let stale) = state else {
            Issue.record("expected a forecast, got \(state)")
            return
        }
        #expect(!stale)
        #expect(cache.origin == origin)
        #expect(cache.fetchedAt == scenario.nowDate)
        #expect(cache.settings == ForecastWidgetCache.DisplaySettings(timeZone: "Australia/Brisbane", dateFormat: .monthDayYear, use24HourTime: false))
        #expect(cache.model.columns.map(\.count) == [2, 3, 1, 1, 1, 0, 1])
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        #expect(files.count == 1)
        let written = try String(contentsOf: try #require(files.first), encoding: .utf8)
        #expect(!written.contains(token))
    }

    @Test func offlineOrServerErrorShowsTheCacheAsStale() async throws {
        // Arrange: one successful load, then the server goes away.
        let scenario = try scenario()
        let directory = tempDirectory()
        let origin = try server(scenario)
        _ = await loader(directory).load(credentials: Credentials(origin: origin, token: token), now: scenario.nowDate)
        let store = ForecastWidgetCacheStore(directory: directory)
        let offline = StubURLProtocol.register { _ in StubResponse(failure: .notConnectedToInternet) }
        let failing = StubURLProtocol.register { _ in StubResponse(status: 503, body: Data("Service Unavailable".utf8)) }
        // The cache is per origin: copy it to the stand-in origins, as if the same server had moved address.
        let cache = try #require(store.read(origin: origin))
        for other in [offline, failing] {
            store.write(ForecastWidgetCache(origin: other, fetchedAt: cache.fetchedAt, settings: cache.settings, model: cache.model))
            // Act
            let later = scenario.nowDate.addingTimeInterval(45 * 60)
            let state = await loader(directory).load(credentials: Credentials(origin: other, token: token), now: later)
            // Assert
            guard case .forecast(let shown, let stale) = state else {
                Issue.record("expected the cached forecast, got \(state)")
                return
            }
            #expect(stale)
            #expect(shown.updatedNote(now: later) == "Updated 2:20 PM")
        }
    }

    @Test func offlineWithoutACacheNamesTheServer() async throws {
        // Arrange
        let directory = tempDirectory()
        let offline = StubURLProtocol.register { _ in StubResponse(failure: .notConnectedToInternet) }
        let portal = StubURLProtocol.register { _ in StubResponse(status: 200, body: Data("<html>Sign in to Wi-Fi</html>".utf8)) }
        // Act
        let none = await loader(directory).load(credentials: Credentials(origin: offline, token: token), now: .now)
        let captive = await loader(directory).load(credentials: Credentials(origin: portal, token: token), now: .now)
        // Assert
        guard case .unreachable(let origin, _) = none else {
            Issue.record("expected unreachable, got \(none)")
            return
        }
        #expect(origin == offline)
        #expect(none.message.hasPrefix("Can't reach \(offline.host()!)."))
        #expect(captive.message == "Can't reach \(portal.host()!). The server's answer wasn't JSON.")
    }

    @Test func cantReachOpensTheServerAndOtherMessagesOpenTheApp() throws {
        let origin = try #require(URL(string: "https://tasks.example.org"))
        let unreachable = ForecastWidgetState.unreachable(origin: origin, reason: "Offline.")
        #expect(unreachable.message == "Can't reach tasks.example.org. Offline.")
        #expect(unreachable.tapURL == origin)
        #expect(ForecastWidgetState.unauthorized.tapURL == ForecastWidgetLinks.today)
        #expect(ForecastWidgetState.signedOut.tapURL == ForecastWidgetLinks.today)
    }

    @Test func aCacheForAnotherServerIsIgnored() async throws {
        let scenario = try scenario()
        let directory = tempDirectory()
        let origin = try server(scenario)
        _ = await loader(directory).load(credentials: Credentials(origin: origin, token: token), now: scenario.nowDate)
        let other = StubURLProtocol.register { _ in StubResponse(failure: .cannotConnectToHost) }
        let state = await loader(directory).load(credentials: Credentials(origin: other, token: token), now: scenario.nowDate)
        #expect(state.message.hasPrefix("Can't reach \(other.host()!)"))
    }

    @Test func aRejectedTokenIgnoresTheCache() async throws {
        // Arrange
        let scenario = try scenario()
        let directory = tempDirectory()
        let origin = try server(scenario)
        _ = await loader(directory).load(credentials: Credentials(origin: origin, token: token), now: scenario.nowDate)
        let store = ForecastWidgetCacheStore(directory: directory)
        let cache = try #require(store.read(origin: origin))
        let rejecting = StubURLProtocol.register { _ in
            .json(#"{"error":{"code":"unauthorized","message":"The bearer token is invalid or revoked"}}"#, status: 401)
        }
        store.write(ForecastWidgetCache(origin: rejecting, fetchedAt: cache.fetchedAt, settings: cache.settings, model: cache.model))
        // Act
        let state = await loader(directory).load(credentials: Credentials(origin: rejecting, token: "pb_revoked"), now: .now)
        // Assert
        #expect(state == .unauthorized)
        #expect(state.message.hasPrefix("Token rejected"))
    }

    @Test func withoutCredentialsAsksToSignInAndMakesNoRequests() async throws {
        let state = await loader(tempDirectory()).load(credentials: nil, now: .now)
        #expect(state == .signedOut)
        #expect(state.message == "Sign in to Prana")
    }

    @Test func otherSizesAskForMediumOrLarge() {
        #expect(ForecastWidgetState.unsupportedSizeMessage == "Use the medium or large widget size.")
    }

    @Test func refreshesAfterFifteenMinutes() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(ForecastWidgetLoader.nextRefresh(after: now) == now.addingTimeInterval(15 * 60))
    }
}
