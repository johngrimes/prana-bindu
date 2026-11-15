// Author: John Grimes

import PranaKit
import SwiftUI

/// Every keyboard shortcut (Shift-? or Keyboard shortcuts in the app menu), as `ShortcutsSheet.tsx`.
struct ShortcutsSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(KeyboardShortcuts.sections) { section in
                    Section(section.title) {
                        ForEach(section.entries, id: \.self) { entry in
                            LabeledContent(entry.label) {
                                Text(entry.keys)
                                    .font(.callout.monospaced())
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(.quaternary, in: .rect(cornerRadius: 6))
                            }
                        }
                    }
                }
                Section {
                } footer: {
                    Text(KeyboardShortcuts.footnote)
                }
            }
            .navigationTitle("Keyboard shortcuts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("shortcuts.done")
                }
            }
        }
        .accessibilityIdentifier("shortcuts.sheet")
    }
}
