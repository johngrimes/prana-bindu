// App-wide UI state: selection, panels and dialogs.
import type { OutlineGroup } from "../../shared/schemas";
import { createStore } from "./store";

/**
 * Selection keys: task/project ids as-is (a project is its root task), folders `f:<id>`, tags `t:<id>`.
 */
export type SelectionKey = string;

export const folderKey = (id: string) => `f:${id}`;
export const tagKey = (id: string) => `t:${id}`;

export function parseSelectionKey(key: SelectionKey): { kind: "task" | "folder" | "tag"; id: string } {
  if (key.startsWith("f:")) return { kind: "folder", id: key.slice(2) };
  if (key.startsWith("t:")) return { kind: "tag", id: key.slice(2) };
  return { kind: "task", id: key };
}

export interface UiState {
  selection: SelectionKey[];
  anchor: SelectionKey | null;
  editingId: string | null;
  /** Desktop panels. */
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  /** Mobile overlays. */
  drawerOpen: boolean;
  inspectorSheet: boolean;
  quickEntry: boolean;
  quickOpen: boolean;
  viewOptions: boolean;
  shortcuts: boolean;
  perspectivesMenu: boolean;
  appMenu: boolean;
  collapsed: Record<string, true>;
  /** Reorder mode: outline actions show drag grips (ended by Done, Escape or navigation). */
  reordering: boolean;
}

const persisted = (() => {
  try {
    return JSON.parse(localStorage.getItem("pb.panels") ?? "{}") as Partial<UiState>;
  } catch {
    return {};
  }
})();

export const ui = createStore<UiState>({
  selection: [],
  anchor: null,
  editingId: null,
  sidebarOpen: persisted.sidebarOpen ?? true,
  inspectorOpen: persisted.inspectorOpen ?? true,
  drawerOpen: false,
  inspectorSheet: false,
  quickEntry: false,
  quickOpen: false,
  viewOptions: false,
  shortcuts: false,
  perspectivesMenu: false,
  appMenu: false,
  collapsed: {},
  reordering: false,
});

ui.subscribe(() => {
  const { sidebarOpen, inspectorOpen } = ui.get();
  try {
    localStorage.setItem("pb.panels", JSON.stringify({ sidebarOpen, inspectorOpen }));
  } catch {
    // storage unavailable (private mode): panel state is simply not remembered
  }
});

export function select(keys: SelectionKey[], anchor: SelectionKey | null = keys[keys.length - 1] ?? null): void {
  ui.set({ selection: keys, anchor, editingId: null });
}

export function clearSelection(): void {
  ui.set({ selection: [], anchor: null, editingId: null });
}

/** True when any modal-like overlay is open (global shortcuts are suspended). */
export function overlayOpen(): boolean {
  const s = ui.get();
  return s.quickEntry || s.quickOpen || s.shortcuts || s.viewOptions || s.perspectivesMenu || s.appMenu || s.drawerOpen || s.inspectorSheet;
}

export function closeOverlays(): void {
  ui.set({
    quickEntry: false,
    quickOpen: false,
    viewOptions: false,
    shortcuts: false,
    perspectivesMenu: false,
    appMenu: false,
    drawerOpen: false,
    inspectorSheet: false,
  });
}

/** Commands and state provided by the mounted outline (New item from the header, undo snapshots, Clean Up). */
export interface OutlineCommands {
  newItem(): void;
  /** The displayed groups (kept rows and pending changes included, collapsed rows too). */
  groups(): OutlineGroup[];
  /** Rows Clean Up removes from the view (greyed out). */
  leaving(): Array<{ groupKey: string; id: string }>;
}
let outlineCommands: OutlineCommands | null = null;
export function registerOutline(commands: OutlineCommands | null): void {
  outlineCommands = commands;
}
export function outline(): OutlineCommands | null {
  return outlineCommands;
}

export const isMobile = () => window.matchMedia("(max-width: 767.98px)").matches;

/** Opens the inspector appropriate for the viewport. */
export function showInspector(): void {
  if (isMobile()) ui.set({ inspectorSheet: true });
  else ui.set({ inspectorOpen: true });
}
