import type { AppDb } from "../db/connection.js";
import * as schema from "../db/schema.js";

export type TaskRow = typeof schema.tasks.$inferSelect;
export type ProjectRow = typeof schema.projects.$inferSelect;
export type FolderRow = typeof schema.folders.$inferSelect;
export type TagRow = typeof schema.tags.$inferSelect;
export type TaskTagRow = typeof schema.taskTags.$inferSelect;
export type AlarmRow = typeof schema.alarms.$inferSelect;
export type AttachmentRow = typeof schema.attachments.$inferSelect;
export type PerspectiveRow = typeof schema.perspectives.$inferSelect;
export type SettingRow = typeof schema.settings.$inferSelect;

export type ContainerItem = { kind: "folder"; row: FolderRow } | { kind: "project"; row: ProjectRow; task: TaskRow };

const byRank = <T extends { rank: number; id: string }>(a: T, b: T): number =>
  a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * In-memory copy of every domain row plus lazily built indexes. Domain writes update the rows in place
 * (via `Store`) and call `touch()`, which bumps `version` and drops the indexes.
 */
export class Snapshot {
  version = 0;
  readonly tasks = new Map<string, TaskRow>();
  readonly projects = new Map<string, ProjectRow>();
  readonly folders = new Map<string, FolderRow>();
  readonly tags = new Map<string, TagRow>();
  /** task id → links ordered by rankInTask */
  readonly taskTags = new Map<string, TaskTagRow[]>();
  readonly alarms = new Map<string, AlarmRow[]>();
  readonly attachments = new Map<string, AttachmentRow>();
  readonly perspectives = new Map<string, PerspectiveRow>();
  settingRows: SettingRow[] = [];

  private childIndex: Map<string, TaskRow[]> | null = null;
  private containerIndex: Map<string, ContainerItem[]> | null = null;
  private tagChildIndex: Map<string, TagRow[]> | null = null;
  private tagTaskIndex: Map<string, TaskTagRow[]> | null = null;
  private attachmentIndex: Map<string, AttachmentRow[]> | null = null;

  static load(db: AppDb): Snapshot {
    const s = new Snapshot();
    for (const r of db.select().from(schema.tasks).all()) s.tasks.set(r.id, r);
    for (const r of db.select().from(schema.projects).all()) s.projects.set(r.taskId, r);
    for (const r of db.select().from(schema.folders).all()) s.folders.set(r.id, r);
    for (const r of db.select().from(schema.tags).all()) s.tags.set(r.id, r);
    for (const r of db.select().from(schema.taskTags).all()) {
      const list = s.taskTags.get(r.taskId);
      if (list) list.push(r);
      else s.taskTags.set(r.taskId, [r]);
    }
    for (const list of s.taskTags.values()) list.sort((a, b) => a.rankInTask - b.rankInTask);
    for (const r of db.select().from(schema.alarms).all()) {
      const list = s.alarms.get(r.taskId);
      if (list) list.push(r);
      else s.alarms.set(r.taskId, [r]);
    }
    for (const r of db.select().from(schema.attachments).all()) s.attachments.set(r.id, r);
    for (const r of db.select().from(schema.perspectives).all()) s.perspectives.set(r.id, r);
    s.settingRows = db.select().from(schema.settings).all();
    return s;
  }

  touch(): void {
    this.version++;
    this.childIndex = null;
    this.containerIndex = null;
    this.tagChildIndex = null;
    this.tagTaskIndex = null;
    this.attachmentIndex = null;
  }

  /** Children of a task (rank order); `null` = top-level tasks (inbox items, project roots, orphans). */
  childrenOf(parentId: string | null): TaskRow[] {
    if (!this.childIndex) {
      const idx = new Map<string, TaskRow[]>();
      for (const t of this.tasks.values()) {
        const key = t.parentId !== null && this.tasks.has(t.parentId) ? t.parentId : "";
        const list = idx.get(key);
        if (list) list.push(t);
        else idx.set(key, [t]);
      }
      for (const list of idx.values()) list.sort(byRank);
      this.childIndex = idx;
    }
    return this.childIndex.get(parentId ?? "") ?? [];
  }

  isProject(taskId: string): boolean {
    return this.projects.has(taskId);
  }

  /** Inbox root items, in rank order. */
  inboxRoots(): TaskRow[] {
    return this.childrenOf(null).filter((t) => t.inInbox && !this.projects.has(t.id));
  }

  /** Top-level tasks that are neither projects nor in the inbox (e.g. tagged items cleaned up without a project). */
  orphanRoots(): TaskRow[] {
    return this.childrenOf(null).filter((t) => !t.inInbox && !this.projects.has(t.id));
  }

  /** Folders and projects inside a folder (`null` = top level), in their shared rank order. */
  containerChildren(folderId: string | null): ContainerItem[] {
    if (!this.containerIndex) {
      const idx = new Map<string, ContainerItem[]>();
      const add = (key: string, item: ContainerItem): void => {
        const list = idx.get(key);
        if (list) list.push(item);
        else idx.set(key, [item]);
      };
      for (const f of this.folders.values()) {
        add(f.parentId !== null && this.folders.has(f.parentId) ? f.parentId : "", { kind: "folder", row: f });
      }
      for (const p of this.projects.values()) {
        const task = this.tasks.get(p.taskId);
        if (!task) continue;
        add(p.folderId !== null && this.folders.has(p.folderId) ? p.folderId : "", { kind: "project", row: p, task });
      }
      const rankOf = (i: ContainerItem): number => (i.kind === "folder" ? i.row.rank : i.task.rank);
      const idOf = (i: ContainerItem): string => (i.kind === "folder" ? i.row.id : i.row.taskId);
      for (const list of idx.values()) {
        list.sort((a, b) => rankOf(a) - rankOf(b) || (idOf(a) < idOf(b) ? -1 : 1));
      }
      this.containerIndex = idx;
    }
    return this.containerIndex.get(folderId ?? "") ?? [];
  }

  tagChildren(parentId: string | null): TagRow[] {
    if (!this.tagChildIndex) {
      const idx = new Map<string, TagRow[]>();
      for (const t of this.tags.values()) {
        const key = t.parentId !== null && this.tags.has(t.parentId) ? t.parentId : "";
        const list = idx.get(key);
        if (list) list.push(t);
        else idx.set(key, [t]);
      }
      for (const list of idx.values()) list.sort(byRank);
      this.tagChildIndex = idx;
    }
    return this.tagChildIndex.get(parentId ?? "") ?? [];
  }

  /** Links of a tag, ordered by rankInTag (nulls last). */
  tagTasks(tagId: string): TaskTagRow[] {
    if (!this.tagTaskIndex) {
      const idx = new Map<string, TaskTagRow[]>();
      for (const links of this.taskTags.values()) {
        for (const l of links) {
          const list = idx.get(l.tagId);
          if (list) list.push(l);
          else idx.set(l.tagId, [l]);
        }
      }
      for (const list of idx.values()) {
        list.sort((a, b) => (a.rankInTag ?? Number.MAX_SAFE_INTEGER) - (b.rankInTag ?? Number.MAX_SAFE_INTEGER));
      }
      this.tagTaskIndex = idx;
    }
    return this.tagTaskIndex.get(tagId) ?? [];
  }

  tagIdsOf(taskId: string): string[] {
    return (this.taskTags.get(taskId) ?? []).map((l) => l.tagId);
  }

  attachmentsOf(taskId: string): AttachmentRow[] {
    if (!this.attachmentIndex) {
      const idx = new Map<string, AttachmentRow[]>();
      for (const a of this.attachments.values()) {
        const list = idx.get(a.taskId);
        if (list) list.push(a);
        else idx.set(a.taskId, [a]);
      }
      for (const list of idx.values()) list.sort((a, b) => a.rank - b.rank || a.added.localeCompare(b.added));
      this.attachmentIndex = idx;
    }
    return this.attachmentIndex.get(taskId) ?? [];
  }

  /** The project root of a task (walking parents), or null. */
  projectRootOf(taskId: string): string | null {
    let cur = this.tasks.get(taskId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      if (this.projects.has(cur.id)) return cur.id;
      seen.add(cur.id);
      cur = cur.parentId === null ? undefined : this.tasks.get(cur.parentId);
    }
    return null;
  }

  /** Ids of a task and all its descendants (pre-order). */
  subtreeIds(taskId: string): string[] {
    const out: string[] = [];
    const visit = (id: string): void => {
      out.push(id);
      for (const c of this.childrenOf(id)) visit(c.id);
    };
    if (this.tasks.has(taskId)) visit(taskId);
    return out;
  }

  isAncestor(ancestorId: string, taskId: string): boolean {
    let cur = this.tasks.get(taskId);
    const seen = new Set<string>();
    while (cur && cur.parentId !== null && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.parentId === ancestorId) return true;
      cur = this.tasks.get(cur.parentId);
    }
    return false;
  }
}
