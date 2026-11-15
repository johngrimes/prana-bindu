import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { Folder, Position, Project, Tag } from "../../shared/schemas";
import { actions, attempt, useFolders, useProjects, useTags } from "../api/queries";
import { dndStore, dragStarter, type DragSource } from "../lib/dnd";
import { newId } from "../lib/drafts";
import { flattenTree } from "../lib/entities";
import { reviewPath } from "../lib/review";
import type { ReviewItem } from "../lib/reviewModel";
import { useStore } from "../lib/store";
import { folderKey, select, tagKey, ui } from "../lib/ui";
import { Icon } from "./Icons";
import { MenuItem, Popover } from "./Overlay";

function projectIcon(p: Project): string {
  return p.type === "sequential" ? "project-sequential" : p.type === "singleActions" ? "project-single" : "project-parallel";
}

function SidebarItem({
  icon,
  label,
  active,
  depth = 0,
  dimmed,
  badge,
  count,
  onClick,
  dropKind,
  dropId,
  dropModes,
  onDragStart,
  renaming,
  onRename,
  onDoubleClick,
  testId,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  depth?: number;
  dimmed?: boolean;
  badge?: ReactNode;
  count?: number;
  onClick: () => void;
  dropKind?: string;
  dropId?: string;
  dropModes?: string;
  onDragStart?: (e: React.PointerEvent) => void;
  renaming?: boolean;
  onRename?: (name: string | null) => void;
  onDoubleClick?: () => void;
  testId?: string;
}) {
  const targetKey = useStore(dndStore, (s) => s.targetKey);
  const targetPos = useStore(dndStore, (s) => s.targetPos);
  const isTarget = dropKind && targetKey === `${dropKind}:${dropId}`;
  const ring = isTarget ? (targetPos === "inside" ? "ring-2 ring-inset ring-accent" : targetPos === "before" ? "shadow-[inset_0_2px_0_var(--accent)]" : "shadow-[inset_0_-2px_0_var(--accent)]") : "";
  return (
    <li>
      <div
        data-drop-kind={dropKind}
        data-drop-id={dropId}
        data-drop-modes={dropModes}
        data-testid={testId}
        onPointerDown={onDragStart}
        data-drag-anywhere={onDragStart ? "" : undefined}
        className={`group flex min-h-[44px] items-center rounded-lg ${active ? "bg-select-strong/70 font-medium" : "hover:bg-surface-3/60"} ${dimmed ? "opacity-60" : ""} ${ring}`}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {renaming ? (
          <div className="flex flex-1 items-center gap-2 pr-2">
            <span className="shrink-0 text-muted">{icon}</span>
            <input
              className="pb-input py-1 md:min-h-[34px]"
              aria-label={`Rename ${label}`}
              defaultValue={label}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => onRename?.(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") onRename?.(null);
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 pr-2 text-left text-sm"
            aria-current={active ? "page" : undefined}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            data-closes-drawer
          >
            <span className="shrink-0 text-muted">{icon}</span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {badge}
            {count !== undefined && count > 0 && <span className="text-xs tabular-nums text-muted">{count}</span>}
          </button>
        )}
      </div>
    </li>
  );
}

function containerDrag(type: "folder" | "project" | "tag", id: string, label: string, drop: DragSource["drop"], accept: DragSource["accept"]) {
  return dragStarter(() => ({ type, ids: [id], label, accept, drop }));
}

/** Projects sidebar: Inbox, folder tree with projects. */
export function ProjectsSidebar({ showDropped }: { showDropped: boolean }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const selectedProject = params.get("project");
  const selectedFolder = params.get("folder");
  const { data: folders = [] } = useFolders();
  const { data: projects = [] } = useProjects();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  // Folders and projects share one rank ordering within each folder (docs/spec.md §1.2).
  const entries = useMemo(() => {
    type Entry = { kind: "folder"; folder: Folder; depth: number } | { kind: "project"; project: Project; depth: number };
    const visibleFolders = folders.filter((f) => showDropped || f.effectiveActive);
    const visibleProjects = projects.filter((p) => showDropped || (p.effectiveStatus !== "dropped" && p.effectiveStatus !== "completed"));
    const out: Entry[] = [];
    const walk = (parentId: string | null, depth: number) => {
      const kids: Array<{ rank: number; entry: Entry }> = [
        ...visibleFolders.filter((f) => f.parentId === parentId).map((f) => ({ rank: f.rank, entry: { kind: "folder" as const, folder: f, depth } })),
        ...visibleProjects.filter((p) => p.folderId === parentId).map((p) => ({ rank: p.task.rank, entry: { kind: "project" as const, project: p, depth } })),
      ].sort((a, b) => a.rank - b.rank);
      for (const k of kids) {
        out.push(k.entry);
        if (k.entry.kind === "folder") walk(k.entry.folder.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [folders, projects, showDropped]);

  const moveContainer = (type: "folder" | "project", id: string, t: { kind: string; id: string; pos: string }) => {
    let parentId: string | null;
    let position: Position;
    if (t.kind === "folder-root") {
      parentId = null;
      position = "end";
    } else if (t.kind === "folder" && t.pos === "inside") {
      parentId = t.id;
      position = "end";
    } else {
      const target = t.kind === "folder" ? folders.find((f) => f.id === t.id) : projects.find((p) => p.id === t.id);
      if (!target) return;
      parentId = "folderId" in target ? target.folderId : target.parentId;
      position = t.pos === "before" ? { before: t.id } : { after: t.id };
    }
    void attempt(type === "folder" ? actions.moveFolder(id, parentId, position) : actions.moveProject(id, parentId, position));
  };

  const isDescendantFolder = (folderId: string, ancestorId: string): boolean => {
    let f = folders.find((x) => x.id === folderId);
    while (f) {
      if (f.id === ancestorId) return true;
      f = f.parentId ? folders.find((x) => x.id === f?.parentId) : undefined;
    }
    return false;
  };

  function newProject(type: Project["type"]) {
    setMenuAnchor(null);
    const id = newId();
    void actions.createProject({ id, name: "Untitled Project", type, folderId: selectedFolder ?? null });
    navigate(`/projects?project=${encodeURIComponent(id)}`);
    window.setTimeout(() => ui.set({ selection: [id], anchor: id, editingId: id }), 50);
  }

  function newFolder() {
    setMenuAnchor(null);
    const id = newId();
    void actions.createFolder({ id, name: "Untitled Folder", parentId: selectedFolder ?? null });
    setRenaming(id);
  }

  return (
    <div className="flex h-full flex-col">
      <ul className="flex-1 p-2" aria-label="Folders and projects">
        <SidebarItem
          icon={<Icon name="inbox" size={18} />}
          label="Inbox"
          active={false}
          onClick={() => navigate("/inbox")}
          dropKind="inbox"
          dropId="inbox"
          testId="sidebar-inbox"
        />
        <SidebarItem
          icon={<Icon name="projects" size={18} />}
          label="All Projects"
          active={!selectedProject && !selectedFolder}
          onClick={() => navigate("/projects")}
          dropKind="folder-root"
          dropId="root"
        />
        {entries.map((e) =>
          e.kind === "folder" ? (
            <SidebarItem
              key={`f:${e.folder.id}`}
              icon={<Icon name="folder" size={18} />}
              label={e.folder.name}
              depth={e.depth + 1}
              dimmed={!e.folder.effectiveActive}
              active={selectedFolder === e.folder.id}
              onClick={() => {
                navigate(`/projects?folder=${encodeURIComponent(e.folder.id)}`);
                select([folderKey(e.folder.id)]);
              }}
              onDoubleClick={() => setRenaming(e.folder.id)}
              renaming={renaming === e.folder.id}
              onRename={(name) => {
                setRenaming(null);
                if (name && name !== e.folder.name) void attempt(actions.patchFolder(e.folder.id, { name }));
              }}
              dropKind="folder"
              dropId={e.folder.id}
              dropModes="before,after,inside"
              onDragStart={containerDrag(
                "folder",
                e.folder.id,
                e.folder.name,
                (t) => moveContainer("folder", e.folder.id, t),
                (t) => (t.kind === "folder" || t.kind === "project" || t.kind === "folder-root") && !(t.kind === "folder" && isDescendantFolder(t.id, e.folder.id)),
              )}
              testId="sidebar-folder"
            />
          ) : (
            <SidebarItem
              key={`p:${e.project.id}`}
              icon={<Icon name={projectIcon(e.project)} size={18} />}
              label={e.project.task.name}
              depth={e.depth + 1}
              dimmed={e.project.effectiveStatus !== "active"}
              badge={e.project.effectiveStatus === "onHold" ? <Icon name="pause" size={14} className="text-muted" title="On hold" /> : undefined}
              count={e.project.availableCount}
              active={selectedProject === e.project.id}
              onClick={() => navigate(`/projects?project=${encodeURIComponent(e.project.id)}`)}
              onDoubleClick={() => setRenaming(e.project.id)}
              renaming={renaming === e.project.id}
              onRename={(name) => {
                setRenaming(null);
                if (name && name !== e.project.task.name) void attempt(actions.patchProject(e.project.id, { name }));
              }}
              dropKind="project"
              dropId={e.project.id}
              dropModes="before,after,inside"
              onDragStart={containerDrag(
                "project",
                e.project.id,
                e.project.task.name,
                (t) => moveContainer("project", e.project.id, t),
                (t) => t.kind === "folder" || t.kind === "folder-root" || (t.kind === "project" && t.pos !== "inside"),
              )}
              testId="sidebar-project"
            />
          ),
        )}
      </ul>
      <div className="sticky bottom-0 border-t border-line bg-surface-2/90 p-2 backdrop-blur">
        <button type="button" className="pb-btn w-full" aria-haspopup="menu" onClick={(e) => setMenuAnchor(e.currentTarget)}>
          <Icon name="plus" size={18} /> New
        </button>
      </div>
      {menuAnchor && (
        <Popover anchor={menuAnchor} onClose={() => setMenuAnchor(null)} label="New project or folder" width={250}>
          <div role="menu" className="py-1">
            <MenuItem icon="project-parallel" label="New Parallel Project" onSelect={() => newProject("parallel")} />
            <MenuItem icon="project-sequential" label="New Sequential Project" onSelect={() => newProject("sequential")} />
            <MenuItem icon="project-single" label="New Single Action List" onSelect={() => newProject("singleActions")} />
            <MenuItem icon="folder" label="New Folder" onSelect={newFolder} />
          </div>
        </Popover>
      )}
    </div>
  );
}

/** Review sidebar: the flat list of projects to review, reviewed ones checked (docs/spec.md §3). */
export function ReviewSidebar({ items, current }: { items: ReviewItem[]; current: string | null }) {
  const navigate = useNavigate();
  return (
    <ul className="p-2" aria-label="Projects to review">
      {items.map(({ project, reviewed }) => (
        <SidebarItem
          key={project.id}
          icon={<Icon name={projectIcon(project)} size={18} />}
          label={project.task.name}
          dimmed={project.effectiveStatus === "completed" || project.effectiveStatus === "dropped"}
          badge={reviewed ? <Icon name="check" size={16} strokeWidth={2.4} className="text-accent" title="Reviewed" /> : undefined}
          active={current === project.id}
          onClick={() => navigate(reviewPath(project.id))}
          testId="review-sidebar-project"
        />
      ))}
    </ul>
  );
}

/** Tags sidebar: tag tree + Untagged. */
export function TagsSidebar({ basePath, showDropped = false, allowCreate = true }: { basePath: string; showDropped?: boolean; allowCreate?: boolean }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const selected = params.get("tag");
  const { data: tags = [] } = useTags();
  const [renaming, setRenaming] = useState<string | null>(null);
  const tree = useMemo(() => flattenTree(tags.filter((t) => showDropped || t.effectiveStatus !== "dropped")), [tags, showDropped]);

  const moveTag = (id: string, t: { kind: string; id: string; pos: string }) => {
    if (t.kind === "tag-root") {
      void attempt(actions.moveTag(id, null, "end"));
      return;
    }
    if (t.kind !== "tag") return;
    if (t.pos === "inside") void attempt(actions.moveTag(id, t.id, "end"));
    else {
      const target = tags.find((x) => x.id === t.id);
      void attempt(actions.moveTag(id, target?.parentId ?? null, t.pos === "before" ? { before: t.id } : { after: t.id }));
    }
  };
  const isDescendant = (tagId: string, ancestorId: string) => {
    let t: Tag | undefined = tags.find((x) => x.id === tagId);
    while (t) {
      if (t.id === ancestorId) return true;
      t = t.parentId ? tags.find((x) => x.id === t?.parentId) : undefined;
    }
    return false;
  };

  function newTag() {
    const id = newId();
    void actions.createTag({ id, name: "Untitled Tag", parentId: null });
    setRenaming(id);
  }

  return (
    <div className="flex h-full flex-col">
      <ul className="flex-1 p-2" aria-label="Tags">
        <SidebarItem
          icon={<Icon name="tags" size={18} />}
          label="All Tags"
          active={!selected}
          onClick={() => navigate(basePath)}
          dropKind="tag-root"
          dropId="root"
        />
        {tree.map(({ item, depth }) => (
          <SidebarItem
            key={item.id}
            icon={<Icon name="tag" size={18} />}
            label={item.name}
            depth={depth + 1}
            dimmed={item.effectiveStatus !== "active"}
            badge={item.effectiveStatus === "onHold" ? <Icon name="pause" size={14} className="text-muted" title="On hold" /> : undefined}
            count={item.availableCount}
            active={selected === item.id}
            onClick={() => {
              navigate(`${basePath}?tag=${encodeURIComponent(item.id)}`);
              select([tagKey(item.id)]);
            }}
            onDoubleClick={() => setRenaming(item.id)}
            renaming={renaming === item.id}
            onRename={(name) => {
              setRenaming(null);
              if (name && name !== item.name) void attempt(actions.patchTag(item.id, { name }));
            }}
            dropKind="tag"
            dropId={item.id}
            dropModes="before,after,inside"
            onDragStart={containerDrag("tag", item.id, item.name, (t) => moveTag(item.id, t), (t) => (t.kind === "tag" && !isDescendant(t.id, item.id)) || t.kind === "tag-root")}
            testId="sidebar-tag"
          />
        ))}
        <SidebarItem
          icon={<Icon name="tag" size={18} />}
          label="Untagged"
          active={selected === "untagged"}
          onClick={() => navigate(`${basePath}?tag=untagged`)}
        />
      </ul>
      {allowCreate && (
        <div className="sticky bottom-0 border-t border-line bg-surface-2/90 p-2 backdrop-blur">
          <button type="button" className="pb-btn w-full" onClick={newTag}>
            <Icon name="plus" size={18} /> New Tag
          </button>
        </div>
      )}
    </div>
  );
}
