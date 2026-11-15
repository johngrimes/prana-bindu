// Author: John Grimes

import PranaKit
import SwiftUI

/// The watch app: one-screen capture to the inbox. Credentials come from the phone over WatchConnectivity.
@main
struct PranaWatchApp: App {
    @State private var connection = PhoneConnection.shared

    var body: some Scene {
        WindowGroup {
            NavigationStack { CaptureView() }
                .environment(connection)
                .task { connection.activate() }
        }
    }
}

/// A text field (dictation or Scribble) and an Add button that adds the text to the inbox.
struct CaptureView: View {
    @Environment(PhoneConnection.self) private var connection
    @State private var text = ""
    @State private var status: Status?
    @State private var isAdding = false

    /// Feedback after Add.
    enum Status: Equatable {
        case added(String)
        case failed(String)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if connection.credentials == nil {
                    Label(InboxCapture.signedOutMessage, systemImage: "iphone")
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("watch.signedOut")
                } else {
                    TextField("Add to inbox", text: $text)
                        .accessibilityIdentifier("watch.text")
                    Button {
                        Task { await add() }
                    } label: {
                        if isAdding { ProgressView() } else { Label("Add", systemImage: "tray.and.arrow.down") }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isAdding || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("watch.add")
                    switch status {
                    case .added(let message):
                        Label(message, systemImage: "checkmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(.green)
                            .accessibilityIdentifier("watch.status")
                    case .failed(let message):
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("watch.status")
                    case nil:
                        EmptyView()
                    }
                }
            }
        }
        .navigationTitle("Prana")
        #if DEBUG
            .task(id: connection.credentials) { await captureForUITests() }
        #endif
    }

    #if DEBUG
        /// The simulator can't type on the watch from a script, so a debug build takes the text from
        /// `PRANA_UITEST_TEXT` and, with `PRANA_UITEST_SUBMIT`, adds it once signed in.
        private func captureForUITests() async {
            let environment = ProcessInfo.processInfo.environment
            guard let preset = environment["PRANA_UITEST_TEXT"], text.isEmpty, status == nil else { return }
            text = preset
            if environment["PRANA_UITEST_SUBMIT"] != nil, connection.credentials != nil { await add() }
        }
    #endif

    private func add() async {
        isAdding = true
        let name = text
        let outcome = await InboxCapture(credentials: connection.credentials).add(name)
        isAdding = false
        if outcome.isAdded {
            status = .added("Added")
            text = ""
        } else {
            status = .failed(outcome.dialog(for: name))
        }
    }
}
