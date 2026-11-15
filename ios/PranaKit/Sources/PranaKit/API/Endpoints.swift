// Author: John Grimes

import Foundation

/// One constructor per bearer-usable REST operation (`src/server/api/routes.ts`, `src/server/auth/routes.ts`).
/// Paths are relative to `/api/v1`.
public enum Endpoints {
    // MARK: Helpers

    /// Percent-encodes one path segment (ids may contain any character).
    static func seg(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#%")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    static func json(_ value: some Encodable) -> RequestBody {
        // Bodies are plain structs of strings, numbers and booleans: encoding cannot fail in practice. Should it ever,
        // an empty body makes the server answer 400, which the write queue reports.
        .json((try? APIClient.encoder.encode(value)) ?? Data())
    }

    static func query(_ pairs: [(String, String?)]) -> [URLQueryItem] {
        pairs.compactMap { name, value in value.map { URLQueryItem(name: name, value: $0) } }
    }

    private struct Ids: Encodable { var ids: [String] }
    private struct Complete: Encodable { var ids: [String]?; var completed: Bool }
    private struct Drop: Encodable { var ids: [String]?; var dropped: Bool; var scope: RepeatScope? }
    private struct Status: Encodable { var ids: [String]; var status: ActivityStatus; var scope: RepeatScope? }
    private struct Tags: Encodable { var ids: [String]; var add: [String]?; var remove: [String]? }
    private struct TagId: Encodable { var tagId: String }
    private struct Batch<P: Encodable>: Encodable { var ids: [String]; var patch: P }
    private struct Outline: Encodable { var op: OutlineOperation; var ids: [String]; var groupId: String? }
    private struct Name: Encodable { var name: String }
    private struct Empty: Encodable {}

    private struct Move: Encodable {
        var ids: [String]
        var target: MoveTarget
        private enum Keys: String, CodingKey { case ids }
        func encode(to encoder: Encoder) throws {
            try target.encode(to: encoder)
            var c = encoder.container(keyedBy: Keys.self)
            try c.encode(ids, forKey: .ids)
        }
    }

    // MARK: Tasks

    /// `GET /tasks`: a page of tasks matching the filters.
    public static func tasks(
        perspective: String? = nil, inbox: Bool? = nil, projectId: String? = nil, tagId: String? = nil,
        folderId: String? = nil, flagged: Bool? = nil, status: String? = nil, availability: Availability? = nil,
        q: String? = nil, dueBefore: String? = nil, dueAfter: String? = nil, limit: Int? = nil, cursor: String? = nil
    ) -> APIRequest<TaskPage> {
        APIRequest(method: .get, path: "/tasks", query: query([
            ("perspective", perspective), ("inbox", inbox.map { String($0) }), ("projectId", projectId),
            ("tagId", tagId), ("folderId", folderId), ("flagged", flagged.map { String($0) }), ("status", status),
            ("availability", availability?.rawValue), ("q", q), ("dueBefore", dueBefore), ("dueAfter", dueAfter),
            ("limit", limit.map { String($0) }), ("cursor", cursor),
        ]))
    }

    /// `POST /tasks`.
    public static func createTask(_ body: TaskCreate) -> APIRequest<TaskItem> {
        APIRequest(method: .post, path: "/tasks", body: json(body))
    }

    /// `GET /tasks/{id}`: the task with children, alarms, attachments and project fields.
    public static func task(_ id: String) -> APIRequest<TaskDetail> {
        APIRequest(method: .get, path: "/tasks/\(seg(id))")
    }

    /// `PATCH /tasks/{id}`.
    public static func patchTask(_ id: String, _ patch: TaskPatch) -> APIRequest<TaskItem> {
        APIRequest(method: .patch, path: "/tasks/\(seg(id))", body: json(patch))
    }

    /// `DELETE /tasks/{id}`.
    public static func deleteTask(_ id: String) -> APIRequest<EmptyResponse> {
        APIRequest(method: .delete, path: "/tasks/\(seg(id))")
    }

    /// `POST /tasks/{id}/discard`: reverts a just-created item's creation, or deletes it.
    public static func discardTask(_ id: String) -> APIRequest<EmptyResponse> {
        APIRequest(method: .post, path: "/tasks/\(seg(id))/discard", body: json(Empty()))
    }

    /// `POST /tasks/{id}/complete`.
    public static func completeTask(_ id: String, completed: Bool) -> APIRequest<Changed> {
        APIRequest(method: .post, path: "/tasks/\(seg(id))/complete", body: json(Complete(ids: nil, completed: completed)))
    }

    /// `POST /tasks/{id}/drop`.
    public static func dropTask(_ id: String, dropped: Bool, scope: RepeatScope? = nil) -> APIRequest<Changed> {
        APIRequest(method: .post, path: "/tasks/\(seg(id))/drop", body: json(Drop(ids: nil, dropped: dropped, scope: scope)))
    }

    /// `POST /tasks/{id}/move`.
    public static func moveTask(_ id: String, to target: MoveTarget) -> APIRequest<Changed> {
        APIRequest(method: .post, path: "/tasks/\(seg(id))/move", body: json(target))
    }

    /// `POST /tasks/{id}/tags`: adds one tag.
    public static func addTag(taskId: String, tagId: String) -> APIRequest<TaskItem> {
        APIRequest(method: .post, path: "/tasks/\(seg(taskId))/tags", body: json(TagId(tagId: tagId)))
    }

    /// `DELETE /tasks/{id}/tags/{tagId}`: removes one tag.
    public static func removeTag(taskId: String, tagId: String) -> APIRequest<TaskItem> {
        APIRequest(method: .delete, path: "/tasks/\(seg(taskId))/tags/\(seg(tagId))")
    }

    /// `GET /tasks/{id}/attachments`.
    public static func attachments(taskId: String) -> APIRequest<Items<Attachment>> {
        APIRequest(method: .get, path: "/tasks/\(seg(taskId))/attachments")
    }

    /// `POST /tasks/{id}/attachments` (multipart field `file`, ≤ 100 MB).
    public static func uploadAttachment(taskId: String, file: UploadFile) -> APIRequest<Attachment> {
        APIRequest(method: .post, path: "/tasks/\(seg(taskId))/attachments", body: .multipart(field: "file", file: file))
    }

    /// `POST /tasks/outline`: indent, outdent, group, ungroup, move up/down (spec §3).
    public static func outline(_ op: OutlineOperation, ids: [String], groupId: String? = nil) -> APIRequest<Changed> {
        APIRequest(method: .post, path: "/tasks/outline", body: json(Outline(op: op, ids: ids, groupId: groupId)))
    }

    /// `POST /tasks/batch`: one patch applied to several tasks.
    public static func batchPatchTasks(_ ids: [String], _ patch: TaskPatch) -> APIRequest<Changed> {
        APIRequest(method: .post, path: "/tasks/batch", body: json(Batch(ids: ids, patch: patch)))
    }

    /// `POST /tasks/complete`.
    public static func completeTasks(_ ids: [String], completed: Bool) -> APIRequest<Changed> {
        APIRequest(method: .post, path: "/tasks/complete", body: json(Complete(ids: ids, completed: completed)))
    }

    /// `POST /tasks/drop`.
    public static func dropTasks(_ ids: [String], dropped: Bool, scope: RepeatScope? = nil) -> APIRequest<Changed> {
        APIRequest(method: .post, path: "/tasks/drop", body: json(Drop(ids: ids, dropped: dropped, scope: scope)))
    }

    /// `POST /tasks/move`.
    public static func moveTasks(_ ids: [String], to target: MoveTarget) -> APIRequest<Changed> {
        APIRequest(method: .post, path: "/tasks/move", body: json(Move(ids: ids, target: target)))
    }

    /// `POST /tasks/tags`: adds and removes tags on several tasks.
    public static func editTags(_ ids: [String], add: [String]? = nil, remove: [String]? = nil) -> APIRequest<Changed> {
        APIRequest(method: .post, path: "/tasks/tags", body: json(Tags(ids: ids, add: add, remove: remove)))
    }

    /// `POST /tasks/status`.
    public static func setStatus(_ ids: [String], _ status: ActivityStatus, scope: RepeatScope? = nil) -> APIRequest<Changed> {
        APIRequest(method: .post, path: "/tasks/status", body: json(Status(ids: ids, status: status, scope: scope)))
    }

    /// `POST /delete`: deletes items of any kind as one change.
    public static func delete(_ selection: DeleteSelection) -> APIRequest<EmptyResponse> {
        APIRequest(method: .post, path: "/delete", body: json(selection))
    }

    /// `POST /cleanup`: files inbox items away and settles completed rows (spec §3 Clean Up).
    public static func cleanup() -> APIRequest<Changed> {
        APIRequest(method: .post, path: "/cleanup", body: json(Empty()))
    }

    // MARK: Projects

    /// `GET /projects`.
    public static func projects(status: ProjectStatus? = nil, folderId: String? = nil) -> APIRequest<Items<Project>> {
        APIRequest(method: .get, path: "/projects", query: query([("status", status?.rawValue), ("folderId", folderId)]))
    }

    /// `POST /projects`.
    public static func createProject(_ body: ProjectCreate) -> APIRequest<Project> {
        APIRequest(method: .post, path: "/projects", body: json(body))
    }

    /// `GET /projects/{id}`.
    public static func project(_ id: String) -> APIRequest<Project> {
        APIRequest(method: .get, path: "/projects/\(seg(id))")
    }

    /// `PATCH /projects/{id}`.
    public static func patchProject(_ id: String, _ patch: ProjectPatch) -> APIRequest<Project> {
        APIRequest(method: .patch, path: "/projects/\(seg(id))", body: json(patch))
    }

    /// `DELETE /projects/{id}`.
    public static func deleteProject(_ id: String) -> APIRequest<EmptyResponse> {
        APIRequest(method: .delete, path: "/projects/\(seg(id))")
    }

    /// `POST /projects/{id}/review`: marks the project reviewed.
    public static func markReviewed(_ id: String) -> APIRequest<Project> {
        APIRequest(method: .post, path: "/projects/\(seg(id))/review", body: json(Empty()))
    }

    /// `POST /projects/{id}/move`: into a folder (or the top level).
    public static func moveProject(_ id: String, _ move: ContainerMove) -> APIRequest<Project> {
        APIRequest(method: .post, path: "/projects/\(seg(id))/move", body: json(move))
    }

    /// `POST /projects/batch`.
    public static func batchPatchProjects(_ ids: [String], _ patch: ProjectPatch) -> APIRequest<Items<Project>> {
        APIRequest(method: .post, path: "/projects/batch", body: json(Batch(ids: ids, patch: patch)))
    }

    // MARK: Folders

    /// `GET /folders`.
    public static func folders() -> APIRequest<Items<Folder>> { APIRequest(method: .get, path: "/folders") }

    /// `POST /folders`.
    public static func createFolder(_ body: FolderCreate) -> APIRequest<Folder> {
        APIRequest(method: .post, path: "/folders", body: json(body))
    }

    /// `GET /folders/{id}`.
    public static func folder(_ id: String) -> APIRequest<Folder> { APIRequest(method: .get, path: "/folders/\(seg(id))") }

    /// `PATCH /folders/{id}`.
    public static func patchFolder(_ id: String, _ patch: FolderPatch) -> APIRequest<Folder> {
        APIRequest(method: .patch, path: "/folders/\(seg(id))", body: json(patch))
    }

    /// `DELETE /folders/{id}`.
    public static func deleteFolder(_ id: String) -> APIRequest<EmptyResponse> {
        APIRequest(method: .delete, path: "/folders/\(seg(id))")
    }

    /// `POST /folders/{id}/move`.
    public static func moveFolder(_ id: String, _ move: ContainerMove) -> APIRequest<Folder> {
        APIRequest(method: .post, path: "/folders/\(seg(id))/move", body: json(move))
    }

    // MARK: Tags

    /// `GET /tags`.
    public static func tags() -> APIRequest<Items<Tag>> { APIRequest(method: .get, path: "/tags") }

    /// `POST /tags`.
    public static func createTag(_ body: TagCreate) -> APIRequest<Tag> {
        APIRequest(method: .post, path: "/tags", body: json(body))
    }

    /// `GET /tags/{id}`.
    public static func tag(_ id: String) -> APIRequest<Tag> { APIRequest(method: .get, path: "/tags/\(seg(id))") }

    /// `PATCH /tags/{id}`.
    public static func patchTag(_ id: String, _ patch: TagPatch) -> APIRequest<Tag> {
        APIRequest(method: .patch, path: "/tags/\(seg(id))", body: json(patch))
    }

    /// `DELETE /tags/{id}`.
    public static func deleteTag(_ id: String) -> APIRequest<EmptyResponse> {
        APIRequest(method: .delete, path: "/tags/\(seg(id))")
    }

    /// `POST /tags/{id}/move`.
    public static func moveTag(_ id: String, _ move: ContainerMove) -> APIRequest<Tag> {
        APIRequest(method: .post, path: "/tags/\(seg(id))/move", body: json(move))
    }

    // MARK: Perspectives

    /// `GET /perspectives`.
    public static func perspectives() -> APIRequest<Items<Perspective>> { APIRequest(method: .get, path: "/perspectives") }

    /// `POST /perspectives`.
    public static func createPerspective(_ body: PerspectiveCreate) -> APIRequest<Perspective> {
        APIRequest(method: .post, path: "/perspectives", body: json(body))
    }

    /// `GET /perspectives/{id}`.
    public static func perspective(_ id: String) -> APIRequest<Perspective> {
        APIRequest(method: .get, path: "/perspectives/\(seg(id))")
    }

    /// `PATCH /perspectives/{id}`.
    public static func patchPerspective(_ id: String, _ patch: PerspectivePatch) -> APIRequest<Perspective> {
        APIRequest(method: .patch, path: "/perspectives/\(seg(id))", body: json(patch))
    }

    /// `DELETE /perspectives/{id}`.
    public static func deletePerspective(_ id: String) -> APIRequest<EmptyResponse> {
        APIRequest(method: .delete, path: "/perspectives/\(seg(id))")
    }

    /// `GET /perspectives/{id}/contents`: the evaluated perspective.
    public static func contents(_ key: ContentsKey) -> APIRequest<OutlineContents> {
        APIRequest(method: .get, path: "/perspectives/\(seg(key.perspectiveId))/contents", query: key.queryItems)
    }

    /// `PUT /perspectives/{id}/view-options` (not journaled).
    public static func setViewOptions(_ id: String, _ options: ViewOptions) -> APIRequest<Perspective> {
        APIRequest(method: .put, path: "/perspectives/\(seg(id))/view-options", body: json(options))
    }

    // MARK: Views

    /// `GET /forecast`: `from` is `YYYY-MM-DD`, `days` 1–60.
    public static func forecast(from: String? = nil, days: Int? = nil) -> APIRequest<ForecastResponse> {
        APIRequest(method: .get, path: "/forecast", query: query([("from", from), ("days", days.map { String($0) })]))
    }

    /// `GET /review`: projects due for review.
    public static func review() -> APIRequest<Items<Project>> { APIRequest(method: .get, path: "/review") }

    /// `GET /search`.
    public static func search(_ q: String, availability: Availability? = nil) -> APIRequest<SearchResults> {
        APIRequest(method: .get, path: "/search", query: query([("q", q), ("availability", availability?.rawValue)]))
    }

    /// `GET /quick-open`.
    public static func quickOpen(_ q: String) -> APIRequest<Items<QuickOpenResult>> {
        APIRequest(method: .get, path: "/quick-open", query: query([("q", q)]))
    }

    // MARK: Attachments

    /// `GET /attachments/{id}`.
    public static func attachment(_ id: String) -> APIRequest<Attachment> {
        APIRequest(method: .get, path: "/attachments/\(seg(id))")
    }

    /// `DELETE /attachments/{id}`.
    public static func deleteAttachment(_ id: String) -> APIRequest<EmptyResponse> {
        APIRequest(method: .delete, path: "/attachments/\(seg(id))")
    }

    /// `GET /attachments/{id}/download`: the file's bytes (redirects are followed).
    public static func downloadAttachment(_ id: String) -> APIRequest<Data> {
        APIRequest(method: .get, path: "/attachments/\(seg(id))/download")
    }

    // MARK: Undo, settings, parse, import

    /// `POST /undo`.
    public static func undo() -> APIRequest<History> { APIRequest(method: .post, path: "/undo", body: json(Empty())) }

    /// `POST /redo`.
    public static func redo() -> APIRequest<History> { APIRequest(method: .post, path: "/redo", body: json(Empty())) }

    /// `GET /history`.
    public static func history() -> APIRequest<History> { APIRequest(method: .get, path: "/history") }

    /// `GET /settings`.
    public static func settings() -> APIRequest<Settings> { APIRequest(method: .get, path: "/settings") }

    /// `PATCH /settings`.
    public static func patchSettings(_ patch: SettingsPatch) -> APIRequest<Settings> {
        APIRequest(method: .patch, path: "/settings", body: json(patch))
    }

    /// `POST /settings/reset`.
    public static func resetSettings() -> APIRequest<Settings> {
        APIRequest(method: .post, path: "/settings/reset", body: json(Empty()))
    }

    /// `POST /parse`: the server's reading of a date or duration.
    public static func parse(_ request: ParseRequest) -> APIRequest<ParseResponse> {
        APIRequest(method: .post, path: "/parse", body: json(request))
    }

    /// `GET /import/last`.
    public static func lastImport() -> APIRequest<LastImport> { APIRequest(method: .get, path: "/import/last") }

    // MARK: Auth (bearer-usable)

    /// `GET /auth/session`.
    public static func session() -> APIRequest<AuthSession> { APIRequest(method: .get, path: "/auth/session") }

    /// `GET /auth/passkeys`.
    public static func passkeys() -> APIRequest<Items<Passkey>> { APIRequest(method: .get, path: "/auth/passkeys") }

    /// `PATCH /auth/passkeys/{id}`.
    public static func renamePasskey(_ id: String, name: String) -> APIRequest<Passkey> {
        APIRequest(method: .patch, path: "/auth/passkeys/\(seg(id))", body: json(Name(name: name)))
    }

    /// `DELETE /auth/passkeys/{id}`.
    public static func deletePasskey(_ id: String) -> APIRequest<EmptyResponse> {
        APIRequest(method: .delete, path: "/auth/passkeys/\(seg(id))")
    }

    /// `GET /auth/tokens`.
    public static func tokens() -> APIRequest<Items<ApiToken>> { APIRequest(method: .get, path: "/auth/tokens") }

    /// `POST /auth/tokens`.
    public static func createToken(name: String) -> APIRequest<ApiTokenCreated> {
        APIRequest(method: .post, path: "/auth/tokens", body: json(Name(name: name)))
    }

    /// `DELETE /auth/tokens/{id}`.
    public static func revokeToken(_ id: String) -> APIRequest<EmptyResponse> {
        APIRequest(method: .delete, path: "/auth/tokens/\(seg(id))")
    }
}
