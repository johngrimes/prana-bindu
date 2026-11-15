// Database schema (SQLite via better-sqlite3 + drizzle). Shared contract for domain, importer and auth.
// Dates: user-facing dates are TEXT in fixed (`...Z`) or floating (no offset) form — see docs/spec.md §1.1.
// Bookkeeping timestamps are fixed UTC ISO strings.
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

const bool = (name: string) => integer(name, { mode: "boolean" });

// ---------------------------------------------------------------------------
// Domain tables (replaced wholesale by the importer; journaled for undo/redo)
// ---------------------------------------------------------------------------

export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    note: text("note").notNull().default(""),
    rank: integer("rank").notNull(),
    status: text("status", { enum: ["active", "dropped"] }).notNull().default("active"),
    added: text("added").notNull(),
    modified: text("modified").notNull(),
  },
  (t) => [index("folders_parent").on(t.parentId)],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    note: text("note").notNull().default(""),
    rank: integer("rank").notNull(),
    status: text("status", { enum: ["active", "onHold", "dropped"] }).notNull().default("active"),
    childrenMutuallyExclusive: bool("children_mutually_exclusive").notNull().default(false),
    added: text("added").notNull(),
    modified: text("modified").notNull(),
  },
  (t) => [index("tags_parent").on(t.parentId)],
);

/** Actions, action groups and project root tasks. */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    parentId: text("parent_id"),
    inInbox: bool("in_inbox").notNull().default(false),
    rank: integer("rank").notNull(),
    name: text("name").notNull(),
    note: text("note").notNull().default(""),
    flagged: bool("flagged").notNull().default(false),
    deferDate: text("defer_date"),
    plannedDate: text("planned_date"),
    dueDate: text("due_date"),
    estimatedMinutes: integer("estimated_minutes"),
    completed: text("completed"),
    dropped: text("dropped"),
    added: text("added").notNull(),
    modified: text("modified").notNull(),
    /** Child ordering for non-project tasks (projects use projects.type). */
    sequential: bool("sequential").notNull().default(false),
    completedByChildren: bool("completed_by_children").notNull().default(false),
    /** RFC 5545 RRULE body without "RRULE:"; null = not repeating. */
    repeatRule: text("repeat_rule"),
    repeatScheduleType: text("repeat_schedule_type", { enum: ["regularly", "fromCompletion"] }),
    repeatAnchor: text("repeat_anchor", { enum: ["due", "defer", "planned"] }),
    repeatCatchUp: bool("repeat_catch_up").notNull().default(false),
    /** Next suffix for repeat clones `<id>.<n>`. */
    nextCloneId: integer("next_clone_id").notNull().default(0),
    /** Inbox item's chosen project, applied on Clean Up. */
    assignedProjectId: text("assigned_project_id"),
  },
  (t) => [
    index("tasks_parent").on(t.parentId),
    index("tasks_inbox").on(t.inInbox),
    index("tasks_due").on(t.dueDate),
    index("tasks_completed").on(t.completed),
    index("tasks_modified").on(t.modified),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    taskId: text("task_id").primaryKey(),
    folderId: text("folder_id"),
    type: text("type", { enum: ["parallel", "sequential", "singleActions"] }).notNull().default("parallel"),
    status: text("status", { enum: ["active", "onHold", "completed", "dropped"] }).notNull().default("active"),
    reviewIntervalSteps: integer("review_interval_steps").notNull().default(1),
    reviewIntervalUnit: text("review_interval_unit", { enum: ["day", "week", "month", "year"] })
      .notNull()
      .default("week"),
    /** Original OmniFocus interval string (e.g. "@1w", "~2d") kept for fidelity; null when set in prana-bindu. */
    reviewIntervalRaw: text("review_interval_raw"),
    lastReview: text("last_review").notNull(),
    nextReview: text("next_review"),
  },
  (t) => [index("projects_folder").on(t.folderId)],
);

export const taskTags = sqliteTable(
  "task_tags",
  {
    taskId: text("task_id").notNull(),
    tagId: text("tag_id").notNull(),
    rankInTask: integer("rank_in_task").notNull(),
    rankInTag: integer("rank_in_tag"),
    added: text("added").notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] }), index("task_tags_tag").on(t.tagId)],
);

export const alarms = sqliteTable(
  "alarms",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    kind: text("kind", { enum: ["absolute", "dueRelative", "deferRelative", "plannedRelative"] }).notNull(),
    fireDate: text("fire_date"),
    offsetSeconds: integer("offset_seconds"),
    repeatIntervalSeconds: integer("repeat_interval_seconds").notNull().default(0),
    snoozed: bool("snoozed").notNull().default(false),
    added: text("added").notNull(),
  },
  (t) => [index("alarms_task").on(t.taskId)],
);

export const blobs = sqliteTable("blobs", {
  sha256: text("sha256").primaryKey(),
  size: integer("size").notNull(),
  contentType: text("content_type").notNull(),
  storageKey: text("storage_key").notNull(),
});

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    blobSha256: text("blob_sha256").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    rank: integer("rank").notNull().default(0),
    added: text("added").notNull(),
  },
  (t) => [index("attachments_task").on(t.taskId), index("attachments_blob").on(t.blobSha256)],
);

/**
 * Built-in perspectives use fixed ids: inbox, projects, tags, forecast, flagged, review, completed, changed, search.
 * Custom perspectives use generated / imported ids.
 */
export const perspectives = sqliteTable("perspectives", {
  id: text("id").primaryKey(),
  builtin: bool("builtin").notNull().default(false),
  name: text("name").notNull(),
  icon: text("icon").notNull().default("list"),
  color: text("color"),
  favorite: bool("favorite").notNull().default(false),
  rank: integer("rank").notNull(),
  /** Custom only. Top-level aggregation. */
  aggregation: text("aggregation", { enum: ["all", "any", "none"] }).notNull().default("all"),
  /** Custom only. JSON array of rule objects (docs/spec.md §4.1). */
  rulesJson: text("rules_json").notNull().default("[]"),
  /** Custom only. JSON: { layout, grouping, sorting, sidebar }. */
  presentationJson: text("presentation_json").notNull().default("{}"),
  /** Per-perspective saved view options (filter, grouping, sort, structure flags, forecast options). JSON. */
  viewOptionsJson: text("view_options_json").notNull().default("{}"),
  /** Imported fields with no prana-bindu meaning, kept verbatim. JSON or null. */
  importExtrasJson: text("import_extras_json"),
  added: text("added").notNull(),
  modified: text("modified").notNull(),
});

/** Key/value settings; value is JSON. Keys per docs/spec.md §1.2. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

export const importRuns = sqliteTable("import_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  importedAt: text("imported_at").notNull(),
  source: text("source").notNull(),
  appId: text("app_id"),
  appVersion: text("app_version"),
  capabilitiesJson: text("capabilities_json").notNull().default("[]"),
  countsJson: text("counts_json").notNull().default("{}"),
  warningsJson: text("warnings_json").notNull().default("[]"),
});

// ---------------------------------------------------------------------------
// Undo/redo journal (populated by SQLite triggers on domain tables; see docs/plan.md §Undo)
// ---------------------------------------------------------------------------

export const changeGroups = sqliteTable("change_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  createdAt: text("created_at").notNull(),
  /** 'applied' (undoable) | 'undone' (redoable) */
  state: text("state", { enum: ["applied", "undone"] }).notNull().default("applied"),
});

export const changeRows = sqliteTable(
  "change_rows",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    groupId: integer("group_id").notNull(),
    tableName: text("table_name").notNull(),
    /** JSON object of primary-key columns. */
    rowKeyJson: text("row_key_json").notNull(),
    /** JSON row before change, null for insert. */
    beforeJson: text("before_json"),
    /** JSON row after change, null for delete. */
    afterJson: text("after_json"),
  },
  (t) => [index("change_rows_group").on(t.groupId)],
);

/**
 * Holds exactly one row (the open change group) while a domain mutation runs; empty otherwise.
 * Journal triggers copy OLD/NEW rows into change_rows only when a row exists, so importer writes are not journaled.
 */
export const journalState = sqliteTable("journal_state", {
  groupId: integer("group_id").primaryKey(),
});

// ---------------------------------------------------------------------------
// Mail Drop (never touched by import or undo)
// ---------------------------------------------------------------------------

/**
 * JMAP messages already turned into inbox items. The row is written in the same transaction as the item, so a
 * message whose move to Trash failed is moved on the next check instead of becoming a second item.
 */
export const mailDropMessages = sqliteTable(
  "mail_drop_messages",
  {
    accountId: text("account_id").notNull(),
    emailId: text("email_id").notNull(),
    taskId: text("task_id").notNull(),
    processedAt: text("processed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.emailId] })],
);

// ---------------------------------------------------------------------------
// Auth tables (never touched by import or undo)
// ---------------------------------------------------------------------------

export const passkeys = sqliteTable("passkeys", {
  /** base64url credential id */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  publicKey: text("public_key").notNull(), // base64url
  counter: integer("counter").notNull().default(0),
  transportsJson: text("transports_json").notNull().default("[]"),
  deviceType: text("device_type"),
  backedUp: bool("backed_up").notNull().default(false),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
});

export const webauthnChallenges = sqliteTable("webauthn_challenges", {
  challenge: text("challenge").primaryKey(),
  kind: text("kind", { enum: ["registration", "authentication"] }).notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const enrollmentTokens = sqliteTable("enrollment_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});

export const sessions = sqliteTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
});

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  /** First characters of the plaintext token (e.g. "pb_ab12cd") for display. */
  prefix: text("prefix").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
});

// ---------------------------------------------------------------------------
// OAuth 2.1 authorization server for remote MCP clients (never touched by import or undo)
// ---------------------------------------------------------------------------
// Codes and tokens are stored only as SHA-256 hex. Every code and token belongs to a grant (one approved
// consent); the service deletes them with their grant (foreign keys are not enforced).

/** Dynamically registered public clients (RFC 7591). */
export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** JSON array of exact redirect URIs. */
  redirectUrisJson: text("redirect_uris_json").notNull(),
  createdAt: text("created_at").notNull(),
  /** Set on every grant; decides when a client without grants is swept. */
  lastGrantedAt: text("last_granted_at"),
});

/** Pending consent: created by `/oauth/authorize`, consumed by approve or deny. */
export const oauthAuthorizationRequests = sqliteTable("oauth_authorization_requests", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  state: text("state"),
  codeChallenge: text("code_challenge").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (t) => [index("oauth_grants_client").on(t.clientId)],
);

/** Single-use codes; `usedAt` is kept until expiry so a replay revokes the grant. */
export const oauthCodes = sqliteTable(
  "oauth_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    grantId: text("grant_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
  },
  (t) => [index("oauth_codes_grant").on(t.grantId)],
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    grantId: text("grant_id").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("oauth_access_tokens_grant").on(t.grantId)],
);

/** Rotated on use: a used token presented again revokes the whole grant. */
export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    grantId: text("grant_id").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
  },
  (t) => [index("oauth_refresh_tokens_grant").on(t.grantId)],
);

/** Domain tables in dependency-free order; used by importer (replace-all) and undo triggers. */
export const DOMAIN_TABLES = [
  "folders",
  "tags",
  "tasks",
  "projects",
  "task_tags",
  "alarms",
  "blobs",
  "attachments",
  "perspectives",
  "settings",
] as const;
