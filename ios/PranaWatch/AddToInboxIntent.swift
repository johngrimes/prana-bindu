// Author: John Grimes

import AppIntents
import PranaKit

/// "Add to inbox" on Apple Watch (spec §15 "Apple Watch"): the watch sends the request itself, with the credentials
/// the phone gave it.
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
        let outcome = await InboxCapture(credentials: KeychainCredentialStore().load()).add(text)
        return .result(value: text, dialog: IntentDialog(stringLiteral: outcome.dialog(for: text)))
    }
}

/// Siri phrases for "Add to inbox" on the watch; each must name the app.
struct PranaWatchShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddToInboxIntent(),
            phrases: [
                "Add to \(.applicationName) inbox",
                "Add to my \(.applicationName) inbox",
                "Add an item to \(.applicationName)",
            ],
            shortTitle: "Add to Inbox",
            systemImageName: "tray.and.arrow.down")
    }
}
