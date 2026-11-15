// Author: John Grimes

import PranaKit
import SwiftUI

/// The Forecast page (spec §4 Forecast): the day strip (Past, Today, the next 6 days, Future) over the day sections;
/// `?day=` shows one section. A day beyond the loaded range is fetched on its own.
struct ForecastPage: View {
    /// `.forecast(day:)`.
    let route: Route

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    @State private var single: ForecastResponse?
    @State private var loaded = false

    private var selected: String? {
        if case .forecast(let day) = route { day } else { nil }
    }

    private var perspective: Perspective? { store.state.perspectives?.first { $0.id == "forecast" } }

    var body: some View {
        @Bindable var navigator = navigator
        VStack(spacing: 0) {
            if let forecast = store.state.forecast {
                // The days come from `/forecast`, not the store's contents: they are the outline's server rows.
                let groups = ForecastPageModel.groups(forecast, single: single, selected: selected)
                ForecastStrip(forecast: forecast, selected: selected)
                Divider()
                OutlineView(
                    contents: OutlineContents(perspectiveId: "forecast", viewOptions: perspective?.viewOptions ?? ViewOptions(), groups: groups),
                    context: OutlineContext(
                        perspective: perspective, contentsKey: ContentsKey(perspectiveId: "forecast", day: selected),
                        reorderMode: navigator.reordering, selection: navigator.selection, serverGroups: groups)
                )
                .overlay {
                    if groups.allSatisfy(\.rows.isEmpty) {
                        PageMessage("No items").allowsHitTesting(false)
                    }
                }
            } else {
                PageMessage(loaded ? "The Forecast could not be loaded." : "Loading…", busy: !loaded)
            }
        }
        .navigationTitle("Forecast")
        .viewOptions(isPresented: $navigator.showsViewOptions, enabled: perspective != nil) {
            if let perspective { ViewOptionsPanel(perspective: perspective) }
        }
        .task {
            await store.loadForecast()
            loaded = true
        }
        .task(id: selected) {
            single = nil
            guard let forecast = store.state.forecast, let selected, ForecastPageModel.isOutside(forecast, selected: selected)
            else { return }
            single = try? await store.send(Endpoints.forecast(from: selected, days: 1))
        }
    }
}

/// The strip under the header: Past, Today, the next days and Future with due counts (badge tone from the server).
private struct ForecastStrip: View {
    let forecast: ForecastResponse
    let selected: String?

    @Environment(Navigator.self) private var navigator

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(forecast.days) { day in
                    let label = ForecastPageModel.label(day, today: forecast.today)
                    let key = ForecastPageModel.selectionKey(day, today: forecast.today)
                    let isSelected = selected == key || selected == day.key
                    Button {
                        navigator.navigate(to: .forecast(day: isSelected ? nil : key))
                    } label: {
                        VStack(spacing: 2) {
                            Text(label.top).font(.caption.weight(.medium))
                            if !label.bottom.isEmpty { Text(label.bottom).font(.caption2).opacity(0.7) }
                            ForecastBadgeView(count: day.dueCount, tone: day.badge)
                        }
                        .frame(minWidth: 52, minHeight: 56)
                        .frame(maxWidth: .infinity)
                        .foregroundStyle(isSelected ? Color.white : Color.primary)
                        .background(isSelected ? Color.accentColor : Color.clear, in: .rect(cornerRadius: 12))
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(label.top) \(label.bottom)\(day.dueCount > 0 ? ", \(day.dueCount) due" : "")")
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                    .accessibilityIdentifier("forecast-strip-\(key)")
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .accessibilityLabel("Forecast days")
    }
}

/// A due-count badge: red when overdue, orange when due soon, grey otherwise; empty space for zero.
struct ForecastBadgeView: View {
    let count: Int
    let tone: ForecastBadge?

    var body: some View {
        if count > 0 {
            Text("\(count)")
                .font(.caption2.weight(.semibold))
                .monospacedDigit()
                .padding(.horizontal, 6)
                .frame(minWidth: 20, minHeight: 18)
                .foregroundStyle(tone == nil ? Color.primary : Color.white)
                .background(background, in: .capsule)
        } else {
            Color.clear.frame(height: 18)
        }
    }

    private var background: Color {
        switch tone {
        case .some(.overdue): .red
        case .some(.dueSoon): .orange
        default: Color(.systemGray5)
        }
    }
}

/// The Forecast sidebar calendar: Past (overdue count), five weeks from the start of the current week with per-day due
/// counts, and Future.
struct ForecastCalendarSidebar: View {
    let selected: String?

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator

    var body: some View {
        if let forecast = store.state.forecast {
            calendar(forecast)
        } else {
            PageMessage("Loading…", busy: true)
                .task { await store.loadForecast() }
        }
    }

    private func calendar(_ forecast: ForecastResponse) -> some View {
        let counts = Dictionary(forecast.calendar.map { ($0.date, $0) }, uniquingKeysWith: { a, _ in a })
        let firstWeekday = store.settings.firstWeekday
        return ScrollView {
            VStack(spacing: 8) {
                endButton("Past", key: "PAST", day: forecast.days.first { $0.key == "PAST" }, tone: .overdue)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 7), spacing: 2) {
                    ForEach(ForecastPageModel.weekdayHeaders(firstWeekday: firstWeekday).enumerated(), id: \.offset) { _, name in
                        Text(name).font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                    }
                    ForEach(ForecastPageModel.calendarCells(forecast, firstWeekday: firstWeekday), id: \.self) { date in
                        cell(date, count: counts[date]?.dueCount ?? 0, today: forecast.today)
                    }
                }
                .accessibilityLabel("Next five weeks")
                endButton("Future", key: "FUTURE", day: forecast.days.first { $0.key == "FUTURE" }, tone: nil)
            }
            .padding(8)
        }
        .accessibilityIdentifier("forecast-calendar")
    }

    private func cell(_ date: String, count: Int, today: String) -> some View {
        let isToday = date == today
        let isSelected = selected == date || (selected == "TODAY" && isToday)
        let past = ForecastPageModel.isPast(date, today: today)
        return Button {
            navigator.navigate(to: .forecast(day: isToday ? "TODAY" : date))
        } label: {
            VStack(spacing: 0) {
                Text("\(ForecastPageModel.dayOfMonth(date))").monospacedDigit()
                Text(count > 0 ? "\(count)" : " ").font(.system(size: 10)).monospacedDigit()
                    .foregroundStyle(isSelected ? Color.white : Color.secondary)
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(isSelected ? Color.white : Color.primary)
            .background(isSelected ? Color.accentColor : Color.clear, in: .rect(cornerRadius: 8))
            .overlay {
                if isToday && !isSelected { RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor, lineWidth: 1) }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(past)
        .opacity(past ? 0.35 : 1)
        .accessibilityLabel(DateDisplay.formatDayKey(date) + (count > 0 ? ", \(count) due" : ""))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("forecast-day-\(date)")
    }

    private func endButton(_ title: String, key: String, day: ForecastDay?, tone: ForecastBadge?) -> some View {
        Button {
            navigator.navigate(to: .forecast(day: key))
        } label: {
            HStack {
                Text(title)
                Spacer()
                ForecastBadgeView(count: day?.dueCount ?? 0, tone: tone)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(selected == key ? Color.accentColor.opacity(0.2) : Color.clear, in: .rect(cornerRadius: 10))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("forecast-\(key)")
    }
}
