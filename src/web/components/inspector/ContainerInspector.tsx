import { actions, attempt, useFolders, useSettingsValue, useTags } from "../../api/queries";
import { CommitInput, ReadOnly, Section, Segmented } from "./Fields";

/** Folder and tag inspectors (docs/spec.md §3). */
export function ContainerInspector({ kind, id }: { kind: "folder" | "tag"; id: string }) {
  const settings = useSettingsValue();
  const { data: folders } = useFolders();
  const { data: tags } = useTags();
  const item = kind === "folder" ? folders?.find((f) => f.id === id) : tags?.find((t) => t.id === id);
  if (!item) return <p className="p-6 text-center text-muted">This item no longer exists.</p>;
  const patch = (p: { name?: string; note?: string; status?: string; childrenMutuallyExclusive?: boolean }) =>
    void attempt(kind === "folder" ? actions.patchFolder(id, p as Parameters<typeof actions.patchFolder>[1]) : actions.patchTag(id, p as Parameters<typeof actions.patchTag>[1]));
  const tag = kind === "tag" ? tags?.find((t) => t.id === id) : undefined;

  return (
    <div data-testid="inspector" className="pb-6">
      <div className="border-b border-line px-4 pb-3 pt-4">
        <p className="pb-label mb-1.5">{kind === "folder" ? "Folder" : "Tag"}</p>
        <CommitInput key={`name-${id}`} value={item.name} label="Title" className="text-base font-semibold" onCommit={(name) => patch({ name })} />
      </div>
      <Section title="Status">
        {kind === "folder" ? (
          <Segmented
            label="Folder status"
            value={item.status as "active" | "dropped"}
            onChange={(status) => patch({ status })}
            options={[
              { value: "active", label: "Active" },
              { value: "dropped", label: "Dropped" },
            ]}
          />
        ) : (
          <Segmented
            label="Tag status"
            value={item.status as "active" | "onHold" | "dropped"}
            onChange={(status) => patch({ status })}
            options={[
              { value: "active", label: "Active" },
              { value: "onHold", label: "On Hold" },
              { value: "dropped", label: "Dropped" },
            ]}
          />
        )}
        {tag && (
          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--accent)]"
              checked={tag.childrenMutuallyExclusive}
              onChange={(e) => patch({ childrenMutuallyExclusive: e.target.checked })}
            />
            Child tags are mutually exclusive
          </label>
        )}
        {tag && (
          <p className="text-sm text-muted">
            {tag.availableCount} available · {tag.remainingCount} remaining
          </p>
        )}
      </Section>
      <Section title="Note">
        <CommitInput key={`note-${id}`} id="pb-inspector-note" value={item.note} label="Note" placeholder="Add a note" multiline onCommit={(note) => patch({ note })} />
      </Section>
      <Section title="Dates">
        <ReadOnly label="Added" value={item.added} settings={settings} />
        <ReadOnly label="Changed" value={item.modified} settings={settings} />
      </Section>
    </div>
  );
}
