import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { Perspective } from "../../shared/schemas";
import { useContents, usePerspectives, useProjects, useTags, type ContentsParams } from "../api/queries";
import { Icon } from "../components/Icons";
import { Outline, type NewItemTarget } from "../components/outline/Outline";
import { ProjectsSidebar, TagsSidebar } from "../components/Sidebars";
import { ViewOptionsPanel, hasViewOptions } from "../components/ViewOptions";
import { Workspace } from "../components/Workspace";
import { perspectiveColor, perspectiveIcon } from "../lib/perspectives";

const FALLBACK_EMPTY: Record<string, string> = {
  inbox: "No items",
  projects: "No projects",
};

function PerspectiveView({ perspective }: { perspective: Perspective }) {
  const [params] = useSearchParams();
  const id = perspective.id;
  const { data: projects } = useProjects();
  const { data: tags } = useTags();
  const contentParams: ContentsParams = useMemo(
    () => ({
      project: params.get("project") ?? undefined,
      folder: params.get("folder") ?? undefined,
      tag: params.get("tag") ?? undefined,
    }),
    [params],
  );
  const { data: contents, isPending, isError } = useContents(id, contentParams);

  const sidebarKind = perspective.builtin
    ? id === "projects"
      ? "projects"
      : id === "tags" || id === "completed" || id === "changed" || id === "flagged"
        ? "tags"
        : "none"
    : perspective.presentation.sidebar;
  const basePath = perspective.builtin ? `/${id}` : `/perspectives/${encodeURIComponent(id)}`;
  // The perspective's own options show a pending change at once; contents carry the server's effective default.
  const filter = perspective.viewOptions.filter ?? contents?.viewOptions.filter;
  const sidebar =
    sidebarKind === "projects" ? (
      <ProjectsSidebar showDropped={filter === "all"} />
    ) : sidebarKind === "tags" ? (
      <TagsSidebar basePath={basePath} showDropped={filter === "all"} allowCreate={id === "tags"} />
    ) : undefined;

  const newItemTarget: NewItemTarget | null = useMemo(() => {
    if (contentParams.project) return { projectId: contentParams.project };
    if (contentParams.tag && contentParams.tag !== "untagged") return { inbox: true, tagIds: [contentParams.tag] };
    if (id === "flagged") return { inbox: true, flagged: true };
    return { inbox: true };
  }, [contentParams, id]);

  // Title reflects the sidebar selection.
  let title = perspective.name;
  if (contentParams.project) title = projects?.find((p) => p.id === contentParams.project)?.task.name ?? title;
  else if (contentParams.tag) title = contentParams.tag === "untagged" ? "Untagged" : (tags?.find((t) => t.id === contentParams.tag)?.name ?? title);

  const groups = contents?.groups ?? [];

  return (
    <Workspace
      title={title}
      icon={perspectiveIcon(perspective)}
      color={perspectiveColor(perspective)}
      sidebar={sidebar}
      sidebarTitle={sidebarKind === "projects" ? "Projects" : "Tags"}
      viewOptions={hasViewOptions(id) && perspective.builtin ? <ViewOptionsPanel perspective={perspective} /> : undefined}
      contentLabel={`${title} outline`}
    >
      {!perspective.builtin && (
        <div className="flex justify-end border-b border-line px-3 py-1.5">
          <Link to={`/perspectives/${encodeURIComponent(id)}/edit`} className="pb-btn text-sm md:min-h-[36px]">
            <Icon name="edit" size={16} /> Edit perspective
          </Link>
        </div>
      )}
      {isPending && !contents ? (
        <p className="px-6 py-16 text-center text-muted" aria-busy="true">
          Loading…
        </p>
      ) : isError && !contents ? (
        <p className="px-6 py-16 text-center text-muted">This perspective could not be loaded.</p>
      ) : (
        <Outline
          groups={groups}
          scopeKey={`${id}?${params.toString()}`}
          newItemTarget={newItemTarget}
          showProject={id !== "projects" && id !== "inbox"}
          emptyText={contents?.emptyText ?? FALLBACK_EMPTY[id] ?? "No items"}
          label={title}
        />
      )}
    </Workspace>
  );
}

export function PerspectivePage({ id }: { id: string }) {
  const { data: perspectives } = usePerspectives();
  const perspective = perspectives?.find((p) => p.id === id);
  if (!perspective) return <p className="p-8 text-center text-muted">{perspectives ? "Perspective not found." : "Loading…"}</p>;
  return <PerspectiveView key={id} perspective={perspective} />;
}

export function CustomPerspectivePage() {
  const { id = "" } = useParams();
  return <PerspectivePage id={id} />;
}
