// Author: John Grimes

import PranaKit
import SafariServices
import SwiftUI
import UIKit

/// Passkeys (spec §6): list with rename and delete; deleting the last one asks first and warns that a new
/// enrolment link is needed. "Add a passkey" opens the web settings page in Safari, as registration needs a browser
/// session.
struct PasskeysSection: View {
    let account: AccountSettings

    @Environment(AppStore.self) private var store
    @State private var renaming: Passkey?
    @State private var newName = ""
    @State private var confirmingLast: Passkey?
    @State private var addingInSafari = false

    var body: some View {
        Section {
            if let passkeys = account.passkeys {
                if passkeys.isEmpty {
                    Text("No passkeys.").foregroundStyle(.secondary).accessibilityIdentifier("passkeys.empty")
                }
                ForEach(passkeys) { passkey in
                    HStack(spacing: 12) {
                        Image(systemName: "key").foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(passkey.name).fontWeight(.medium).lineLimit(1)
                            Text(SettingsOptions.subtitle(of: passkey, settings: store.settings))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        Menu {
                            Button("Rename", systemImage: "pencil") { startRename(passkey) }
                            Button("Delete", systemImage: "trash", role: .destructive) { requestDelete(passkey) }
                        } label: {
                            Image(systemName: "ellipsis.circle").frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("Actions for \(passkey.name)")
                        .accessibilityIdentifier("passkey.actions.\(passkey.id)")
                    }
                    .accessibilityIdentifier("passkey.\(passkey.id)")
                    .swipeActions {
                        Button("Delete", systemImage: "trash", role: .destructive) { requestDelete(passkey) }
                        Button("Rename", systemImage: "pencil") { startRename(passkey) }
                    }
                }
            } else {
                ProgressView()
            }
            Button("Add a passkey", systemImage: "plus") { addingInSafari = true }
                .accessibilityIdentifier("passkeys.add")
                .alert("Rename passkey", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }), presenting: renaming) { passkey in
                    TextField("Passkey name", text: $newName)
                        .accessibilityIdentifier("passkey.renameField")
                    Button("Cancel", role: .cancel) {}
                    Button("Rename") {
                        let name = newName
                        Task { await account.rename(passkey, to: name) }
                    }
                }
                .alert("Delete your last passkey?", isPresented: Binding(get: { confirmingLast != nil }, set: { if !$0 { confirmingLast = nil } }), presenting: confirmingLast) { passkey in
                    Button("Cancel", role: .cancel) {}
                    Button("Delete passkey", role: .destructive) {
                        Task { await account.delete(passkey) }
                    }
                } message: { passkey in
                    Text(SettingsOptions.lastPasskeyWarning(name: passkey.name))
                }
                .sheet(isPresented: $addingInSafari, onDismiss: { Task { await account.loadPasskeys() } }) {
                    if let origin = store.credentials?.origin {
                        SafariView(url: SettingsOptions.passkeySetupURL(origin: origin))
                            .ignoresSafeArea()
                    }
                }
        } header: {
            Text("Passkeys")
        } footer: {
            Text("Passkeys used to sign in to prana-bindu. Adding one opens the server’s settings page in Safari.")
        }
    }

    private func startRename(_ passkey: Passkey) {
        newName = passkey.name
        renaming = passkey
    }

    private func requestDelete(_ passkey: Passkey) {
        if account.needsLastPasskeyConfirmation {
            confirmingLast = passkey
        } else {
            Task { await account.delete(passkey) }
        }
    }
}

/// API tokens (spec §6): list, create (the plaintext is shown once with a Copy button) and revoke (confirmed).
struct ApiTokensSection: View {
    let account: AccountSettings

    @Environment(AppStore.self) private var store
    @State private var name = ""
    @State private var revoking: ApiToken?
    @State private var creating = false

    var body: some View {
        Section {
            if let tokens = account.tokens {
                if tokens.isEmpty { Text("No tokens.").foregroundStyle(.secondary) }
                ForEach(tokens) { token in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(token.name).fontWeight(.medium).lineLimit(1)
                            Text(SettingsOptions.subtitle(of: token, settings: store.settings))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("token.subtitle.\(token.id)")
                        }
                        Spacer(minLength: 0)
                        Button("Revoke", role: .destructive) { revoking = token }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Revoke \(token.name)")
                            .accessibilityIdentifier("token.revoke.\(token.id)")
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("token.\(token.id)")
                }
            } else {
                ProgressView()
            }
            HStack {
                TextField("Token name, e.g. Claude Desktop", text: $name)
                    .onSubmit(create)
                    .accessibilityLabel("Token name")
                    .accessibilityIdentifier("tokens.name")
                Button("Create token", systemImage: "plus", action: create)
                    .labelStyle(.titleAndIcon)
                    .buttonStyle(.borderless)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || creating)
                    .accessibilityIdentifier("tokens.create")
            }
            .alert("Revoke token?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), presenting: revoking) { token in
                Button("Cancel", role: .cancel) {}
                Button("Revoke", role: .destructive) { Task { await account.revoke(token) } }
            } message: { token in
                Text("Apps using “\(token.name)” will no longer be able to reach the server.")
            }
            .sheet(item: Binding(get: { account.created.map(CreatedToken.init) }, set: { if $0 == nil { account.dismissCreated() } })) { created in
                TokenCreatedSheet(plaintext: created.value.plaintext) { account.dismissCreated() }
            }
        } header: {
            Text("API tokens")
        } footer: {
            Text("Bearer tokens for the REST API and the MCP server.")
        }
    }

    private func create() {
        let value = name
        creating = true
        Task {
            if await account.createToken(named: value) { name = "" }
            creating = false
        }
    }
}

/// A created token as a sheet item.
private struct CreatedToken: Identifiable {
    let value: ApiTokenCreated
    var id: String { value.token.id }
}

/// "Token created": the plaintext, shown once, with Copy.
private struct TokenCreatedSheet: View {
    let plaintext: String
    let onDone: () -> Void

    @Environment(AppStore.self) private var store

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Copy this token now. It will not be shown again.")
                Text(plaintext)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary, in: .rect(cornerRadius: 10))
                    .accessibilityIdentifier("token.plaintext")
                Button("Copy", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = plaintext
                    store.toast("Copied")
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("token.copy")
                Spacer()
            }
            .padding()
            .navigationTitle("Token created")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onDone).accessibilityIdentifier("token.done")
                }
            }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled()
    }
}

/// The last import run, read-only (spec §6). Imports run from the CLI or the API.
struct ImportSection: View {
    let account: AccountSettings

    @Environment(AppStore.self) private var store

    var body: some View {
        Section {
            if !account.importLoaded {
                Text("Loading…").foregroundStyle(.secondary)
            } else if let run = account.lastImport {
                LabeledContent("Last import", value: DateDisplay.formatDateTime(run.importedAt, settings: store.settings))
                    .accessibilityIdentifier("import.time")
                LabeledContent("Source") {
                    Text(run.source).textSelection(.enabled).multilineTextAlignment(.trailing)
                }
                .accessibilityIdentifier("import.source")
                if let version = run.appVersion {
                    LabeledContent("OmniFocus version", value: version)
                }
                ForEach(run.counts.sorted { $0.key < $1.key }, id: \.key) { key, value in
                    LabeledContent(key) { Text("\(value)").monospacedDigit() }
                }
                if !run.warnings.isEmpty {
                    DisclosureGroup {
                        ForEach(Array(run.warnings.enumerated()), id: \.offset) { _, warning in
                            Text(warning).font(.caption).foregroundStyle(.secondary)
                        }
                    } label: {
                        Text("\(run.warnings.count) warnings").foregroundStyle(.orange)
                    }
                    .accessibilityIdentifier("import.warnings")
                }
            } else {
                Text("No import has been run.").foregroundStyle(.secondary)
            }
        } header: {
            Text("Import")
        } footer: {
            Text("Imports replace all data and run from the CLI or the API (prana-bindu import <path|url>).")
        }
    }
}

/// An in-app Safari sheet.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
