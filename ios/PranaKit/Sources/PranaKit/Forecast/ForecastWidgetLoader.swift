// Author: John Grimes

import Foundation

/// The last successful forecast, kept on the device so the widget can show it when the server can't be reached
/// (spec §13 "Failures"). Holds the computed strip and rows and the display settings, never the token.
public struct ForecastWidgetCache: Codable, Sendable, Hashable {
    /// The settings the "Updated" note needs.
    public struct DisplaySettings: Codable, Sendable, Hashable {
        public var timeZone: String
        public var dateFormat: Settings.DateFormat
        public var use24HourTime: Bool

        /// Creates display settings.
        public init(timeZone: String, dateFormat: Settings.DateFormat, use24HourTime: Bool) {
            self.timeZone = timeZone
            self.dateFormat = dateFormat
            self.use24HourTime = use24HourTime
        }

        /// The display settings of `settings`.
        public init(_ settings: Settings) {
            self.init(timeZone: settings.timeZone, dateFormat: settings.dateFormat, use24HourTime: settings.use24HourTime)
        }

        /// Full settings for the date formatters (other fields at the server's defaults).
        var settings: Settings {
            var settings = Settings.defaults(timeZone: timeZone)
            settings.dateFormat = dateFormat
            settings.use24HourTime = use24HourTime
            return settings
        }
    }

    /// The server the forecast came from; a cache for another server is never shown.
    public var origin: URL
    public var fetchedAt: Date
    public var settings: DisplaySettings
    public var model: ForecastWidgetModel

    /// Creates a cache entry.
    public init(origin: URL, fetchedAt: Date, settings: DisplaySettings, model: ForecastWidgetModel) {
        self.origin = origin
        self.fetchedAt = fetchedAt
        self.settings = settings
        self.model = model
    }

    /// "Updated 2:20 PM", or with the day when the forecast was fetched on another day ("Updated Yesterday 2:20 PM").
    public func updatedNote(now: Date) -> String {
        let settings = settings.settings
        let fetched = DateDisplay.instantToWall(fetchedAt, timeZone: settings.timeZone)
        if DateDisplay.wallDayKey(fetched) == DateDisplay.todayKey(timeZone: settings.timeZone, now: now) {
            return "Updated \(DateDisplay.formatTime(fetched, use24HourTime: settings.use24HourTime))"
        }
        let instant = DateDisplay.wallToFloating(fetched)
        return "Updated \(DateDisplay.formatDateChip(instant, settings: settings, now: now))"
    }
}

/// Reads and writes the widget's cache file in a directory (the App Group container in the widget).
public struct ForecastWidgetCacheStore: Sendable {
    /// The cache file's name.
    public static let fileName = "forecast-widget-cache.json"

    public let directory: URL

    /// Creates a store for `directory`.
    public init(directory: URL) {
        self.directory = directory
    }

    /// The store in the App Group container named by the bundle's `AppGroupIdentifier`, or in the caches directory
    /// when the container is unavailable.
    public static func shared(bundle: Bundle = .main) -> ForecastWidgetCacheStore {
        let directory =
            AppGroup.containerURL(bundle: bundle)
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return ForecastWidgetCacheStore(directory: directory)
    }

    private var url: URL { directory.appending(path: Self.fileName) }

    /// The cache for `origin`, or nil when there is none or it belongs to another server.
    public func read(origin: URL) -> ForecastWidgetCache? {
        guard let data = try? Data(contentsOf: url),
            let cache = try? JSONDecoder.forecastCache.decode(ForecastWidgetCache.self, from: data),
            cache.origin == origin
        else { return nil }
        return cache
    }

    /// Replaces the cache.
    public func write(_ cache: ForecastWidgetCache) {
        guard let data = try? JSONEncoder.forecastCache.encode(cache) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    /// Deletes the cache (sign-out).
    public func delete() {
        try? FileManager.default.removeItem(at: url)
    }
}

extension JSONEncoder {
    fileprivate static var forecastCache: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

extension JSONDecoder {
    fileprivate static var forecastCache: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

/// What the Forecast widget shows.
public enum ForecastWidgetState: Sendable, Hashable {
    /// The forecast; `stale` when it is the cache shown because the server could not be reached.
    case forecast(ForecastWidgetCache, stale: Bool)
    /// No credentials saved.
    case signedOut
    /// The server answered 401.
    case unauthorized
    /// No answer (or no usable one) and nothing cached for this server.
    case unreachable(origin: URL, reason: String)

    /// Shown by sizes other than medium and large.
    public static let unsupportedSizeMessage = "Use the medium or large widget size."

    /// The message a non-forecast state shows (empty for `.forecast`).
    public var message: String {
        switch self {
        case .forecast: ""
        case .signedOut: "Sign in to Prana"
        case .unauthorized: "Token rejected. Open Prana to sign in again."
        case .unreachable(let origin, let reason):
            "Can't reach \(ForecastWidgetLoader.host(of: origin))." + (reason.isEmpty ? "" : " \(reason)")
        }
    }

    /// What a tap on the widget's background opens: the server in the browser when it can't be reached (spec §13
    /// "Failures"), otherwise Today in the app.
    public var tapURL: URL {
        switch self {
        case .unreachable(let origin, _): origin
        case .forecast, .signedOut, .unauthorized: ForecastWidgetLinks.today
        }
    }
}

/// Fetches the forecast for the widget and falls back to the cache (port of `load` in
/// `scriptable/prana-bindu-forecast.js`).
public struct ForecastWidgetLoader: Sendable {
    /// iOS is asked to refresh the widget this long after each timeline.
    public static let refreshInterval: TimeInterval = 15 * 60
    /// Requests give up after this long, so the widget is drawn within its time budget.
    static let requestTimeout: TimeInterval = 15

    public let cacheStore: ForecastWidgetCacheStore
    public let session: URLSession

    /// Creates a loader.
    public init(cacheStore: ForecastWidgetCacheStore, session: URLSession? = nil) {
        self.cacheStore = cacheStore
        self.session =
            session
            ?? {
                let configuration = URLSessionConfiguration.ephemeral
                configuration.timeoutIntervalForRequest = Self.requestTimeout
                return URLSession(configuration: configuration)
            }()
    }

    /// When the timeline should be refreshed.
    public static func nextRefresh(after now: Date) -> Date { now.addingTimeInterval(refreshInterval) }

    /// Loads the forecast: caches and returns it, or returns the cache (stale) unless the token was rejected, or the
    /// failure.
    public func load(credentials: Credentials?, now: Date) async -> ForecastWidgetState {
        guard let credentials else { return .signedOut }
        let client = APIClient(origin: credentials.origin, token: credentials.token, session: session)
        async let forecast = Self.result { () async throws(APIError) in
            try await client.send(Endpoints.forecast(days: ForecastWidgetModel.days)).value
        }
        async let settings = Self.result { () async throws(APIError) in try await client.send(Endpoints.settings()).value }
        switch await (forecast, settings) {
        case (.success(let f), .success(let s)):
            let cache = ForecastWidgetCache(
                origin: credentials.origin, fetchedAt: now, settings: .init(s),
                model: ForecastWidgetModel(forecast: f, settings: s, now: now))
            cacheStore.write(cache)
            return .forecast(cache, stale: false)
        case (.failure(.unauthorized), _), (_, .failure(.unauthorized)):
            return .unauthorized
        case (.failure(let error), _), (_, .failure(let error)):
            if let cache = cacheStore.read(origin: credentials.origin) { return .forecast(cache, stale: true) }
            return .unreachable(origin: credentials.origin, reason: Self.reason(error))
        }
    }

    /// Runs a request, capturing its error, so two requests can run concurrently with `async let`.
    private static func result<T: Sendable>(_ body: @Sendable () async throws(APIError) -> T) async -> Result<T, APIError> {
        do throws(APIError) { return .success(try await body()) } catch { return .failure(error) }
    }

    /// The origin without its scheme, as the Scriptable widget names it.
    static func host(of origin: URL) -> String {
        origin.absoluteString.replacing(/^https?:\/\//.ignoresCase(), with: "")
    }

    private static func reason(_ error: APIError) -> String {
        switch error {
        case .server(let status, _, _): "The server answered HTTP \(status)."
        // For example a captive portal's login page.
        case .decoding: "The server's answer wasn't JSON."
        case .transport(let message), .unauthorized(let message): message
        case .cancelled: error.message
        }
    }
}
