// Author: John Grimes

import PranaKit
import SwiftUI

/// The view options panel (V), saved per perspective on the server (spec §4). Port of `ViewOptionsPanel` in
/// `src/web/components/ViewOptions.tsx`: Filter for most perspectives, plus Projects, Tags and Flagged options, and
/// Forecast's own options.
struct ViewOptionsPanel: View {
    let perspective: Perspective

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    /// The perspective as shown now (a saved change shows at once).
    private var current: Perspective {
        store.state.perspectives?.first { $0.id == perspective.id } ?? perspective
    }

    private var options: ViewOptions { current.viewOptions }

    private func save(_ change: (inout ViewOptions) -> Void) {
        var next = options
        change(&next)
        store.setViewOptions(perspective.id, next)
    }

    var body: some View {
        NavigationStack {
            Form {
                if perspective.id == "forecast" { forecastSections } else { filterSections }
            }
            .navigationTitle("View Options")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("view-options-done")
                }
            }
        }
        .accessibilityIdentifier("view-options")
    }

    // MARK: Filter perspectives

    @ViewBuilder private var filterSections: some View {
        let filter = options.filter ?? PageOptions.defaultFilters[perspective.id] ?? .remaining
        Section("Filter") {
            ForEach(PageOptions.filters(for: perspective.id)) { choice in
                Button {
                    save { $0.filter = choice.value }
                } label: {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(choice.label).foregroundStyle(.primary)
                            Text(choice.hint).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if filter == choice.value {
                            Image(systemName: "checkmark").foregroundStyle(Color.accentColor).accessibilityHidden(true)
                        }
                    }
                    .contentShape(.rect)
                }
                .tint(.primary)
                .accessibilityAddTraits(filter == choice.value ? .isSelected : [])
                .accessibilityIdentifier("filter-\(choice.value.rawValue)")
            }
        }
        if perspective.id == "projects" {
            Section("Structure") {
                Toggle("Show Inbox", isOn: binding(\.showInbox))
                    .accessibilityIdentifier("show-inbox")
                Toggle("Show folders in outline", isOn: binding(\.showFolders))
                    .accessibilityIdentifier("show-folders")
            }
        }
        if perspective.id == "tags" {
            Section {
                Toggle("Sort by due date and flagged", isOn: binding(\.sortByDueAndFlagged))
                    .accessibilityIdentifier("sort-due-flagged")
            }
        }
        if perspective.id == "flagged" {
            Section {
                Picker(
                    "Group actions by",
                    selection: Binding(get: { options.grouping ?? Grouping.none }, set: { value in save { $0.grouping = value } })
                ) {
                    ForEach(PageOptions.flaggedGroupings) { Text($0.label).tag($0.value) }
                }
                .accessibilityIdentifier("flagged-grouping")
            }
        }
    }

    private func binding(_ key: WritableKeyPath<ViewOptions, Bool?>) -> Binding<Bool> {
        Binding(get: { options[keyPath: key] ?? false }, set: { value in save { $0[keyPath: key] = value } })
    }

    // MARK: Forecast

    @ViewBuilder private var forecastSections: some View {
        Section("In Forecast, include") {
            Toggle("Items on planned dates", isOn: forecast(\.includePlanned, default: true))
            Toggle("Items on defer dates", isOn: forecast(\.includeDefer, default: false))
            Toggle("Items on notification date", isOn: forecast(\.includeNotification, default: false))
            Toggle("On hold projects", isOn: forecast(\.includeOnHold, default: false))
                .accessibilityIdentifier("include-on-hold")
        }
        Section("Today includes") {
            Toggle("Flagged items", isOn: forecast(\.todayIncludesFlagged, default: false))
            Toggle("Items tagged with the Forecast tag", isOn: forecast(\.todayIncludesTag, default: true))
            Picker(
                "Forecast tag",
                selection: Binding(
                    get: { store.settings.forecastTagId ?? "" },
                    set: { store.patchSettings(SettingsPatch(forecastTagId: .some($0.isEmpty ? nil : $0))) })
            ) {
                Text("None").tag("")
                ForEach(store.state.tags ?? []) { Text($0.name).tag($0.id) }
            }
        }
        Section("Structure") {
            Picker(
                "Structure",
                selection: Binding(
                    get: { options.forecast?.organized ?? false },
                    set: { value in save { $0.forecast = with($0.forecast) { $0.organized = value } } })
            ) {
                Text("Flexible").tag(false)
                Text("Organized").tag(true)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("forecast-structure")
            Toggle("Preserve hierarchy", isOn: forecast(\.preserveHierarchy, default: false))
            Toggle("Keep sorted", isOn: forecast(\.keepSorted, default: true))
        }
    }

    private func forecast(_ key: WritableKeyPath<ViewOptions.Forecast, Bool?>, default value: Bool) -> Binding<Bool> {
        Binding(
            get: { options.forecast?[keyPath: key] ?? value },
            set: { newValue in save { $0.forecast = with($0.forecast) { $0[keyPath: key] = newValue } } })
    }

    private func with(_ forecast: ViewOptions.Forecast?, _ change: (inout ViewOptions.Forecast) -> Void) -> ViewOptions.Forecast {
        var f = forecast ?? ViewOptions.Forecast()
        change(&f)
        return f
    }
}

extension View {
    /// Presents a page's view options when the shell asks (header button or V): a popover on iPad, a sheet on iPhone.
    func viewOptions(isPresented: Binding<Bool>, enabled: Bool, @ViewBuilder panel: @escaping () -> some View) -> some View {
        overlay(alignment: .topTrailing) {
            Color.clear
                .frame(width: 1, height: 1)
                .popover(isPresented: enabled ? isPresented : .constant(false), arrowEdge: .top) {
                    panel()
                        .frame(minWidth: 320, minHeight: 420)
                        .presentationCompactAdaptation(.sheet)
                        .presentationDetents([.medium, .large])
                }
        }
    }
}
