// Author: John Grimes

import PranaKit
import SwiftUI

/// The global keyboard shortcuts (spec §2, with S = refresh) as menu commands, so they work with a hardware
/// keyboard on iPad and iPhone and show in the iPad menu bar. Single-key shortcuts pause while a sheet is open
/// (`overlayOpen` in the web app); text fields take typed keys first.
struct ShellCommands: Commands {
    let store: AppStore
    let navigator: Navigator

    private var actions: ShellActions { ShellActions(store: store, navigator: navigator) }

    var body: some Commands {
        CommandGroup(replacing: .undoRedo) {
            button(.undo, title: store.undoLabel.map { "Undo \($0)" } ?? "Undo", disabled: !store.canUndo)
            button(.redo, title: store.redoLabel.map { "Redo \($0)" } ?? "Redo", disabled: !store.canRedo)
        }
        CommandGroup(replacing: .newItem) {
            button(.quickEntry)
            button(.newItem, title: "New Item")
        }
        CommandMenu("Go") {
            button(.quickOpen)
            button(.perspectives)
            button(.search)
            Divider()
            button(.refresh)
        }
        CommandMenu("Outline") {
            button(.cleanUp)
            button(.viewOptions, disabled: !actions.chrome.hasViewOptions)
            Button(navigator.reordering ? "Done Reordering" : "Reorder") { actions.toggleReorder() }
                .disabled(!store.isSignedIn || !actions.canReorder)
        }
        CommandGroup(before: .sidebar) {
            button(.toggleSidebar)
            button(.toggleInspector)
        }
        CommandGroup(replacing: .help) {
            button(.shortcuts)
        }
    }

    /// A menu item per chord of `command` (alternatives such as Z and ⌘Z each get their own item).
    @ViewBuilder
    private func button(_ command: ShellCommand, title: String? = nil, disabled: Bool = false) -> some View {
        ForEach(Array(command.chords.enumerated()), id: \.offset) { _, chord in
            Button(title ?? command.title) { actions.run(command) }
                .keyboardShortcut(KeyEquivalent(chord.key), modifiers: chord.modifiers)
                .disabled(!store.isSignedIn || disabled || (!chord.worksOverOverlays && navigator.overlayOpen))
        }
    }
}

extension KeyChord {
    /// The SwiftUI modifiers for this chord.
    var modifiers: EventModifiers {
        var modifiers: EventModifiers = []
        if shift { modifiers.insert(.shift) }
        if command { modifiers.insert(.command) }
        return modifiers
    }
}
