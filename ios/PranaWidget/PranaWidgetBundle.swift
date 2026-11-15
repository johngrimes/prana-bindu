// Author: John Grimes

import PranaKit
import SwiftUI
import WidgetKit

/// The widgets Prana offers.
@main
struct PranaWidgetBundle: WidgetBundle {
    var body: some Widget {
        ForecastWidget()
    }
}

/// The Forecast widget (spec §13): a strip of Past, Today, the next four days and Future, then Today's items.
struct ForecastWidget: Widget {
    static let kind = "au.id.grimes.prana-bindu.forecast"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: ForecastProvider()) { entry in
            ForecastWidgetView(entry: entry)
        }
        .configurationDisplayName("Forecast")
        .description("Today's items and the coming days.")
        .supportedFamilies([.systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}
