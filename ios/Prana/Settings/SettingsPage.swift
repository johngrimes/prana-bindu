// Author: John Grimes

import PranaKit
import SwiftUI

/// Settings (spec §6), port of `src/web/pages/SettingsPage.tsx`: the settings of spec §1.2 with Restore Defaults
/// (instant writes), the server and Sign Out, passkeys, API tokens and the last import (these wait for the server).
struct SettingsPage: View {
    @Environment(AppStore.self) private var store
    @State private var account: AccountSettings?

    var body: some View {
        Form {
            GeneralSettingsSection()
            Section("Server and account") {
                LabeledContent("Server", value: store.credentials?.origin.absoluteString ?? "")
                    .accessibilityIdentifier("settings.server")
                Button("Sign Out", role: .destructive) {
                    Task { await store.signOut() }
                }
                .accessibilityIdentifier("settings.signOut")
            }
            if let account {
                PasskeysSection(account: account)
                ApiTokensSection(account: account)
                ImportSection(account: account)
            }
        }
        .navigationTitle("Settings")
        .refreshable {
            await store.refresh()
            await account?.load()
        }
        .task {
            let model = account ?? AccountSettings(store: store)
            account = model
            await model.load()
        }
    }
}

/// The settings of spec §1.2. Every change is an instant write (`AppStore.patchSettings`).
private struct GeneralSettingsSection: View {
    @Environment(AppStore.self) private var store
    @State private var choosingTimeZone = false
    @State private var confirmingRestore = false

    private var settings: Settings { store.settings }

    var body: some View {
        Section("General") {
            Picker("Theme", selection: setting(\.theme) { SettingsPatch(theme: $0) }) {
                Label("System", systemImage: "circle.lefthalf.filled").tag(Settings.Theme.system)
                Label("Light", systemImage: "sun.max").tag(Settings.Theme.light)
                Label("Dark", systemImage: "moon").tag(Settings.Theme.dark)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("settings.theme")

            Button {
                choosingTimeZone = true
            } label: {
                LabeledContent("Time zone", value: settings.timeZone)
            }
            .foregroundStyle(.primary)
            .accessibilityIdentifier("settings.timeZone")
            if settings.timeZone != SettingsOptions.deviceTimeZone {
                Button("Use this device’s time zone (\(SettingsOptions.deviceTimeZone))") {
                    store.patchSettings(SettingsPatch(timeZone: SettingsOptions.deviceTimeZone))
                }
                .font(.callout)
                .accessibilityIdentifier("settings.deviceTimeZone")
            }

            Picker("Date format", selection: setting(\.dateFormat) { SettingsPatch(dateFormat: $0) }) {
                ForEach(SettingsOptions.dateFormats, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .accessibilityIdentifier("settings.dateFormat")

            Picker("Start of week", selection: setting(\.firstWeekday) { SettingsPatch(firstWeekday: $0) }) {
                ForEach(SettingsOptions.weekdays, id: \.value) { Text($0.label).tag($0.value) }
            }
            .accessibilityIdentifier("settings.firstWeekday")

            Picker("Time format", selection: setting(\.use24HourTime) { SettingsPatch(use24HourTime: $0) }) {
                Text("12-hour").tag(false)
                Text("24-hour").tag(true)
            }
            .accessibilityIdentifier("settings.timeFormat")

            timePicker("Default defer time", \.defaultDeferTime, id: "settings.defaultDeferTime") { SettingsPatch(defaultDeferTime: $0) }
            timePicker("Default due time", \.defaultDueTime, id: "settings.defaultDueTime") { SettingsPatch(defaultDueTime: $0) }
            timePicker("Default planned time", \.defaultPlannedTime, id: "settings.defaultPlannedTime") { SettingsPatch(defaultPlannedTime: $0) }

            Picker("Due soon", selection: setting(\.dueSoonSeconds) { SettingsPatch(dueSoonSeconds: $0) }) {
                ForEach(dueSoonOptions, id: \.value) { Text($0.label).tag($0.value) }
            }
            .accessibilityIdentifier("settings.dueSoon")

            Picker("Forecast tag", selection: setting(\.forecastTagId) { SettingsPatch(forecastTagId: .some($0)) }) {
                Text("None").tag(String?.none)
                ForEach(RulePickerChoice.tags(store.state.tags ?? [])) { tag in
                    Text(String(repeating: "  ", count: tag.depth) + tag.name).tag(Optional(tag.id))
                }
            }
            .accessibilityIdentifier("settings.forecastTag")

            Button("Restore Defaults") { confirmingRestore = true }
                .accessibilityIdentifier("settings.restoreDefaults")
                .sheet(isPresented: $choosingTimeZone) {
                    TimeZonePicker(selection: settings.timeZone) { zone in
                        store.patchSettings(SettingsPatch(timeZone: zone))
                    }
                }
                .alert("Restore default settings?", isPresented: $confirmingRestore) {
                    Button("Cancel", role: .cancel) {}
                    Button("Restore") { store.resetSettings() }
                } message: {
                    Text(SettingsOptions.restoreDefaultsMessage)
                }
        }
    }

    /// The due-soon choices, plus the stored value when it is not one of them (imported settings).
    private var dueSoonOptions: [RuleOption<Int>] {
        let current = settings.dueSoonSeconds
        let options = SettingsOptions.dueSoon
        return options.contains { $0.value == current } ? options : options + [RuleOption(current, "\(current / 3600) hours")]
    }

    /// A binding that reads a setting and writes a patch.
    private func setting<Value: Equatable>(_ keyPath: KeyPath<Settings, Value>, patch: @escaping (Value) -> SettingsPatch) -> Binding<Value> {
        Binding(
            get: { store.settings[keyPath: keyPath] },
            set: { value in
                guard value != store.settings[keyPath: keyPath] else { return }
                store.patchSettings(patch(value))
            })
    }

    private func timePicker(
        _ title: String, _ keyPath: KeyPath<Settings, String>, id: String, patch: @escaping (String) -> SettingsPatch
    ) -> some View {
        DatePicker(
            title,
            selection: Binding(
                get: { SettingsOptions.date(fromHHMM: store.settings[keyPath: keyPath]) },
                set: { date in
                    let value = SettingsOptions.hhmm(from: date)
                    guard value != store.settings[keyPath: keyPath] else { return }
                    store.patchSettings(patch(value))
                }),
            displayedComponents: .hourAndMinute
        )
        .environment(\.locale, Locale(identifier: settings.use24HourTime ? "en_GB" : "en_US"))
        .accessibilityIdentifier(id)
    }
}

/// A searchable list of IANA time zones.
private struct TimeZonePicker: View {
    let selection: String
    let onPick: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var zones: [String] {
        let all = SettingsOptions.timeZones(including: selection)
        guard !query.isEmpty else { return all }
        let needle = query.replacingOccurrences(of: " ", with: "_")
        return all.filter { $0.localizedCaseInsensitiveContains(needle) }
    }

    var body: some View {
        NavigationStack {
            List(zones, id: \.self) { zone in
                Button {
                    if zone != selection { onPick(zone) }
                    dismiss()
                } label: {
                    HStack {
                        Text(zone).foregroundStyle(.primary)
                        Spacer()
                        if zone == selection { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                    }
                }
                .accessibilityIdentifier("timeZone.\(zone)")
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
            .navigationTitle("Time Zone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }
}
