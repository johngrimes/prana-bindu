// Author: John Grimes

import SwiftUI
import UniformTypeIdentifiers

#if DEBUG
    /// UI tests can't drag from another app, so with `PRANA_UITEST_DRAG_FILE` (a file path) in the launch environment
    /// a debug build shows a chip that drags that file as Files does: one item with a file representation of the
    /// file's type, named after the file (debug builds only).
    struct UITestDragSource: View {
        private let url = ProcessInfo.processInfo.environment["PRANA_UITEST_DRAG_FILE"].map { URL(filePath: $0) }

        var body: some View {
            if let url {
                Text("Drag \(url.lastPathComponent)")
                    .font(.caption)
                    .padding(8)
                    .background(.yellow, in: .capsule)
                    .accessibilityIdentifier("uitest.drag-file")
                    .onDrag { Self.provider(for: url) }
                    .padding()
            }
        }

        /// What Files puts on a drag of one file: its type as a file representation, and its name with the extension.
        private static func provider(for url: URL) -> NSItemProvider {
            let provider = NSItemProvider()
            provider.suggestedName = url.lastPathComponent
            provider.registerFileRepresentation(
                for: UTType(filenameExtension: url.pathExtension) ?? .data, visibility: .all, openInPlace: false
            ) { load in
                load(url, false, nil)
                return nil
            }
            return provider
        }
    }
#endif
