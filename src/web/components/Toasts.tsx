import { createStore, useStore } from "../lib/store";
import { Icon } from "./Icons";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
  action?: { label: string; run: () => void };
}

const toastStore = createStore<{ toasts: Toast[] }>({ toasts: [] });
let nextId = 1;

export function dismissToast(id: number): void {
  toastStore.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function toast(message: string, options: { kind?: Toast["kind"]; action?: Toast["action"]; durationMs?: number } = {}): number {
  const id = nextId++;
  const entry: Toast = { id, message, kind: options.kind ?? "info", action: options.action };
  toastStore.set((s) => ({ toasts: [...s.toasts.slice(-3), entry] }));
  window.setTimeout(() => dismissToast(id), options.durationMs ?? (entry.kind === "error" ? 7000 : 5000));
  return id;
}

export function toastError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  toast(message, { kind: "error" });
}

export function Toasts() {
  const toasts = useStore(toastStore, (s) => s.toasts);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-[80] flex flex-col items-center gap-2 px-3 md:bottom-6"
      aria-live="polite"
      role="status"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid="toast"
          className={`pb-anim-up pointer-events-auto flex max-w-md items-center gap-3 rounded-xl px-4 py-2.5 text-sm shadow-pop ${
            t.kind === "error" ? "bg-danger text-white" : "bg-fg text-bg"
          }`}
        >
          <span className="min-w-0 flex-1">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="min-h-[44px] min-w-[44px] rounded-md px-2 font-semibold underline-offset-2 hover:underline"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" aria-label="Dismiss" className="-mr-2 flex min-h-[44px] min-w-[44px] items-center justify-center opacity-70" onClick={() => dismissToast(t.id)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
