// Author: John Grimes

import PranaKit
import SwiftUI

extension Color {
    /// A colour from a `#rrggbb` string; nil for anything else (e.g. no colour set).
    init?(hex: String?) {
        guard let hex, let rgb = PerspectiveStyle.rgb(hex: hex) else { return nil }
        self.init(red: rgb.red, green: rgb.green, blue: rgb.blue)
    }

    /// The `#rrggbb` form of this colour in sRGB (alpha dropped).
    var hexString: String {
        let resolved = resolve(in: EnvironmentValues())
        return PerspectiveStyle.hex(red: Double(resolved.red), green: Double(resolved.green), blue: Double(resolved.blue))
    }
}

extension PerspectiveStyle {
    /// The perspective's colour, or the accent colour when it has none.
    static func tint(of perspective: Perspective) -> Color {
        Color(hex: color(of: perspective)) ?? .accentColor
    }
}
