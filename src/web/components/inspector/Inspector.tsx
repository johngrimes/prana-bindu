import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Alarm, Project, Settings, TaskDetail, TaskPatch } from "../../../shared/schemas";
import {
  actions,
  attempt,
  useFolders,
  useProjects,
  useSettingsValue,
  useTags,
  useTaskDetail,
  useTaskDetails,
  type ProjectPatchInput,
} from "../../api/queries";
import { formatDateTime } from "../../lib/dates";
import { newId } from "../../lib/drafts";
import { byId, flattenTree, projectChoices, tagChoices } from "../../lib/entities";
import { useStore } from "../../lib/store";
import { parseSelectionKey, ui } from "../../lib/ui";
import { Icon } from "../Icons";
import { Dialog } from "../Overlay";
import { SmartMatch } from "../SmartMatch";
import { Attachments } from "./Attachments";
import { ContainerInspector } from "./ContainerInspector";
import { CommitInput, DateField, DurationField, FieldRow, ReadOnly, Section, Segmented } from "./Fields";
import { RepeatEditor } from "./RepeatEditor";
import { ReviewSchedule } from "./ReviewSchedule";
import { markReviewedAndAdvance } from "../../lib/review";

export function Inspector() {
  const selection = useStore(ui, (s) => s.selection);
  if (selection.length === 0) {
    return (
      <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 p-6 text-center text-muted" data-testid="inspector-empty">
        <Icon name="inspector" size={28} />
        <p>No Selection</p>
      </div>
    );
  }
  const parsed = selection.map(parseSelectionKey);
  if (parsed.length === 1 && parsed[0]) {
    const only = parsed[0];
    if (only.kind === "folder" || only.kind === "tag") return <ContainerInspector kind={only.kind} id={only.id} />;
    return <TaskInspector key={only.id} id={only.id} />;
  }
  const taskIds = parsed.filter((p) => p.kind === "task").map((p) => p.id);
  if (taskIds.length === 0) return <p className="p-6 text-center text-muted">{parsed.length} items selected</p>;
  return <MultiInspector ids={taskIds} />;
}

function kindLabel(task: TaskDetail): string {
  if (task.project) return "Project";
  if (task.inInbox) return "Inbox Item";
  if (task.childCount > 0) return "Action Group";
  return "Action";
}

function AlarmList({ alarms, settings }: { alarms: Alarm[]; settings: Settings }) {
  const describe = (a: Alarm) => {
    if (a.kind === "absolute") return formatDateTime(a.fireDate, settings);
    const secs = a.offsetSeconds ?? 0;
    const anchor = a.kind === "dueRelative" ? "due" : a.kind === "deferRelative" ? "defer" : "planned";
    if (secs === 0) return `At ${anchor} time`;
    const abs = Math.abs(secs);
    const amount = abs % 86400 === 0 ? `${abs / 86400} d` : abs % 3600 === 0 ? `${abs / 3600} h` : `${Math.round(abs / 60)} min`;
    return `${amount} ${secs < 0 ? "before" : "after"} ${anchor}`;
  };
  return (
    <ul className="flex flex-col gap-1 text-sm" aria-label="Notifications">
      {alarms.map((a) => (
        <li key={a.id} className="flex items-center gap-2">
          <Icon name="bell" size={14} className="text-muted" />
          <span className="flex-1">{describe(a)}</span>
          {a.effectiveFireDate && a.kind !== "absolute" && <span className="text-xs text-muted">{formatDateTime(a.effectiveFireDate, settings)}</span>}
        </li>
      ))}
    </ul>
  );
}

function TaskInspector({ id }: { id: string }) {
  const { data: task, isPending, isError } = useTaskDetail(id);
  const settings = useSettingsValue();
  const { data: tagList } = useTags();
  const { data: projects } = useProjects();
  const { data: folders } = useFolders();
  const tags = useMemo(() => byId(tagList), [tagList]);
  const [dropChoice, setDropChoice] = useState(false);

  if (!task) return <p className="p-6 text-center text-muted">{isPending && !isError ? "Loading…" : "This item no longer exists."}</p>;

  const project = task.project;
  const isGroup = !project && task.childCount > 0;
  const patch = (p: TaskPatch & ProjectPatchInput) => void attempt(project ? actions.patchProject(task.id, p) : actions.patchTask(task.id, p));
  const projectRecord = projects?.find((p) => p.id === (task.inInbox ? task.assignedProjectId : task.projectId));
  const taskStatus = task.dropped ? "dropped" : task.completed ? "completed" : "active";

  /** One request per status change (completing also clears dropped, and vice versa). */
  function setTaskStatus(status: "active" | "completed" | "dropped") {
    if (!task) return;
    if (status === "dropped" && task.repeat) setDropChoice(true);
    else void attempt(actions.setStatus([task.id], status));
  }

  /** Project status; dropping a repeating project first asks whether to skip one occurrence or drop the series. */
  function setProjectStatus(status: Project["status"]) {
    if (!task) return;
    if (status === "dropped" && task.repeat) setDropChoice(true);
    else void attempt(actions.patchProject(task.id, { status }));
  }

  function addTag(tagId: string) {
    void attempt(actions.addTag(task!.id, tagId));
  }

  function createAndAddTag(name: string) {
    const tagId = newId();
    void attempt(actions.createTag({ id: tagId, name }));
    addTag(tagId);
  }

  function setProject(projectId: string | null) {
    if (!task) return;
    if (task.inInbox) void attempt(actions.patchTask(task.id, { assignedProjectId: projectId }));
    else if (projectId) void attempt(actions.moveTask(task.id, { projectId, position: "end" }));
    else void attempt(actions.moveTask(task.id, { inbox: true, position: "end" }));
  }

  function createProjectFor(name: string) {
    const projectId = newId();
    void attempt(actions.createProject({ id: projectId, name, type: "parallel" }));
    setProject(projectId);
  }

  const folderTree = flattenTree(folders ?? []);

  return (
    <div data-testid="inspector" className="pb-6">
      <div className="border-b border-line px-4 pb-3 pt-4">
        <p className="pb-label mb-1.5">{kindLabel(task)}</p>
        <CommitInput
          key={`name-${task.id}`}
          value={task.name}
          label="Title"
          placeholder="Untitled"
          className="text-base font-semibold"
          onCommit={(name) => patch({ name })}
        />
      </div>

      <Section title={project ? "Project" : "Status"}>
        {project ? (
          <Segmented
            label="Project status"
            value={project.status}
            onChange={setProjectStatus}
            options={[
              { value: "active", label: "Active" },
              { value: "onHold", label: "On Hold" },
              { value: "completed", label: "Completed" },
              { value: "dropped", label: "Dropped" },
            ]}
          />
        ) : (
          <Segmented
            label="Status"
            value={taskStatus}
            onChange={setTaskStatus}
            options={[
              { value: "active", label: "Active" },
              { value: "completed", label: "Completed" },
              { value: "dropped", label: "Dropped" },
            ]}
          />
        )}
        <button
          type="button"
          className={`flex min-h-[44px] items-center gap-2 self-start rounded-lg px-2 text-sm ${task.flagged ? "text-flag" : task.effectiveFlagged ? "text-flag/80" : "text-muted"} hover:bg-surface-2`}
          aria-pressed={task.flagged}
          onClick={() => patch({ flagged: !task.flagged })}
        >
          <Icon name="flag" size={18} filled={task.flagged} />
          {task.flagged ? "Flagged" : task.effectiveFlagged ? "Flag inherited (click to flag)" : "Unflagged"}
        </button>
        {project && (
          <Segmented
            label="Project type"
            value={project.type}
            onChange={(type) => patch({ type })}
            options={[
              { value: "parallel", label: "Parallel" },
              { value: "sequential", label: "Sequential" },
              { value: "singleActions", label: "Single Actions" },
            ]}
          />
        )}
        {isGroup && (
          <Segmented
            label="Group type"
            value={task.sequential ? "sequential" : "parallel"}
            onChange={(t) => patch({ sequential: t === "sequential" })}
            options={[
              { value: "parallel", label: "Parallel" },
              { value: "sequential", label: "Sequential" },
            ]}
          />
        )}
        {(project || isGroup) && (
          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--accent)]"
              checked={task.completedByChildren}
              onChange={(e) => patch({ completedByChildren: e.target.checked })}
            />
            Complete with last action
          </label>
        )}
        {project ? (
          <FieldRow label="Folder">
            <select className="pb-input" aria-label="Folder" value={project.folderId ?? ""} onChange={(e) => patch({ folderId: e.target.value || null })}>
              <option value="">No folder</option>
              {folderTree.map(({ item, depth }) => (
                <option key={item.id} value={item.id}>
                  {"\u00a0\u00a0".repeat(depth)}
                  {item.name}
                </option>
              ))}
            </select>
          </FieldRow>
        ) : (
          <FieldRow label="Project">
            {projectRecord ? (
              <div className="flex min-h-[44px] items-center gap-1 rounded-lg border border-line pl-3">
                <span className="flex-1 truncate text-sm" data-testid="inspector-project">
                  {projectRecord.task.name}
                </span>
                <Link to={`/projects?project=${encodeURIComponent(projectRecord.id)}`} className="pb-icon-btn" aria-label="Go to project" title="Go to project">
                  <Icon name="arrow-right" size={16} />
                </Link>
                <button type="button" className="pb-icon-btn" aria-label="Clear project" onClick={() => setProject(null)}>
                  <Icon name="close" size={16} />
                </button>
              </div>
            ) : (
              <SmartMatch
                key={`proj-${task.id}`}
                label="Project"
                placeholder={task.inInbox ? "Inbox" : "No project"}
                items={projectChoices(projects, folders)}
                onPick={(p) => setProject(p.id)}
                onCreate={createProjectFor}
                testId="inspector-project-input"
              />
            )}
          </FieldRow>
        )}
      </Section>

      <Section title="Tags">
        {task.tagIds.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
            {task.tagIds.map((tid) => {
              const t = tags.get(tid);
              return (
                <li key={tid} className="flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-sm">
                  {t?.name ?? tid}
                  <button
                    type="button"
                    className="pb-hit rounded-full p-1"
                    aria-label={`Remove tag ${t?.name ?? tid}`}
                    onClick={() => void attempt(actions.removeTag(task.id, tid))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <SmartMatch
          key={`tags-${task.id}`}
          label="Add tag"
          placeholder="Add tag"
          items={tagChoices(tagList, task.tagIds)}
          onPick={(t) => addTag(t.id)}
          onCreate={createAndAddTag}
          testId="inspector-tag-input"
        />
      </Section>

      <Section title="Dates">
        <FieldRow label="Duration">
          <DurationField value={task.estimatedMinutes} onChange={(estimatedMinutes) => patch({ estimatedMinutes })} />
        </FieldRow>
        <FieldRow label="Defer">
          <DateField label="Defer" field="defer" value={task.deferDate} effective={task.effectiveDeferDate} settings={settings} onChange={(deferDate) => patch({ deferDate })} />
        </FieldRow>
        <FieldRow label="Planned">
          <DateField label="Planned" field="planned" value={task.plannedDate} effective={task.effectivePlannedDate} settings={settings} onChange={(plannedDate) => patch({ plannedDate })} />
        </FieldRow>
        <FieldRow label="Due">
          <DateField label="Due" field="due" value={task.dueDate} effective={task.effectiveDueDate} settings={settings} onChange={(dueDate) => patch({ dueDate })} />
        </FieldRow>
        <ReadOnly label="Completed" value={task.completed} settings={settings} />
        <ReadOnly label="Dropped" value={task.dropped} settings={settings} />
        <ReadOnly label="Added" value={task.added} settings={settings} />
        <ReadOnly label="Changed" value={task.modified} settings={settings} />
      </Section>

      {project && <ReviewSection id={task.id} project={project} settings={settings} />}

      <Section title="Repeat">
        <RepeatEditor repeat={task.repeat} onChange={(repeat) => patch({ repeat })} />
      </Section>

      {task.alarms.length > 0 && (
        <Section title="Notifications">
          <AlarmList alarms={task.alarms} settings={settings} />
        </Section>
      )}

      <Section title="Note">
        <CommitInput key={`note-${task.id}`} id="pb-inspector-note" value={task.note} label="Note" placeholder="Add a note" multiline onCommit={(note) => patch({ note })} />
      </Section>

      <Section title="Attachments">
        <Attachments taskId={task.id} attachments={task.attachments} />
      </Section>

      {dropChoice && (
        <DropRepeatingDialog
          message={`“${task.name}” repeats. Skip just this occurrence (the next one is scheduled), or drop it completely?`}
          onClose={() => setDropChoice(false)}
          onChoose={(scope) => void attempt(actions.setStatus([task.id], "dropped", scope))}
        />
      )}
    </div>
  );
}

/** "Skip this occurrence / Drop completely" choice for dropping repeating items (docs/spec.md §1.4). */
function DropRepeatingDialog({ message, onClose, onChoose }: { message: string; onClose: () => void; onChoose: (scope: "occurrence" | "series") => void }) {
  const choose = (scope: "occurrence" | "series") => {
    onClose();
    onChoose(scope);
  };
  return (
    <Dialog
      title="Drop repeating item"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="pb-btn" onClick={() => choose("occurrence")}>
            Skip this occurrence
          </button>
          <button type="button" className="pb-btn pb-btn-primary" onClick={() => choose("series")}>
            Drop completely
          </button>
        </>
      }
    >
      <p className="p-4 text-sm">{message}</p>
    </Dialog>
  );
}

function ReviewSection({ id, project, settings }: { id: string; project: Omit<Project, "task">; settings: Settings }) {
  const navigate = useNavigate();
  return (
    <Section title="Review">
      <ReadOnly label="Last review" value={project.lastReview} settings={settings} />
      <ReviewSchedule id={id} project={project} settings={settings} />
      <button type="button" className="pb-btn pb-btn-primary self-start" onClick={() => void markReviewedAndAdvance(id, navigate)}>
        <Icon name="review" size={18} /> Mark Reviewed
      </button>
    </Section>
  );
}

/** Editing several selected items at once; mixed values show as "Multiple values" (docs/spec.md §3). */
function MultiInspector({ ids }: { ids: string[] }) {
  const settings = useSettingsValue();
  const { data: tagList } = useTags();
  const { data: projects } = useProjects();
  const { data: folders } = useFolders();
  const tags = useMemo(() => byId(tagList), [tagList]);
  const details = useTaskDetails(ids);
  const [dropChoice, setDropChoice] = useState(false);
  const tasks = details.filter((t): t is TaskDetail => !!t);
  if (tasks.length < ids.length) return <p className="p-6 text-center text-muted">Loading…</p>;

  const same = <K extends keyof TaskDetail>(key: K): TaskDetail[K] | undefined => {
    const first = tasks[0]?.[key];
    return tasks.every((t) => JSON.stringify(t[key]) === JSON.stringify(first)) ? first : undefined;
  };
  const batch = (patch: TaskPatch) => void attempt(actions.batchPatch(ids, patch));
  const allTagIds = [...new Set(tasks.flatMap((t) => t.tagIds))];
  const flagged = same("flagged");
  const status = tasks.every((t) => t.completed) ? "completed" : tasks.every((t) => t.dropped) ? "dropped" : tasks.every((t) => !t.completed && !t.dropped) ? "active" : null;

  /** One request per status change, so a single undo reverts the whole multi-selection edit. */
  function setStatus(s: "active" | "completed" | "dropped", scope?: "occurrence" | "series") {
    if (s === "dropped" && !scope && tasks.some((t) => !t.dropped && t.repeat)) {
      setDropChoice(true);
      return;
    }
    void attempt(actions.setStatus(ids, s, scope));
  }

  function setProject(projectId: string) {
    const inbox = tasks.filter((t) => !t.project && t.inInbox).map((t) => t.id);
    const others = tasks.filter((t) => !t.project && !t.inInbox).map((t) => t.id);
    if (inbox.length) void attempt(actions.batchPatch(inbox, { assignedProjectId: projectId }));
    if (others.length) void attempt(actions.moveMany(others, { projectId, position: "end" }));
  }

  return (
    <div data-testid="inspector-multi" className="pb-6">
      <div className="border-b border-line px-4 py-4">
        <p className="pb-label">Multiple selection</p>
        <p className="mt-1 text-base font-semibold">{ids.length} items selected</p>
      </div>
      <Section title="Status">
        <Segmented
          label="Status"
          value={status}
          mixed={status === null}
          onChange={(s) => setStatus(s)}
          options={[
            { value: "active", label: "Active" },
            { value: "completed", label: "Completed" },
            { value: "dropped", label: "Dropped" },
          ]}
        />
        <button
          type="button"
          className={`flex min-h-[44px] items-center gap-2 self-start rounded-lg px-2 text-sm hover:bg-surface-2 ${flagged ? "text-flag" : "text-muted"}`}
          aria-pressed={flagged === undefined ? "mixed" : flagged}
          onClick={() => batch({ flagged: !flagged })}
        >
          <Icon name="flag" size={18} filled={!!flagged} />
          {flagged === undefined ? "Multiple values" : flagged ? "Flagged" : "Unflagged"}
        </button>
        <FieldRow label="Project">
          <SmartMatch label="Project" placeholder="Move to project…" items={projectChoices(projects, folders)} onPick={(p) => setProject(p.id)} />
        </FieldRow>
      </Section>
      <Section title="Tags">
        {allTagIds.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
            {allTagIds.map((tid) => {
              const onAll = tasks.every((t) => t.tagIds.includes(tid));
              return (
                <li key={tid} className={`flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-sm ${onAll ? "bg-accent-soft" : "border border-dashed border-line"}`}>
                  {tags.get(tid)?.name ?? tid}
                  <button
                    type="button"
                    className="pb-hit rounded-full p-1"
                    aria-label={`Remove tag ${tags.get(tid)?.name ?? tid} from all`}
                    onClick={() => void attempt(actions.tagsMany(ids, { remove: [tid] }))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <SmartMatch
          label="Add tag to all"
          placeholder="Add tag to all"
          items={tagChoices(tagList)}
          onPick={(tag) => void attempt(actions.tagsMany(ids, { add: [tag.id] }))}
        />
      </Section>
      <Section title="Dates">
        <FieldRow label="Duration">
          <DurationField value={same("estimatedMinutes") ?? null} mixed={same("estimatedMinutes") === undefined} onChange={(estimatedMinutes) => batch({ estimatedMinutes })} />
        </FieldRow>
        {(
          [
            ["Defer", "defer", "deferDate"],
            ["Planned", "planned", "plannedDate"],
            ["Due", "due", "dueDate"],
          ] as const
        ).map(([label, field, key]) => {
          const v = same(key);
          return (
            <FieldRow key={key} label={label}>
              <DateField label={label} field={field} value={v ?? null} mixed={v === undefined} settings={settings} onChange={(value) => batch({ [key]: value })} />
            </FieldRow>
          );
        })}
      </Section>
      {dropChoice && (
        <DropRepeatingDialog
          message="Some selected items repeat. Skip just this occurrence of each (the next ones are scheduled), or drop them completely?"
          onClose={() => setDropChoice(false)}
          onChoose={(scope) => setStatus("dropped", scope)}
        />
      )}
    </div>
  );
}
