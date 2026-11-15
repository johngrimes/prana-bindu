// Author: John Grimes

import Foundation
import UniformTypeIdentifiers

extension UploadFile {
    /// The server's attachment size limit (100 MB, spec §3 Inspector).
    public static let maxBytes = 100 * 1024 * 1024
}

#if !os(watchOS)
/// A file from an `NSItemProvider` (drag and drop onto the inspector's attachments, or the share sheet), read for
/// upload with its name and MIME type. (watchOS has neither.) Main-actor, where drop targets and share sheets get
/// their providers.
@MainActor
public enum ItemProviderFile {
    /// What reading a provider gave.
    public enum Outcome: Sendable, Hashable {
        /// The file, ready to upload.
        case file(UploadFile)
        /// Larger than the limit; its contents were not read.
        case tooLarge(name: String)
        /// The provider had no readable file.
        case unreadable
    }

    /// Whether a drag carries a file, as the web's drop target accepts only files: an image or other non-text data,
    /// or anything with a file name. Selected text, links and dragged outline rows (text without a name) are not.
    public static func offersFile(_ provider: NSItemProvider) -> Bool {
        provider.suggestedName != nil
            || provider.registeredContentTypes.contains { $0.conforms(to: .data) && !$0.conforms(to: .text) && !$0.conforms(to: .url) }
    }

    /// Reads the provider's file (an image or any other file); files over `maxBytes` are refused unread.
    public static func load(_ provider: NSItemProvider, maxBytes: Int = .max) async -> Outcome {
        await loadAll([provider], maxBytes: maxBytes).value[0]
    }

    /// Asks every provider for its file before returning and gives the outcomes in the providers' order. Drop targets
    /// call this inside `performDrop`: a drag from another app only hands over the files asked for by then, and each
    /// file's temporary copy is deleted once its completion handler returns, so it is read there.
    public static func loadAll(_ providers: [NSItemProvider], maxBytes: Int = .max) -> Task<[Outcome], Never> {
        let streams = providers.map { provider in
            let (stream, continuation) = AsyncStream.makeStream(of: Outcome.self)
            request(provider, maxBytes: maxBytes) { outcome in
                continuation.yield(outcome)
                continuation.finish()
            }
            return stream
        }
        return Task {
            var outcomes: [Outcome] = []
            for stream in streams {
                var read: Outcome = .unreadable
                for await outcome in stream { read = outcome }
                outcomes.append(read)
            }
            return outcomes
        }
    }

    /// Asks the provider for its file now and reads it in the completion handler, while the copy exists.
    nonisolated private static func request(_ provider: NSItemProvider, maxBytes: Int, done: @escaping @Sendable (Outcome) -> Void) {
        guard let type = provider.registeredContentTypes.first(where: { $0.conforms(to: .data) || $0.conforms(to: .image) })
        else { return done(.unreadable) }
        let suggestedName = provider.suggestedName
        _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, _ in
            guard let url else { return done(.unreadable) }
            let fileType = UTType(filenameExtension: url.pathExtension) ?? type
            let base = suggestedName ?? url.deletingPathExtension().lastPathComponent
            let ext = url.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "") : url.pathExtension
            let name = ext.isEmpty || base.hasSuffix(".\(ext)") ? base : "\(base).\(ext)"
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > maxBytes {
                return done(.tooLarge(name: name))
            }
            guard let data = try? Data(contentsOf: url) else { return done(.unreadable) }
            done(.file(UploadFile(name: name, contentType: fileType.preferredMIMEType ?? "application/octet-stream", data: data)))
        }
    }
}
#endif
