import type { perspectives } from "../db/schema.js";
import { BUILTIN_PERSPECTIVES } from "../shared/schemas.js";

export type BuiltinPerspectiveId = (typeof BUILTIN_PERSPECTIVES)[number];

interface BuiltinMeta {
  name: string;
  icon: string;
  favorite: boolean;
  viewOptions: Record<string, unknown>;
}

/** Default presentation of every built-in perspective (docs/spec.md §4). */
export const BUILTIN_META: Record<BuiltinPerspectiveId, BuiltinMeta> = {
  inbox: { name: "Inbox", icon: "inbox", favorite: true, viewOptions: { filter: "remaining" } },
  projects: {
    name: "Projects",
    icon: "projects",
    favorite: true,
    viewOptions: { filter: "remaining", showInbox: false, showFolders: false },
  },
  tags: { name: "Tags", icon: "tags", favorite: true, viewOptions: { filter: "available", sortByDueAndFlagged: false } },
  forecast: {
    name: "Forecast",
    icon: "forecast",
    favorite: true,
    viewOptions: {
      forecast: {
        includePlanned: true,
        includeDefer: false,
        includeNotification: false,
        includeOnHold: false,
        todayIncludesFlagged: false,
        todayIncludesTag: true,
        organized: false,
        preserveHierarchy: false,
        keepSorted: true,
      },
    },
  },
  flagged: { name: "Flagged", icon: "flagged", favorite: true, viewOptions: { filter: "available", grouping: "none" } },
  review: { name: "Review", icon: "review", favorite: true, viewOptions: { filter: "remaining" } },
  completed: { name: "Completed", icon: "completed", favorite: false, viewOptions: { filter: "all" } },
  changed: { name: "Changed", icon: "changed", favorite: false, viewOptions: { filter: "all" } },
  search: { name: "Search", icon: "search", favorite: false, viewOptions: { filter: "remaining" } },
};

export const BUILTIN_RANK_STEP = 65536;

/** Rows for the built-in perspectives (pure). Used to seed the table on first use and by the importer. */
export function builtinPerspectiveRows(nowIso: string): (typeof perspectives.$inferInsert)[] {
  return BUILTIN_PERSPECTIVES.map((id, i) => {
    const meta = BUILTIN_META[id];
    return {
      id,
      builtin: true,
      name: meta.name,
      icon: meta.icon,
      color: null,
      favorite: meta.favorite,
      rank: i * BUILTIN_RANK_STEP,
      aggregation: "all" as const,
      rulesJson: "[]",
      presentationJson: "{}",
      viewOptionsJson: JSON.stringify(meta.viewOptions),
      importExtrasJson: null,
      added: nowIso,
      modified: nowIso,
    };
  });
}
