import type { Perspective, ViewOptions } from "../../shared/schemas";
import { actions, useSettingsValue, useTags } from "../api/queries";

type Filter = NonNullable<ViewOptions["filter"]>;
type Grouping = NonNullable<ViewOptions["grouping"]>;

const FILTERS: Array<{ value: Filter; label: string; hint: string }> = [
  { value: "next", label: "First Available", hint: "The first available action in each project" },
  { value: "available", label: "Available", hint: "Items not blocked, deferred, or on hold" },
  { value: "remaining", label: "Remaining", hint: "Items not completed or dropped" },
  { value: "all", label: "Everything", hint: "Including completed and dropped items" },
];

const FLAGGED_GROUPS: Array<{ value: Grouping; label: string }> = [
  { value: "none", label: "Ungrouped" },
  { value: "tag", label: "Tag" },
  { value: "tagsCombined", label: "Tags (Combined)" },
  { value: "project", label: "Project" },
  { value: "due", label: "Due Date" },
  { value: "planned", label: "Planned Date" },
  { value: "defer", label: "Defer Date" },
  { value: "completed", label: "Completed Date" },
  { value: "dropped", label: "Dropped Date" },
  { value: "added", label: "Added Date" },
  { value: "changed", label: "Changed Date" },
];

export const DEFAULT_FILTER: Record<string, Filter> = { inbox: "remaining", flagged: "available", projects: "remaining", tags: "available" };

function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex min-h-[44px] items-start gap-3 py-1.5">
      <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-sm">
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** View options popover content (V), saved per perspective on the server (docs/spec.md §4). */
export function ViewOptionsPanel({ perspective }: { perspective: Perspective }) {
  const { data: tags = [] } = useTags();
  const settings = useSettingsValue();
  const vo = perspective.viewOptions;
  const id = perspective.id;
  const save = (patch: Partial<ViewOptions>) => void actions.setViewOptions(id, { ...vo, ...patch });
  const filter = vo.filter ?? DEFAULT_FILTER[id] ?? "remaining";
  const filters = id === "inbox" ? FILTERS.filter((f) => f.value !== "next") : FILTERS;

  if (id === "forecast") {
    const f = vo.forecast ?? {};
    const set = (patch: Partial<NonNullable<ViewOptions["forecast"]>>) => save({ forecast: { ...f, ...patch } });
    return (
      <div className="flex flex-col gap-1 p-4" data-testid="view-options">
        <h3 className="pb-label">In Forecast, include</h3>
        <Check label="Items on planned dates" checked={f.includePlanned ?? true} onChange={(v) => set({ includePlanned: v })} />
        <Check label="Items on defer dates" checked={f.includeDefer ?? false} onChange={(v) => set({ includeDefer: v })} />
        <Check label="Items on notification date" checked={f.includeNotification ?? false} onChange={(v) => set({ includeNotification: v })} />
        <Check label="On hold projects" checked={f.includeOnHold ?? false} onChange={(v) => set({ includeOnHold: v })} />
        <h3 className="pb-label mt-2">Today includes</h3>
        <Check label="Flagged items" checked={f.todayIncludesFlagged ?? false} onChange={(v) => set({ todayIncludesFlagged: v })} />
        <Check label="Items tagged with the Forecast tag" checked={f.todayIncludesTag ?? true} onChange={(v) => set({ todayIncludesTag: v })} />
        <label className="flex flex-col gap-1 py-1 text-sm">
          <span className="text-muted">Forecast tag</span>
          <select
            className="pb-input"
            value={settings.forecastTagId ?? ""}
            aria-label="Forecast tag"
            onChange={(e) => void actions.patchSettings({ forecastTagId: e.target.value || null })}
          >
            <option value="">None</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <h3 className="pb-label mt-2">Structure</h3>
        <div className="pb-seg" role="group" aria-label="Structure">
          <button type="button" aria-pressed={!f.organized} onClick={() => set({ organized: false })}>
            Flexible
          </button>
          <button type="button" aria-pressed={!!f.organized} onClick={() => set({ organized: true })}>
            Organized
          </button>
        </div>
        <Check label="Preserve hierarchy" checked={f.preserveHierarchy ?? false} onChange={(v) => set({ preserveHierarchy: v })} />
        <Check label="Keep sorted" checked={f.keepSorted ?? true} onChange={(v) => set({ keepSorted: v })} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-4" data-testid="view-options">
      <h3 className="pb-label mb-1">Filter</h3>
      <div role="radiogroup" aria-label="Filter" className="flex flex-col">
        {filters.map((f) => (
          <label key={f.value} className="flex min-h-[44px] items-start gap-3 py-1.5">
            <input type="radio" name="pb-filter" className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]" checked={filter === f.value} onChange={() => save({ filter: f.value })} />
            <span className="text-sm">
              {f.label}
              <span className="block text-xs text-muted">{id === "inbox" && f.value === "available" ? "Items not blocked or deferred" : f.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {id === "projects" && (
        <>
          <h3 className="pb-label mt-2">Structure</h3>
          <Check label="Show Inbox" checked={vo.showInbox ?? false} onChange={(v) => save({ showInbox: v })} />
          <Check label="Show folders in outline" checked={vo.showFolders ?? false} onChange={(v) => save({ showFolders: v })} />
        </>
      )}
      {id === "tags" && <Check label="Sort by due date and flagged" checked={vo.sortByDueAndFlagged ?? false} onChange={(v) => save({ sortByDueAndFlagged: v })} />}
      {id === "flagged" && (
        <label className="mt-2 flex flex-col gap-1">
          <span className="pb-label">Group actions by</span>
          <select className="pb-input" aria-label="Group actions by" value={vo.grouping ?? "none"} onChange={(e) => save({ grouping: e.target.value as Grouping })}>
            {FLAGGED_GROUPS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** Perspectives whose view options are user-adjustable (custom perspectives use their saved settings). */
export function hasViewOptions(id: string): boolean {
  return ["inbox", "projects", "tags", "flagged", "forecast"].includes(id);
}
