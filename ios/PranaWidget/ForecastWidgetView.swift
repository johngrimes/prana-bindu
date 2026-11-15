// Author: John Grimes

import PranaKit
import SwiftUI
import WidgetKit

/// The iOS system colours the Scriptable widget uses, following the appearance (spec §13 "Colours").
enum WidgetColour {
    static let background = dynamic(0xFFFFFF, 0x1C1C1E)
    static let text = dynamic(0x000000, 0xFFFFFF)
    static let secondary = dynamic(0x6C6C70, 0x8E8E93)
    static let faint = dynamic(0xC7C7CC, 0x48484A)
    static let highlight = dynamic(0xE5E5EA, 0x3A3A3C)
    static let red = dynamic(0xFF3B30, 0xFF453A)
    static let redSoft = dynamic(0xFF3B30, 0xFF453A, alpha: 0.22)
    static let yellow = dynamic(0xFFCC00, 0xFFD60A)
    static let yellowSoft = dynamic(0xFFCC00, 0xFFD60A, alpha: 0.22)
    static let yellowText = dynamic(0x946200, 0xFFD60A)
    static let grey = dynamic(0x8E8E93, 0x8E8E93)
    static let orange = dynamic(0xFF9500, 0xFF9F0A)
    static let accent = dynamic(0x007AFF, 0x0A84FF)
    /// The flag corner keeps one orange that suits both appearances, as in the Scriptable widget.
    static let flagCorner = Color(rgb: 0xFF9F0A)

    private static func dynamic(_ light: UInt32, _ dark: UInt32, alpha: CGFloat = 1) -> Color {
        Color(
            uiColor: UIColor { traits in
                UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light, alpha: alpha)
            })
    }

    /// A dot's colour: red overdue, yellow due soon, grey otherwise.
    static func dot(_ tone: ForecastWidgetTone) -> Color {
        switch tone {
        case .overdue: red
        case .dueSoon: yellow
        case .due: grey
        }
    }
}

extension UIColor {
    fileprivate convenience init(rgb: UInt32, alpha: CGFloat) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255,
            alpha: alpha)
    }
}

extension Color {
    fileprivate init(rgb: UInt32) {
        self.init(uiColor: UIColor(rgb: rgb, alpha: 1))
    }
}

/// The widget for an entry: the forecast, or a message for the failure states.
struct ForecastWidgetView: View {
    let entry: ForecastEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            switch (ForecastWidgetFamily(family), entry.state) {
            case (nil, _):
                MessageView(text: ForecastWidgetState.unsupportedSizeMessage)
            case (let size?, .forecast(let cache, let stale)):
                ForecastContent(family: size, cache: cache, stale: stale, now: entry.date)
            case (_, let state):
                MessageView(text: state.message)
                    .widgetURL(state.tapURL)
            }
        }
        .containerBackground(WidgetColour.background, for: .widget)
    }
}

extension ForecastWidgetFamily {
    /// The model family of a WidgetKit family, nil for sizes the widget doesn't draw.
    init?(_ family: WidgetFamily) {
        switch family {
        case .systemMedium: self = .medium
        case .systemLarge: self = .large
        default: return nil
        }
    }
}

/// "Prana" and one line of explanation.
private struct MessageView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Prana")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(WidgetColour.text)
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(WidgetColour.secondary)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16))
    }
}

/// The strip, Today's rows, the "Updated" note when stale, and the "+" button.
private struct ForecastContent: View {
    let family: ForecastWidgetFamily
    let cache: ForecastWidgetCache
    let stale: Bool
    let now: Date

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 2) {
                ForEach(cache.model.columns) { column in
                    Link(destination: column.url) { ColumnView(column: column) }
                }
            }
            HStack(alignment: .bottom, spacing: 6) {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(cache.model.rows(for: family, stale: stale).enumerated()), id: \.offset) { _, row in
                        Link(destination: ForecastWidgetLinks.today) { RowView(row: row).frame(maxWidth: .infinity) }
                    }
                    if cache.model.rows.isEmpty {
                        Text(ForecastWidgetModel.emptyText)
                            .font(.system(size: 15))
                            .foregroundStyle(WidgetColour.secondary)
                    }
                    Spacer(minLength: 0)
                    if stale {
                        Text(cache.updatedNote(now: now))
                            .font(.system(size: 10))
                            .foregroundStyle(WidgetColour.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Link(destination: ForecastWidgetLinks.quickEntry) {
                    Image(systemName: "plus")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 30, height: 30)
                        .background(WidgetColour.accent, in: Circle())
                }
                .accessibilityLabel("New item")
            }
        }
        .padding(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
        .widgetURL(ForecastWidgetLinks.today)
    }
}

/// One strip column: title, count (faint at zero) and up to four due dots; Today highlighted.
private struct ColumnView: View {
    let column: ForecastWidgetColumn

    var body: some View {
        VStack(spacing: 1) {
            Text(column.title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(WidgetColour.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(String(column.count))
                .font(.system(size: 24, weight: .medium, design: .rounded))
                .foregroundStyle(column.isDimmed ? WidgetColour.faint : WidgetColour.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            HStack(spacing: 2) {
                ForEach(Array(column.dots.enumerated()), id: \.offset) { _, tone in
                    Circle().fill(WidgetColour.dot(tone)).frame(width: 5, height: 5)
                }
            }
            .frame(height: 8)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity)
        .background(column.isHighlighted ? WidgetColour.highlight : .clear, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(column.title): \(column.count)")
    }
}

/// One of Today's items: status circle with the flag corner, name and due chip.
private struct RowView: View {
    let row: ForecastWidgetRow

    var body: some View {
        HStack(spacing: 6) {
            StatusCell(row: row)
            Text(row.name)
                .font(.system(size: 15))
                .foregroundStyle(row.isDimmed ? WidgetColour.secondary : WidgetColour.text)
                .lineLimit(1)
            Spacer(minLength: 0)
            if let chip = row.chip {
                Text(chip.text)
                    .font(.system(size: 12))
                    .foregroundStyle(chipText(chip.tone))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .padding(EdgeInsets(top: 1, leading: 4, bottom: 1, trailing: 4))
                    .background(chipBackground(chip.tone), in: RoundedRectangle(cornerRadius: 4))
            }
        }
    }

    private func chipText(_ tone: ForecastWidgetTone?) -> Color {
        switch tone {
        case .overdue: WidgetColour.red
        case .dueSoon: WidgetColour.yellowText
        default: WidgetColour.secondary
        }
    }

    private func chipBackground(_ tone: ForecastWidgetTone?) -> Color {
        switch tone {
        case .overdue: WidgetColour.redSoft
        case .dueSoon: WidgetColour.yellowSoft
        default: .clear
        }
    }
}

/// The status circle (square for projects): dashed/dotted SF Symbols for blocked and repeating, otherwise a ring in
/// the state's colours; an orange corner when flagged.
private struct StatusCell: View {
    let row: ForecastWidgetRow

    var body: some View {
        ZStack(alignment: .topLeading) {
            if row.isFlagged {
                FlagCorner().fill(WidgetColour.flagCorner).frame(width: 8.5, height: 8.5)
            }
            Group {
                if let symbol = row.symbolName {
                    Image(systemName: symbol)
                        .resizable()
                        .frame(width: 17, height: 17)
                        .foregroundStyle(WidgetColour.secondary)
                } else {
                    let shape = RoundedRectangle(cornerRadius: row.isProject ? 4 : 7.5)
                    shape.fill(ringFill)
                        .overlay(shape.stroke(ringBorder, lineWidth: 1.75))
                        .frame(width: 15, height: 15)
                }
            }
            .frame(width: 20, height: 20)
        }
        .frame(width: 20, height: 20)
    }

    private var ringBorder: Color {
        switch row.circle {
        case .overdue: WidgetColour.red
        case .dueSoon: WidgetColour.yellow
        case .flagged: WidgetColour.orange
        case .next: WidgetColour.text
        default: WidgetColour.secondary
        }
    }

    private var ringFill: Color {
        switch row.circle {
        case .overdue: WidgetColour.redSoft
        case .dueSoon: WidgetColour.yellowSoft
        default: .clear
        }
    }
}

/// The flagged corner: a triangle in the top-left corner.
private struct FlagCorner: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: rect.origin)
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            path.closeSubpath()
        }
    }
}

#Preview("Medium", as: .systemMedium) {
    ForecastWidget()
} timeline: {
    ForecastEntry(date: .now, state: .forecast(.sample, stale: false))
    ForecastEntry(date: .now, state: .forecast(.sample, stale: true))
    ForecastEntry(date: .now, state: .unauthorized)
}

#Preview("Large", as: .systemLarge) {
    ForecastWidget()
} timeline: {
    ForecastEntry(date: .now, state: .forecast(.sample, stale: false))
}
