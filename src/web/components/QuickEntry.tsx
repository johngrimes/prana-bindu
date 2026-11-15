import { useState } from "react";
import { actions, useFolders, useProjects, useSettingsValue, useTags } from "../api/queries";
import { formatDateTime } from "../lib/dates";
import { newId } from "../lib/drafts";
import { projectChoices, tagChoices } from "../lib/entities";
import { resolveDateInput } from "../lib/optimistic";
import { ui } from "../lib/ui";
import { Icon } from "./Icons";
import { Dialog } from "./Overlay";
import { SmartMatch } from "./SmartMatch";
import { toast } from "./Toasts";

/** Quick Entry (C): adds an item to the Inbox, or to the start of the chosen project. */
export function QuickEntry() {
  const settings = useSettingsValue();
  const { data: projects } = useProjects();
  const { data: folders } = useFolders();
  const { data: tags } = useTags();
  const [name, setName] = useState("");
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);
  const [tagList, setTagList] = useState<Array<{ id: string; name: string }>>([]);
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [flagged, setFlagged] = useState(false);
  const [dueError, setDueError] = useState<string | null>(null);
  const close = () => ui.set({ quickEntry: false });
  const duePreview = due.trim() ? resolveDateInput(due, "due", settings) : null;

  function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (!name.trim()) return;
    // Parse the due date before closing so a fast save never loses it, and send the parsed date, so a queued
    // or retried save cannot resolve "tomorrow" differently.
    if (duePreview === undefined) {
      setDueError("Unable to parse date");
      return;
    }
    void actions.createTask({
      id: newId(),
      name: name.trim(),
      note: note || undefined,
      flagged,
      dueDate: duePreview,
      tagIds: tagList.map((t) => t.id),
      ...(project ? { projectId: project.id, position: "start" as const } : { inbox: true }),
    });
    toast(project ? `Added to ${project.name}` : "Added to Inbox");
    close();
  }

  function createTag(tagName: string) {
    const id = newId();
    void actions.createTag({ id, name: tagName });
    setTagList((list) => [...list, { id, name: tagName }]);
  }

  function createProject(projectName: string) {
    const id = newId();
    void actions.createProject({ id, name: projectName, type: "parallel" });
    setProject({ id, name: projectName });
  }

  return (
    <Dialog
      title={project ? project.name : "Inbox"}
      onClose={close}
      testId="quick-entry"
      footer={
        <>
          <button type="button" className="pb-btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="pb-quick-entry" className="pb-btn pb-btn-primary" disabled={!name.trim()}>
            Save
          </button>
        </>
      }
    >
      <form
        id="pb-quick-entry"
        onSubmit={save}
        className="flex flex-col gap-3 p-4"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
        }}
      >
        <div className="flex items-center gap-2">
          <input
            className="pb-input text-base font-medium"
            aria-label="Title"
            placeholder="New item"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            className={`pb-icon-btn shrink-0 ${flagged ? "text-flag" : ""}`}
            aria-label={flagged ? "Unflag" : "Flag"}
            aria-pressed={flagged}
            onClick={() => setFlagged((f) => !f)}
          >
            <Icon name="flag" filled={flagged} />
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="pb-label">Project</span>
            {project ? (
              <div className="flex min-h-[44px] items-center gap-2 rounded-lg border border-line px-3">
                <Icon name="project-parallel" size={16} className="text-muted" />
                <span className="flex-1 truncate text-sm">{project.name}</span>
                <button type="button" className="pb-hit text-muted" aria-label="Clear project" onClick={() => setProject(null)}>
                  <Icon name="close" size={16} />
                </button>
              </div>
            ) : (
              <SmartMatch
                label="Project"
                placeholder="Inbox"
                items={projectChoices(projects, folders)}
                onPick={(p) => setProject({ id: p.id, name: p.name })}
                onCreate={createProject}
              />
            )}
          </div>
          <label className="flex flex-col gap-1">
            <span className="pb-label">Due</span>
            <input
              className={`pb-input ${dueError ? "border-danger" : ""}`}
              placeholder="e.g. fri 5pm"
              value={due}
              aria-invalid={!!dueError}
              aria-describedby="pb-qe-due-hint"
              onChange={(e) => {
                setDue(e.target.value);
                setDueError(null);
              }}
            />
            <span id="pb-qe-due-hint" className={`min-h-[16px] text-xs ${dueError || duePreview === undefined ? "text-danger" : "text-muted"}`}>
              {dueError ?? (duePreview === undefined ? "Unable to parse date" : formatDateTime(duePreview, settings))}
            </span>
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <span className="pb-label">Tags</span>
          {tagList.length > 0 && (
            <ul className="mb-1 flex flex-wrap gap-1.5" aria-label="Selected tags">
              {tagList.map((t) => (
                <li key={t.id} className="flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-sm">
                  {t.name}
                  <button type="button" className="pb-hit rounded-full p-1" aria-label={`Remove tag ${t.name}`} onClick={() => setTagList((l) => l.filter((x) => x.id !== t.id))}>
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <SmartMatch
            label="Add tag"
            placeholder="Add tag"
            items={tagChoices(tags, tagList.map((t) => t.id))}
            onPick={(t) => setTagList((l) => [...l, { id: t.id, name: t.name }])}
            onCreate={createTag}
          />
        </div>
        {showNote ? (
          <label className="flex flex-col gap-1">
            <span className="pb-label">Note</span>
            <textarea className="pb-input min-h-[88px]" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        ) : (
          <button type="button" className="pb-hit self-start text-sm text-accent" onClick={() => setShowNote(true)}>
            + Add note
          </button>
        )}
      </form>
    </Dialog>
  );
}
