// Author: John Grimes

import PranaKit
import SwiftUI

/// The repeat editor (spec §3, `RepeatEditor.tsx`): none, or every N units with FREQ-specific options (weekdays for
/// weekly; day of month or nth weekday for monthly and yearly; months for yearly), schedule type, anchor date,
/// catch-up and end, with the human-readable summary on top. Every change is sent at once.
struct RepeatEditorView: View {
    let rule: RepeatRule?
    let onChange: (RepeatRule?) -> Void

    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    private static let nths: [(Int, String)] = [(1, "first"), (2, "second"), (3, "third"), (4, "fourth"), (5, "fifth"), (-1, "last")]

    var body: some View {
        if let rule {
            editor(rule)
        } else {
            HStack {
                Text("Doesn’t repeat").foregroundStyle(.secondary)
                Spacer()
                Button("Add repeat") { onChange(.defaultRepeat) }
                    .accessibilityIdentifier("repeat.add")
            }
            .frame(minHeight: 44)
        }
    }

    @ViewBuilder
    private func editor(_ rule: RepeatRule) -> some View {
        let form = RepeatForm(rule: rule.rule)
        let update: (RepeatForm) -> Void = { new in
            var next = rule
            next.rule = new.rule
            onChange(next)
        }
        Text(summarizeRepeat(rule))
            .font(.subheadline)
            .accessibilityIdentifier("repeat.summary")

        Stepper(value: Binding(get: { form.interval }, set: { var f = form; f.interval = max(1, $0); update(f) }), in: 1...999) {
            HStack {
                Text("Every \(form.interval)")
                Spacer()
            }
        }
        .accessibilityIdentifier("repeat.interval")

        Picker("Unit", selection: Binding(get: { form.freq }, set: { var f = form; f.setFrequency($0); update(f) })) {
            ForEach(RepeatFrequency.options(for: form.freq), id: \.self) { freq in
                Text(freq.label(interval: form.interval)).tag(freq)
            }
        }
        .accessibilityIdentifier("repeat.unit")

        if form.freq == .weekly {
            HStack(spacing: 2) {
                ForEach(RepeatWeekday.allCases, id: \.self) { day in
                    let on = form.byDay.contains(day)
                    Button {
                        var f = form
                        f.toggle(day)
                        update(f)
                    } label: {
                        Text(String(day.name.prefix(1)))
                            .font(.subheadline)
                            .frame(width: 40, height: 44)
                            .background(Circle().fill(on ? Color.accentColor : .clear).frame(width: 38, height: 38))
                            .overlay(Circle().strokeBorder(on ? Color.accentColor : .secondary.opacity(0.4)).frame(width: 38, height: 38))
                            .foregroundStyle(on ? .white : .primary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(day.name)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }

        if form.freq == .yearly {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 6), spacing: 4) {
                ForEach(1...12, id: \.self) { month in
                    let on = form.byMonth.contains(month)
                    Button {
                        var f = form
                        f.toggleMonth(month)
                        update(f)
                    } label: {
                        Text(Self.months[month - 1])
                            .font(.caption)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(RoundedRectangle(cornerRadius: 6).fill(on ? Color.accentColor : .clear))
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(on ? Color.accentColor : .secondary.opacity(0.4)))
                            .foregroundStyle(on ? .white : .primary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }

        if form.freq == .monthly || form.freq == .yearly {
            SegmentedField(
                label: "Monthly repeat mode",
                options: [(RepeatForm.MonthlyMode.none, "Same day"), (.dayOfMonth, "Day of month"), (.nthWeekday, "Weekday")],
                selection: form.monthlyMode
            ) { mode in
                var f = form
                f.setMonthlyMode(mode)
                update(f)
            }
            if form.monthlyMode == .dayOfMonth {
                Picker("On day", selection: Binding(get: { form.byMonthDay.first ?? 1 }, set: { var f = form; f.byMonthDay = [$0]; update(f) })) {
                    ForEach(1...31, id: \.self) { Text("\($0)").tag($0) }
                    Text("last").tag(-1)
                }
            }
            if form.monthlyMode == .nthWeekday {
                Picker("On the", selection: Binding(get: { form.nth }, set: { var f = form; f.nth = $0; update(f) })) {
                    ForEach(Self.nths, id: \.0) { Text($0.1).tag($0.0) }
                }
                Picker("Weekday", selection: Binding(get: { form.nthWeekday }, set: { var f = form; f.nthWeekday = $0; update(f) })) {
                    ForEach(RepeatWeekday.allCases, id: \.self) { Text($0.name).tag($0) }
                }
            }
        }

        LabeledContent("Schedule") {
            SegmentedField(
                label: "Repeat schedule",
                options: [(RepeatRule.ScheduleType.regularly, "Regularly"), (.fromCompletion, "From completion")],
                selection: rule.scheduleType
            ) { schedule in
                var next = rule
                next.scheduleType = schedule
                onChange(next)
            }
        }
        LabeledContent("Anchor date") {
            SegmentedField(
                label: "Repeat anchor date",
                options: [(RepeatRule.AnchorDate.due, "Due"), (.defer, "Defer"), (.planned, "Planned")],
                selection: rule.anchorDate
            ) { anchor in
                var next = rule
                next.anchorDate = anchor
                onChange(next)
            }
        }
        if rule.scheduleType == .regularly {
            Toggle(
                "Catch up automatically",
                isOn: Binding(
                    get: { rule.catchUpAutomatically },
                    set: {
                        var next = rule
                        next.catchUpAutomatically = $0
                        onChange(next)
                    }))
        }
        LabeledContent("Ends") {
            SegmentedField(
                label: "Repeat end",
                options: [(RepeatForm.EndKind.never, "Never"), (.count, "After"), (.until, "On date")],
                selection: RepeatForm.EndKind(form.end)
            ) { kind in
                var f = form
                f.setEndKind(kind, now: Date())
                update(f)
            }
        }
        .accessibilityIdentifier("repeat.end")
        if case .count(let count) = form.end {
            Stepper(value: Binding(get: { count }, set: { var f = form; f.end = .count(max(1, $0)); update(f) }), in: 1...9999) {
                Text("\(count) times")
            }
        }
        if case .until(let day) = form.end {
            DatePicker(
                "Repeat until",
                selection: Binding(
                    get: { Self.utcDate(day) },
                    set: {
                        var f = form
                        f.end = .until(DateTime.dayKeyOfNaive(DateTime.milliseconds($0)))
                        update(f)
                    }),
                displayedComponents: .date
            )
            .environment(\.timeZone, TimeZone(identifier: "UTC")!)
        }
        Button("Remove repeat", role: .destructive) { onChange(nil) }
            .accessibilityIdentifier("repeat.remove")
    }

    /// Midnight UTC of a `YYYY-MM-DD` day (the picker shows UTC so the day round-trips).
    private static func utcDate(_ day: String) -> Date {
        DateTime.dayKeyToNaive(day).map { DateTime.date(milliseconds: $0) } ?? Date()
    }
}
