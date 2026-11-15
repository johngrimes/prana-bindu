// REST resources under /api/v1 (docs/spec.md §9), except auth. Paths are relative to /api/v1.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { DomainError, MAX_ATTACHMENT_BYTES, type Domain } from "../../domain/index.js";
import {
  ApiError,
  Attachment,
  Availability,
  Changed,
  ContainerMove,
  Folder,
  FolderCreate,
  FolderPatch,
  Forecast,
  History,
  ImportRun,
  LastImport,
  OutlineOp,
  ParseRequest,
  ParseResponse,
  Perspective,
  PerspectiveContents,
  PerspectiveCreate,
  PerspectivePatch,
  Project,
  ProjectCreate,
  ProjectPatch,
  ProjectStatus,
  QuickOpenResult,
  SearchResults,
  Settings,
  Tag,
  TagCreate,
  TagPatch,
  Task,
  TaskCreate,
  TaskDetail,
  TaskMove,
  TaskPage,
  TaskPatch,
  TaskStatus,
  ViewOptions,
  type ImportRun as ImportRunT,
} from "../../shared/schemas.js";
import type { BlobStore } from "../../storage/types.js";
import { errorResponse, handleError, validationHook } from "../errors.js";

export type ImportSource = { url: string } | { zip: Uint8Array; name: string };

export interface ApiDeps {
  domain: Domain;
  blobStore: BlobStore;
  /** Runs a replace-all import and invalidates the domain cache. */
  runImport: (source: ImportSource) => Promise<ImportRunT>;
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const body = <T extends z.ZodType>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const err = (description: string) => json(ApiError, description);
const E400 = { 400: err("Invalid request") };
const E404 = { 404: err("Not found") };
const E409 = { 409: err("Id already in use") };
const E422 = { 422: err("Unprocessable (unparseable date, invalid operation)") };
const NO_CONTENT = { 204: { description: "Deleted" } };
const items = <T extends z.ZodType>(schema: T) => z.object({ items: z.array(schema) });

const IdParam = z.object({ id: z.string().min(1) });
const Ids = z.array(z.string().min(1)).min(1);
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const intParam = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const ContentsQuery = z.object({
  project: z.string().optional().openapi({ description: "Project id: the selected project in Projects; in Review, that project's outline instead of the due list" }),
  folder: z.string().optional(),
  tag: z.string().optional().openapi({ description: "Tag id or `untagged`" }),
  day: z.string().optional().openapi({ description: "Forecast section: PAST, TODAY, FUTURE or YYYY-MM-DD" }),
  q: z.string().optional().openapi({ description: "Search perspective query" }),
});

const TasksQuery = z.object({
  perspective: z.string().optional(),
  inbox: bool.optional(),
  projectId: z.string().optional(),
  tagId: z.string().optional(),
  folderId: z.string().optional(),
  flagged: bool.optional(),
  status: TaskStatus.optional(),
  availability: Availability.optional().openapi({ description: "Default `remaining`" }),
  q: z.string().optional(),
  dueBefore: z.string().optional().openapi({ description: "ISO or natural-language date" }),
  dueAfter: z.string().optional(),
  limit: intParam(1, 5000).optional().openapi({ description: "Default 500" }),
  cursor: z.string().optional(),
});

const FileUpload = z.object({
  file: z.any().openapi({ type: "string", format: "binary", description: "The file to attach (≤ 100 MB)" }),
});
const ImportUpload = z.object({
  file: z.any().openapi({ type: "string", format: "binary", description: "`.zip` containing a `.ofocus` package" }),
});
const ImportUrl = z.object({ url: z.url() });

const t = {
  tasks: ["Tasks"],
  projects: ["Projects"],
  folders: ["Folders"],
  tags: ["Tags"],
  perspectives: ["Perspectives"],
  forecast: ["Forecast & Review"],
  search: ["Search"],
  attachments: ["Attachments"],
  history: ["Undo"],
  settings: ["Settings"],
  util: ["Utilities"],
  import: ["Import"],
};

const r = {
  // Tasks
  listTasks: createRoute({ method: "get", path: "/tasks", tags: t.tasks, summary: "List tasks", request: { query: TasksQuery }, responses: { 200: json(TaskPage, "Tasks in outline order"), ...E400, ...E404 } }),
  createTask: createRoute({ method: "post", path: "/tasks", tags: t.tasks, summary: "Create a task (inbox unless a container or position anchor is given)", request: { body: body(TaskCreate) }, responses: { 201: json(Task, "Created"), ...E400, ...E409, ...E404, ...E422 } }),
  outline: createRoute({ method: "post", path: "/tasks/outline", tags: t.tasks, summary: "Outline operation (indent, outdent, group, ungroup, moveUp, moveDown)", request: { body: body(OutlineOp) }, responses: { 200: json(Changed, "Changed tasks"), ...E400, ...E409, ...E404, ...E422 } }),
  batch: createRoute({ method: "post", path: "/tasks/batch", tags: t.tasks, summary: "Apply one patch to several tasks (one undo step)", request: { body: body(z.object({ ids: Ids, patch: TaskPatch })) }, responses: { 200: json(Changed, "Changed tasks"), ...E400, ...E404, ...E422 } }),
  completeMany: createRoute({ method: "post", path: "/tasks/complete", tags: t.tasks, summary: "Complete or un-complete several tasks (one undo step)", request: { body: body(z.object({ ids: Ids, completed: z.boolean() })) }, responses: { 200: json(Changed, "Changed tasks"), ...E400, ...E404 } }),
  dropMany: createRoute({ method: "post", path: "/tasks/drop", tags: t.tasks, summary: "Drop or reactivate several tasks (one undo step)", request: { body: body(z.object({ ids: Ids, dropped: z.boolean(), scope: z.enum(["occurrence", "series"]).optional() })) }, responses: { 200: json(Changed, "Changed tasks"), ...E400, ...E404 } }),
  moveMany: createRoute({ method: "post", path: "/tasks/move", tags: t.tasks, summary: "Move several tasks to one place, keeping their outline order (one undo step)", request: { body: body(TaskMove.extend({ ids: Ids })) }, responses: { 200: json(Changed, "Changed tasks"), ...E400, ...E404, ...E422 } }),
  tagMany: createRoute({ method: "post", path: "/tasks/tags", tags: t.tasks, summary: "Add and remove tags on several tasks (one undo step)", request: { body: body(z.object({ ids: Ids, add: z.array(z.string().min(1)).optional(), remove: z.array(z.string().min(1)).optional() })) }, responses: { 200: json(Changed, "Changed tasks"), ...E400, ...E404 } }),
  discardTask: createRoute({ method: "post", path: "/tasks/{id}/discard", tags: t.tasks, summary: "Discard a new task: erase its creation if that was the latest change, else delete it (undoable)", request: { params: IdParam }, responses: { ...NO_CONTENT, ...E404 } }),
  statusMany: createRoute({ method: "post", path: "/tasks/status", tags: t.tasks, summary: "Set several tasks (or project roots) to active, completed or dropped (one undo step)", request: { body: body(z.object({ ids: Ids, status: z.enum(["active", "completed", "dropped"]), scope: z.enum(["occurrence", "series"]).optional() })) }, responses: { 200: json(Changed, "Changed tasks"), ...E400, ...E404 } }),
  deleteMany: createRoute({ method: "post", path: "/delete", tags: t.tasks, summary: "Delete a mixed selection of tasks, projects, folders and tags (one undo step)", request: { body: body(z.object({ taskIds: z.array(z.string().min(1)).optional(), projectIds: z.array(z.string().min(1)).optional(), folderIds: z.array(z.string().min(1)).optional(), tagIds: z.array(z.string().min(1)).optional() })) }, responses: { ...NO_CONTENT, ...E400, ...E404 } }),
  getTask: createRoute({ method: "get", path: "/tasks/{id}", tags: t.tasks, summary: "Get a task with children, alarms and attachments", request: { params: IdParam }, responses: { 200: json(TaskDetail, "Task"), ...E404 } }),
  patchTask: createRoute({ method: "patch", path: "/tasks/{id}", tags: t.tasks, summary: "Update a task", request: { params: IdParam, body: body(TaskPatch) }, responses: { 200: json(Task, "Updated"), ...E400, ...E404, ...E422 } }),
  deleteTask: createRoute({ method: "delete", path: "/tasks/{id}", tags: t.tasks, summary: "Delete a task and its descendants", request: { params: IdParam }, responses: { ...NO_CONTENT, ...E404 } }),
  completeTask: createRoute({ method: "post", path: "/tasks/{id}/complete", tags: t.tasks, summary: "Complete or un-complete (repeats advance)", request: { params: IdParam, body: body(z.object({ completed: z.boolean() })) }, responses: { 200: json(Changed, "Changed tasks"), ...E400, ...E404 } }),
  dropTask: createRoute({ method: "post", path: "/tasks/{id}/drop", tags: t.tasks, summary: "Drop or reactivate; repeating tasks drop one occurrence or the series", request: { params: IdParam, body: body(z.object({ dropped: z.boolean(), scope: z.enum(["occurrence", "series"]).optional() })) }, responses: { 200: json(Changed, "Changed tasks"), ...E400, ...E404 } }),
  moveTask: createRoute({ method: "post", path: "/tasks/{id}/move", tags: t.tasks, summary: "Move to a parent task, project or the inbox", request: { params: IdParam, body: body(TaskMove) }, responses: { 200: json(Changed, "Changed tasks"), ...E400, ...E404, ...E422 } }),
  addTag: createRoute({ method: "post", path: "/tasks/{id}/tags", tags: t.tasks, summary: "Add a tag (mutually exclusive siblings are removed)", request: { params: IdParam, body: body(z.object({ tagId: z.string().min(1) })) }, responses: { 200: json(Task, "Updated"), ...E400, ...E404 } }),
  removeTag: createRoute({ method: "delete", path: "/tasks/{id}/tags/{tagId}", tags: t.tasks, summary: "Remove a tag", request: { params: z.object({ id: z.string().min(1), tagId: z.string().min(1) }) }, responses: { 200: json(Task, "Updated"), ...E404 } }),
  listAttachments: createRoute({ method: "get", path: "/tasks/{id}/attachments", tags: t.attachments, summary: "List a task's attachments", request: { params: IdParam }, responses: { 200: json(items(Attachment), "Attachments"), ...E404 } }),
  uploadAttachment: createRoute({ method: "post", path: "/tasks/{id}/attachments", tags: t.attachments, summary: "Upload an attachment (multipart, ≤ 100 MB)", request: { params: IdParam, body: { content: { "multipart/form-data": { schema: FileUpload } }, required: true } }, responses: { 201: json(Attachment, "Created"), ...E400, ...E404, 413: err("Larger than 100 MB") } }),
  cleanup: createRoute({ method: "post", path: "/cleanup", tags: t.tasks, summary: "Clean Up: file inbox items with a project or tags", responses: { 200: json(Changed, "Changed tasks") } }),

  // Projects
  listProjects: createRoute({ method: "get", path: "/projects", tags: t.projects, summary: "List projects in sidebar order", request: { query: z.object({ status: ProjectStatus.optional(), folderId: z.string().optional() }) }, responses: { 200: json(items(Project), "Projects"), ...E400 } }),
  createProject: createRoute({ method: "post", path: "/projects", tags: t.projects, summary: "Create a project", request: { body: body(ProjectCreate) }, responses: { 201: json(Project, "Created"), ...E400, ...E409, ...E404, ...E422 } }),
  getProject: createRoute({ method: "get", path: "/projects/{id}", tags: t.projects, summary: "Get a project", request: { params: IdParam }, responses: { 200: json(Project, "Project"), ...E404 } }),
  patchProject: createRoute({ method: "patch", path: "/projects/{id}", tags: t.projects, summary: "Update a project", request: { params: IdParam, body: body(ProjectPatch) }, responses: { 200: json(Project, "Updated"), ...E400, ...E404, ...E422 } }),
  deleteProject: createRoute({ method: "delete", path: "/projects/{id}", tags: t.projects, summary: "Delete a project and its actions", request: { params: IdParam }, responses: { ...NO_CONTENT, ...E404 } }),
  reviewProject: createRoute({ method: "post", path: "/projects/{id}/review", tags: t.projects, summary: "Mark reviewed", request: { params: IdParam }, responses: { 200: json(Project, "Reviewed"), ...E404 } }),
  moveProject: createRoute({ method: "post", path: "/projects/{id}/move", tags: t.projects, summary: "Move into a folder (parentId) at a position among folders and projects", request: { params: IdParam, body: body(ContainerMove) }, responses: { 200: json(Project, "Moved"), ...E400, ...E404 } }),
  batchProjects: createRoute({ method: "post", path: "/projects/batch", tags: t.projects, summary: "Apply one patch to several projects (one undo step)", request: { body: body(z.object({ ids: Ids, patch: ProjectPatch })) }, responses: { 200: json(items(Project), "Updated projects"), ...E400, ...E404, ...E422 } }),

  // Folders
  listFolders: createRoute({ method: "get", path: "/folders", tags: t.folders, summary: "List folders (tree order; nest by parentId)", responses: { 200: json(items(Folder), "Folders") } }),
  createFolder: createRoute({ method: "post", path: "/folders", tags: t.folders, summary: "Create a folder", request: { body: body(FolderCreate) }, responses: { 201: json(Folder, "Created"), ...E400, ...E409, ...E404 } }),
  getFolder: createRoute({ method: "get", path: "/folders/{id}", tags: t.folders, summary: "Get a folder", request: { params: IdParam }, responses: { 200: json(Folder, "Folder"), ...E404 } }),
  patchFolder: createRoute({ method: "patch", path: "/folders/{id}", tags: t.folders, summary: "Update a folder", request: { params: IdParam, body: body(FolderPatch) }, responses: { 200: json(Folder, "Updated"), ...E400, ...E404 } }),
  deleteFolder: createRoute({ method: "delete", path: "/folders/{id}", tags: t.folders, summary: "Delete a folder, its subfolders and contained projects", request: { params: IdParam }, responses: { ...NO_CONTENT, ...E404 } }),
  moveFolder: createRoute({ method: "post", path: "/folders/{id}/move", tags: t.folders, summary: "Move a folder", request: { params: IdParam, body: body(ContainerMove) }, responses: { 200: json(Folder, "Moved"), ...E400, ...E404, ...E422 } }),

  // Tags
  listTags: createRoute({ method: "get", path: "/tags", tags: t.tags, summary: "List tags (tree order) with counts", responses: { 200: json(items(Tag), "Tags") } }),
  createTag: createRoute({ method: "post", path: "/tags", tags: t.tags, summary: "Create a tag", request: { body: body(TagCreate) }, responses: { 201: json(Tag, "Created"), ...E400, ...E409, ...E404 } }),
  getTag: createRoute({ method: "get", path: "/tags/{id}", tags: t.tags, summary: "Get a tag", request: { params: IdParam }, responses: { 200: json(Tag, "Tag"), ...E404 } }),
  patchTag: createRoute({ method: "patch", path: "/tags/{id}", tags: t.tags, summary: "Update a tag", request: { params: IdParam, body: body(TagPatch) }, responses: { 200: json(Tag, "Updated"), ...E400, ...E404 } }),
  deleteTag: createRoute({ method: "delete", path: "/tags/{id}", tags: t.tags, summary: "Delete a tag and its child tags", request: { params: IdParam }, responses: { ...NO_CONTENT, ...E404 } }),
  moveTag: createRoute({ method: "post", path: "/tags/{id}/move", tags: t.tags, summary: "Move a tag", request: { params: IdParam, body: body(ContainerMove) }, responses: { 200: json(Tag, "Moved"), ...E400, ...E404, ...E422 } }),

  // Perspectives
  listPerspectives: createRoute({ method: "get", path: "/perspectives", tags: t.perspectives, summary: "List perspectives (built-in and custom) by rank", responses: { 200: json(items(Perspective), "Perspectives") } }),
  createPerspective: createRoute({ method: "post", path: "/perspectives", tags: t.perspectives, summary: "Create a custom perspective", request: { body: body(PerspectiveCreate) }, responses: { 201: json(Perspective, "Created"), ...E400, ...E409 } }),
  getPerspective: createRoute({ method: "get", path: "/perspectives/{id}", tags: t.perspectives, summary: "Get a perspective", request: { params: IdParam }, responses: { 200: json(Perspective, "Perspective"), ...E404 } }),
  patchPerspective: createRoute({ method: "patch", path: "/perspectives/{id}", tags: t.perspectives, summary: "Update a perspective (built-ins: favorite and rank only)", request: { params: IdParam, body: body(PerspectivePatch) }, responses: { 200: json(Perspective, "Updated"), ...E400, ...E404, ...E422 } }),
  deletePerspective: createRoute({ method: "delete", path: "/perspectives/{id}", tags: t.perspectives, summary: "Delete a custom perspective", request: { params: IdParam }, responses: { ...NO_CONTENT, ...E404, ...E422 } }),
  contents: createRoute({ method: "get", path: "/perspectives/{id}/contents", tags: t.perspectives, summary: "Evaluated outline (groups → rows) honouring view options", request: { params: IdParam, query: ContentsQuery }, responses: { 200: json(PerspectiveContents, "Contents"), ...E404 } }),
  viewOptions: createRoute({ method: "put", path: "/perspectives/{id}/view-options", tags: t.perspectives, summary: "Save view options", request: { params: IdParam, body: body(ViewOptions) }, responses: { 200: json(Perspective, "Saved"), ...E400, ...E404 } }),

  // Forecast & review
  forecast: createRoute({ method: "get", path: "/forecast", tags: t.forecast, summary: "Forecast day buckets (default: today + 6 days) and the 5-week calendar", request: { query: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), days: intParam(1, 60).optional() }) }, responses: { 200: json(Forecast, "Forecast"), ...E400 } }),
  review: createRoute({ method: "get", path: "/review", tags: t.forecast, summary: "Projects due for review", responses: { 200: json(items(Project), "Projects") } }),

  // Search
  search: createRoute({ method: "get", path: "/search", tags: t.search, summary: "Search tasks (name, note), projects, folders and tags", request: { query: z.object({ q: z.string(), availability: Availability.optional() }) }, responses: { 200: json(SearchResults, "Results"), ...E400 } }),
  quickOpen: createRoute({ method: "get", path: "/quick-open", tags: t.search, summary: "Fuzzy match perspectives, folders, projects and tags (empty query → no results)", request: { query: z.object({ q: z.string().default("") }) }, responses: { 200: json(items(QuickOpenResult), "Matches") } }),

  // Attachments
  getAttachment: createRoute({ method: "get", path: "/attachments/{id}", tags: t.attachments, summary: "Attachment metadata", request: { params: IdParam }, responses: { 200: json(Attachment, "Attachment"), ...E404 } }),
  download: createRoute({ method: "get", path: "/attachments/{id}/download", tags: t.attachments, summary: "Download (302 to a presigned URL, or streamed)", request: { params: IdParam }, responses: { 200: { description: "File bytes", content: { "application/octet-stream": { schema: z.any().openapi({ type: "string", format: "binary" }) } } }, 302: { description: "Redirect to a short-lived URL" }, ...E404 } }),
  deleteAttachment: createRoute({ method: "delete", path: "/attachments/{id}", tags: t.attachments, summary: "Delete an attachment", request: { params: IdParam }, responses: { ...NO_CONTENT, ...E404 } }),

  // Undo
  undo: createRoute({ method: "post", path: "/undo", tags: t.history, summary: "Undo the last change", responses: { 200: json(History, "History after undo"), 409: err("Nothing to undo") } }),
  redo: createRoute({ method: "post", path: "/redo", tags: t.history, summary: "Redo", responses: { 200: json(History, "History after redo"), 409: err("Nothing to redo") } }),
  history: createRoute({ method: "get", path: "/history", tags: t.history, summary: "Undo/redo availability", responses: { 200: json(History, "History") } }),

  // Settings
  getSettings: createRoute({ method: "get", path: "/settings", tags: t.settings, summary: "Settings", responses: { 200: json(Settings, "Settings") } }),
  patchSettings: createRoute({ method: "patch", path: "/settings", tags: t.settings, summary: "Update settings", request: { body: body(Settings.partial()) }, responses: { 200: json(Settings, "Settings"), ...E400, ...E404 } }),
  resetSettings: createRoute({ method: "post", path: "/settings/reset", tags: t.settings, summary: "Restore default settings", responses: { 200: json(Settings, "Settings") } }),

  // Utilities
  parse: createRoute({ method: "post", path: "/parse", tags: t.util, summary: "Parse a natural-language date or duration", request: { body: body(ParseRequest) }, responses: { 200: json(ParseResponse, "Parsed"), ...E400, 422: err("Unable to parse") } }),

  // Import
  runImport: createRoute({
    method: "post",
    path: "/import",
    tags: t.import,
    summary: "Replace all data from an .ofocus backup (multipart `file` or JSON `{url}`)",
    request: { body: { content: { "multipart/form-data": { schema: ImportUpload }, "application/json": { schema: ImportUrl } } } },
    responses: { 200: json(ImportRun, "Import run summary"), ...E400, 404: err("URL not found"), 422: err("Invalid or unsupported package"), 502: err("Download failed") },
  }),
  lastImport: createRoute({ method: "get", path: "/import/last", tags: t.import, summary: "Most recent import run", responses: { 200: json(LastImport, "Last run or null") } }),
};

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function fileBytes(value: unknown): Promise<{ name: string; bytes: Uint8Array; type: string } | null> {
  if (!(value instanceof File)) return null;
  return { name: value.name, bytes: new Uint8Array(await value.arrayBuffer()), type: value.type };
}

export function createApiRoutes({ domain, runImport }: ApiDeps): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.onError(handleError);

  // Tasks
  app.openapi(r.listTasks, (c) => c.json(domain.listTasks(c.req.valid("query")), 200));
  app.openapi(r.createTask, (c) => c.json(domain.createTask(c.req.valid("json")), 201));
  app.openapi(r.outline, (c) => {
    const { op, ids, groupId } = c.req.valid("json");
    return c.json(domain.outline(op, ids, groupId), 200);
  });
  app.openapi(r.batch, (c) => {
    const { ids, patch } = c.req.valid("json");
    return c.json(domain.batchUpdate(ids, patch), 200);
  });
  app.openapi(r.completeMany, (c) => {
    const { ids, completed } = c.req.valid("json");
    return c.json(domain.completeTasks(ids, completed), 200);
  });
  app.openapi(r.dropMany, (c) => {
    const { ids, dropped, scope } = c.req.valid("json");
    return c.json(domain.dropTasks(ids, dropped, scope), 200);
  });
  app.openapi(r.moveMany, (c) => {
    const { ids, ...move } = c.req.valid("json");
    return c.json(domain.moveTasks(ids, move), 200);
  });
  app.openapi(r.tagMany, (c) => {
    const { ids, add, remove } = c.req.valid("json");
    return c.json(domain.tagTasks(ids, { add, remove }), 200);
  });
  app.openapi(r.discardTask, async (c) => {
    await domain.discardTask(c.req.valid("param").id);
    return c.body(null, 204);
  });
  app.openapi(r.statusMany, (c) => {
    const { ids, status, scope } = c.req.valid("json");
    return c.json(domain.setTasksStatus(ids, status, scope), 200);
  });
  app.openapi(r.deleteMany, async (c) => {
    await domain.deleteMany(c.req.valid("json"));
    return c.body(null, 204);
  });
  app.openapi(r.getTask, (c) => c.json(domain.getTaskDetail(c.req.valid("param").id), 200));
  app.openapi(r.patchTask, (c) => c.json(domain.updateTask(c.req.valid("param").id, c.req.valid("json")), 200));
  app.openapi(r.deleteTask, async (c) => {
    await domain.deleteTask(c.req.valid("param").id);
    return c.body(null, 204);
  });
  app.openapi(r.completeTask, (c) => c.json(domain.completeTask(c.req.valid("param").id, c.req.valid("json").completed), 200));
  app.openapi(r.dropTask, (c) => {
    const { dropped, scope } = c.req.valid("json");
    return c.json(domain.dropTask(c.req.valid("param").id, dropped, scope), 200);
  });
  app.openapi(r.moveTask, (c) => c.json(domain.moveTask(c.req.valid("param").id, c.req.valid("json")), 200));
  app.openapi(r.addTag, (c) => c.json(domain.addTag(c.req.valid("param").id, c.req.valid("json").tagId), 200));
  app.openapi(r.removeTag, (c) => {
    const { id, tagId } = c.req.valid("param");
    return c.json(domain.removeTag(id, tagId), 200);
  });
  app.openapi(r.listAttachments, (c) => c.json({ items: domain.listAttachments(c.req.valid("param").id) }, 200));
  app.use(
    "/tasks/:id/attachments",
    bodyLimit({
      // Allow for multipart framing around a file of exactly the limit.
      maxSize: MAX_ATTACHMENT_BYTES + 64 * 1024,
      onError: (c) => errorResponse(c, 413, "payload_too_large", "Attachments are limited to 100 MB"),
    }),
  );
  app.openapi(r.uploadAttachment, async (c) => {
    const file = await fileBytes(c.req.valid("form").file);
    if (!file) throw new DomainError("validation_error", "Multipart field `file` must be a file");
    const attachment = await domain.uploadAttachment(c.req.valid("param").id, {
      name: file.name,
      bytes: file.bytes,
      contentType: file.type,
    });
    return c.json(attachment, 201);
  });
  app.openapi(r.cleanup, (c) => c.json(domain.cleanup(), 200));

  // Projects
  app.openapi(r.listProjects, (c) => c.json({ items: domain.listProjects(c.req.valid("query")) }, 200));
  app.openapi(r.createProject, (c) => c.json(domain.createProject(c.req.valid("json")), 201));
  app.openapi(r.getProject, (c) => c.json(domain.getProject(c.req.valid("param").id), 200));
  app.openapi(r.patchProject, (c) => c.json(domain.updateProject(c.req.valid("param").id, c.req.valid("json")), 200));
  app.openapi(r.deleteProject, async (c) => {
    await domain.deleteProject(c.req.valid("param").id);
    return c.body(null, 204);
  });
  app.openapi(r.reviewProject, (c) => c.json(domain.markReviewed(c.req.valid("param").id), 200));
  app.openapi(r.moveProject, (c) => c.json(domain.moveProject(c.req.valid("param").id, c.req.valid("json")), 200));
  app.openapi(r.batchProjects, (c) => {
    const { ids, patch } = c.req.valid("json");
    return c.json({ items: domain.updateProjects(ids, patch) }, 200);
  });

  // Folders
  app.openapi(r.listFolders, (c) => c.json({ items: domain.listFolders() }, 200));
  app.openapi(r.createFolder, (c) => c.json(domain.createFolder(c.req.valid("json")), 201));
  app.openapi(r.getFolder, (c) => c.json(domain.getFolder(c.req.valid("param").id), 200));
  app.openapi(r.patchFolder, (c) => c.json(domain.updateFolder(c.req.valid("param").id, c.req.valid("json")), 200));
  app.openapi(r.deleteFolder, async (c) => {
    await domain.deleteFolder(c.req.valid("param").id);
    return c.body(null, 204);
  });
  app.openapi(r.moveFolder, (c) => c.json(domain.moveFolder(c.req.valid("param").id, c.req.valid("json")), 200));

  // Tags
  app.openapi(r.listTags, (c) => c.json({ items: domain.listTags() }, 200));
  app.openapi(r.createTag, (c) => c.json(domain.createTag(c.req.valid("json")), 201));
  app.openapi(r.getTag, (c) => c.json(domain.getTag(c.req.valid("param").id), 200));
  app.openapi(r.patchTag, (c) => c.json(domain.updateTag(c.req.valid("param").id, c.req.valid("json")), 200));
  app.openapi(r.deleteTag, (c) => {
    domain.deleteTag(c.req.valid("param").id);
    return c.body(null, 204);
  });
  app.openapi(r.moveTag, (c) => c.json(domain.moveTag(c.req.valid("param").id, c.req.valid("json")), 200));

  // Perspectives
  app.openapi(r.listPerspectives, (c) => c.json({ items: domain.listPerspectives() }, 200));
  app.openapi(r.createPerspective, (c) => c.json(domain.createPerspective(c.req.valid("json")), 201));
  app.openapi(r.getPerspective, (c) => c.json(domain.getPerspective(c.req.valid("param").id), 200));
  app.openapi(r.patchPerspective, (c) => c.json(domain.updatePerspective(c.req.valid("param").id, c.req.valid("json")), 200));
  app.openapi(r.deletePerspective, (c) => {
    domain.deletePerspective(c.req.valid("param").id);
    return c.body(null, 204);
  });
  app.openapi(r.contents, (c) => c.json(domain.perspectiveContents(c.req.valid("param").id, c.req.valid("query")), 200));
  app.openapi(r.viewOptions, (c) => c.json(domain.setViewOptions(c.req.valid("param").id, c.req.valid("json")), 200));

  // Forecast & review, search
  app.openapi(r.forecast, (c) => c.json(domain.forecast(c.req.valid("query")), 200));
  app.openapi(r.review, (c) => c.json({ items: domain.reviewQueue() }, 200));
  app.openapi(r.search, (c) => {
    const { q, availability } = c.req.valid("query");
    return c.json(domain.search(q, availability), 200);
  });
  app.openapi(r.quickOpen, (c) => c.json({ items: domain.quickOpen(c.req.valid("query").q) }, 200));

  // Attachments
  app.openapi(r.getAttachment, (c) => c.json(domain.getAttachment(c.req.valid("param").id), 200));
  app.openapi(r.download, async (c) => {
    const id = c.req.valid("param").id;
    const url = await domain.attachmentDownloadUrl(id);
    if (url) return c.redirect(url, 302);
    const { attachment, bytes } = await domain.attachmentBytes(id);
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": attachment.contentType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": contentDisposition(attachment.name),
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
  });
  app.openapi(r.deleteAttachment, async (c) => {
    await domain.deleteAttachment(c.req.valid("param").id);
    return c.body(null, 204);
  });

  // Undo, settings, parse
  app.openapi(r.undo, (c) => c.json(domain.undo(), 200));
  app.openapi(r.redo, (c) => c.json(domain.redo(), 200));
  app.openapi(r.history, (c) => c.json(domain.history(), 200));
  app.openapi(r.getSettings, (c) => c.json(domain.getSettings(), 200));
  app.openapi(r.patchSettings, (c) => c.json(domain.updateSettings(c.req.valid("json")), 200));
  app.openapi(r.resetSettings, (c) => c.json(domain.resetSettings(), 200));
  app.openapi(r.parse, (c) => {
    const { kind, field, text } = c.req.valid("json");
    return c.json({ value: domain.parse(kind, text, field) }, 200);
  });

  // Import
  app.openapi(r.runImport, async (c) => {
    const type = c.req.header("content-type") ?? "";
    if (type.startsWith("application/json")) {
      const input = c.req.valid("json");
      if ("url" in input) return c.json(await runImport({ url: input.url }), 200);
    } else if (type.startsWith("multipart/form-data")) {
      const input = c.req.valid("form");
      const file = "file" in input ? await fileBytes(input.file) : null;
      if (file) return c.json(await runImport({ zip: file.bytes, name: file.name }), 200);
    }
    throw new DomainError("validation_error", "Send a multipart `file` (.zip of a .ofocus package) or JSON `{url}`");
  });
  app.openapi(r.lastImport, (c) => c.json({ run: domain.lastImportRun() }, 200));

  return app;
}
