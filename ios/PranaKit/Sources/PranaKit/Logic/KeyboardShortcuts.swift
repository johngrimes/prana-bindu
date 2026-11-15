// Author: John Grimes

/// A key press: a character plus Shift and ⌘ (the platform command key).
public struct KeyChord: Hashable, Sendable {
    /// The character typed (lowercase letters; `?` is typed with Shift).
    public var key: Character
    public var shift: Bool
    public var command: Bool

    /// Creates a chord.
    public init(_ key: Character, shift: Bool = false, command: Bool = false) {
        self.key = key
        self.shift = shift
        self.command = command
    }

    /// Whether the chord works while a sheet or popover is open: only ⌘ chords do (`useGlobalShortcuts` returns early
    /// on `overlayOpen()` for the rest).
    public var worksOverOverlays: Bool { command }
}

/// The global commands of the shell (spec §2, with S = refresh), with their keys as `useGlobalShortcuts` in
/// `src/web/components/Shell.tsx` handles them.
public enum ShellCommand: CaseIterable, Sendable {
    case quickEntry, newItem, quickOpen, perspectives, viewOptions, cleanUp, refresh, search, undo, redo
    case toggleSidebar, toggleInspector, shortcuts

    /// The command's name, as the shortcuts sheet lists it.
    public var title: String {
        switch self {
        case .quickEntry: "Quick Entry"
        case .newItem: "New item in current location"
        case .quickOpen: "Quick Open"
        case .perspectives: "Perspectives"
        case .viewOptions: "View options"
        case .cleanUp: "Clean Up"
        case .refresh: "Refresh"
        case .search: "Search"
        case .undo: "Undo"
        case .redo: "Redo"
        case .toggleSidebar: "Toggle sidebar"
        case .toggleInspector: "Toggle inspector"
        case .shortcuts: "Keyboard shortcuts"
        }
    }

    /// The keys that run the command.
    public var chords: [KeyChord] {
        switch self {
        case .quickEntry: [KeyChord("c")]
        case .newItem: [KeyChord("n")]
        case .quickOpen: [KeyChord("o")]
        case .perspectives: [KeyChord("p")]
        case .viewOptions: [KeyChord("v")]
        case .cleanUp: [KeyChord("k")]
        case .refresh: [KeyChord("s")]
        case .search: [KeyChord("/")]
        case .undo: [KeyChord("z"), KeyChord("z", command: true)]
        case .redo: [KeyChord("z", shift: true), KeyChord("z", shift: true, command: true)]
        case .toggleSidebar: [KeyChord("s", shift: true)]
        case .toggleInspector: [KeyChord("i", shift: true)]
        case .shortcuts: [KeyChord("?", shift: true)]
        }
    }
}

/// The keyboard shortcuts sheet's contents, as `SECTIONS` in `src/web/components/ShortcutsSheet.tsx`.
public enum KeyboardShortcuts {
    /// One shortcut: the keys as shown and what they do.
    public struct Entry: Hashable, Sendable {
        public var keys: String
        public var label: String

        /// Creates an entry.
        public init(_ keys: String, _ label: String) {
            self.keys = keys
            self.label = label
        }
    }

    /// A titled group of shortcuts.
    public struct Section: Hashable, Sendable, Identifiable {
        public var title: String
        public var entries: [Entry]
        public var id: String { title }
    }

    /// Every shortcut, by section.
    public static let sections: [Section] = [
        Section(
            title: "Global",
            entries: [
                Entry("C", "Quick Entry"),
                Entry("N", "New item in current location"),
                Entry("O", "Quick Open"),
                Entry("P", "Perspectives"),
                Entry("V", "View options"),
                Entry("K", "Clean Up"),
                Entry("S", "Refresh"),
                Entry("/", "Search"),
                Entry("Z / ⌘Z", "Undo"),
                Entry("⇧Z / ⌘⇧Z", "Redo"),
                Entry("⇧S", "Toggle sidebar"),
                Entry("⇧I", "Toggle inspector"),
                Entry("?", "Keyboard shortcuts"),
            ]),
        Section(
            title: "Outline",
            entries: [
                Entry("↑ / ↓", "Move selection"),
                Entry("⇧↑ / ⇧↓", "Extend selection"),
                Entry("← / →", "Collapse / expand"),
                Entry("Enter", "New item after selection"),
                Entry("⇧Enter", "New item above"),
                Entry("E, Tab, ⌘Enter", "Edit title"),
                Entry("'", "Edit note"),
                Entry("] / [", "Indent / outdent"),
                Entry("} / {", "Add child / add outdented item"),
                Entry("G / U", "Group / ungroup"),
                Entry("⇧← / ⇧→", "Move item out / in"),
                Entry("⌥⇧↑ / ⌥⇧↓", "Move item up / down"),
                Entry("Space", "Complete / uncomplete"),
                Entry("F", "Toggle flag"),
                Entry("⌫ / Delete", "Delete selection"),
                Entry("Esc", "Stop editing / clear selection / end reorder"),
            ]),
        Section(
            title: "Review",
            entries: [
                Entry("⌘⇧R", "Mark Reviewed"),
                Entry("⌘[ / ⌘]", "Previous / next project"),
            ]),
    ]

    /// The note under the list.
    public static let footnote = "Single-key shortcuts are ignored while typing in a field."
}
