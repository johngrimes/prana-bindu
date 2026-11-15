// Author: John Grimes

import PranaKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The share extension's entry point: shared text, links, images and files become an inbox item (name and note from
/// the text or page), with the files attached.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let model = ShareModel(credentials: KeychainCredentialStore().load())
        let host = UIHostingController(
            rootView: ShareSheet(model: model) { [weak self] in
                self?.extensionContext?.completeRequest(returningItems: nil)
            } cancel: { [weak self] in
                self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
            })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.load(items) }
    }
}

/// What the compose sheet shows and posts.
@MainActor @Observable
final class ShareModel {
    enum Phase: Equatable {
        case loading, ready, posting
        case failed(String)
        /// The item was added but a file could not be attached: posting again would add a second item.
        case addedWithError(String)

        var error: String? {
            switch self {
            case .failed(let message), .addedWithError(let message): message
            default: nil
            }
        }
    }

    let credentials: Credentials?
    var name = ""
    var note = ""
    var files: [UploadFile] = []
    var phase = Phase.loading

    init(credentials: Credentials?) {
        self.credentials = credentials
    }

    /// Reads the shared items: text, a web URL (with the page title Safari supplies) and files or images.
    func load(_ items: [NSExtensionItem]) async {
        var texts: [String] = []
        var url: URL?
        var title: String?
        for item in items {
            if let text = item.attributedContentText?.string, !text.isEmpty { texts.append(text) }
            if let itemTitle = item.attributedTitle?.string, !itemTitle.isEmpty { title = itemTitle }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                    !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
                    let shared = await Self.loadURL(provider)
                {
                    url = shared
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                    !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
                    let text = await Self.loadText(provider)
                {
                    texts.append(text)
                } else if case .file(let file) = await ItemProviderFile.load(provider) {
                    files.append(file)
                }
            }
        }
        // Safari repeats the page title as content text: use it as the title when there is a URL.
        if url != nil, title == nil, texts.count == 1, !texts[0].contains("\n") { title = texts.removeFirst() }
        let draft = CaptureDraft(
            text: texts.isEmpty ? nil : texts.joined(separator: "\n"), url: url, title: title, fileNames: files.map(\.name))
        name = draft.name
        note = draft.note
        phase = .ready
    }

    /// Creates the item, then uploads the files; returns whether the sheet can close.
    func post() async -> Bool {
        phase = .posting
        let outcome = await InboxCapture(credentials: credentials).add(CaptureDraft(name: name, note: note), files: files)
        switch outcome {
        case .added:
            return true
        case .attachmentsFailed:
            phase = .addedWithError(outcome.dialog(for: name))
            return false
        case .failed, .signedOut, .empty:
            phase = .failed(outcome.dialog(for: name))
            return false
        }
    }

    private static func loadURL(_ provider: NSItemProvider) async -> URL? {
        try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL
    }

    private static func loadText(_ provider: NSItemProvider) async -> String? {
        try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String
    }
}

/// The compose sheet: name, note and the files to attach; Post adds the item to the inbox.
struct ShareSheet: View {
    @Bindable var model: ShareModel
    let done: () -> Void
    let cancel: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if model.credentials == nil {
                    ContentUnavailableView(
                        "Sign in to Prana", systemImage: "person.crop.circle.badge.exclamationmark",
                        description: Text("Open Prana and sign in to add shared items to your inbox."))
                } else {
                    form
                }
            }
            .navigationTitle("Add to Inbox")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel).accessibilityIdentifier("share.cancel")
                }
                if model.credentials != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        if case .addedWithError = model.phase {
                            Button("Done", action: done).accessibilityIdentifier("share.done")
                        } else if model.phase == .posting {
                            ProgressView()
                        } else {
                            Button("Post") {
                                Task { if await model.post() { done() } }
                            }
                            .disabled(model.phase == .loading || model.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("share.post")
                        }
                    }
                }
            }
        }
    }

    private var form: some View {
        Form {
            Section {
                TextField("Name", text: $model.name, axis: .vertical)
                    .font(.headline)
                    .accessibilityIdentifier("share.name")
                TextField("Note", text: $model.note, axis: .vertical)
                    .lineLimit(2...8)
                    .accessibilityIdentifier("share.note")
            }
            if !model.files.isEmpty {
                Section("Attachments") {
                    ForEach(Array(model.files.enumerated()), id: \.offset) { _, file in
                        Label(file.name, systemImage: "paperclip")
                            .badge(ByteCountFormatter.string(fromByteCount: Int64(file.data.count), countStyle: .file))
                    }
                }
            }
            if let message = model.phase.error {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("share.error")
                }
            }
        }
        .disabled(model.phase == .posting)
        .overlay {
            if model.phase == .loading { ProgressView() }
        }
    }
}
