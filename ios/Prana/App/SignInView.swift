// Author: John Grimes

import PranaKit
import SwiftUI

/// Sign-in (spec §9 Auth): the server origin and an API token created in the web app's Settings → API tokens. The
/// token is checked with `GET /api/v1/settings` before it is saved to the Keychain.
struct SignInView: View {
    @Environment(AppStore.self) private var store
    @State private var origin = ""
    @State private var token = ""
    @State private var error: String?
    @State private var signingIn = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Server", text: $origin, prompt: Text("https://tasks.example.org"))
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("signIn.origin")
                    SecureField("API token", text: $token, prompt: Text("pb_…"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("signIn.token")
                } footer: {
                    Text("Create a token in the web app under Settings → API tokens.")
                }
                if let message = error ?? store.signInMessage {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("signIn.error")
                    }
                }
                Section {
                    Button {
                        Task { await signIn() }
                    } label: {
                        HStack {
                            Text("Sign In")
                            if signingIn {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(signingIn || token.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("signIn.submit")
                }
            }
            .navigationTitle("Prana")
            .onAppear {
                // Signed out (e.g. "Token rejected"): offer the server that was in use again.
                if let last = store.lastOrigin { origin = last.absoluteString }
            }
        }
    }

    private func signIn() async {
        guard let url = Credentials.origin(from: origin) else {
            error = "Enter the server's address, e.g. https://tasks.example.org."
            return
        }
        signingIn = true
        defer { signingIn = false }
        do {
            try await store.signIn(origin: url, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
            error = nil
        } catch {
            switch error {
            case .unauthorized: self.error = "Token rejected"
            case .transport(let message): self.error = "Couldn't reach the server: \(message)"
            default: self.error = error.message
            }
        }
    }
}
