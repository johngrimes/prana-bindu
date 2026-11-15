// Author: John Grimes

import CoreTransferable
import UniformTypeIdentifiers

/// Outline rows being dragged: the task ids (the whole selection when the dragged row is selected). Travels as plain
/// text `prana-tasks:<id>,<id>` so drop targets in the app (sidebar projects, tags, the inbox) can read it without a
/// custom declared type.
struct TaskDragItem: Codable, Hashable, Transferable {
    static let prefix = "prana-tasks:"

    var ids: [String]

    /// The title shown while dragging.
    var label: String = ""

    /// Errors decoding dropped text.
    enum DecodeError: Error {
        case notTasks
    }

    static var transferRepresentation: some TransferRepresentation {
        ProxyRepresentation(exporting: \.text, importing: { text in try TaskDragItem(text: text) })
    }

    /// The encoded text.
    var text: String { Self.prefix + ids.joined(separator: ",") }

    /// The ids, from text made by `text`.
    init(text: String) throws {
        guard text.hasPrefix(Self.prefix) else { throw DecodeError.notTasks }
        ids = text.dropFirst(Self.prefix.count).split(separator: ",").map(String.init)
    }

    /// Dragged ids.
    init(ids: [String], label: String = "") {
        self.ids = ids
        self.label = label
    }
}
