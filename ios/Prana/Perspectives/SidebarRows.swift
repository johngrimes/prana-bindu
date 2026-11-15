// Author: John Grimes

import PranaKit
import SwiftUI

/// One sidebar entry: icon, name, optional badge and count, indented by depth; highlighted when it is the current
/// selection and dimmed when inactive (on hold, dropped).
struct SidebarRow: View {
    let icon: String
    let label: String
    var depth = 0
    var dimmed = false
    var onHold = false
    var reviewed = false
    var count: Int?
    var active = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .foregroundStyle(.secondary)
                    .frame(width: 22)
                    .accessibilityHidden(true)
                Text(label).lineLimit(1)
                Spacer(minLength: 4)
                if onHold {
                    Image(systemName: "pause.circle").foregroundStyle(.secondary).accessibilityLabel("On hold")
                }
                if reviewed {
                    Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityLabel("Reviewed")
                }
                if let count, count > 0 {
                    Text("\(count)").font(.caption).monospacedDigit().foregroundStyle(.secondary)
                }
            }
            .padding(.leading, CGFloat(depth) * 16)
            .frame(minHeight: 44)
            .opacity(dimmed ? 0.55 : 1)
            .contentShape(.rect)
        }
        .foregroundStyle(.primary)
        .fontWeight(active ? .semibold : .regular)
        .listRowBackground(active ? Color.accentColor.opacity(0.18) : nil)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

extension View {
    /// Makes a sidebar entry accept outline rows dragged onto it (spec §3: drop on a project moves, on a tag adds the
    /// tag), highlighting the entry while they hover over it.
    func taskDropTarget(_ perform: @escaping ([String]) -> Void) -> some View {
        modifier(TaskDropTarget(perform: perform))
    }
}

/// The drop target behind `taskDropTarget`.
private struct TaskDropTarget: ViewModifier {
    let perform: ([String]) -> Void
    @State private var targeted = false

    func body(content: Content) -> some View {
        content
            .dropDestination(for: TaskDragItem.self) { items, _ in
                let ids = items.flatMap(\.ids)
                guard !ids.isEmpty else { return false }
                perform(ids)
                return true
            } isTargeted: { targeted = $0 }
            .overlay {
                if targeted { RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor, lineWidth: 2) }
            }
    }
}

/// What a rename alert is renaming.
struct RenameTarget: Identifiable, Hashable {
    enum Kind: Hashable { case folder, project, tag }
    var kind: Kind
    var id: String
    var name: String
}

extension View {
    /// The sidebar rename alert: a text field prefilled with the current name; saves a changed, non-empty name.
    func renameAlert(_ target: Binding<RenameTarget?>, text: Binding<String>, save: @escaping (RenameTarget, String) -> Void) -> some View {
        alert(
            "Rename",
            isPresented: Binding(get: { target.wrappedValue != nil }, set: { if !$0 { target.wrappedValue = nil } }),
            presenting: target.wrappedValue
        ) { item in
            TextField("Name", text: text)
                .accessibilityIdentifier("rename-field")
            Button("Save") {
                let name = text.wrappedValue.trimmingCharacters(in: .whitespaces)
                if !name.isEmpty, name != item.name { save(item, name) }
            }
            .accessibilityIdentifier("rename-save")
            Button("Cancel", role: .cancel) {}
        }
    }
}
