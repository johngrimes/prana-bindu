// API contract shared by server (REST + MCP) and web client. Plain zod (v4); no server-only imports.
// Semantics: docs/spec.md. Field names are camelCase.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const Id = z.string().min(1);

/** Optional client-chosen id for a new entity, in the alphabet the server's own ids use. */
export const ClientId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "8–64 characters from [A-Za-z0-9_-]")
  .describe("Client-chosen id for the new entity: 8–64 characters from [A-Za-z0-9_-]. Must not already exist (409 conflict). Omit to let the server assign one.");

/** Fixed `...Z` instant or floating `YYYY-MM-DDTHH:mm:ss(.sss)` wall time (docs/spec.md §1.1). */
export const DateValue = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z)?$/, "fixed (…Z) or floating ISO date-time");
export type DateValue = z.infer<typeof DateValue>;

/** Input dates may additionally use an explicit offset or natural language (server normalises). */
export const DateInput = z.string().min(1);

export const Timestamp = z.string(); // fixed UTC ISO

export const TaskStatus = z.enum(["completed", "dropped", "overdue", "dueSoon", "blocked", "next", "available"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Availability = z.enum(["next", "available", "remaining", "all"]);
export type Availability = z.infer<typeof Availability>;

export const ProjectType = z.enum(["parallel", "sequential", "singleActions"]);
export const ProjectStatus = z.enum(["active", "onHold", "completed", "dropped"]);
export const FolderStatus = z.enum(["active", "dropped"]);
export const TagStatus = z.enum(["active", "onHold", "dropped"]);
export const IntervalUnit = z.enum(["day", "week", "month", "year"]);

export const RepeatRule = z.object({
  rule: z.string().min(1), // RRULE body, e.g. "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"
  scheduleType: z.enum(["regularly", "fromCompletion"]),
  anchorDate: z.enum(["due", "defer", "planned"]),
  catchUpAutomatically: z.boolean(),
});
export type RepeatRule = z.infer<typeof RepeatRule>;

export const ReviewInterval = z.object({ steps: z.number().int().min(1), unit: IntervalUnit });

export const Position = z.union([
  z.literal("start"),
  z.literal("end"),
  z.object({ before: Id }),
  z.object({ after: Id }),
]);
export type Position = z.infer<typeof Position>;

// ---------------------------------------------------------------------------
// Entities (responses)
// ---------------------------------------------------------------------------

export const Task = z.object({
  id: Id,
  name: z.string(),
  note: z.string(),
  parentId: Id.nullable(),
  projectId: Id.nullable(),
  /** True when this task is a project's root task (then `project` is set). */
  isProject: z.boolean(),
  inInbox: z.boolean(),
  rank: z.number().int(),
  flagged: z.boolean(),
  deferDate: DateValue.nullable(),
  plannedDate: DateValue.nullable(),
  dueDate: DateValue.nullable(),
  estimatedMinutes: z.number().int().nullable(),
  completed: Timestamp.nullable(),
  dropped: Timestamp.nullable(),
  added: Timestamp,
  modified: Timestamp,
  sequential: z.boolean(),
  completedByChildren: z.boolean(),
  repeat: RepeatRule.nullable(),
  assignedProjectId: Id.nullable(),
  tagIds: z.array(Id),
  attachmentCount: z.number().int(),
  childCount: z.number().int(),
  remainingChildCount: z.number().int(),
  // Derived (docs/spec.md §1.3)
  effectiveFlagged: z.boolean(),
  effectiveDeferDate: DateValue.nullable(),
  effectivePlannedDate: DateValue.nullable(),
  effectiveDueDate: DateValue.nullable(),
  effectiveCompleted: z.boolean(),
  effectiveDropped: z.boolean(),
  remaining: z.boolean(),
  deferred: z.boolean(),
  blocked: z.boolean(),
  available: z.boolean(),
  firstAvailable: z.boolean(),
  overdue: z.boolean(),
  dueSoon: z.boolean(),
  status: TaskStatus,
  /** Ancestor names for display: project name and containing folder path. */
  projectName: z.string().nullable(),
});
export type Task = z.infer<typeof Task>;

export const Project = z.object({
  id: Id, // == root task id
  task: Task,
  folderId: Id.nullable(),
  type: ProjectType,
  status: ProjectStatus,
  effectiveStatus: ProjectStatus,
  reviewInterval: ReviewInterval,
  lastReview: Timestamp,
  nextReview: DateValue.nullable(),
  stalled: z.boolean(),
  pending: z.boolean(),
  remainingCount: z.number().int(),
  availableCount: z.number().int(),
  dueSoonCount: z.number().int(),
  overdueCount: z.number().int(),
});
export type Project = z.infer<typeof Project>;

export const Folder = z.object({
  id: Id,
  name: z.string(),
  note: z.string(),
  parentId: Id.nullable(),
  rank: z.number().int(),
  status: FolderStatus,
  effectiveActive: z.boolean(),
  added: Timestamp,
  modified: Timestamp,
});
export type Folder = z.infer<typeof Folder>;

export const Tag = z.object({
  id: Id,
  name: z.string(),
  note: z.string(),
  parentId: Id.nullable(),
  rank: z.number().int(),
  status: TagStatus,
  effectiveStatus: TagStatus,
  childrenMutuallyExclusive: z.boolean(),
  added: Timestamp,
  modified: Timestamp,
  remainingCount: z.number().int(),
  availableCount: z.number().int(),
});
export type Tag = z.infer<typeof Tag>;

export const Alarm = z.object({
  id: Id,
  taskId: Id,
  kind: z.enum(["absolute", "dueRelative", "deferRelative", "plannedRelative"]),
  fireDate: DateValue.nullable(),
  offsetSeconds: z.number().int().nullable(),
  /** Computed fire time (resolved against the anchor date), or null when the anchor is unset. */
  effectiveFireDate: DateValue.nullable(),
});
export type Alarm = z.infer<typeof Alarm>;

export const Attachment = z.object({
  id: Id,
  taskId: Id,
  name: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  added: Timestamp,
});
export type Attachment = z.infer<typeof Attachment>;

/** Task detail adds children, alarms, attachments. */
export const TaskDetail = Task.extend({
  children: z.array(Task),
  alarms: z.array(Alarm),
  attachments: z.array(Attachment),
  project: Project.omit({ task: true }).nullable(),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

// ---------------------------------------------------------------------------
// Perspectives
// ---------------------------------------------------------------------------

export const BUILTIN_PERSPECTIVES = [
  "inbox",
  "projects",
  "tags",
  "forecast",
  "flagged",
  "review",
  "completed",
  "changed",
  "search",
] as const;
export const BuiltinPerspectiveId = z.enum(BUILTIN_PERSPECTIVES);

export const Grouping = z.enum([
  "none",
  "tag",
  "tagsCombined",
  "project",
  "folder",
  "due",
  "defer",
  "planned",
  "completed",
  "dropped",
  "added",
  "changed",
  "flagged",
]);
export const Sorting = z.enum([
  "manual",
  "due",
  "defer",
  "planned",
  "completed",
  "added",
  "changed",
  "flagged",
  "duration",
  "name",
]);

/** Perspective rule JSON (docs/spec.md §4.1). Kept loose so unknown imported rules round-trip. */
export const PerspectiveRule: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());

export const PerspectivePresentation = z.object({
  layout: z.enum(["projects", "flat"]).default("projects"),
  grouping: Grouping.default("none"),
  sorting: Sorting.default("manual"),
  sidebar: z.enum(["projects", "tags", "none"]).default("projects"),
});

export const ViewOptions = z.object({
  filter: Availability.optional(),
  grouping: Grouping.optional(),
  sortByDueAndFlagged: z.boolean().optional(), // Tags
  showInbox: z.boolean().optional(), // Projects
  showFolders: z.boolean().optional(), // Projects
  forecast: z
    .object({
      includePlanned: z.boolean(),
      includeDefer: z.boolean(),
      includeNotification: z.boolean(),
      includeOnHold: z.boolean(),
      todayIncludesFlagged: z.boolean(),
      todayIncludesTag: z.boolean(),
      organized: z.boolean(),
      preserveHierarchy: z.boolean(),
      keepSorted: z.boolean(),
    })
    .partial()
    .optional(),
});
export type ViewOptions = z.infer<typeof ViewOptions>;

export const Perspective = z.object({
  id: Id,
  builtin: z.boolean(),
  name: z.string(),
  icon: z.string(),
  color: z.string().nullable(),
  favorite: z.boolean(),
  rank: z.number().int(),
  aggregation: z.enum(["all", "any", "none"]),
  rules: z.array(PerspectiveRule),
  presentation: PerspectivePresentation,
  viewOptions: ViewOptions,
});
export type Perspective = z.infer<typeof Perspective>;

/** Evaluated perspective content: ordered groups of rows. A row is a task (with depth for hierarchy) or a project/folder/tag header. */
export const OutlineRow = z.object({
  kind: z.enum(["task", "project", "folder", "tag"]),
  id: Id,
  depth: z.number().int(),
  task: Task.optional(),
  project: Project.optional(),
  folder: Folder.optional(),
  tag: Tag.optional(),
});
export type OutlineRow = z.infer<typeof OutlineRow>;

export const OutlineGroup = z.object({
  key: z.string(), // stable group key (e.g. tag id, "untagged", "PAST", "2026-11-02", "bucket:today")
  title: z.string(),
  kind: z.enum(["none", "project", "folder", "tag", "date", "flagged", "kind"]),
  rows: z.array(OutlineRow),
});
export type OutlineGroup = z.infer<typeof OutlineGroup>;

export const PerspectiveContents = z.object({
  perspectiveId: Id,
  viewOptions: ViewOptions,
  groups: z.array(OutlineGroup),
  emptyText: z.string().nullable(),
});
export type PerspectiveContents = z.infer<typeof PerspectiveContents>;

export const ForecastDay = z.object({
  key: z.string(), // "PAST" | "TODAY" | "YYYY-MM-DD" | "FUTURE"
  date: z.string().nullable(), // YYYY-MM-DD for real days
  title: z.string(),
  dueCount: z.number().int(),
  count: z.number().int(),
  deferredCount: z.number().int(),
  badge: z.enum(["overdue", "dueSoon"]).nullable(),
  rows: z.array(OutlineRow),
});
export const Forecast = z.object({
  today: z.string(), // YYYY-MM-DD in user tz
  days: z.array(ForecastDay),
  calendar: z.array(z.object({ date: z.string(), dueCount: z.number().int(), count: z.number().int() })),
});
export type Forecast = z.infer<typeof Forecast>;

// ---------------------------------------------------------------------------
// Settings, search, history, import
// ---------------------------------------------------------------------------

export const Settings = z.object({
  timeZone: z.string(),
  dateFormat: z.enum(["MM/dd/yyyy", "dd/MM/yyyy", "yyyy/MM/dd", "yyyy-MM-dd"]),
  firstWeekday: z.number().int().min(1).max(7),
  use24HourTime: z.boolean(),
  defaultDeferTime: z.string().regex(/^\d{2}:\d{2}$/),
  defaultDueTime: z.string().regex(/^\d{2}:\d{2}$/),
  defaultPlannedTime: z.string().regex(/^\d{2}:\d{2}$/),
  dueSoonSeconds: z.number().int().min(0),
  theme: z.enum(["system", "light", "dark"]),
  forecastTagId: Id.nullable(),
});
export type Settings = z.infer<typeof Settings>;

export const SearchResults = z.object({
  query: z.string(),
  tasks: z.array(Task),
  projects: z.array(Project),
  folders: z.array(Folder),
  tags: z.array(Tag),
});
export type SearchResults = z.infer<typeof SearchResults>;

export const QuickOpenResult = z.object({
  type: z.enum(["perspective", "folder", "project", "tag"]),
  id: Id,
  name: z.string(),
  score: z.number(),
  /** Character index ranges in `name` that matched. */
  matches: z.array(z.tuple([z.number().int(), z.number().int()])),
});
export type QuickOpenResult = z.infer<typeof QuickOpenResult>;

export const History = z.object({
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  undoLabel: z.string().nullable(),
  redoLabel: z.string().nullable(),
  /** The step Undo would revert and the one Redo would reapply (ids as in `X-Undo-Step`). */
  undoId: z.number().int().nullable(),
  redoId: z.number().int().nullable(),
});
export type History = z.infer<typeof History>;

export const ImportRun = z.object({
  id: z.number().int(),
  importedAt: Timestamp,
  source: z.string(),
  appId: z.string().nullable(),
  appVersion: z.string().nullable(),
  counts: z.record(z.string(), z.number().int()),
  warnings: z.array(z.string()),
});
export type ImportRun = z.infer<typeof ImportRun>;

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const TaskCreate = z.object({
  id: ClientId.optional(),
  name: z.string(),
  note: z.string().optional(),
  parentId: Id.optional(),
  projectId: Id.optional(),
  inbox: z.boolean().optional(),
  position: Position.optional(),
  flagged: z.boolean().optional(),
  deferDate: DateInput.nullable().optional(),
  plannedDate: DateInput.nullable().optional(),
  dueDate: DateInput.nullable().optional(),
  estimatedMinutes: z.number().int().min(0).nullable().optional(),
  tagIds: z.array(Id).optional(),
  repeat: RepeatRule.nullable().optional(),
  sequential: z.boolean().optional(),
  completedByChildren: z.boolean().optional(),
});
export type TaskCreate = z.infer<typeof TaskCreate>;

export const TaskPatch = z
  .object({
    name: z.string(),
    note: z.string(),
    flagged: z.boolean(),
    deferDate: DateInput.nullable(),
    plannedDate: DateInput.nullable(),
    dueDate: DateInput.nullable(),
    estimatedMinutes: z.number().int().min(0).nullable(),
    repeat: RepeatRule.nullable(),
    sequential: z.boolean(),
    completedByChildren: z.boolean(),
    assignedProjectId: Id.nullable(),
    tagIds: z.array(Id),
  })
  .partial();
export type TaskPatch = z.infer<typeof TaskPatch>;

export const TaskMove = z.object({
  parentId: Id.optional(),
  projectId: Id.optional(),
  inbox: z.boolean().optional(),
  position: Position.default("end"),
});
export type TaskMove = z.infer<typeof TaskMove>;

export const OutlineOp = z.object({
  op: z.enum(["indent", "outdent", "group", "ungroup", "moveUp", "moveDown"]),
  ids: z.array(Id).min(1),
  groupId: ClientId.optional().describe("`group` only: id for the new group task (8–64 characters from [A-Za-z0-9_-]; 409 if it exists). Ignored by other ops."),
});

export const ProjectCreate = TaskCreate.omit({ parentId: true, projectId: true, inbox: true, sequential: true }).extend({
  type: ProjectType.default("parallel"),
  folderId: Id.nullable().optional(),
  status: ProjectStatus.optional(),
  reviewInterval: ReviewInterval.optional(),
});
export type ProjectCreate = z.infer<typeof ProjectCreate>;

export const ProjectPatch = TaskPatch.omit({ sequential: true, assignedProjectId: true })
  .extend({
    type: ProjectType,
    status: ProjectStatus,
    folderId: Id.nullable(),
    reviewInterval: ReviewInterval,
    nextReview: DateInput.nullable(),
  })
  .partial();
export type ProjectPatch = z.infer<typeof ProjectPatch>;

export const FolderCreate = z.object({
  id: ClientId.optional(),
  name: z.string(),
  note: z.string().optional(),
  parentId: Id.nullable().optional(),
  position: Position.optional(),
});
export const FolderPatch = z.object({ name: z.string(), note: z.string(), status: FolderStatus }).partial();
export const TagCreate = z.object({
  id: ClientId.optional(),
  name: z.string(),
  note: z.string().optional(),
  parentId: Id.nullable().optional(),
  position: Position.optional(),
  status: TagStatus.optional(),
  childrenMutuallyExclusive: z.boolean().optional(),
});
export const TagPatch = z
  .object({ name: z.string(), note: z.string(), status: TagStatus, childrenMutuallyExclusive: z.boolean() })
  .partial();
export const ContainerMove = z.object({ parentId: Id.nullable(), position: Position.default("end") });

export const PerspectiveCreate = z.object({
  id: ClientId.optional(),
  name: z.string().min(1),
  icon: z.string().optional(),
  color: z.string().nullable().optional(),
  favorite: z.boolean().optional(),
  aggregation: z.enum(["all", "any", "none"]).optional(),
  rules: z.array(PerspectiveRule).optional(),
  presentation: PerspectivePresentation.partial().optional(),
});
export const PerspectivePatch = PerspectiveCreate.omit({ id: true }).partial().extend({ rank: z.number().int().optional() });

export const ParseRequest = z.object({
  kind: z.enum(["date", "duration"]),
  field: z.enum(["defer", "due", "planned"]).optional(),
  text: z.string(),
});
export const ParseResponse = z.object({ value: z.union([DateValue, z.number().int()]) });

/** Response for multi-entity mutations. */
export const Changed = z.object({ changed: z.array(Task) });
export type Changed = z.infer<typeof Changed>;

/** `GET /tasks` page; pass `nextCursor` back as `cursor` for the next page. */
export const TaskPage = z.object({ items: z.array(Task), nextCursor: z.string().nullable() });
export type TaskPage = z.infer<typeof TaskPage>;

/** `GET /import/last`. */
export const LastImport = z.object({ run: ImportRun.nullable() });

// ---------------------------------------------------------------------------
// Auth (docs/plan.md §Auth, docs/spec.md §9 Auth row)
// ---------------------------------------------------------------------------

export const AuthSession = z.object({ authenticated: z.literal(true), via: z.enum(["session", "token"]) });
export type AuthSession = z.infer<typeof AuthSession>;

export const AuthPasskey = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  deviceType: z.string().nullable(),
  backedUp: z.boolean(),
});
export type AuthPasskey = z.infer<typeof AuthPasskey>;

export const ApiTokenInfo = z.object({
  id: z.string(),
  name: z.string(),
  /** Leading characters of the plaintext token for display, e.g. `pb_AbC123`. */
  prefix: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export type ApiTokenInfo = z.infer<typeof ApiTokenInfo>;

/** Returned once on creation; `plaintext` is never retrievable again. */
export const ApiTokenCreated = z.object({ token: ApiTokenInfo, plaintext: z.string() });
export type ApiTokenCreated = z.infer<typeof ApiTokenCreated>;

/** A pending OAuth authorization request, as shown on the consent page. `clientName` is chosen by the client. */
export const OAuthAuthorizationRequestInfo = z.object({
  id: z.string(),
  clientName: z.string(),
  /** Host of the redirect URI the browser returns to after the decision. */
  redirectHost: z.string(),
  expiresAt: Timestamp,
});
export type OAuthAuthorizationRequestInfo = z.infer<typeof OAuthAuthorizationRequestInfo>;

/** Where the browser goes after an OAuth consent decision (the client's redirect URI with `code` or `error`). */
export const OAuthRedirect = z.object({ redirectTo: z.string() });

/** An OAuth client the user approved to use the MCP server. */
export const ConnectedApp = z.object({
  id: z.string(),
  clientName: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export type ConnectedApp = z.infer<typeof ConnectedApp>;

/** WebAuthn `RegistrationResponseJSON` / `AuthenticationResponseJSON` from @simplewebauthn/browser (validated structurally). */
export const WebAuthnCredentialResponse = z.looseObject({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal("public-key"),
  response: z.looseObject({ clientDataJSON: z.string().min(1) }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
});

export const EnrollOptionsRequest = z.object({ token: z.string().optional() });
export const EnrollVerifyRequest = z.object({
  token: z.string().optional(),
  name: z.string().trim().min(1).max(100),
  response: WebAuthnCredentialResponse,
});
export const PasskeyRename = z.object({ name: z.string().trim().min(1).max(100) });
export const ApiTokenCreate = z.object({ name: z.string().trim().min(1).max(100) });
