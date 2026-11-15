// Pointer-based drag and drop shared by the outline and sidebars. Mouse and touch drags from a grip start
// after a small move; touch drags on `data-drag-anywhere` elements (sidebars) need a long press instead.
// Drop targets are elements with `data-drop-kind` and `data-drop-id`; rows also accept before/after/inside
// positions computed from the pointer's height.
import { createStore } from "./store";

export type DropKind = "row" | "project" | "folder" | "tag" | "inbox" | "untagged" | "folder-root" | "tag-root";
export type DropPos = "before" | "after" | "inside";

export interface DropTarget {
  kind: DropKind;
  id: string;
  pos: DropPos;
  el: HTMLElement;
}

export interface DragSource {
  /** What is being dragged: outline tasks or sidebar containers. */
  type: "task" | "project" | "folder" | "tag";
  ids: string[];
  label: string;
  /** Returns whether the target accepts this drag (and at which position). */
  accept(target: Omit<DropTarget, "el">): boolean;
  drop(target: Omit<DropTarget, "el">): void;
}

export const dndStore = createStore<{ active: boolean; targetKey: string | null; targetPos: DropPos | null }>({
  active: false,
  targetKey: null,
  targetPos: null,
});

let ghost: HTMLDivElement | null = null;

function resolveTarget(x: number, y: number): DropTarget | null {
  const hit = document.elementFromPoint(x, y);
  const el = hit instanceof Element ? (hit.closest("[data-drop-kind]") as HTMLElement | null) : null;
  if (!el) return null;
  const kind = el.dataset.dropKind as DropKind;
  const id = el.dataset.dropId ?? "";
  const modes = (el.dataset.dropModes ?? "inside").split(",");
  const rect = el.getBoundingClientRect();
  const rel = (y - rect.top) / Math.max(1, rect.height);
  let pos: DropPos;
  if (modes.includes("before") && rel < (modes.includes("inside") ? 0.3 : 0.5)) pos = "before";
  else if (modes.includes("after") && rel > (modes.includes("inside") ? 0.7 : 0.5)) pos = "after";
  else if (modes.includes("inside")) pos = "inside";
  else pos = rel < 0.5 ? "before" : "after";
  return { kind, id, pos, el };
}

/** Starts a drag from a pointer event. Resolves when the drag ends. */
export function beginDrag(source: DragSource, start: { x: number; y: number; pointerId: number }): void {
  ghost = document.createElement("div");
  ghost.textContent = source.ids.length > 1 ? `${source.label} (+${source.ids.length - 1})` : source.label;
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.cssText =
    "position:fixed;z-index:100;pointer-events:none;max-width:260px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" +
    "padding:6px 12px;border-radius:10px;background:var(--accent);color:var(--accent-text);font-size:14px;box-shadow:var(--shadow);";
  document.body.appendChild(ghost);
  document.body.style.userSelect = "none";
  dndStore.set({ active: true, targetKey: null, targetPos: null });
  let current: DropTarget | null = null;

  const place = (x: number, y: number) => {
    if (ghost) ghost.style.transform = `translate(${x + 12}px, ${y + 8}px)`;
    const t = resolveTarget(x, y);
    const accepted = t && !(t.kind === "row" && source.ids.includes(t.id)) && source.accept(t) ? t : null;
    current = accepted;
    const key = accepted ? `${accepted.kind}:${accepted.id}` : null;
    const s = dndStore.get();
    if (s.targetKey !== key || s.targetPos !== (accepted?.pos ?? null)) dndStore.set({ targetKey: key, targetPos: accepted?.pos ?? null });
  };
  place(start.x, start.y);

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== start.pointerId) return;
    e.preventDefault();
    place(e.clientX, e.clientY);
  };
  const finish = (e: PointerEvent) => {
    if (e.pointerId !== start.pointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    ghost?.remove();
    ghost = null;
    document.body.style.userSelect = "";
    const target = e.type === "pointerup" ? current : null;
    dndStore.set({ active: false, targetKey: null, targetPos: null });
    if (target) {
      const { kind, id, pos } = target;
      source.drop({ kind, id, pos });
    }
    // Swallow the click that follows a mouse drag.
    const swallow = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 50);
  };
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}

/**
 * Pointer-down handler factory: mouse drags, and touch drags from a `data-drag-handle` grip (which needs
 * `touch-action: none`), start after a small move. Touch elsewhere on a `data-drag-anywhere` element starts
 * after a 350ms long press, so normal touch scrolling keeps working there.
 */
export function dragStarter(getSource: () => DragSource | null) {
  return (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const anywhere = (e.currentTarget as HTMLElement).hasAttribute("data-drag-anywhere");
    const onHandle = !!target.closest("[data-drag-handle]");
    if (!anywhere && target.closest("button, input, textarea, select, a, [data-no-drag]") && !onHandle) return;
    if (target.closest("input, textarea, select")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const touch = e.pointerType !== "mouse";
    if (touch && !anywhere && !onHandle) return;
    const longPress = touch && !onHandle;
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    };
    const start = (x: number, y: number) => {
      cleanup();
      const source = getSource();
      if (source) {
        navigator.vibrate?.(15);
        beginDrag(source, { x, y, pointerId });
      }
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
      if (!longPress && dist > 6) start(ev.clientX, ev.clientY);
      else if (longPress && dist > 10) cleanup();
    };
    if (touch) e.preventDefault();
    if (longPress) timer = window.setTimeout(() => start(startX, startY), 350);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  };
}
