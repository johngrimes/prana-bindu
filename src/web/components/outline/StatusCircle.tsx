import type { Task } from "../../../shared/schemas";
import { Icon } from "../Icons";

/** Visual state of a task's status circle (docs/spec.md §3 row). */
export function circleState(task: Task): string {
  if (task.completed || task.effectiveCompleted) return "completed";
  if (task.dropped || task.effectiveDropped) return "dropped";
  if (task.overdue) return "overdue";
  if (task.dueSoon) return "dueSoon";
  if (task.effectiveFlagged) return "flagged";
  if (task.blocked) return "blocked";
  if (task.repeat) return "repeating";
  if (task.firstAvailable) return "next";
  return "available";
}

const RING: Record<string, string> = {
  available: "border-muted",
  next: "border-fg",
  blocked: "border-faint border-dashed opacity-70",
  overdue: "border-danger bg-danger-soft",
  dueSoon: "border-warn bg-warn-soft",
  flagged: "border-flag",
  repeating: "border-muted border-dotted",
  completed: "border-accent bg-accent text-on-accent",
  dropped: "border-faint text-faint",
};

export function StatusCircle({
  task,
  onToggle,
  label,
  project = false,
  className = "",
}: {
  task: Task;
  onToggle: () => void;
  label: string;
  project?: boolean;
  className?: string;
}) {
  const state = circleState(task);
  const done = state === "completed";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={`Complete ${label}`}
      data-state={state}
      data-testid="status-circle"
      className={`flex h-11 w-11 shrink-0 items-center justify-center ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <span
        className={`relative flex h-[20px] w-[20px] items-center justify-center border-[1.75px] ${project ? "rounded-[6px]" : "rounded-full"} ${RING[state] ?? RING.available}`}
      >
        {done && <Icon name="check" size={13} strokeWidth={3} />}
        {state === "dropped" && <span className="absolute h-[1.75px] w-[22px] rotate-[-45deg] bg-faint" />}
        {state === "repeating" && <span className="h-1.5 w-1.5 rounded-full bg-muted" />}
        {task.repeat && state !== "repeating" && !done && (
          <span className="absolute -right-1.5 -top-1.5 rounded-full bg-surface text-muted">
            <Icon name="repeat" size={10} strokeWidth={2.4} />
          </span>
        )}
      </span>
    </button>
  );
}
