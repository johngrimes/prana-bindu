// Author: John Grimes

import Foundation

/// The App Group the app shares with its widget and share extension (`group.au.id.grimes.prana-bindu`).
public enum AppGroup {
    /// The group named by the bundle's `AppGroupIdentifier` Info.plist key, or nil when absent (tests, the watch).
    public static func identifier(bundle: Bundle = .main) -> String? {
        guard let group = bundle.object(forInfoDictionaryKey: "AppGroupIdentifier") as? String,
            !group.isEmpty, !group.hasPrefix("$(")
        else { return nil }
        return group
    }

    /// The group's shared container, or nil when the build is not entitled to it.
    public static func containerURL(bundle: Bundle = .main) -> URL? {
        guard let identifier = identifier(bundle: bundle) else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    }
}
