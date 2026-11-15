// Author: John Grimes

import PranaKit
import SwiftUI

/// The Search page (spec §4 Search): a case-insensitive search over task names and notes plus project, folder and tag
/// names, grouped by kind with matches highlighted. The query lives in the route (`/search?q=`).
struct SearchPage: View {
    /// `.search(query:)`.
    let route: Route

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    @State private var text = ""
    @State private var availability: Availability = .remaining
    @State private var searching = false
    @FocusState private var focused: Bool

    private var query: String {
        if case .search(let q) = route { q } else { "" }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            results
        }
        .navigationTitle("Search")
        .onAppear {
            text = query
            focused = query.isEmpty
        }
        .task(id: text) {
            // Typing updates the route after a short pause, like the web app's `?q=`, unless another page has been
            // opened meanwhile (the page stays mounted under it on the phone).
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled, text != query,
                case .search = ShellNavigation.resolve(navigator.route, perspectives: store.state.perspectives)
            else { return }
            navigator.route = .search(query: text)
        }
        .task(id: SearchKey(query: query, availability: availability)) {
            searching = true
            await store.search(query, availability: availability)
            searching = false
        }
    }

    private struct SearchKey: Hashable {
        var query: String
        var availability: Availability
    }

    private var header: some View {
        VStack(spacing: 8) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
                TextField("Search tasks, notes, projects, folders and tags", text: $text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .focused($focused)
                    .frame(minHeight: 44)
                    .accessibilityLabel("Search")
                    .accessibilityIdentifier("search-field")
                if !text.isEmpty {
                    Button("Clear", systemImage: "xmark.circle.fill") { text = "" }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 44, minHeight: 44)
                }
            }
            .padding(.horizontal, 12)
            .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 12))
            Picker("Filter", selection: $availability) {
                Text("Available").tag(Availability.available)
                Text("Remaining").tag(Availability.remaining)
                Text("Everything").tag(Availability.all)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("search-filter")
        }
        .padding(12)
    }

    @ViewBuilder private var results: some View {
        if query.trimmingCharacters(in: .whitespaces).isEmpty {
            PageMessage("Type to search names and notes.")
        } else if let data = store.state.search, data.query == query {
            if data.tasks.isEmpty && data.projects.isEmpty && data.folders.isEmpty && data.tags.isEmpty {
                PageMessage(searching ? "Searching…" : "No matches", busy: searching)
            } else {
                list(data)
            }
        } else {
            PageMessage("Searching…", busy: true)
        }
    }

    private func list(_ data: SearchResults) -> some View {
        List {
            if !data.projects.isEmpty {
                Section("Projects") {
                    ForEach(data.projects) { p in
                        link(p.task.name, icon: PageIcons.project(p.type)) { .projects(project: p.id, folder: nil) }
                    }
                }
            }
            if !data.folders.isEmpty {
                Section("Folders") {
                    ForEach(data.folders) { f in link(f.name, icon: "folder") { .projects(project: nil, folder: f.id) } }
                }
            }
            if !data.tags.isEmpty {
                Section("Tags") {
                    ForEach(data.tags) { t in link(t.name, icon: "tag") { .tags(tag: t.id) } }
                }
            }
            if !data.tasks.isEmpty {
                Section("Actions") {
                    ForEach(data.tasks) { task in SearchTaskRow(task: task, query: query) }
                }
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("search-results")
    }

    private func link(_ name: String, icon: String, route: @escaping () -> Route) -> some View {
        Button {
            navigator.navigate(to: route())
        } label: {
            Label {
                Highlighted(text: name, query: query)
            } icon: {
                Image(systemName: icon).foregroundStyle(.secondary)
            }
            .frame(minHeight: 44, alignment: .leading)
        }
        .foregroundStyle(.primary)
    }
}

/// A task result: status circle (toggles completion), highlighted name and note snippet, project and due date.
private struct SearchTaskRow: View {
    let task: TaskItem
    let query: String

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator

    var body: some View {
        let selected = navigator.selection.selection.ids.contains(task.id)
        HStack(alignment: .top, spacing: 10) {
            Button(task.completed == nil ? "Complete" : "Mark Incomplete", systemImage: task.completed == nil ? "circle" : "checkmark.circle.fill") {
                store.complete([task.id], completed: task.completed == nil)
            }
            .labelStyle(.iconOnly)
            .font(.title3)
            .foregroundStyle(task.overdue ? .red : task.dueSoon ? .orange : .secondary)
            .frame(minWidth: 44, minHeight: 44)
            .buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 2) {
                Highlighted(text: task.name.isEmpty ? "Untitled" : task.name, query: query)
                    .strikethrough(task.completed != nil)
                    .foregroundStyle(task.completed != nil ? .secondary : .primary)
                if let snippet = SearchPageModel.noteSnippet(task.note, query: query) {
                    Highlighted(text: snippet, query: query).font(.subheadline).foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    Text(task.inInbox ? "Inbox" : (task.projectName ?? ""))
                    if let due = task.effectiveDueDate {
                        Text("Due \(DateDisplay.formatDateChip(due, settings: store.settings, now: .now))")
                            .foregroundStyle(task.overdue ? .red : task.dueSoon ? .orange : .secondary)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .padding(.vertical, 6)
            Spacer(minLength: 0)
        }
        .contentShape(.rect)
        .onTapGesture {
            navigator.selection.selection = Selection(ids: [task.id], kind: .task)
            navigator.showInspector()
        }
        .listRowBackground(selected ? Color.accentColor.opacity(0.15) : nil)
        .accessibilityIdentifier("search-task")
    }
}

/// Text with the query's matches highlighted (`Highlight` in the web app, using `matchRanges`).
struct Highlighted: View {
    let text: String
    let query: String

    var body: some View {
        Text(attributed)
    }

    private var attributed: AttributedString {
        var out = AttributedString()
        for segment in SearchPageModel.segments(text, query: query) {
            var run = AttributedString(segment.text)
            if segment.match {
                run.backgroundColor = .yellow.opacity(0.45)
                run.inlinePresentationIntent = .stronglyEmphasized
            }
            out += run
        }
        return out
    }
}
