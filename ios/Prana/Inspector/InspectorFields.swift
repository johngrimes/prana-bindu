// Author: John Grimes

import PranaKit
import SwiftUI

/// Text that commits when editing ends (Return or focus leaves), like `CommitInput` in the web inspector. While
/// focused the field edits a local draft; otherwise it shows the stored value.
struct CommitTextField: View {
    let label: String
    let value: String
    var placeholder: String = ""
    var multiline = false
    var font: Font = .body
    let onCommit: (String) -> Void

    @State private var draft: String?
    @FocusState private var focused: Bool

    var body: some View {
        let text = Binding(
            get: { draft ?? value },
            set: { new in
                // Return in a single-line field ends editing (the field wraps long titles, so it is vertical).
                if !multiline && new.contains("\n") {
                    draft = new.replacingOccurrences(of: "\n", with: "")
                    focused = false
                } else {
                    draft = new
                }
            })
        Group {
            if multiline {
                TextField(placeholder, text: text, axis: .vertical)
                    .lineLimit(6...)
            } else {
                TextField(placeholder, text: text, axis: .vertical)
                    .submitLabel(.done)
            }
        }
        .font(font)
        .focused($focused)
        .accessibilityLabel(label)
        .onChange(of: focused) { _, isFocused in
            if isFocused {
                draft = value
            } else {
                commit()
            }
        }
        .onDisappear { commit() }
    }

    private func commit() {
        guard var text = draft else { return }
        draft = nil
        if !multiline { text = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .newlines) }
        if text != value { onCommit(text) }
    }
}

/// A natural-language date field (spec §3 Dates, `DateField` in `Fields.tsx`): typed text with a live preview
/// ("Unable to parse date" when it does not parse), a native picker committed when it closes, clear, and +1 day /
/// week / month buttons that start from today at the default time when the field is empty.
struct NaturalDateField: View {
    @Environment(AppStore.self) private var store

    let label: String
    let field: DateField
    let value: String?
    var effective: String?
    var mixed = false
    /// Date only (Next review): a date picker without time and no +1 buttons.
    var dateOnly = false
    let onChange: (String?) -> Void

    @State private var draft: String?
    @State private var picking = false
    @State private var picked = Date()
    @State private var pickerStart = Date()
    @FocusState private var focused: Bool

    private var settings: Settings { store.settings }

    private var display: String {
        let text = DateDisplay.formatDateInput(value, settings: settings)
        return dateOnly ? String(text.split(separator: " ").first ?? "") : text
    }

    private var implied: Bool { value == nil && effective != nil }

    private var placeholder: String {
        if mixed { return InspectorModel.multipleValues }
        if implied { return DateDisplay.formatDateInput(effective, settings: settings) }
        return "None"
    }

    private var preview: DateEntry.Preview {
        guard let draft else { return .none }
        return DateEntry.preview(draft, display: display, field: field, settings: settings, now: Date())
    }

    private var identifier: String { "date.\(label.lowercased().replacingOccurrences(of: " ", with: "-"))" }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                // While typing, the parsed date (or the error) replaces the +1 buttons, above the keyboard.
                switch preview {
                case .parsed(let text):
                    Text(text).font(.caption).foregroundStyle(.secondary).frame(minHeight: 44)
                case .invalid:
                    Text(DateEntry.invalidMessage).font(.caption).foregroundStyle(.red).frame(minHeight: 44)
                        .accessibilityIdentifier("\(identifier).error")
                case .none:
                    if !dateOnly {
                        bump("day", .day)
                        bump("week", .week)
                        bump("month", .month)
                    }
                }
            }
            HStack(spacing: 4) {
                TextField(placeholder, text: Binding(get: { draft ?? display }, set: { draft = $0 }))
                    .italic(implied)
                    .focused($focused)
                    .submitLabel(.done)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityLabel(label)
                    .accessibilityIdentifier(identifier)
                    .onSubmit { focused = false }
                Button {
                    pickerStart = DateEntry.pickerStart(value, field: field, settings: settings, now: Date())
                    picked = pickerStart
                    picking = true
                } label: {
                    Image(systemName: "calendar").frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Pick \(label) from calendar")
                .accessibilityIdentifier("\(identifier).calendar")
                if value != nil || mixed {
                    Button {
                        onChange(nil)
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary).frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Clear \(label)")
                }
            }
        }
        .onChange(of: focused) { _, isFocused in
            if isFocused {
                draft = display
            } else {
                commit()
            }
        }
        .sheet(isPresented: $picking, onDismiss: commitPicked) {
            pickerSheet
        }
    }

    private func bump(_ name: String, _ unit: DateDisplay.WallUnit) -> some View {
        Button("+1 \(name)") {
            onChange(DateDisplay.bumpDate(value, 1, unit, field: field, settings: settings, now: Date()))
        }
        .font(.caption)
        .buttonStyle(.bordered)
        .controlSize(.small)
        .frame(minHeight: 44)
        .accessibilityLabel("\(label) plus one \(name)")
    }

    private var pickerSheet: some View {
        NavigationStack {
            DatePicker(
                label, selection: $picked, displayedComponents: dateOnly ? [.date] : [.date, .hourAndMinute]
            )
            .datePickerStyle(.graphical)
            .padding()
            .navigationTitle(label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        picked = pickerStart
                        picking = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { picking = false }
                        .accessibilityIdentifier("\(identifier).done")
                }
            }
        }
        .environment(\.timeZone, TimeZone(identifier: settings.timeZone) ?? .current)
        .presentationDetents([.medium, .large])
    }

    /// The picker commits when it closes (iOS updates the value while scrolling).
    private func commitPicked() {
        guard picked != pickerStart else { return }
        if dateOnly {
            onChange(
                DateEntry.dayOnly(
                    dayKey: DateEntry.dayKey(of: picked, settings: settings), replacing: value, field: field,
                    settings: settings))
        } else {
            onChange(DateEntry.floating(from: picked, settings: settings))
        }
    }

    private func commit() {
        guard let text = draft else { return }
        draft = nil
        if case .some(let new) = DateEntry.commit(text, display: display) { onChange(new) }
    }
}

/// The Duration field: `1h 30m` text, "Unable to parse duration" when it does not parse.
struct DurationField: View {
    let value: Int?
    var mixed = false
    let onChange: (Int?) -> Void

    @State private var draft: String?
    @FocusState private var focused: Bool

    private var display: String { DurationEntry.display(value) }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Duration").font(.subheadline).foregroundStyle(.secondary)
            TextField(mixed ? InspectorModel.multipleValues : "None", text: Binding(get: { draft ?? display }, set: { draft = $0 }))
                .focused($focused)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.done)
                .frame(minHeight: 44)
                .accessibilityLabel("Duration")
                .accessibilityIdentifier("duration")
                .onSubmit { focused = false }
            if let draft, DurationEntry.commit(draft, display: display) == .invalid {
                Text(DurationEntry.invalidMessage).font(.caption).foregroundStyle(.red)
            }
        }
        .onChange(of: focused) { _, isFocused in
            if isFocused {
                draft = display
            } else if let text = draft {
                draft = nil
                if case .valid(let minutes) = DurationEntry.commit(text, display: display) { onChange(minutes) }
            }
        }
    }
}

/// A read-only date row (Completed, Dropped, Added, Changed); hidden when empty.
struct ReadOnlyDateRow: View {
    @Environment(AppStore.self) private var store
    let label: String
    let value: String?

    var body: some View {
        if let value, !value.isEmpty {
            LabeledContent(label, value: DateDisplay.formatDateTime(value, settings: store.settings))
        }
    }
}

/// A segmented control over string-backed options; `selection` nil (mixed values) selects nothing.
struct SegmentedField<Value: Hashable>: View {
    let label: String
    let options: [(value: Value, title: String)]
    let selection: Value?
    let onChange: (Value) -> Void

    var body: some View {
        Picker(
            label,
            selection: Binding<Value?>(
                get: { selection },
                set: { if let new = $0 { onChange(new) } })
        ) {
            ForEach(options.indices, id: \.self) { index in
                Text(options[index].title).tag(Optional(options[index].value))
            }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("segmented.\(label)")
    }
}

/// Removable tag pills, laid out in wrapping rows.
struct TagPills: View {
    struct Pill: Identifiable {
        let id: String
        let name: String
        /// False draws a dashed outline (a tag on only some of the selected items).
        var onAll = true
    }

    let pills: [Pill]
    var removeLabel: (Pill) -> String = { "Remove tag \($0.name)" }
    let onRemove: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(pills) { pill in
                HStack(spacing: 2) {
                    Text(pill.name).font(.subheadline)
                    Button {
                        onRemove(pill.id)
                    } label: {
                        Image(systemName: "xmark").font(.caption2.bold()).frame(width: 28, height: 28)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(removeLabel(pill))
                }
                .padding(.leading, 10)
                .padding(.trailing, 2)
                .background {
                    if pill.onAll {
                        Capsule().fill(Color.accentColor.opacity(0.15))
                    } else {
                        Capsule().strokeBorder(.secondary, style: StrokeStyle(lineWidth: 1, dash: [3]))
                    }
                }
                .accessibilityIdentifier("tag-pill.\(pill.name)")
            }
        }
    }
}
