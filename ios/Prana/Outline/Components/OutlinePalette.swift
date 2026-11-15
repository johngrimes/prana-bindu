// Author: John Grimes

import SwiftUI
import UIKit

/// The web app's semantic colours (`src/web/styles.css`), light and dark, for status circles and chips.
enum OutlinePalette {
    static let accent = dynamic(light: 0x2F5D62, dark: 0x6FB3B0)
    static let accentSoft = dynamic(light: 0xDCEBE9, dark: 0x23393A)
    static let accentText = dynamic(light: 0xFFFFFF, dark: 0x0F1214)
    static let danger = dynamic(light: 0xC4372F, dark: 0xFF6B5F)
    static let dangerSoft = dynamic(light: 0xF8DEDB, dark: 0x3D2120)
    static let warn = dynamic(light: 0xC66B12, dark: 0xF29A45)
    static let warnSoft = dynamic(light: 0xFAE7D2, dark: 0x3B2A19)
    static let flag = dynamic(light: 0xE08A12, dark: 0xF2A33A)
    static let muted = dynamic(light: 0x6B6F74, dark: 0xA1A5AB)
    static let faint = dynamic(light: 0x9A9DA1, dark: 0x737880)
    static let text = dynamic(light: 0x1D2125, dark: 0xE9E7E1)
    static let surface2 = dynamic(light: 0xEFEDE6, dark: 0x24282E)
    static let select = dynamic(light: 0xD9E8F2, dark: 0x22364A)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1)
        })
    }
}
