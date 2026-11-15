import { useEffect, useRef, useState } from "react";
import type { OutlineRow, Settings, Tag, Task } from "../../../shared/schemas";
import { formatDateChip } from "../../lib/dates";
import { dragStarter, type DragSource } from "../../lib/dnd";
import { Icon } from "../Icons";
import { StatusCircle } from "./StatusCircle";

export interface RowCallbacks {
  onSelect(e: React.MouseEvent | React.KeyboardEvent): void;
  onToggleComplete(): void;
  onToggleFlag(): void;
  onToggleCollapse(): void;
  onStartEdit(): void;
  onCommitEdit(text: string, then?: "after" | "above" | "indent" | "outdent" | "stop"): void;
  onRemoveTag(tagId: string): void;
  onMenu(anchor: HTMLElement): void;
  onDelete(): void;
  dragSource(): DragSource | null;
}

const SWIPE_COMPLETE = 88;
const SWIPE_REVEAL = 132;

function DateChip({ value, implied, tone, icon, label, settings }: { value: string; implied: boolean; tone: "danger" | "warn" | "muted"; icon: string; label: string; settings: Settings }) {
  const cls = tone === "danger" ? "bg-danger-soft text-danger" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-px text-xs ${cls} ${implied ? "italic opacity-80" : ""}`} title={label}>
      <Icon name={icon} size={12} />
      <span>
        <span className="sr-only">{label} </span>
        {formatDateChip(value, settings)}
      </span>
    </span>
  );
}

function TitleEditor({ initial, onCommit, label }: { initial: string; onCommit: RowCallbacks["onCommitEdit"]; label: string }) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const commit = (then?: Parameters<RowCallbacks["onCommitEdit"]>[1]) => {
    if (done.current) return;
    // Indent/outdent keep editing the same row, so the editor stays live for the next commit.
    if (then !== "indent" && then !== "outdent") done.current = true;
    onCommit(text, then);
  };
  return (
    <input
      className="w-full min-w-0 rounded-md bg-surface px-1.5 py-1 outline-2 outline-accent"
      aria-label={label}
      data-testid="row-title-input"
      value={text}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.shiftKey ? "stop" : e.metaKey || e.ctrlKey ? "stop" : "after");
        } else if (e.key === "Escape") {
          e.preventDefault();
          commit("stop");
        } else if (e.key === "Tab") {
          e.preventDefault();
          commit(e.shiftKey ? "outdent" : "indent");
        }
      }}
    />
  );
}

/** Outline row for a task, project or folder (docs/spec.md §3 Row). */
export function Row({
  row,
  title,
  subtitle,
  depth,
  selected,
  editing,
  hasChildren,
  disclosureColumn,
  reordering,
  leaving,
  collapsed,
  showProject,
  settings,
  tags,
  dropState,
  revealed,
  onReveal,
  cb,
}: {
  row: OutlineRow;
  title: string;
  subtitle?: string;
  depth: number;
  selected: boolean;
  editing: boolean;
  hasChildren: boolean;
  /** Reserve the disclosure-triangle column (some row in the outline has children), keeping circles aligned. */
  disclosureColumn: boolean;
  /** Reorder mode: actions show a drag grip at the trailing edge. */
  reordering: boolean;
  /** Clean Up will remove this row from the view; it is greyed out until then. */
  leaving: boolean;
  collapsed: boolean;
  showProject: boolean;
  settings: Settings;
  tags: Map<string, Tag>;
  dropState: "before" | "after" | "inside" | null;
  revealed: boolean;
  onReveal(open: boolean): void;
  cb: RowCallbacks;
}) {
  const task: Task | undefined = row.kind === "task" ? row.task : row.kind === "project" ? row.project?.task : undefined;
  const isProject = row.kind === "project";
  const isFolder = row.kind === "folder";
  // Live swipe offset while a touch swipe is in progress; otherwise the row rests at 0 or revealed.
  const [swipeDx, setSwipeDx] = useState<number | null>(null);
  const dx = swipeDx ?? (revealed ? -SWIPE_REVEAL : 0);
  const swipe = useRef<{ x: number; y: number; id: number; horizontal: boolean | null } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const swiped = useRef(false);

  useEffect(() => {
    if (selected && !editing && rowRef.current && document.activeElement !== rowRef.current) {
      const active = document.activeElement;
      // Follow the keyboard selection without stealing focus from fields elsewhere.
      if (!active || active === document.body || active.closest("[data-outline]")) rowRef.current.focus({ preventScroll: false });
    }
  }, [selected, editing]);

  const done = !!task && (task.completed !== null || task.dropped !== null);
  const status = task?.status;
  const pad = 4 + Math.min(depth, 12) * 18;
  const dim = leaving ? "opacity-50" : "";
  const taskTags = task ? task.tagIds.map((id) => tags.get(id)).filter((t): t is Tag => !!t) : [];

  const onPointerDown = (e: React.PointerEvent) => {
    swiped.current = false;
    if (e.pointerType === "touch" && task && !editing && !(e.target as HTMLElement).closest("[data-drag-handle]")) {
      swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: null };
    }
    dragStarter(cb.dragSource)(e);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (s.horizontal === null && Math.hypot(mx, my) > 10) s.horizontal = Math.abs(mx) > Math.abs(my) * 1.2;
    if (s.horizontal) setSwipeDx(Math.max(-SWIPE_REVEAL - 30, Math.min(SWIPE_COMPLETE + 40, mx + (revealed ? -SWIPE_REVEAL : 0))));
  };
  const onPointerUp = () => {
    const s = swipe.current;
    swipe.current = null;
    if (!s?.horizontal) return;
    swiped.current = true;
    setSwipeDx(null);
    if (dx >= SWIPE_COMPLETE) {
      onReveal(false);
      cb.onToggleComplete();
    } else onReveal(dx <= -SWIPE_REVEAL / 2);
  };

  const dropCls =
    dropState === "inside"
      ? "ring-2 ring-inset ring-accent"
      : dropState === "before"
        ? "shadow-[inset_0_2px_0_var(--accent)]"
        : dropState === "after"
          ? "shadow-[inset_0_-2px_0_var(--accent)]"
          : "";

  return (
    <div
      className="relative isolate overflow-hidden"
      data-testid={isProject ? "project-row" : isFolder ? "folder-row" : "row"}
      data-row-id={row.id}
      data-status={status}
      data-leaving={leaving || undefined}
    >
      {task && (dx !== 0 || revealed) && (
        <div className="absolute inset-0 flex items-stretch justify-between" aria-hidden={!revealed}>
          <div className="flex items-center bg-accent px-5 text-on-accent">
            <Icon name="check" />
          </div>
          <div className="flex">
            <button type="button" className="flex w-[66px] flex-col items-center justify-center bg-flag text-xs text-white" onClick={() => { onReveal(false); cb.onToggleFlag(); }}>
              <Icon name="flag" size={18} />
              {task.flagged ? "Unflag" : "Flag"}
            </button>
            <button type="button" className="flex w-[66px] flex-col items-center justify-center bg-danger text-xs text-white" onClick={() => { onReveal(false); cb.onDelete(); }}>
              <Icon name="trash" size={18} />
              Delete
            </button>
          </div>
        </div>
      )}
      <div
        ref={rowRef}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selected}
        aria-expanded={hasChildren ? !collapsed : undefined}
        aria-label={title || "Untitled"}
        tabIndex={selected ? 0 : -1}
        data-drop-kind="row"
        data-drop-id={row.id}
        data-drop-modes={isFolder ? "inside" : isProject ? "inside" : "before,after,inside"}
        style={{ paddingLeft: pad, transform: dx ? `translateX(${dx}px)` : undefined, touchAction: "pan-y" }}
        className={`group relative flex min-h-[48px] items-start gap-0.5 border-b border-line/60 pr-1 transition-[background-color] ${swipeDx !== null ? "" : "transition-transform"} ${
          selected ? "bg-select" : "bg-surface hover:bg-surface-2/60"
        } ${dropCls} ${isProject ? "pt-1" : ""}`}
        onClick={(e) => {
          if (swiped.current) {
            swiped.current = false;
            return;
          }
          if (revealed) {
            onReveal(false);
            return;
          }
          cb.onSelect(e);
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          cb.onStartEdit();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          swipe.current = null;
          setSwipeDx(null);
        }}
      >
        {disclosureColumn && (
          <span className="flex h-11 w-5 shrink-0 items-center justify-center">
            {hasChildren && (
              <button
                type="button"
                className="pb-hit flex h-11 w-6 items-center justify-center text-muted"
                aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  cb.onToggleCollapse();
                }}
              >
                <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={14} strokeWidth={2.4} />
              </button>
            )}
          </span>
        )}
        {task ? (
          <StatusCircle task={task} onToggle={cb.onToggleComplete} label={title || "Untitled"} project={isProject} className={dim} />
        ) : (
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center text-muted ${dim}`}>
            <Icon name={isFolder ? "folder" : "tag"} size={18} />
          </span>
        )}
        <div className={`min-w-0 flex-1 py-2.5 ${dim}`}>
          {editing ? (
            <TitleEditor initial={title} onCommit={cb.onCommitEdit} label={`Title of ${title || "new item"}`} />
          ) : (
            <div className={`flex items-baseline gap-2 ${isProject || isFolder ? "font-semibold" : ""} ${task && hasChildren && !isProject ? "font-medium" : ""}`}>
              {subtitle && <span className="shrink-0 truncate text-sm font-normal text-muted">{subtitle}</span>}
              <span
                data-testid="row-title"
                className={`min-w-0 break-words ${done ? "text-muted line-through decoration-1" : ""} ${!title ? "italic text-faint" : ""} ${task?.status === "blocked" && !isProject ? "text-muted" : ""}`}
                onClick={(e) => {
                  if (selected && !e.shiftKey && !e.metaKey && !e.ctrlKey && window.matchMedia("(min-width: 768px)").matches) {
                    e.stopPropagation();
                    cb.onStartEdit();
                  }
                }}
              >
                {title || "Untitled"}
              </span>
            </div>
          )}
          {task && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted empty:hidden">
              {showProject && !isProject && (task.projectName || task.inInbox) && (
                <span className="inline-flex max-w-[14rem] items-center gap-1 truncate" data-testid="row-project">
                  <Icon name={task.inInbox ? "inbox" : "project-parallel"} size={12} />
                  <span className="truncate">{task.inInbox ? "Inbox" : task.projectName}</span>
                </span>
              )}
              {taskTags.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-0.5 rounded-full bg-accent-soft py-px pl-2 pr-0.5 text-fg" data-testid="tag-pill">
                  {t.name}
                  <button
                    type="button"
                    data-no-drag
                    className="pb-hit rounded-full p-0.5 text-muted opacity-70 hover:opacity-100"
                    aria-label={`Remove tag ${t.name} from ${title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      cb.onRemoveTag(t.id);
                    }}
                  >
                    <Icon name="close" size={10} strokeWidth={2.6} />
                  </button>
                </span>
              ))}
              {task.effectiveDueDate && (
                <DateChip
                  value={task.effectiveDueDate}
                  implied={!task.dueDate}
                  tone={task.overdue ? "danger" : task.dueSoon ? "warn" : "muted"}
                  icon="clock"
                  label="Due"
                  settings={settings}
                />
              )}
              {task.deferred && task.effectiveDeferDate && (
                <DateChip value={task.effectiveDeferDate} implied={!task.deferDate} tone="muted" icon="calendar" label="Deferred until" settings={settings} />
              )}
              {task.repeat && <Icon name="repeat" size={13} title="Repeats" />}
              {task.note.trim() && <Icon name="note" size={13} title="Has note" />}
              {task.attachmentCount > 0 && <Icon name="paperclip" size={13} title={`${task.attachmentCount} attachments`} />}
              {isProject && row.project && (
                <span className="inline-flex items-center gap-1">
                  <Icon name={row.project.type === "sequential" ? "project-sequential" : row.project.type === "singleActions" ? "project-single" : "project-parallel"} size={12} />
                  {row.project.status === "onHold" ? "On Hold" : row.project.status === "active" ? `${row.project.remainingCount} remaining` : row.project.status}
                </span>
              )}
            </div>
          )}
        </div>
        {task && (
          <button
            type="button"
            data-no-drag
            className={`h-11 w-11 shrink-0 items-center justify-center ${task.flagged ? "flex text-flag" : task.effectiveFlagged ? "flex text-flag/70" : "hidden text-faint md:flex md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"} ${selected ? "md:opacity-100" : ""} ${dim}`}
            aria-label={task.flagged ? `Unflag ${title}` : `Flag ${title}`}
            aria-pressed={task.flagged}
            onClick={(e) => {
              e.stopPropagation();
              cb.onToggleFlag();
            }}
          >
            <Icon name="flag" size={17} filled={task.flagged} />
          </button>
        )}
        <button
          type="button"
          data-no-drag
          className="hidden h-11 w-10 shrink-0 items-center justify-center text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 md:flex"
          aria-label={`More actions for ${title}`}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            cb.onMenu(e.currentTarget);
          }}
        >
          <Icon name="more" size={18} strokeWidth={3} />
        </button>
        {reordering && row.kind === "task" && (
          <span
            data-drag-handle
            className="flex h-11 w-11 shrink-0 cursor-grab touch-none select-none items-center justify-center text-muted [-webkit-touch-callout:none]"
            aria-hidden="true"
            // A tap on the grip without dragging should not select the row (or open the phone inspector).
            onClick={(e) => e.stopPropagation()}
          >
            <Icon name="grip" size={18} strokeWidth={2.6} />
          </span>
        )}
      </div>
    </div>
  );
}
