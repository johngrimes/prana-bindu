import type { Folder, Project, Tag } from "../../shared/schemas";

export function byId<T extends { id: string }>(items: T[] | undefined): Map<string, T> {
  return new Map((items ?? []).map((i) => [i.id, i]));
}

/** "Parent : Child" path of a tag. */
export function tagPath(tag: Tag, tags: Map<string, Tag>): string {
  const names = [tag.name];
  let parent = tag.parentId ? tags.get(tag.parentId) : undefined;
  while (parent) {
    names.unshift(parent.name);
    parent = parent.parentId ? tags.get(parent.parentId) : undefined;
  }
  return names.join(" : ");
}

export function folderPath(folderId: string | null, folders: Map<string, Folder>): string {
  const names: string[] = [];
  let f = folderId ? folders.get(folderId) : undefined;
  while (f) {
    names.unshift(f.name);
    f = f.parentId ? folders.get(f.parentId) : undefined;
  }
  return names.join(" : ");
}

/** Projects offered by the Project smart-match field: remaining (active or on hold) ones. */
export function projectChoices(projects: Project[] | undefined, folders: Folder[] | undefined) {
  const fmap = byId(folders);
  return (projects ?? [])
    .filter((p) => p.effectiveStatus === "active" || p.effectiveStatus === "onHold")
    .map((p) => ({ id: p.id, name: p.task.name, detail: folderPath(p.folderId, fmap) || undefined }));
}

export function tagChoices(tags: Tag[] | undefined, exclude: string[] = []) {
  const tmap = byId(tags);
  return (tags ?? [])
    .filter((t) => t.effectiveStatus !== "dropped" && !exclude.includes(t.id))
    .map((t) => ({ id: t.id, name: t.name, detail: t.parentId ? tagPath(t, tmap).split(" : ").slice(0, -1).join(" : ") : undefined }));
}

export interface TreeNode<T> {
  item: T;
  depth: number;
}

/** Depth-first ordering of a parent-linked list by rank (folders, tags). */
export function flattenTree<T extends { id: string; parentId: string | null; rank: number }>(items: T[]): TreeNode<T>[] {
  const children = new Map<string | null, T[]>();
  const ids = new Set(items.map((i) => i.id));
  for (const item of items) {
    const parent = item.parentId && ids.has(item.parentId) ? item.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(item);
    children.set(parent, list);
  }
  const out: TreeNode<T>[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const child of (children.get(parent) ?? []).sort((a, b) => a.rank - b.rank)) {
      out.push({ item: child, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}
