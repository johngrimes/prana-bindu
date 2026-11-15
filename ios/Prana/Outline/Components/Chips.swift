// Author: John Grimes

import PranaKit
import SwiftUI

/// A due or defer chip (`DateChip` in `Row.tsx`): red when overdue, orange when due soon, italic when implied.
struct DateChipView: View {
    let chip: RowBadges.DateChip
    /// "Due" or "Deferred until", for VoiceOver.
    let label: String
    let systemImage: String
    let settings: Settings

    var body: some View {
        let (fg, bg) = colours
        Label {
            Text(DateDisplay.formatDateChip(chip.value, settings: settings, now: .now))
                .italic(chip.implied)
        } icon: {
            Image(systemName: systemImage)
        }
        .labelStyle(.chip)
        .font(.caption)
        .padding(.horizontal, 6)
        .padding(.vertical, 1)
        .foregroundStyle(fg)
        .background(bg, in: .rect(cornerRadius: 6))
        .opacity(chip.implied ? 0.8 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label) \(DateDisplay.formatDateChip(chip.value, settings: settings, now: .now))")
    }

    private var colours: (Color, Color) {
        switch chip.tone {
        case .danger: (OutlinePalette.danger, OutlinePalette.dangerSoft)
        case .warn: (OutlinePalette.warn, OutlinePalette.warnSoft)
        case .muted: (OutlinePalette.muted, OutlinePalette.surface2)
        }
    }
}

/// A removable tag pill.
struct TagPill: View {
    let name: String
    /// The row's title, for the remove button's VoiceOver label.
    let rowTitle: String
    /// Nil hides the remove button.
    var onRemove: (() -> Void)?

    var body: some View {
        HStack(spacing: 2) {
            Text(name)
                .font(.caption)
                .foregroundStyle(OutlinePalette.text)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(OutlinePalette.muted)
                        .frame(width: 18, height: 18)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Remove tag \(name) from \(rowTitle)")
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, onRemove == nil ? 8 : 1)
        .padding(.vertical, 1)
        .background(OutlinePalette.accentSoft, in: .capsule)
        .accessibilityIdentifier("tag-pill")
    }
}

/// Icon and title tight together, as in the web chips.
struct ChipLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

extension LabelStyle where Self == ChipLabelStyle {
    /// Icon and title tight together.
    static var chip: ChipLabelStyle { ChipLabelStyle() }
}
