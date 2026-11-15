// Author: John Grimes

import PranaKit
import SwiftUI

/// Smart-match picker for projects and tags (`SmartMatch.tsx`): typing fuzzy-matches existing items, best
/// first with the matched letters highlighted, and offers `Create “<text>”` unless the text names an item exactly.
/// Choosing an option clears the text.
struct SmartMatchField: View {
    let label: String
    let placeholder: String
    let items: [MatchItem]
    /// Accessibility identifier stem (`<id>`, `<id>.option.<n>`, `<id>.create`).
    let identifier: String
    let onPick: (MatchItem) -> Void
    /// Nil hides `Create “…”`.
    var onCreate: ((String) -> Void)?

    @State private var text = ""
    @FocusState private var focused: Bool

    private var options: [SmartMatchOption] {
        SmartMatch.options(for: text, items: items, allowsCreate: onCreate != nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField(placeholder, text: $text)
                .focused($focused)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.done)
                .frame(minHeight: 44)
                .accessibilityLabel(label)
                .accessibilityIdentifier(identifier)
                .onSubmit {
                    if let first = options.first { choose(first) }
                }
            if focused, !options.isEmpty {
                Divider()
                ForEach(Array(options.enumerated()), id: \.element.id) { index, option in
                    Button {
                        choose(option)
                    } label: {
                        row(option)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(optionIdentifier(option, index))
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ option: SmartMatchOption) -> some View {
        HStack(spacing: 8) {
            switch option {
            case .item(let item, let ranges):
                Text(highlighted(item.name, ranges))
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let detail = item.detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            case .create:
                Image(systemName: "plus.circle")
                Text(option.label).fontWeight(.medium)
                Spacer()
            }
        }
        .foregroundStyle(option.isCreate ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    private func optionIdentifier(_ option: SmartMatchOption, _ index: Int) -> String {
        option.isCreate ? "\(identifier).create" : "\(identifier).option.\(index)"
    }

    private func choose(_ option: SmartMatchOption) {
        switch option {
        case .item(let item, _): onPick(item)
        case .create(let name): onCreate?(name)
        }
        text = ""
    }

    /// The name with matched ranges in bold.
    private func highlighted(_ name: String, _ ranges: [Range<Int>]) -> AttributedString {
        var out = AttributedString()
        let characters = Array(name)
        var position = 0
        for range in ranges where range.lowerBound >= position && range.upperBound <= characters.count {
            out += AttributedString(String(characters[position..<range.lowerBound]))
            var match = AttributedString(String(characters[range]))
            match.inlinePresentationIntent = .stronglyEmphasized
            out += match
            position = range.upperBound
        }
        out += AttributedString(String(characters[position...]))
        return out
    }
}

extension SmartMatchOption {
    /// Whether this is the `Create “…”` option.
    var isCreate: Bool {
        if case .create = self { return true }
        return false
    }
}
