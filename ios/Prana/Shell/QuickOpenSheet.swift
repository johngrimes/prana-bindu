// Author: John Grimes

import PranaKit
import SwiftUI

/// Quick Open (O): jump to a perspective, folder, project or tag by fuzzy name (`QuickOpen.tsx`). Matches
/// come ranked from the server with the matched characters highlighted; Return opens the first.
struct QuickOpenSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [QuickOpenResult] = []
    @State private var searched = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            List {
                ForEach(results) { result in
                    Button {
                        open(result)
                    } label: {
                        QuickOpenRow(result: result)
                    }
                    .accessibilityIdentifier("quickOpen.result.\(result.type.rawValue).\(result.id)")
                }
            }
            .listStyle(.plain)
            .overlay {
                if !searched.isEmpty, results.isEmpty, searched == query {
                    ContentUnavailableView("No matches", systemImage: "magnifyingglass")
                }
            }
            .safeAreaInset(edge: .top) {
                TextField("Perspective, Folder, Project, or Tag", text: $query)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit { results.first.map(open) }
                    .padding(12)
                    .background(.quaternary, in: .rect(cornerRadius: 12))
                    .padding(.horizontal)
                    .padding(.bottom, 8)
                    .accessibilityLabel("Quick Open")
                    .accessibilityIdentifier("quickOpen.field")
            }
            .navigationTitle("Quick Open")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task(id: query) {
                // The web app keeps the previous matches while the next ones load.
                let q = query
                guard !q.trimmingCharacters(in: .whitespaces).isEmpty else {
                    results = []
                    searched = ""
                    return
                }
                try? await Task.sleep(for: .milliseconds(120))
                guard !Task.isCancelled else { return }
                let found = await store.quickOpen(q)
                guard !Task.isCancelled else { return }
                results = found
                searched = q
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.large])
    }

    private func open(_ result: QuickOpenResult) {
        dismiss()
        navigator.navigate(to: ShellNavigation.route(for: result, perspectives: store.state.perspectives ?? []))
    }
}

/// One Quick Open match: its kind's symbol, the name with matched characters in bold, and the kind.
private struct QuickOpenRow: View {
    let result: QuickOpenResult

    private var symbol: String {
        switch result.type {
        case .perspective: "square.stack"
        case .folder: "folder"
        case .project: "circle.grid.2x1"
        default: "tag"
        }
    }

    private var name: AttributedString {
        ShellNavigation.highlightSegments(result.name, ranges: result.matches).reduce(into: AttributedString()) { text, segment in
            var run = AttributedString(segment.text)
            if segment.matched {
                run.inlinePresentationIntent = .stronglyEmphasized
                run.backgroundColor = .yellow.opacity(0.35)
            }
            text += run
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            Text(name)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(result.type.rawValue.capitalized)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .foregroundStyle(.primary)
        .frame(minHeight: 44)
    }
}
