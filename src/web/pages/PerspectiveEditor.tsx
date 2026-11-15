import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { Perspective } from "../../shared/schemas";
import { actions, useFolders, usePerspectives, useProjects, useTags } from "../api/queries";
import { Icon, PERSPECTIVE_ICONS } from "../components/Icons";
import { Dialog } from "../components/Overlay";
import { toast } from "../components/Toasts";
import { Workspace } from "../components/Workspace";
import { newId } from "../lib/drafts";
import { flattenTree } from "../lib/entities";
import { sortPerspectives } from "../lib/perspectives";
import {
  BOOLEAN_RULES,
  DATE_CONDITIONS,
  DATE_FIELDS,
  RULE_KIND_LABELS,
  buildDateRule,
  dateCondition,
  defaultRule,
  inner,
  isDisabled,
  moveAt,
  replaceInner,
  ruleKind,
  setEnabled,
  updateAt,
  type DateCondition,
  type Rule,
  type RuleKind,
} from "../lib/rules";

const COLORS = ["#4f6fd1", "#3f8a6b", "#c4372f", "#e08a12", "#8a5cb8", "#2f5d62", "#b5487a", "#56707d", "#7a6a52", "#1f8fb5"];

type Aggregation = Perspective["aggregation"];
type Presentation = Perspective["presentation"];

interface Draft {
  name: string;
  icon: string;
  color: string | null;
  favorite: boolean;
  aggregation: Aggregation;
  rules: Rule[];
  presentation: Presentation;
}

function toDraft(p: Perspective): Draft {
  return { name: p.name, icon: p.icon, color: p.color, favorite: p.favorite, aggregation: p.aggregation, rules: p.rules, presentation: p.presentation };
}

function Select<T extends string | number>({ value, onChange, options, label, className = "" }: { value: T; onChange: (v: T) => void; options: Array<[T, string]>; label: string; className?: string }) {
  return (
    <select
      className={`pb-input w-auto ${className}`}
      aria-label={label}
      value={String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        onChange((typeof value === "number" ? Number(raw) : raw) as T);
      }}
    >
      {options.map(([v, l]) => (
        <option key={String(v)} value={String(v)}>
          {l}
        </option>
      ))}
    </select>
  );
}

function IdChecklist({ label, items, selected, onChange }: { label: string; items: Array<{ id: string; name: string; depth: number; icon: string }>; selected: string[]; onChange: (ids: string[]) => void }) {
  return (
    <fieldset className="pb-scroll max-h-56 rounded-lg border border-line p-1">
      <legend className="sr-only">{label}</legend>
      {items.length === 0 && <p className="p-2 text-sm text-muted">Nothing to choose from.</p>}
      {items.map((i) => (
        <label key={i.id} className="flex min-h-[44px] items-center gap-2 rounded px-2 text-sm hover:bg-surface-2 md:min-h-[36px]" style={{ paddingLeft: 8 + i.depth * 14 }}>
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={selected.includes(i.id)}
            onChange={(e) => onChange(e.target.checked ? [...selected, i.id] : selected.filter((x) => x !== i.id))}
          />
          <Icon name={i.icon} size={14} className="text-muted" />
          {i.name}
        </label>
      ))}
    </fieldset>
  );
}

function RuleParams({ rule, onChange }: { rule: Rule; onChange: (r: Rule) => void }) {
  const { data: tags = [] } = useTags();
  const { data: projects = [] } = useProjects();
  const { data: folders = [] } = useFolders();
  const r = inner(rule);
  const kind = ruleKind(rule);
  const set = (next: Rule) => onChange(replaceInner(rule, next));
  switch (kind) {
    case "availability":
      return (
        <Select
          label="Availability"
          value={String(r.actionAvailability)}
          onChange={(v) => set({ actionAvailability: v })}
          options={[
            ["firstAvailable", "First available"],
            ["available", "Available"],
            ["remaining", "Remaining"],
            ["completed", "Completed"],
            ["dropped", "Dropped"],
          ]}
        />
      );
    case "status":
      return (
        <Select
          label="Status"
          value={String(r.actionStatus)}
          onChange={(v) => set({ actionStatus: v })}
          options={[
            ["due", "Due or due soon"],
            ["flagged", "Flagged"],
          ]}
        />
      );
    case "boolean":
      return (
        <Select label="Property" value={Object.keys(r)[0] ?? "actionHasDueDate"} onChange={(k) => set({ [k]: true })} options={BOOLEAN_RULES.map((b) => [b.key, b.label])} />
      );
    case "withinDuration":
      return (
        <Select
          label="Duration"
          value={Number(r.actionWithinDuration) || 30}
          onChange={(v) => set({ actionWithinDuration: v })}
          options={[5, 15, 30, 60, 120, 240].map((m) => [m, m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`])}
        />
      );
    case "date": {
      const cond = dateCondition(rule);
      const field = String(r.actionDateField ?? "due");
      const rel = (r.actionDateIsInThePast ?? r.actionDateIsInTheNext) as { relativeBeforeAmount?: number; relativeAfterAmount?: number; relativeComponent?: string } | undefined;
      const amount = rel?.relativeBeforeAmount ?? rel?.relativeAfterAmount ?? 1;
      const component = rel?.relativeComponent ?? "week";
      const setRel = (a: number, c: string) =>
        set({ actionDateField: field, [cond]: cond === "actionDateIsInThePast" ? { relativeBeforeAmount: a, relativeComponent: c } : { relativeAfterAmount: a, relativeComponent: c } });
      const spec = (key: string) => String((r[key] as { dynamic?: string } | undefined)?.dynamic ?? "");
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Select label="Date field" value={field} onChange={(f) => set(buildDateRule(f, cond, r))} options={DATE_FIELDS.map((f) => [f, `${f[0]?.toUpperCase()}${f.slice(1)} date`])} />
          <Select<DateCondition> label="Date condition" value={cond} onChange={(c) => set(buildDateRule(field, c, r))} options={DATE_CONDITIONS.map((c) => [c.key, c.label])} />
          {(cond === "actionDateIsInThePast" || cond === "actionDateIsInTheNext") && (
            <>
              <input type="number" min={1} className="pb-input w-20" aria-label="Amount" value={amount} onChange={(e) => setRel(Math.max(1, Number(e.target.value) || 1), component)} />
              <Select label="Unit" value={component} onChange={(c) => setRel(amount, c)} options={["hour", "day", "week", "month", "year"].map((u) => [u, `${u}s`])} />
            </>
          )}
          {cond === "actionDateIsOnDateSpec" && (
            <input className="pb-input w-40" aria-label="Date" placeholder="e.g. today, dec 25" value={spec("actionDateIsOnDateSpec")} onChange={(e) => set({ ...r, actionDateIsOnDateSpec: { dynamic: e.target.value } })} />
          )}
          {cond === "between" && (
            <>
              <input className="pb-input w-32" aria-label="From date" value={spec("actionDateIsAfterDateSpec")} onChange={(e) => set({ ...r, actionDateIsAfterDateSpec: { dynamic: e.target.value } })} />
              <span className="text-sm">and</span>
              <input className="pb-input w-32" aria-label="To date" value={spec("actionDateIsBeforeDateSpec")} onChange={(e) => set({ ...r, actionDateIsBeforeDateSpec: { dynamic: e.target.value } })} />
            </>
          )}
        </div>
      );
    }
    case "tagStatus":
      return (
        <Select
          label="Tag status"
          value={String(r.actionHasTagWithStatus)}
          onChange={(v) => set({ actionHasTagWithStatus: v })}
          options={[
            ["active", "Active"],
            ["remaining", "Remaining"],
            ["onHold", "On hold"],
            ["dropped", "Dropped"],
            ["stalled", "Stalled"],
          ]}
        />
      );
    case "anyTags":
    case "allTags": {
      const key = kind === "anyTags" ? "actionHasAnyOfTags" : "actionHasAllOfTags";
      return (
        <IdChecklist
          label="Tags"
          items={flattenTree(tags).map(({ item, depth }) => ({ id: item.id, name: item.name, depth, icon: "tag" }))}
          selected={Array.isArray(r[key]) ? (r[key] as string[]) : []}
          onChange={(ids) => set({ [key]: ids })}
        />
      );
    }
    case "projectStatus":
      return (
        <Select
          label="Project status"
          value={String(r.actionHasProjectWithStatus)}
          onChange={(v) => set({ actionHasProjectWithStatus: v })}
          options={[
            ["active", "Active"],
            ["remaining", "Remaining"],
            ["onHold", "On hold"],
            ["completed", "Completed"],
            ["dropped", "Dropped"],
            ["stalled", "Stalled"],
            ["pending", "Pending"],
          ]}
        />
      );
    case "focus":
      return (
        <IdChecklist
          label="Projects and folders"
          items={[
            ...flattenTree(folders).map(({ item, depth }) => ({ id: item.id, name: item.name, depth, icon: "folder" })),
            ...projects.map((p) => ({ id: p.id, name: p.task.name, depth: 0, icon: "project-parallel" })),
          ]}
          selected={Array.isArray(r.actionWithinFocus) ? (r.actionWithinFocus as string[]) : []}
          onChange={(ids) => set({ actionWithinFocus: ids })}
        />
      );
    case "search":
      return (
        <input
          className="pb-input"
          aria-label="Search terms"
          placeholder="Terms, separated by commas"
          defaultValue={Array.isArray(r.actionMatchingSearch) ? (r.actionMatchingSearch as string[]).join(", ") : ""}
          onBlur={(e) =>
            set({
              actionMatchingSearch: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      );
    default:
      return null;
  }
}

function RuleList({ rules, path, onRules, depth }: { rules: Rule[]; path: number[]; onRules: (fn: (rules: Rule[]) => Rule[]) => void; depth: number }) {
  return (
    <ol className="flex flex-col gap-2">
      {rules.map((rule, i) => (
        <RuleNode key={`${path.join(".")}.${i}`} rule={rule} path={[...path, i]} onRules={onRules} depth={depth} first={i === 0} last={i === rules.length - 1} />
      ))}
    </ol>
  );
}

function AddRule({ onAdd, label = "Add rule" }: { onAdd: (r: Rule) => void; label?: string }) {
  return (
    <select
      className="pb-input w-auto self-start text-sm text-accent"
      aria-label={label}
      value=""
      onChange={(e) => {
        if (e.target.value) onAdd(defaultRule(e.target.value as Exclude<RuleKind, "unknown">));
      }}
    >
      <option value="">+ {label}…</option>
      {RULE_KIND_LABELS.map((k) => (
        <option key={k.kind} value={k.kind}>
          {k.label}
        </option>
      ))}
    </select>
  );
}

function RuleNode({ rule, path, onRules, depth, first, last }: { rule: Rule; path: number[]; onRules: (fn: (rules: Rule[]) => Rule[]) => void; depth: number; first: boolean; last: boolean }) {
  const kind = ruleKind(rule);
  const disabled = isDisabled(rule);
  const r = inner(rule);
  const replace = (next: Rule | null) => onRules((rules) => updateAt(rules, path, () => next));
  return (
    <li data-testid="rule" data-rule-kind={kind} className={`rounded-xl border border-line p-3 ${depth > 0 ? "bg-surface-2/40" : "bg-surface"} ${disabled ? "opacity-55" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={!disabled} onChange={(e) => replace(setEnabled(rule, e.target.checked))} aria-label="Rule enabled" />
        </label>
        {kind === "unknown" ? (
          <span className="flex-1 text-sm text-muted">Unsupported rule (kept)</span>
        ) : (
          <select
            className="pb-input w-auto"
            aria-label="Rule type"
            value={kind}
            onChange={(e) => replace(replaceInner(rule, defaultRule(e.target.value as Exclude<RuleKind, "unknown">)))}
          >
            {RULE_KIND_LABELS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        )}
        {kind === "group" && (
          <Select
            label="Group matches"
            value={String(r.aggregateType ?? "any") as Aggregation}
            onChange={(v) => replace(replaceInner(rule, { ...r, aggregateType: v }))}
            options={[
              ["all", "All of"],
              ["any", "Any of"],
              ["none", "None of"],
            ]}
          />
        )}
        <span className="flex-1" />
        <button type="button" className="pb-icon-btn" aria-label="Move rule up" disabled={first} onClick={() => onRules((rules) => moveAt(rules, path, -1))}>
          <Icon name="arrow-up" size={16} />
        </button>
        <button type="button" className="pb-icon-btn" aria-label="Move rule down" disabled={last} onClick={() => onRules((rules) => moveAt(rules, path, 1))}>
          <Icon name="arrow-down" size={16} />
        </button>
        <button type="button" className="pb-icon-btn hover:text-danger" aria-label="Remove rule" onClick={() => replace(null)}>
          <Icon name="trash" size={16} />
        </button>
      </div>
      {kind !== "group" && kind !== "unknown" && (
        <div className="mt-2">
          <RuleParams rule={rule} onChange={(next) => replace(next)} />
        </div>
      )}
      {kind === "group" && (
        <div className="mt-3 flex flex-col gap-2 border-l-2 border-accent/40 pl-3">
          <RuleList rules={Array.isArray(r.aggregateRules) ? (r.aggregateRules as Rule[]) : []} path={path} onRules={onRules} depth={depth + 1} />
          <AddRule
            label="Add rule to group"
            onAdd={(child) =>
              replace(replaceInner(rule, { ...r, aggregateRules: [...(Array.isArray(r.aggregateRules) ? (r.aggregateRules as Rule[]) : []), child] }))
            }
          />
        </div>
      )}
    </li>
  );
}

/** Draft shown for `/perspectives/new/edit`; nothing is stored until Save. */
const NEW_PERSPECTIVE: Perspective = {
  id: "new",
  builtin: false,
  name: "New Perspective",
  icon: "layers",
  color: "#4f6fd1",
  favorite: true,
  rank: 0,
  aggregation: "all",
  rules: [{ actionAvailability: "available" }],
  presentation: { layout: "projects", grouping: "none", sorting: "manual", sidebar: "projects" },
  viewOptions: {},
};

export function PerspectiveEditorPage() {
  const { id = "" } = useParams();
  const { data: perspectives } = usePerspectives();
  if (id === "new") return <PerspectiveEditor key="new" perspective={NEW_PERSPECTIVE} perspectives={perspectives ?? []} isNew />;
  const perspective = perspectives?.find((p) => p.id === id);
  if (!perspectives) return <p className="p-8 text-center text-muted">Loading…</p>;
  if (!perspective) return <p className="p-8 text-center text-muted">Perspective not found.</p>;
  if (perspective.builtin) {
    return (
      <Workspace title={perspective.name} icon="layers" inspector={false} canCleanUp={false} canCreate={false} canReorder={false}>
        <p className="p-8 text-center text-muted">Built-in perspectives cannot be edited.</p>
      </Workspace>
    );
  }
  return <PerspectiveEditor key={id} perspective={perspective} perspectives={perspectives} />;
}

function PerspectiveEditor({ perspective, perspectives, isNew = false }: { perspective: Perspective; perspectives: Perspective[]; isNew?: boolean }) {
  const id = perspective.id;
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(() => toDraft(perspective));
  const [dirty, setDirty] = useState(isNew);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  const onRules = (fn: (rules: Rule[]) => Rule[]) => update({ rules: fn(draft.rules) });

  function save() {
    if (isNew) {
      const newPerspectiveId = newId();
      void actions.createPerspective({ id: newPerspectiveId, ...draft });
      toast("Perspective saved");
      navigate(`/perspectives/${encodeURIComponent(newPerspectiveId)}/edit`, { replace: true });
      return;
    }
    void actions.patchPerspective(id, { ...draft });
    setDirty(false);
    toast("Perspective saved");
  }

  function duplicate() {
    const copyId = newId();
    void actions.createPerspective({ id: copyId, ...draft, name: `${draft.name} copy` });
    navigate(`/perspectives/${encodeURIComponent(copyId)}/edit`);
  }

  function reorder(delta: -1 | 1) {
    const sorted = sortPerspectives(perspectives ?? []);
    const idx = sorted.findIndex((p) => p.id === id);
    const other = sorted[idx + delta];
    const me = sorted[idx];
    if (!other || !me) return;
    void actions.patchPerspective(me.id, { rank: other.rank });
    void actions.patchPerspective(other.id, { rank: me.rank });
  }

  const presentation = draft.presentation;
  const setPresentation = (patch: Partial<Presentation>) => update({ presentation: { ...presentation, ...patch } });

  return (
    <Workspace title={`Edit “${perspective.name}”`} icon={draft.icon} color={draft.color ?? undefined} inspector={false} canCleanUp={false} canCreate={false} canReorder={false}>
      <form
        className="mx-auto flex max-w-2xl flex-col gap-6 p-4 pb-24"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <section className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="pb-label">Name</span>
            <input className="pb-input text-base" value={draft.name} onChange={(e) => update({ name: e.target.value })} required aria-label="Perspective name" />
          </label>
          <div>
            <span className="pb-label">Icon</span>
            <div role="radiogroup" aria-label="Icon" className="mt-1 flex flex-wrap gap-1">
              {PERSPECTIVE_ICONS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  role="radio"
                  aria-checked={draft.icon === icon}
                  aria-label={icon}
                  onClick={() => update({ icon })}
                  className={`flex h-11 w-11 items-center justify-center rounded-lg border ${draft.icon === icon ? "border-accent bg-accent-soft" : "border-line"}`}
                  style={{ color: draft.color ?? undefined }}
                >
                  <Icon name={icon} />
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="pb-label">Colour</span>
            <div role="radiogroup" aria-label="Colour" className="mt-1 flex flex-wrap items-center gap-1.5">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === c}
                  aria-label={c}
                  onClick={() => update({ color: c })}
                  className={`h-11 w-11 rounded-full border-2 ${draft.color === c ? "border-fg" : "border-transparent"}`}
                  style={{ background: c }}
                />
              ))}
              <input type="color" aria-label="Custom colour" className="h-11 w-12 cursor-pointer rounded border border-line bg-transparent md:h-10" value={draft.color ?? "#4f6fd1"} onChange={(e) => update({ color: e.target.value })} />
            </div>
          </div>
          <label className="flex min-h-[44px] items-center gap-2">
            <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={draft.favorite} onChange={(e) => update({ favorite: e.target.checked })} />
            <Icon name="star" size={18} filled={draft.favorite} className="text-gold" />
            Show in the perspectives bar (favourite)
          </label>
        </section>

        <section className="flex flex-col gap-3" aria-label="Rules">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Actions matching</h2>
            <Select<Aggregation>
              label="Top-level aggregation"
              value={draft.aggregation}
              onChange={(aggregation) => update({ aggregation })}
              options={[
                ["all", "all"],
                ["any", "any"],
                ["none", "none"],
              ]}
            />
            <span className="text-base font-semibold">of these rules</span>
          </div>
          {draft.rules.length === 0 && <p className="text-sm text-muted">No rules: the perspective shows all remaining actions.</p>}
          <RuleList rules={draft.rules} path={[]} onRules={onRules} depth={0} />
          <AddRule onAdd={(r) => update({ rules: [...draft.rules, r] })} />
        </section>

        <section className="grid gap-3 sm:grid-cols-2" aria-label="Presentation">
          <label className="flex flex-col gap-1">
            <span className="pb-label">Layout</span>
            <Select label="Layout" value={presentation.layout} onChange={(layout) => setPresentation({ layout })} options={[["projects", "Projects hierarchy"], ["flat", "Individual actions"]]} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="pb-label">Sidebar</span>
            <Select label="Sidebar" value={presentation.sidebar} onChange={(sidebar) => setPresentation({ sidebar })} options={[["projects", "Projects"], ["tags", "Tags"], ["none", "None"]]} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="pb-label">Group by</span>
            <Select
              label="Group by"
              value={presentation.grouping}
              onChange={(grouping) => setPresentation({ grouping })}
              options={[
                ["none", "None"],
                ["tag", "Tag"],
                ["tagsCombined", "Tags (combined)"],
                ["project", "Project"],
                ["folder", "Folder"],
                ["due", "Due date"],
                ["defer", "Defer date"],
                ["planned", "Planned date"],
                ["completed", "Completed date"],
                ["dropped", "Dropped date"],
                ["added", "Added date"],
                ["changed", "Changed date"],
                ["flagged", "Flagged"],
              ]}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="pb-label">Sort by</span>
            <Select
              label="Sort by"
              value={presentation.sorting}
              onChange={(sorting) => setPresentation({ sorting })}
              options={[
                ["manual", "Manual"],
                ["due", "Due"],
                ["defer", "Defer"],
                ["planned", "Planned"],
                ["completed", "Completed"],
                ["added", "Added"],
                ["changed", "Changed"],
                ["flagged", "Flagged"],
                ["duration", "Duration"],
                ["name", "Name"],
              ]}
            />
          </label>
        </section>

        <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] flex flex-wrap gap-2 rounded-xl border border-line bg-surface/95 p-2 shadow-pop backdrop-blur md:bottom-2">
          <button type="submit" className="pb-btn pb-btn-primary" disabled={!dirty}>
            Save
          </button>
          {isNew ? (
            <button
              type="button"
              className="pb-btn"
              onClick={() => {
                // react-router records the in-app history index; a directly opened editor has nowhere to go back to.
                const state: unknown = window.history.state;
                const idx = state && typeof state === "object" && "idx" in state ? state.idx : 0;
                if (typeof idx === "number" && idx > 0) navigate(-1);
                else navigate("/", { replace: true });
              }}
            >
              Cancel
            </button>
          ) : (
            <>
              <button type="button" className="pb-btn" onClick={() => navigate(`/perspectives/${encodeURIComponent(id)}`)}>
                View
              </button>
              <button type="button" className="pb-btn" onClick={duplicate}>
                <Icon name="duplicate" size={16} /> Duplicate
              </button>
              <button type="button" className="pb-btn" aria-label="Move perspective up" onClick={() => reorder(-1)}>
                <Icon name="arrow-up" size={16} />
              </button>
              <button type="button" className="pb-btn" aria-label="Move perspective down" onClick={() => reorder(1)}>
                <Icon name="arrow-down" size={16} />
              </button>
              <span className="flex-1" />
              <button type="button" className="pb-btn pb-btn-danger" onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" size={16} /> Delete
              </button>
            </>
          )}
        </div>
      </form>
      {confirmDelete && (
        <Dialog
          title="Delete perspective?"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button type="button" className="pb-btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="pb-btn bg-danger text-white"
                onClick={() => {
                  setConfirmDelete(false);
                  void actions.deletePerspective(id);
                  navigate("/");
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p className="p-4 text-sm">“{perspective.name}” will be deleted. You can undo this.</p>
        </Dialog>
      )}
    </Workspace>
  );
}
