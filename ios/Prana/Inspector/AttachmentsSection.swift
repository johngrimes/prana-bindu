// Author: John Grimes

import PhotosUI
import PranaKit
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// A task's attachments (spec §3, `Attachments.tsx`): name and size (or "Uploading…" while the upload is queued),
/// image thumbnails, open in Quick Look (downloaded first), delete, and upload from Photos or Files or by dropping
/// files or images from other apps on the section's drop zone (≤ 100 MB).
struct AttachmentsSection: View {
    @Environment(AppStore.self) private var store

    let taskId: String
    let attachments: [Attachment]

    @State private var thumbnails: [String: UIImage] = [:]
    @State private var previewURL: URL?
    @State private var opening: String?
    @State private var photos: [PhotosPickerItem] = []
    @State private var importing = false
    @State private var dropTargeted = false

    var body: some View {
        ForEach(attachments) { attachment in
            row(attachment)
        }
        PhotosPicker(selection: $photos, matching: .any(of: [.images, .videos]), photoLibrary: .shared()) {
            Label("Add from Photos", systemImage: "photo.on.rectangle")
        }
        .accessibilityIdentifier("attachments.photos")
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            Task { await upload(items) }
        }
        Button {
            importing = true
        } label: {
            Label("Add from Files", systemImage: "doc.badge.plus")
        }
        .accessibilityIdentifier("attachments.files")
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { upload(urls) }
        }
        .quickLookPreview($previewURL)
        dropZone
    }

    /// Where files and images dragged from Files, Photos or another app are dropped, highlighted while a drag with
    /// files is over it. The label lets drags through to the UIKit drop target behind it.
    private var dropZone: some View {
        Label("Drop files here", systemImage: "arrow.down.doc")
            .foregroundStyle(dropTargeted ? Color.accentColor : .secondary)
            .frame(maxWidth: .infinity, minHeight: 56)
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
                    .foregroundStyle(dropTargeted ? Color.accentColor : Color.secondary.opacity(0.5))
            }
            .allowsHitTesting(false)
            .background {
                FileDropZone(targeted: $dropTargeted) { providers in upload(providers) }
            }
            .listRowBackground(dropTargeted ? Color.accentColor.opacity(0.15) : nil)
            .accessibilityIdentifier("attachments.drop")
    }

    private func row(_ attachment: Attachment) -> some View {
        let uploading = attachment.uploading == true
        return HStack(spacing: 10) {
            thumbnail(attachment, uploading: uploading)
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.name).lineLimit(1).truncationMode(.middle)
                Text(uploading ? "Uploading…" : Entities.formatBytes(attachment.size))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if !uploading {
                if opening == attachment.id {
                    ProgressView().frame(width: 44, height: 44)
                } else {
                    Button {
                        Task { await open(attachment) }
                    } label: {
                        Image(systemName: "eye").frame(width: 44, height: 44)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Open \(attachment.name)")
                }
                Button(role: .destructive) {
                    store.deleteAttachment(taskId: taskId, id: attachment.id)
                } label: {
                    Image(systemName: "trash").frame(width: 44, height: 44)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Delete \(attachment.name)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("attachment.\(attachment.name)")
    }

    @ViewBuilder
    private func thumbnail(_ attachment: Attachment, uploading: Bool) -> some View {
        Group {
            if !uploading, attachment.contentType.hasPrefix("image/"), let image = thumbnails[attachment.id] {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "doc").foregroundStyle(.secondary)
            }
        }
        .frame(width: 40, height: 40)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .task(id: attachment.id) {
            guard !uploading, attachment.contentType.hasPrefix("image/"), thumbnails[attachment.id] == nil,
                let data = try? await store.send(Endpoints.downloadAttachment(attachment.id)),
                let image = UIImage(data: data)
            else { return }
            thumbnails[attachment.id] = image.preparingThumbnail(of: CGSize(width: 120, height: 120)) ?? image
        }
    }

    /// Downloads the file to a temporary folder and shows it in Quick Look (where it can also be shared or saved).
    private func open(_ attachment: Attachment) async {
        opening = attachment.id
        defer { opening = nil }
        do {
            let data = try await store.send(Endpoints.downloadAttachment(attachment.id))
            let folder = FileManager.default.temporaryDirectory.appending(path: "attachments/\(attachment.id)", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appending(path: attachment.name.isEmpty ? attachment.id : attachment.name)
            try data.write(to: url, options: .atomic)
            previewURL = url
        } catch let error as APIError {
            if error != .cancelled { store.toast(error.message, kind: .error) }
        } catch {
            store.toast(error.localizedDescription, kind: .error)
        }
    }

    private func send(_ file: UploadFile) {
        guard file.data.count <= UploadFile.maxBytes else {
            store.toast("\(file.name) is larger than 100 MB", kind: .error)
            return
        }
        store.uploadAttachment(taskId: taskId, file: file)
    }

    private func upload(_ items: [PhotosPickerItem]) async {
        for (index, item) in items.enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first ?? .data
            let stamp = Date().formatted(Date.VerbatimFormatStyle(
                format: "\(year: .defaultDigits)-\(month: .twoDigits)-\(day: .twoDigits) at \(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)).\(minute: .twoDigits).\(second: .twoDigits)",
                timeZone: .current, calendar: .current))
            let ext = type.preferredFilenameExtension.map { ".\($0)" } ?? ""
            let suffix = items.count > 1 ? "-\(index + 1)" : ""
            send(UploadFile(name: "Photo \(stamp)\(suffix)\(ext)", contentType: type.preferredMIMEType ?? "application/octet-stream", data: data))
        }
    }

    private func upload(_ urls: [URL]) {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else {
                store.toast("Couldn't read \(url.lastPathComponent)", kind: .error)
                continue
            }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            send(UploadFile(name: url.lastPathComponent, contentType: type, data: data))
        }
    }

    /// Uploads dropped files and images; ones over the limit are refused unread with the same message. Called inside
    /// `performDrop`, which is when every file must be asked for.
    private func upload(_ providers: [NSItemProvider]) {
        let loading = ItemProviderFile.loadAll(providers, maxBytes: UploadFile.maxBytes)
        Task {
            for (provider, outcome) in zip(providers, await loading.value) {
                switch outcome {
                case .file(let file): send(file)
                case .tooLarge(let name): store.toast("\(name) is larger than 100 MB", kind: .error)
                case .unreadable: store.toast("Couldn't read \(provider.suggestedName ?? "the dropped file")", kind: .error)
                }
            }
        }
    }
}
