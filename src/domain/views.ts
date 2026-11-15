// Perspective contents, Forecast, Review, Search and Quick Open (docs/spec.md §4).
import { addDaysToKey, addToNaive, dateValueToInstant, dayKeyOfNaive, dayKeyToNaive, localDayKey } from "../shared/datetime.js";
import type {
  Availability,
  Folder,
  Forecast,
  OutlineGroup,
  OutlineRow,
  Perspective,
  PerspectiveContents,
  Project,
  QuickOpenResult,
  SearchResults,
  Settings,
  Tag,
  Task,
  ViewOptions,
} from "../shared/schemas.js";
import type { Derived, TaskState } from "./derive.js";
import { alarmDto, computeNextReview, folderDto, projectDto, tagDto, taskDto } from "./dto.js";
import { evaluateRules, type Aggregation } from "./rules.js";
import type { ProjectRow, Snapshot, TaskRow } from "./snapshot.js";

export type Grouping = NonNullable<ViewOptions["grouping"]>;
export type Sorting = Perspective["presentation"]["sorting"];

export interface ContentsParams {
  project?: string;
  folder?: string;
  tag?: string;
  day?: string;
  q?: string;
}

const EMPTY_TEXT: Record<Availability, string> = {
  next: "No available projects",
  available: "No available projects",
  remaining: "No remaining projects",
  all: "No projects",
};

/** Per-request view over a snapshot + derived state with DTO caching. */
export class View {
  private taskCache = new Map<string, Task>();
  private projectCache = new Map<string, Project>();

  constructor(
    readonly snap: Snapshot,
    readonly d: Derived,
    readonly settings: Settings,
  ) {}

  task(id: string): Task {
    let t = this.taskCache.get(id);
    if (!t) {
      t = taskDto(this.snap, this.d, this.snap.tasks.get(id)!);
      this.taskCache.set(id, t);
    }
    return t;
  }

  project(id: string): Project {
    let p = this.projectCache.get(id);
    if (!p) {
      p = projectDto(this.snap, this.d, this.snap.projects.get(id)!, this.settings);
      this.projectCache.set(id, p);
    }
    return p;
  }

  state(id: string): TaskState {
    return this.d.tasks.get(id)!;
  }

  /** Row for a task id: project roots render as project rows. */
  row(id: string, depth: number): OutlineRow {
    if (this.snap.isProject(id)) return { kind: "project", id, depth, project: this.project(id) };
    return { kind: "task", id, depth, task: this.task(id) };
  }

  matchesFilter(id: string, filter: Availability): boolean {
    const s = this.state(id);
    switch (filter) {
      case "next":
        return s.firstAvailable;
      case "available":
        return s.available;
      case "remaining":
        return s.remaining;
      case "all":
        return true;
    }
  }

  /**
   * Hierarchical rows under `parentId` where a task is shown if it matches or has a shown descendant
   * (ancestors of matches are kept as context).
   */
  hierarchy(parentId: string, depth: number, include: (row: TaskRow) => boolean): OutlineRow[] {
    const out: OutlineRow[] = [];
    for (const child of this.snap.childrenOf(parentId)) {
      const sub = this.hierarchy(child.id, depth + 1, include);
      if (sub.length > 0 || include(child)) {
        out.push(this.row(child.id, depth), ...sub);
      }
    }
    return out;
  }

  /** Rows for root items (inbox items/orphans) with their subtrees. */
  rootsHierarchy(roots: TaskRow[], include: (row: TaskRow) => boolean): OutlineRow[] {
    const out: OutlineRow[] = [];
    for (const r of roots) {
      const sub = this.hierarchy(r.id, 1, include);
      if (sub.length > 0 || include(r)) out.push(this.row(r.id, 0), ...sub);
    }
    return out;
  }

  projectTitle(projectId: string): string {
    const ps = this.d.projects.get(projectId);
    return [...(ps?.folderPath ?? []), this.snap.tasks.get(projectId)?.name ?? ""].join(" : ");
  }

  /** Projects in sidebar order. */
  projectRows(): ProjectRow[] {
    return [...this.snap.projects.values()]
      .filter((p) => this.d.projects.has(p.taskId))
      .sort((a, b) => this.d.projects.get(a.taskId)!.order - this.d.projects.get(b.taskId)!.order);
  }

  projectMatchesFilter(projectId: string, filter: Availability): boolean {
    const ps = this.d.projects.get(projectId);
    if (!ps) return false;
    switch (filter) {
      case "all":
        return true;
      case "remaining":
        return ps.effectiveStatus === "active" || ps.effectiveStatus === "onHold";
      case "available":
      case "next":
        return ps.effectiveStatus === "active" && !ps.pending;
    }
  }

  // -------------------------------------------------------------------------
  // Built-in perspectives
  // -------------------------------------------------------------------------

  inbox(vo: ViewOptions): OutlineGroup[] {
    const filter = vo.filter === "next" ? "available" : (vo.filter ?? "remaining");
    const rows = this.rootsHierarchy(this.snap.inboxRoots(), (r) => this.matchesFilter(r.id, filter));
    return rows.length ? [{ key: "inbox", title: "Inbox", kind: "none", rows }] : [];
  }

  projects(vo: ViewOptions, params: ContentsParams): { groups: OutlineGroup[]; emptyText: string } {
    const filter = vo.filter ?? "remaining";
    const groups: OutlineGroup[] = [];
    // The Inbox section only belongs to the unfiltered outline, not to a selected project or folder.
    if (vo.showInbox && !params.project && !params.folder) {
      const inbox = this.inbox({ filter: filter === "next" ? "available" : filter });
      groups.push(...inbox);
    }
    const include = (r: TaskRow): boolean => this.matchesFilter(r.id, filter);
    const selected = (p: ProjectRow): boolean => {
      if (params.project) return p.taskId === params.project;
      if (params.folder) return this.d.projects.get(p.taskId)?.folderIds.includes(params.folder) ?? false;
      return true;
    };
    const visible = this.projectRows().filter(
      (p) => selected(p) && (params.project === p.taskId || this.projectMatchesFilter(p.taskId, filter)),
    );
    if (vo.showFolders) {
      const visibleIds = new Set(visible.map((p) => p.taskId));
      const rows: OutlineRow[] = [];
      const walk = (folderId: string | null, depth: number): boolean => {
        let any = false;
        for (const item of this.snap.containerChildren(folderId)) {
          if (item.kind === "folder") {
            const at = rows.length;
            const fs = this.d.folders.get(item.row.id);
            const hasContent = walk(item.row.id, depth + 1);
            const folderShown = hasContent || (!params.project && !params.folder && (filter === "all" || (filter === "remaining" && fs?.effectiveActive)));
            if (folderShown) {
              rows.splice(at, 0, { kind: "folder", id: item.row.id, depth, folder: folderDto(this.d, item.row) });
              any = true;
            } else rows.length = at;
          } else if (visibleIds.has(item.row.taskId)) {
            rows.push(this.row(item.row.taskId, depth), ...this.hierarchy(item.row.taskId, depth + 1, include));
            any = true;
          }
        }
        return any;
      };
      walk(null, 0);
      if (rows.length) groups.push({ key: "outline", title: "", kind: "none", rows });
    } else {
      for (const p of visible) {
        groups.push({
          key: p.taskId,
          title: this.projectTitle(p.taskId),
          kind: "project",
          rows: [this.row(p.taskId, 0), ...this.hierarchy(p.taskId, 1, include)],
        });
      }
    }
    return { groups, emptyText: EMPTY_TEXT[filter] };
  }

  tags(vo: ViewOptions, params: ContentsParams): OutlineGroup[] {
    const filter = vo.filter ?? "available";
    const sortTasks = (ids: string[]): string[] => {
      if (!vo.sortByDueAndFlagged) return ids;
      return [...ids].sort((a, b) => {
        const sa = this.state(a);
        const sb = this.state(b);
        const da = sa.dueMs ?? Number.POSITIVE_INFINITY;
        const db = sb.dueMs ?? Number.POSITIVE_INFINITY;
        if (da !== db) return da < db ? -1 : 1;
        if (sa.effectiveFlagged !== sb.effectiveFlagged) return sa.effectiveFlagged ? -1 : 1;
        return sa.order - sb.order;
      });
    };
    const groups: OutlineGroup[] = [];
    let selectedTags: Set<string> | null = null;
    if (params.tag && params.tag !== "untagged") {
      selectedTags = new Set();
      const add = (id: string): void => {
        selectedTags!.add(id);
        for (const c of this.snap.tagChildren(id)) add(c.id);
      };
      add(params.tag);
    }
    if (params.tag !== "untagged") {
      const tags = [...this.snap.tags.values()].sort((a, b) => this.d.tags.get(a.id)!.order - this.d.tags.get(b.id)!.order);
      for (const tag of tags) {
        if (selectedTags && !selectedTags.has(tag.id)) continue;
        const ts = this.d.tags.get(tag.id)!;
        if (filter === "remaining" && ts.effectiveStatus === "dropped") continue;
        if ((filter === "available" || filter === "next") && ts.effectiveStatus !== "active") continue;
        const ids = this.snap
          .tagTasks(tag.id)
          .map((l) => l.taskId)
          .filter((id) => this.d.tasks.has(id) && this.matchesFilter(id, filter));
        if (ids.length === 0) continue;
        groups.push({ key: tag.id, title: tag.name, kind: "tag", rows: sortTasks(ids).map((id) => this.row(id, 0)) });
      }
    }
    if (!params.tag || params.tag === "untagged") {
      const ids = this.d.taskOrder.filter(
        (id) =>
          !this.snap.isProject(id) && (this.snap.taskTags.get(id) ?? []).length === 0 && this.matchesFilter(id, filter),
      );
      if (ids.length) groups.push({ key: "untagged", title: "Untagged", kind: "tag", rows: sortTasks(ids).map((id) => this.row(id, 0)) });
    }
    return groups;
  }

  flagged(vo: ViewOptions): OutlineGroup[] {
    const filter = vo.filter ?? "available";
    const ids = this.d.taskOrder.filter(
      (id) => !this.snap.isProject(id) && this.state(id).effectiveFlagged && this.matchesFilter(id, filter),
    );
    return this.groupFlat(ids, vo.grouping ?? "none", "manual");
  }

  /** Projects due for review (active or on hold, next review ≤ end of today), soonest first. */
  reviewProjects(): Project[] {
    const tz = this.settings.timeZone;
    const due: { p: ProjectRow; key: string }[] = [];
    for (const p of this.projectRows()) {
      const ps = this.d.projects.get(p.taskId)!;
      if (ps.effectiveStatus !== "active" && ps.effectiveStatus !== "onHold") continue;
      const next = p.nextReview ?? computeNextReview(p, tz);
      const key = localDayKey(dateValueToInstant(next, tz), tz);
      if (key <= this.d.todayKey) due.push({ p, key });
    }
    due.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : this.d.projects.get(a.p.taskId)!.order - this.d.projects.get(b.p.taskId)!.order));
    return due.map(({ p }) => this.project(p.taskId));
  }

  review(): OutlineGroup[] {
    const tz = this.settings.timeZone;
    const groups = new Map<string, OutlineGroup>();
    for (const project of this.reviewProjects()) {
      const key = localDayKey(dateValueToInstant(project.nextReview!, tz), tz);
      let g = groups.get(key);
      if (!g) {
        g = { key, title: this.dayTitle(key), kind: "date", rows: [] };
        groups.set(key, g);
      }
      g.rows.push({ kind: "project", id: project.id, depth: 0, project });
    }
    return [...groups.values()];
  }

  /** Completed (or Changed) items in past date buckets, newest first. */
  history(field: "completed" | "modified"): OutlineGroup[] {
    const ids = this.d.taskOrder.filter((id) => this.snap.tasks.get(id)![field] !== null);
    const ms = (id: string): number => Date.parse(this.snap.tasks.get(id)![field]!);
    ids.sort((a, b) => ms(b) - ms(a));
    return this.bucketGroups(ids, (id) => ms(id), "past");
  }

  search(q: string, filter: Availability): SearchResults {
    const needle = q.trim().toLowerCase();
    const empty: SearchResults = { query: q, tasks: [], projects: [], folders: [], tags: [] };
    if (!needle) return empty;
    const hit = (s: string): boolean => s.toLowerCase().includes(needle);
    const tasks = this.d.taskOrder
      .filter((id) => !this.snap.isProject(id))
      .filter((id) => {
        const r = this.snap.tasks.get(id)!;
        return (hit(r.name) || hit(r.note)) && this.matchesFilter(id, filter);
      })
      .map((id) => this.task(id));
    const projects = this.projectRows()
      .filter((p) => hit(this.snap.tasks.get(p.taskId)!.name) && this.projectMatchesFilter(p.taskId, filter))
      .map((p) => this.project(p.taskId));
    const folders: Folder[] = [...this.snap.folders.values()]
      .filter((f) => hit(f.name) && (filter === "all" || this.d.folders.get(f.id)?.effectiveActive))
      .sort((a, b) => (this.d.folders.get(a.id)?.order ?? 0) - (this.d.folders.get(b.id)?.order ?? 0))
      .map((f) => folderDto(this.d, f));
    const tags: Tag[] = [...this.snap.tags.values()]
      .filter((t) => {
        if (!hit(t.name)) return false;
        const st = this.d.tags.get(t.id)?.effectiveStatus;
        return filter === "all" || (filter === "remaining" ? st !== "dropped" : st === "active");
      })
      .sort((a, b) => (this.d.tags.get(a.id)?.order ?? 0) - (this.d.tags.get(b.id)?.order ?? 0))
      .map((t) => tagDto(this.d, t));
    return { query: q, tasks, projects, folders, tags };
  }

  searchGroups(q: string, filter: Availability): OutlineGroup[] {
    const r = this.search(q, filter);
    const groups: OutlineGroup[] = [];
    if (r.tasks.length) groups.push({ key: "tasks", title: "Actions", kind: "kind", rows: r.tasks.map((t) => ({ kind: "task", id: t.id, depth: 0, task: t })) });
    if (r.projects.length) groups.push({ key: "projects", title: "Projects", kind: "kind", rows: r.projects.map((p) => ({ kind: "project", id: p.id, depth: 0, project: p })) });
    if (r.folders.length) groups.push({ key: "folders", title: "Folders", kind: "kind", rows: r.folders.map((f) => ({ kind: "folder", id: f.id, depth: 0, folder: f })) });
    if (r.tags.length) groups.push({ key: "tags", title: "Tags", kind: "kind", rows: r.tags.map((t) => ({ kind: "tag", id: t.id, depth: 0, tag: t })) });
    return groups;
  }

  // -------------------------------------------------------------------------
  // Custom perspectives
  // -------------------------------------------------------------------------

  custom(p: Perspective): OutlineGroup[] {
    const ctx = { snap: this.snap, d: this.d, settings: this.settings };
    const noRules = p.rules.length === 0;
    const matched = new Set<string>();
    for (const id of this.d.taskOrder) {
      const row = this.snap.tasks.get(id)!;
      const ok = noRules
        ? this.state(id).remaining && !this.snap.isProject(id)
        : evaluateRules(p.rules, p.aggregation as Aggregation, row, ctx);
      if (ok) matched.add(id);
    }
    if (p.presentation.layout === "flat") {
      const ids = this.d.taskOrder.filter((id) => matched.has(id));
      return this.groupFlat(ids, p.presentation.grouping, p.presentation.sorting);
    }
    const include = (r: TaskRow): boolean => matched.has(r.id);
    const groups: OutlineGroup[] = [];
    const inboxRows = this.rootsHierarchy(this.snap.inboxRoots(), include);
    if (inboxRows.length) groups.push({ key: "inbox", title: "Inbox", kind: "none", rows: inboxRows });
    for (const pr of this.projectRows()) {
      const rows = this.hierarchy(pr.taskId, 1, include);
      if (rows.length === 0 && !matched.has(pr.taskId)) continue;
      groups.push({ key: pr.taskId, title: this.projectTitle(pr.taskId), kind: "project", rows: [this.row(pr.taskId, 0), ...rows] });
    }
    const orphanRows = this.rootsHierarchy(this.snap.orphanRoots(), include);
    if (orphanRows.length) groups.push({ key: "no-project", title: "No Project", kind: "none", rows: orphanRows });
    return groups;
  }

  // -------------------------------------------------------------------------
  // Grouping / sorting / buckets
  // -------------------------------------------------------------------------

  sortIds(ids: string[], sorting: Sorting): string[] {
    if (sorting === "manual") return ids;
    const row = (id: string): TaskRow => this.snap.tasks.get(id)!;
    const ts = (v: string | null): number => (v === null ? Number.POSITIVE_INFINITY : Date.parse(v));
    const key = (id: string): number | string => {
      const s = this.state(id);
      const r = row(id);
      switch (sorting) {
        case "due":
          return s.dueMs ?? Number.POSITIVE_INFINITY;
        case "defer":
          return s.deferMs ?? Number.POSITIVE_INFINITY;
        case "planned":
          return s.plannedMs ?? Number.POSITIVE_INFINITY;
        case "completed":
          return ts(r.completed);
        case "added":
          return ts(r.added);
        case "changed":
          return ts(r.modified);
        case "flagged":
          return s.effectiveFlagged ? 0 : 1;
        case "duration":
          return r.estimatedMinutes ?? Number.POSITIVE_INFINITY;
        case "name":
          return r.name.toLowerCase();
      }
    };
    return [...ids].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka !== kb) {
        if (typeof ka === "string" && typeof kb === "string") return ka.localeCompare(kb);
        return ka < kb ? -1 : 1;
      }
      return this.state(a).order - this.state(b).order;
    });
  }

  groupFlat(ids: string[], grouping: Grouping, sorting: Sorting): OutlineGroup[] {
    const sorted = this.sortIds(ids, sorting);
    const rows = (list: string[]): OutlineRow[] => list.map((id) => this.row(id, 0));
    const keyed = (keyOf: (id: string) => { key: string; title: string; kind: OutlineGroup["kind"]; order: number }[]): OutlineGroup[] => {
      const groups = new Map<string, { g: OutlineGroup; order: number }>();
      for (const id of sorted) {
        for (const k of keyOf(id)) {
          let entry = groups.get(k.key);
          if (!entry) {
            entry = { g: { key: k.key, title: k.title, kind: k.kind, rows: [] }, order: k.order };
            groups.set(k.key, entry);
          }
          entry.g.rows.push(this.row(id, 0));
        }
      }
      return [...groups.values()].sort((a, b) => a.order - b.order).map((e) => e.g);
    };
    const tagOrder = (tagId: string): number => this.d.tags.get(tagId)?.order ?? Number.MAX_SAFE_INTEGER;
    switch (grouping) {
      case "none":
        return sorted.length ? [{ key: "all", title: "", kind: "none", rows: rows(sorted) }] : [];
      case "tag":
        return keyed((id) => {
          const tagIds = this.snap.tagIdsOf(id).filter((t) => this.snap.tags.has(t));
          if (tagIds.length === 0) return [{ key: "untagged", title: "Untagged", kind: "tag", order: Number.MAX_SAFE_INTEGER }];
          return tagIds.map((t) => ({ key: t, title: this.snap.tags.get(t)!.name, kind: "tag" as const, order: tagOrder(t) }));
        });
      case "tagsCombined":
        return keyed((id) => {
          const tagIds = this.snap.tagIdsOf(id).filter((t) => this.snap.tags.has(t));
          if (tagIds.length === 0) return [{ key: "untagged", title: "Untagged", kind: "tag", order: Number.MAX_SAFE_INTEGER }];
          const sortedTags = [...tagIds].sort((a, b) => tagOrder(a) - tagOrder(b));
          return [
            {
              key: sortedTags.join(","),
              title: sortedTags.map((t) => this.snap.tags.get(t)!.name).join(", "),
              kind: "tag" as const,
              order: tagOrder(sortedTags[0]!) * 1000 + sortedTags.length,
            },
          ];
        });
      case "project":
        return keyed((id) => {
          const s = this.state(id);
          if (s.projectId) return [{ key: s.projectId, title: this.projectTitle(s.projectId), kind: "project", order: this.d.projects.get(s.projectId)!.order }];
          if (s.inInboxTree) return [{ key: "inbox", title: "Inbox", kind: "none", order: -1 }];
          return [{ key: "no-project", title: "No Project", kind: "none", order: Number.MAX_SAFE_INTEGER }];
        });
      case "folder":
        return keyed((id) => {
          const s = this.state(id);
          const folderId = s.projectId ? this.d.projects.get(s.projectId)?.folderIds.at(-1) : undefined;
          if (!folderId) return [{ key: "no-folder", title: "No Folder", kind: "folder", order: Number.MAX_SAFE_INTEGER }];
          return [{ key: folderId, title: this.snap.folders.get(folderId)!.name, kind: "folder", order: this.d.folders.get(folderId)?.order ?? 0 }];
        });
      case "flagged":
        return keyed((id) =>
          this.state(id).effectiveFlagged
            ? [{ key: "flagged", title: "Flagged", kind: "flagged", order: 0 }]
            : [{ key: "unflagged", title: "Unflagged", kind: "flagged", order: 1 }],
        );
      case "due":
      case "defer":
      case "planned": {
        const msOf = (id: string): number | null => {
          const s = this.state(id);
          return grouping === "due" ? s.dueMs : grouping === "defer" ? s.deferMs : s.plannedMs;
        };
        return this.bucketGroups(sorted, msOf, "future", `No ${grouping[0]!.toUpperCase()}${grouping.slice(1)} Date`);
      }
      case "completed":
      case "dropped":
      case "added":
      case "changed": {
        const field = grouping === "changed" ? "modified" : grouping;
        const msOf = (id: string): number | null => {
          const v = this.snap.tasks.get(id)![field];
          return v === null ? null : Date.parse(v);
        };
        return this.bucketGroups(sorted, msOf, "past", `No ${grouping[0]!.toUpperCase()}${grouping.slice(1)} Date`);
      }
    }
  }

  /** Date buckets relative to today (empty buckets omitted). */
  bucketGroups(ids: string[], msOf: (id: string) => number | null, direction: "past" | "future", noneTitle = "No Date"): OutlineGroup[] {
    const today = this.d.todayKey;
    const todayNaive = dayKeyToNaive(today);
    const shift = (amount: number, unit: "day" | "month" | "year"): string => dayKeyOfNaive(addToNaive(todayNaive, amount, unit));
    const buckets: { key: string; title: string; test: (k: string) => boolean }[] =
      direction === "past"
        ? [
            { key: "today", title: "Today", test: (k) => k >= today },
            { key: "yesterday", title: "Yesterday", test: (k) => k === addDaysToKey(today, -1) },
            { key: "week", title: "Within the last week", test: (k) => k >= shift(-7, "day") },
            { key: "month", title: "Within the last month", test: (k) => k >= shift(-1, "month") },
            { key: "months3", title: "Within the last 3 months", test: (k) => k >= shift(-3, "month") },
            { key: "months6", title: "Within the last 6 months", test: (k) => k >= shift(-6, "month") },
            { key: "year", title: "Within the last year", test: (k) => k >= shift(-1, "year") },
            { key: "older", title: "More than a year ago", test: () => true },
          ]
        : [
            { key: "past", title: "Past", test: (k) => k < today },
            { key: "today", title: "Today", test: (k) => k === today },
            { key: "tomorrow", title: "Tomorrow", test: (k) => k === addDaysToKey(today, 1) },
            { key: "week", title: "Within the next week", test: (k) => k <= shift(7, "day") },
            { key: "month", title: "Within the next month", test: (k) => k <= shift(1, "month") },
            { key: "months3", title: "Within the next 3 months", test: (k) => k <= shift(3, "month") },
            { key: "months6", title: "Within the next 6 months", test: (k) => k <= shift(6, "month") },
            { key: "year", title: "Within the next year", test: (k) => k <= shift(1, "year") },
            { key: "later", title: "Later", test: () => true },
          ];
    const groups = new Map<string, OutlineGroup>();
    const none: OutlineRow[] = [];
    for (const id of ids) {
      const ms = msOf(id);
      if (ms === null) {
        none.push(this.row(id, 0));
        continue;
      }
      const k = localDayKey(ms, this.settings.timeZone);
      const b = buckets.find((x) => x.test(k))!;
      let g = groups.get(b.key);
      if (!g) {
        g = { key: `bucket:${b.key}`, title: b.title, kind: "date", rows: [] };
        groups.set(b.key, g);
      }
      g.rows.push(this.row(id, 0));
    }
    const out = buckets.map((b) => groups.get(b.key)).filter((g): g is OutlineGroup => g !== undefined);
    if (none.length) out.push({ key: "bucket:none", title: noneTitle, kind: "date", rows: none });
    return out;
  }

  dayTitle(key: string): string {
    if (key === this.d.todayKey) return "Today";
    if (key === addDaysToKey(this.d.todayKey, -1)) return "Yesterday";
    if (key === addDaysToKey(this.d.todayKey, 1)) return "Tomorrow";
    return new Date(dayKeyToNaive(key)).toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  // -------------------------------------------------------------------------
  // Forecast
  // -------------------------------------------------------------------------

  forecast(vo: ViewOptions, from: string | undefined, days: number): Forecast {
    const opts = {
      includePlanned: true,
      includeDefer: false,
      includeNotification: false,
      includeOnHold: false,
      todayIncludesFlagged: false,
      todayIncludesTag: true,
      organized: false,
      preserveHierarchy: false,
      keepSorted: true,
      ...vo.forecast,
    };
    const tz = this.settings.timeZone;
    const today = this.d.todayKey;
    const fromKey = from ?? today;
    const dayKeys = Array.from({ length: days }, (_, i) => addDaysToKey(fromKey, i));
    const lastKey = dayKeys.at(-1) ?? fromKey;

    interface Entry {
      ms: number;
      due: boolean;
    }
    const byDay = new Map<string, Map<string, Entry>>();
    const past = new Map<string, Entry>();
    const future = new Map<string, Entry>();
    const put = (bucket: Map<string, Entry>, id: string, e: Entry): void => {
      const prev = bucket.get(id);
      if (!prev) bucket.set(id, e);
      else bucket.set(id, { ms: Math.min(prev.ms, e.ms), due: prev.due || e.due });
    };
    const onDay = (key: string, id: string, e: Entry): void => {
      let m = byDay.get(key);
      if (!m) {
        m = new Map();
        byDay.set(key, m);
      }
      put(m, id, e);
    };
    const candidates: string[] = [];
    for (const id of this.d.taskOrder) {
      const s = this.state(id);
      if (!s.remaining) continue;
      if (!opts.includeOnHold && s.projectId && this.d.projects.get(s.projectId)?.effectiveStatus === "onHold") continue;
      candidates.push(id);
      const entries: Entry[] = [];
      if (s.dueMs !== null) entries.push({ ms: s.dueMs, due: true });
      if (opts.includePlanned && s.plannedMs !== null) entries.push({ ms: s.plannedMs, due: false });
      if (opts.includeDefer && s.deferMs !== null) entries.push({ ms: s.deferMs, due: false });
      if (opts.includeNotification) {
        for (const a of this.snap.alarms.get(id) ?? []) {
          const fire = alarmDto(this.d, a, tz).effectiveFireDate;
          if (fire) entries.push({ ms: dateValueToInstant(fire, tz), due: false });
        }
      }
      for (const e of entries) {
        const key = localDayKey(e.ms, tz);
        if (key < today) {
          if (e.due) put(past, id, e);
          continue;
        }
        onDay(key, id, e);
        if (key > lastKey) put(future, id, e);
      }
    }

    const toRows = (bucket: Map<string, Entry>): OutlineRow[] => {
      const ids = [...bucket.keys()];
      if (opts.organized) {
        ids.sort((a, b) => this.state(a).order - this.state(b).order);
        if (opts.preserveHierarchy) return this.withAncestors(ids);
      } else {
        ids.sort((a, b) => bucket.get(a)!.ms - bucket.get(b)!.ms || this.state(a).order - this.state(b).order);
      }
      return ids.map((id) => this.row(id, 0));
    };
    const makeDay = (key: string, date: string | null, title: string, bucket: Map<string, Entry>) => {
      let dueCount = 0;
      let deferredCount = 0;
      let overdue = false;
      let dueSoon = false;
      for (const [id, e] of bucket) {
        const s = this.state(id);
        if (e.due) dueCount++;
        if (s.deferred) deferredCount++;
        if (s.overdue) overdue = true;
        else if (e.due && s.dueSoon) dueSoon = true;
      }
      return {
        key,
        date,
        title,
        dueCount,
        count: bucket.size,
        deferredCount,
        badge: overdue ? ("overdue" as const) : dueSoon ? ("dueSoon" as const) : null,
        rows: toRows(bucket),
      };
    };

    const out: Forecast["days"] = [makeDay("PAST", null, "Past", past)];
    for (const key of dayKeys) {
      const bucket = new Map(byDay.get(key) ?? []);
      if (key === today) {
        for (const [id, e] of past) put(bucket, id, e);
        const tagId = this.settings.forecastTagId;
        for (const id of candidates) {
          const s = this.state(id);
          if (opts.todayIncludesFlagged && s.effectiveFlagged && !this.snap.isProject(id)) put(bucket, id, { ms: Number.MAX_SAFE_INTEGER, due: false });
          if (opts.todayIncludesTag && tagId && this.snap.tagIdsOf(id).includes(tagId)) put(bucket, id, { ms: Number.MAX_SAFE_INTEGER, due: false });
        }
      }
      out.push(makeDay(key === today ? "TODAY" : key, key, key === today ? "Today" : this.dayTitle(key), bucket));
    }
    out.push(makeDay("FUTURE", null, "Future", future));

    // Calendar: 5 weeks from the start of the current week.
    const weekday = new Date(dayKeyToNaive(today)).getUTCDay();
    const startKey = addDaysToKey(today, -((weekday - (this.settings.firstWeekday - 1) + 7) % 7));
    const calendar = Array.from({ length: 35 }, (_, i) => {
      const date = addDaysToKey(startKey, i);
      const bucket = byDay.get(date);
      let dueCount = 0;
      for (const e of bucket?.values() ?? []) if (e.due) dueCount++;
      return { date, dueCount, count: bucket?.size ?? 0 };
    });
    return { today, days: out, calendar };
  }

  /** Flat rows plus their non-project ancestors as context (organized + preserve hierarchy). */
  withAncestors(ids: string[]): OutlineRow[] {
    const wanted = new Set<string>();
    for (const id of ids) {
      let cur: string | null = id;
      while (cur !== null && !wanted.has(cur)) {
        wanted.add(cur);
        const parent: string | null = this.snap.tasks.get(cur)?.parentId ?? null;
        cur = parent !== null && !this.snap.isProject(parent) ? parent : null;
      }
    }
    const rows: OutlineRow[] = [];
    const topLevel = [...wanted].filter((id) => {
      const p = this.snap.tasks.get(id)!.parentId;
      return p === null || !wanted.has(p);
    });
    topLevel.sort((a, b) => this.state(a).order - this.state(b).order);
    const visit = (id: string, depth: number): void => {
      rows.push(this.row(id, depth));
      for (const c of this.snap.childrenOf(id)) if (wanted.has(c.id)) visit(c.id, depth + 1);
    };
    for (const id of topLevel) visit(id, 0);
    return rows;
  }

  // -------------------------------------------------------------------------
  // Quick Open
  // -------------------------------------------------------------------------

  quickOpen(q: string, perspectives: Perspective[]): QuickOpenResult[] {
    const needle = q.trim();
    if (!needle) return [];
    const out: QuickOpenResult[] = [];
    const consider = (type: QuickOpenResult["type"], id: string, name: string): void => {
      const m = fuzzyMatch(name, needle);
      if (m) out.push({ type, id, name, score: m.score, matches: m.matches });
    };
    for (const p of perspectives) consider("perspective", p.id, p.name);
    for (const f of this.snap.folders.values()) if (this.d.folders.get(f.id)?.effectiveActive) consider("folder", f.id, f.name);
    for (const p of this.projectRows()) {
      const st = this.d.projects.get(p.taskId)!.effectiveStatus;
      if (st === "active" || st === "onHold") consider("project", p.taskId, this.snap.tasks.get(p.taskId)!.name);
    }
    for (const t of this.snap.tags.values()) if (this.d.tags.get(t.id)?.effectiveStatus !== "dropped") consider("tag", t.id, t.name);
    out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return out.slice(0, 50);
  }
}

/**
 * Fuzzy subsequence match. Prefix matches rank highest, then word-start and contiguous substrings,
 * then scattered subsequences (fewer gaps score higher). `matches` are [start, endExclusive] ranges.
 */
export function fuzzyMatch(name: string, query: string): { score: number; matches: [number, number][] } | null {
  const hay = name.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return null;
  const lengthBonus = (needle.length / Math.max(hay.length, 1)) * 10;
  if (hay.startsWith(needle)) return { score: 100 + lengthBonus, matches: [[0, needle.length]] };
  const wordStart = new RegExp(`(^|[\\s\\-_:/.])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(hay);
  if (wordStart) {
    const start = wordStart.index + wordStart[1]!.length;
    return { score: 80 + lengthBonus, matches: [[start, start + needle.length]] };
  }
  const idx = hay.indexOf(needle);
  if (idx >= 0) return { score: 60 + lengthBonus, matches: [[idx, idx + needle.length]] };
  const matches: [number, number][] = [];
  let pos = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, pos);
    if (found < 0) return null;
    const last = matches.at(-1);
    if (last && last[1] === found) last[1] = found + 1;
    else matches.push([found, found + 1]);
    pos = found + 1;
  }
  return { score: Math.max(1, 40 - matches.length * 5) + lengthBonus, matches };
}

export function contentsFor(
  view: View,
  p: Perspective,
  params: ContentsParams,
): PerspectiveContents {
  const vo = p.viewOptions;
  let groups: OutlineGroup[];
  let emptyText: string | null = "No items";
  switch (p.builtin ? p.id : "custom") {
    case "inbox":
      groups = view.inbox(vo);
      break;
    case "projects": {
      const r = view.projects(vo, params);
      groups = r.groups;
      emptyText = r.emptyText;
      break;
    }
    case "tags":
      groups = view.tags(vo, params);
      break;
    case "flagged":
      groups = view.flagged(vo);
      break;
    case "review":
      // With a selected project, the Review outline shows that one project for editing, always with the
      // Remaining filter: Review has no view options (docs/spec.md §3).
      if (params.project) {
        const r = view.projects({ filter: "remaining" }, { project: params.project });
        groups = r.groups;
        emptyText = r.emptyText;
      } else {
        groups = view.review();
        emptyText = "No projects";
      }
      break;
    case "completed":
      groups = view.history("completed");
      break;
    case "changed":
      groups = view.history("modified");
      break;
    case "search":
      groups = params.q ? view.searchGroups(params.q, vo.filter ?? "remaining") : [];
      emptyText = params.q ? "No results" : null;
      break;
    case "forecast": {
      const f = view.forecast(vo, undefined, 7);
      groups = f.days
        .filter((d) => !params.day || d.key === params.day || d.date === params.day)
        .filter((d) => params.day || d.rows.length > 0)
        .map((d) => ({ key: d.key, title: d.title, kind: "date" as const, rows: d.rows }));
      break;
    }
    default:
      groups = view.custom(p);
      break;
  }
  return { perspectiveId: p.id, viewOptions: vo, groups, emptyText: groups.length === 0 ? emptyText : null };
}
