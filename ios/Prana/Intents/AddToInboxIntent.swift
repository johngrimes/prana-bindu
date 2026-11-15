// Author: John Grimes

import AppIntents
import PranaKit

/// "Add to inbox" for Siri and Shortcuts (spec §15): asks "What do you want to add?" and adds the answer, verbatim, as
/// a new item at the end of the inbox, without opening the app.
struct AddToInboxIntent: AppIntent {
    static let title: LocalizedStringResource = "Add to Inbox"
    static let description = IntentDescription("Adds an item to your Prana inbox.")
    static let openAppWhenRun = false

    @Parameter(title: "Item", requestValueDialog: IntentDialog("What do you want to add?"))
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$text) to the inbox")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        .result(value: text, dialog: IntentDialog(stringLiteral: await Self.add(text)))
    }

    /// Adds `text` to the inbox with the saved credentials and returns what Siri says.
    static func add(_ text: String) async -> String {
        await InboxCapture(credentials: KeychainCredentialStore().load()).add(text).dialog(for: text)
    }
}

/// Siri phrases for "Add to inbox"; each must name the app.
struct PranaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddToInboxIntent(),
            phrases: [
                "Add to \(.applicationName) inbox",
                "Add to my \(.applicationName) inbox",
                "Add an item to \(.applicationName)",
                "Capture in \(.applicationName)",
            ],
            shortTitle: "Add to Inbox",
            systemImageName: "tray.and.arrow.down")
    }
}
