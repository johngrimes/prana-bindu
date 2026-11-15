import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Task } from "../../shared/schemas";
import { actions, useSearch, useSettingsValue } from "../api/queries";
import { Icon } from "../components/Icons";
import { Highlight } from "../components/SmartMatch";
import { StatusCircle } from "../components/outline/StatusCircle";
import { Workspace } from "../components/Workspace";
import { formatDateChip } from "../lib/dates";
import { matchRanges } from "../lib/fuzzy";
import { useStore } from "../lib/store";
import { showInspector, ui } from "../lib/ui";

function noteSnippet(note: string, query: string): string | null {
  const ranges = matchRanges(note, query);
  const first = ranges[0];
  if (!first) return null;
  const start = Math.max(0, first[0] - 40);
  return `${start > 0 ? "…" : ""}${note.slice(start, start + 140).replace(/\s+/g, " ")}${start + 140 < note.length ? "…" : ""}`;
}

function TaskResult({ task, query }: { task: Task; query: string }) {
  const settings = useSettingsValue();
  const selected = useStore(ui, (s) => s.selection.includes(task.id));
  const snippet = noteSnippet(task.note, query);
  return (
    <li
      className={`flex items-start gap-1 border-b border-line/60 pr-3 ${selected ? "bg-select" : "hover:bg-surface-2/60"}`}
      data-testid="search-task"
      onClick={() => {
        ui.set({ selection: [task.id], anchor: task.id });
        showInspector();
      }}
    >
      <StatusCircle task={task} label={task.name} onToggle={() => void actions.complete(task.id, task.completed === null)} />
      <div className="min-w-0 flex-1 py-2.5">
        <p className={task.completed ? "text-muted line-through" : ""}>
          <Highlight text={task.name || "Untitled"} ranges={matchRanges(task.name, query)} />
        </p>
        {snippet && (
          <p className="mt-0.5 text-sm text-muted">
            <Highlight text={snippet} ranges={matchRanges(snippet, query)} />
          </p>
        )}
        <p className="mt-0.5 flex flex-wrap gap-2 text-xs text-muted">
          <span>{task.inInbox ? "Inbox" : (task.projectName ?? "")}</span>
          {task.effectiveDueDate && <span className={task.overdue ? "text-danger" : task.dueSoon ? "text-warn" : ""}>Due {formatDateChip(task.effectiveDueDate, settings)}</span>}
        </p>
      </div>
    </li>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [text, setText] = useState(q);
  const [availability, setAvailability] = useState("remaining");
  const { data, isFetching } = useSearch(q, availability);

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (text !== q) setParams(text ? { q: text } : {}, { replace: true });
    }, 200);
    return () => window.clearTimeout(t);
  }, [text, q, setParams]);

  const total = data ? data.tasks.length + data.projects.length + data.folders.length + data.tags.length : 0;

  return (
    <Workspace title="Search" icon="search" color="#56707d" canCleanUp={false} canReorder={false}>
      <div className="sticky top-0 z-[2] flex flex-col gap-2 border-b border-line bg-surface p-3">
        <div className="flex items-center gap-2 rounded-xl border border-line bg-bg px-3">
          <Icon name="search" className="text-muted" />
          <input
            id="pb-search-input"
            type="search"
            className="min-h-[44px] flex-1 bg-transparent outline-none"
            placeholder="Search tasks, notes, projects, folders and tags"
            aria-label="Search"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="pb-seg" role="group" aria-label="Filter">
          {[
            ["available", "Available"],
            ["remaining", "Remaining"],
            ["all", "Everything"],
          ].map(([value, label]) => (
            <button key={value} type="button" aria-pressed={availability === value} onClick={() => setAvailability(value ?? "remaining")}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {!q && <p className="px-6 py-16 text-center text-muted">Type to search names and notes.</p>}
      {q && data && total === 0 && !isFetching && <p className="px-6 py-16 text-center text-muted">No matches</p>}
      {q && data && (
        <div className="pb-6" aria-live="polite">
          {data.projects.length > 0 && (
            <section aria-label="Projects">
              <h2 className="pb-label px-4 pb-1 pt-4">Projects</h2>
              <ul>
                {data.projects.map((p) => (
                  <li key={p.id}>
                    <Link to={`/projects?project=${encodeURIComponent(p.id)}`} className="flex min-h-[44px] items-center gap-3 border-b border-line/60 px-4 hover:bg-surface-2">
                      <Icon name="project-parallel" size={18} className="text-muted" />
                      <Highlight text={p.task.name} ranges={matchRanges(p.task.name, q)} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.folders.length > 0 && (
            <section aria-label="Folders">
              <h2 className="pb-label px-4 pb-1 pt-4">Folders</h2>
              <ul>
                {data.folders.map((f) => (
                  <li key={f.id}>
                    <Link to={`/projects?folder=${encodeURIComponent(f.id)}`} className="flex min-h-[44px] items-center gap-3 border-b border-line/60 px-4 hover:bg-surface-2">
                      <Icon name="folder" size={18} className="text-muted" />
                      <Highlight text={f.name} ranges={matchRanges(f.name, q)} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.tags.length > 0 && (
            <section aria-label="Tags">
              <h2 className="pb-label px-4 pb-1 pt-4">Tags</h2>
              <ul>
                {data.tags.map((t) => (
                  <li key={t.id}>
                    <Link to={`/tags?tag=${encodeURIComponent(t.id)}`} className="flex min-h-[44px] items-center gap-3 border-b border-line/60 px-4 hover:bg-surface-2">
                      <Icon name="tag" size={18} className="text-muted" />
                      <Highlight text={t.name} ranges={matchRanges(t.name, q)} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.tasks.length > 0 && (
            <section aria-label="Actions">
              <h2 className="pb-label px-4 pb-1 pt-4">Actions</h2>
              <ul>
                {data.tasks.map((t) => (
                  <TaskResult key={t.id} task={t} query={q} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Workspace>
  );
}
