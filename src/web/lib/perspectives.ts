import type { Perspective } from "../../shared/schemas";

export const BUILTIN_ICONS: Record<string, string> = {
  inbox: "inbox",
  projects: "projects",
  tags: "tags",
  forecast: "forecast",
  flagged: "flagged",
  review: "review",
  completed: "completed",
  changed: "changed",
  search: "search",
};

export const BUILTIN_COLORS: Record<string, string> = {
  inbox: "#4a7fb5",
  projects: "#3f8a6b",
  tags: "#8a5cb8",
  forecast: "#c4372f",
  flagged: "#e08a12",
  review: "#4f6fd1",
  completed: "#5f7a46",
  changed: "#7a6a52",
  search: "#56707d",
};

export function perspectivePath(p: Pick<Perspective, "id" | "builtin">): string {
  return p.builtin ? `/${p.id}` : `/perspectives/${encodeURIComponent(p.id)}`;
}

export function perspectiveIcon(p: Pick<Perspective, "id" | "builtin" | "icon">): string {
  return p.builtin ? (BUILTIN_ICONS[p.id] ?? "layers") : p.icon || "layers";
}

export function perspectiveColor(p: Pick<Perspective, "id" | "builtin" | "color">): string {
  return p.color ?? BUILTIN_COLORS[p.id] ?? "var(--accent)";
}

/** Perspective id for the current pathname, or null (settings, editor, auth pages). */
export function perspectiveIdFromPath(pathname: string): string | null {
  const custom = /^\/perspectives\/([^/]+)$/.exec(pathname);
  if (custom?.[1]) return decodeURIComponent(custom[1]);
  const builtin = /^\/(inbox|projects|tags|forecast|flagged|review|completed|changed|search)$/.exec(pathname);
  return builtin?.[1] ?? null;
}

export function sortPerspectives(list: Perspective[]): Perspective[] {
  return [...list].sort((a, b) => a.rank - b.rank);
}
