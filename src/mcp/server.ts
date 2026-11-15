// MCP tool server (docs/spec.md §10). Tools mirror the REST API and call domain services directly.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isTextual } from "../domain/attachments.js";
import { DomainError, type Domain } from "../domain/index.js";
import {
  Availability,
  FolderCreate,
  FolderPatch,
  Position,
  ProjectCreate,
  ProjectPatch,
  ProjectStatus,
  TagCreate,
  TagPatch,
  TaskCreate,
  TaskPatch,
  TaskStatus,
} from "../shared/schemas.js";
import type { BlobStore } from "../storage/types.js";

export interface McpDeps {
  domain: Domain;
  blobStore: BlobStore;
}

const SERVER_VERSION = "0.1.0";
const MAX_TEXT_BYTES = 1024 * 1024;

const id = z.string().min(1);
const dateHelp = "ISO date-time (fixed …Z, floating, or with offset) or natural language such as 'tomorrow 5pm'";

/** Wraps a domain call: structured JSON plus a one-line summary; domain errors become tool errors. */
async function run<T extends object>(fn: () => T | Promise<T>, summary: (value: T) => string): Promise<CallToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: summary(value) }], structuredContent: value as Record<string, unknown> };
  } catch (e) {
    if (e instanceof DomainError) {
      return { isError: true, content: [{ type: "text", text: `${e.code}: ${e.message}` }] };
    }
    throw e;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function createMcpServer({ domain }: McpDeps): McpServer {
  const server = new McpServer({ name: "prana-bindu", version: SERVER_VERSION });
  const tool = server.registerTool.bind(server);

  // --- Tasks ------------------------------------------------------------------
  tool(
    "list_tasks",
    {
      description:
        "List tasks in outline order. Filters: perspective id, inbox, projectId, tagId, folderId, flagged, status, availability (next|available|remaining|all, default remaining), q (name/note), dueBefore/dueAfter (dates), limit, cursor.",
      inputSchema: {
        perspective: z.string().optional(),
        inbox: z.boolean().optional(),
        projectId: z.string().optional(),
        tagId: z.string().optional(),
        folderId: z.string().optional(),
        flagged: z.boolean().optional(),
        status: TaskStatus.optional(),
        availability: Availability.optional(),
        q: z.string().optional(),
        dueBefore: z.string().optional().describe(dateHelp),
        dueAfter: z.string().optional().describe(dateHelp),
        limit: z.number().int().min(1).max(5000).optional(),
        cursor: z.string().optional(),
      },
    },
    (args) => run(() => domain.listTasks(args), (r) => `${plural(r.items.length, "task")}${r.nextCursor ? ` (more: cursor ${r.nextCursor})` : ""}`),
  );
  tool(
    "get_task",
    { description: "Get a task with derived state, children, alarms and attachments.", inputSchema: { id } },
    ({ id }) => run(() => domain.getTaskDetail(id), (t) => `${t.name} [${t.status}]`),
  );
  tool(
    "create_task",
    {
      description: `Create a task. Without parentId/projectId it goes to the inbox (or next to a position anchor). Dates: ${dateHelp}.`,
      inputSchema: TaskCreate.shape,
    },
    (args) => run(() => domain.createTask(args), (t) => `Created task "${t.name}" (${t.id})`),
  );
  tool(
    "update_task",
    { description: `Update task fields. Dates: ${dateHelp}; null clears.`, inputSchema: { id, ...TaskPatch.shape } },
    ({ id, ...patch }) => run(() => domain.updateTask(id, patch), (t) => `Updated "${t.name}"`),
  );
  tool(
    "complete_task",
    {
      description: "Complete (or with completed=false, un-complete) a task. Repeating tasks create a completed clone and advance.",
      inputSchema: { id, completed: z.boolean().default(true) },
    },
    ({ id, completed }) => run(() => domain.completeTask(id, completed), (r) => `${plural(r.changed.length, "task")} changed`),
  );
  tool(
    "drop_task",
    {
      description: "Drop (or with dropped=false, reactivate) a task. For repeating tasks scope 'occurrence' skips one occurrence; 'series' drops it completely.",
      inputSchema: { id, dropped: z.boolean().default(true), scope: z.enum(["occurrence", "series"]).optional() },
    },
    ({ id, dropped, scope }) => run(() => domain.dropTask(id, dropped, scope), (r) => `${plural(r.changed.length, "task")} changed`),
  );
  tool(
    "delete_task",
    { description: "Delete a task and all its descendants.", inputSchema: { id } },
    ({ id }) =>
      run(
        async () => {
          await domain.deleteTask(id);
          return { deleted: id };
        },
        () => `Deleted ${id}`,
      ),
  );
  tool(
    "move_task",
    {
      description: "Move a task under a parent task (parentId), into a project (projectId) or the inbox (inbox=true), at a position ('start', 'end', {before:id}, {after:id}).",
      inputSchema: { id, parentId: z.string().optional(), projectId: z.string().optional(), inbox: z.boolean().optional(), position: Position.optional() },
    },
    ({ id, ...move }) => run(() => domain.moveTask(id, move), (r) => `${plural(r.changed.length, "task")} moved`),
  );
  tool(
    "add_tag_to_task",
    { description: "Add a tag to a task (mutually exclusive sibling tags are removed).", inputSchema: { taskId: id, tagId: id } },
    ({ taskId, tagId }) => run(() => domain.addTag(taskId, tagId), (t) => `Tags of "${t.name}": ${t.tagIds.length}`),
  );
  tool(
    "remove_tag_from_task",
    { description: "Remove a tag from a task.", inputSchema: { taskId: id, tagId: id } },
    ({ taskId, tagId }) => run(() => domain.removeTag(taskId, tagId), (t) => `Tags of "${t.name}": ${t.tagIds.length}`),
  );

  // --- Projects ---------------------------------------------------------------
  tool(
    "list_projects",
    { description: "List projects in sidebar order, optionally by status or folder.", inputSchema: { status: ProjectStatus.optional(), folderId: z.string().optional() } },
    (args) => run(() => ({ items: domain.listProjects(args) }), (r) => plural(r.items.length, "project")),
  );
  tool(
    "get_project",
    { description: "Get a project with its remaining and completed actions (outline order).", inputSchema: { id } },
    ({ id }) =>
      run(
        () => ({ project: domain.getProject(id), tasks: domain.listTasks({ projectId: id, availability: "all", limit: 5000 }).items }),
        (r) => `${r.project.task.name} [${r.project.status}], ${plural(r.tasks.length, "action")}`,
      ),
  );
  tool(
    "create_project",
    { description: `Create a project (type parallel|sequential|singleActions, optional folderId). Dates: ${dateHelp}.`, inputSchema: ProjectCreate.shape },
    (args) => run(() => domain.createProject(args), (p) => `Created project "${p.task.name}" (${p.id})`),
  );
  tool(
    "update_project",
    { description: "Update a project: task fields, status, type, folderId, reviewInterval, nextReview.", inputSchema: { id, ...ProjectPatch.shape } },
    ({ id, ...patch }) => run(() => domain.updateProject(id, patch), (p) => `Updated project "${p.task.name}"`),
  );
  tool(
    "delete_project",
    { description: "Delete a project and all its actions.", inputSchema: { id } },
    ({ id }) =>
      run(
        async () => {
          await domain.deleteProject(id);
          return { deleted: id };
        },
        () => `Deleted project ${id}`,
      ),
  );
  tool(
    "mark_project_reviewed",
    { description: "Mark a project reviewed (sets lastReview to now and schedules the next review).", inputSchema: { id } },
    ({ id }) => run(() => domain.markReviewed(id), (p) => `Reviewed "${p.task.name}"; next review ${p.nextReview}`),
  );

  // --- Folders ----------------------------------------------------------------
  tool(
    "list_folders",
    { description: "List folders in tree order (nest by parentId).", inputSchema: {} },
    () => run(() => ({ items: domain.listFolders() }), (r) => plural(r.items.length, "folder")),
  );
  tool(
    "create_folder",
    { description: "Create a folder.", inputSchema: FolderCreate.shape },
    (args) => run(() => domain.createFolder(args), (f) => `Created folder "${f.name}" (${f.id})`),
  );
  tool(
    "update_folder",
    {
      description: "Update a folder (name, note, status). Pass parentId (null = top level) with optional position to move it.",
      inputSchema: { id, ...FolderPatch.shape, parentId: z.string().nullable().optional(), position: Position.optional() },
    },
    ({ id, parentId, position, ...patch }) =>
      run(
        () => domain.updateFolder(id, patch, parentId === undefined ? undefined : { parentId, position }),
        (f) => `Updated folder "${f.name}"`,
      ),
  );
  tool(
    "delete_folder",
    { description: "Delete a folder, its subfolders and contained projects.", inputSchema: { id } },
    ({ id }) =>
      run(
        async () => {
          await domain.deleteFolder(id);
          return { deleted: id };
        },
        () => `Deleted folder ${id}`,
      ),
  );

  // --- Tags -------------------------------------------------------------------
  tool(
    "list_tags",
    { description: "List tags in tree order with remaining/available counts.", inputSchema: {} },
    () => run(() => ({ items: domain.listTags() }), (r) => plural(r.items.length, "tag")),
  );
  tool(
    "create_tag",
    { description: "Create a tag.", inputSchema: TagCreate.shape },
    (args) => run(() => domain.createTag(args), (t) => `Created tag "${t.name}" (${t.id})`),
  );
  tool(
    "update_tag",
    {
      description: "Update a tag (name, note, status, childrenMutuallyExclusive). Pass parentId (null = top level) with optional position to move it.",
      inputSchema: { id, ...TagPatch.shape, parentId: z.string().nullable().optional(), position: Position.optional() },
    },
    ({ id, parentId, position, ...patch }) =>
      run(
        () => domain.updateTag(id, patch, parentId === undefined ? undefined : { parentId, position }),
        (t) => `Updated tag "${t.name}"`,
      ),
  );
  tool(
    "delete_tag",
    { description: "Delete a tag and its child tags (tasks keep their other tags).", inputSchema: { id } },
    ({ id }) =>
      run(
        () => {
          domain.deleteTag(id);
          return { deleted: id };
        },
        () => `Deleted tag ${id}`,
      ),
  );

  // --- Perspectives, forecast, review, search ----------------------------------
  tool(
    "list_perspectives",
    { description: "List built-in and custom perspectives.", inputSchema: {} },
    () => run(() => ({ items: domain.listPerspectives() }), (r) => r.items.map((p) => `${p.name} (${p.id})`).join(", ")),
  );
  tool(
    "get_perspective_contents",
    {
      description:
        "Evaluate a perspective: inbox|projects|tags|forecast|flagged|review|completed|changed|search or a custom perspective id. Optional sidebar selection (project, folder, tag or 'untagged'), forecast day (PAST|TODAY|FUTURE|YYYY-MM-DD) and search q.",
      inputSchema: {
        perspective: id,
        project: z.string().optional(),
        folder: z.string().optional(),
        tag: z.string().optional(),
        day: z.string().optional(),
        q: z.string().optional(),
      },
    },
    ({ perspective, ...params }) =>
      run(
        () => domain.perspectiveContents(perspective, params),
        (c) => `${plural(c.groups.length, "group")}, ${plural(c.groups.reduce((n, g) => n + g.rows.length, 0), "row")}${c.emptyText ? ` (${c.emptyText})` : ""}`,
      ),
  );
  tool(
    "get_forecast",
    {
      description: "Forecast: Past, Today and following days (default 7 days from today), Future, plus a 5-week calendar of counts.",
      inputSchema: { from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), days: z.number().int().min(1).max(60).optional() },
    },
    (args) => run(() => domain.forecast(args), (f) => f.days.map((d) => `${d.title}: ${d.count}`).join("; ")),
  );
  tool(
    "get_review_queue",
    { description: "Projects due for review (active or on hold, next review on or before today).", inputSchema: {} },
    () => run(() => ({ items: domain.reviewQueue() }), (r) => `${plural(r.items.length, "project")} to review`),
  );
  tool(
    "search",
    {
      description: "Case-insensitive search over task names and notes, and project, folder and tag names.",
      inputSchema: { q: z.string().min(1), availability: Availability.optional() },
    },
    ({ q, availability }) =>
      run(
        () => domain.search(q, availability),
        (r) => `${plural(r.tasks.length, "task")}, ${plural(r.projects.length, "project")}, ${plural(r.folders.length, "folder")}, ${plural(r.tags.length, "tag")}`,
      ),
  );

  // --- Attachments -------------------------------------------------------------
  tool(
    "list_attachments",
    { description: "List a task's attachments (metadata).", inputSchema: { taskId: id } },
    ({ taskId }) => run(() => ({ items: domain.listAttachments(taskId) }), (r) => plural(r.items.length, "attachment")),
  );
  tool(
    "get_attachment",
    {
      description: "Attachment metadata; text content is included when the type is text/* or JSON and the file is at most 1 MB.",
      inputSchema: { id },
    },
    ({ id }) =>
      run(
        async () => {
          const attachment = domain.getAttachment(id);
          if (!isTextual(attachment.contentType) || attachment.size > MAX_TEXT_BYTES) return { attachment, content: null };
          const { bytes } = await domain.attachmentBytes(id);
          return { attachment, content: new TextDecoder().decode(bytes) };
        },
        (r) => (r.content === null ? `${r.attachment.name} (${r.attachment.contentType}, ${r.attachment.size} bytes)` : r.content),
      ),
  );

  // --- Undo / parse --------------------------------------------------------------
  tool(
    "undo",
    { description: "Undo the most recent change (from any client).", inputSchema: {} },
    () => run(() => domain.undo(), (h) => `Undone. Undo: ${h.undoLabel ?? "—"}, redo: ${h.redoLabel ?? "—"}`),
  );
  tool(
    "redo",
    { description: "Redo the most recently undone change.", inputSchema: {} },
    () => run(() => domain.redo(), (h) => `Redone. Undo: ${h.undoLabel ?? "—"}, redo: ${h.redoLabel ?? "—"}`),
  );
  tool(
    "parse_date",
    {
      description: "Parse a natural-language date (e.g. 'next fri 3pm', '+2w') in the user's time zone; the field picks the default time.",
      inputSchema: { text: z.string().min(1), field: z.enum(["defer", "due", "planned"]).optional() },
    },
    ({ text, field }) => run(() => ({ value: domain.parse("date", text, field) }), (r) => String(r.value)),
  );

  return server;
}
