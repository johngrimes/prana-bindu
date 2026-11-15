import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { Perspective, Settings } from "../../shared/schemas";
import { useContents, usePerspectives, useSettingsValue } from "../api/queries";
import { Icon } from "../components/Icons";
import { ReviewSchedule, formatInterval } from "../components/inspector/ReviewSchedule";
import { Outline } from "../components/outline/Outline";
import { Popover } from "../components/Overlay";
import { ReviewSidebar } from "../components/Sidebars";
import { Workspace } from "../components/Workspace";
import { formatDayOnly, toWall, weekdayName, weekdayOf } from "../lib/dates";
import { hasCommandKey, isTypingTarget } from "../lib/keys";
import { perspectiveColor, perspectiveIcon } from "../lib/perspectives";
import { markReviewedAndAdvance, reviewPath, useReviewSession } from "../lib/review";
import { nextUnreviewed, type ReviewItem } from "../lib/reviewModel";
import { clearSelection, overlayOpen, ui } from "../lib/ui";

/**
 * Review perspective (docs/spec.md §3): the projects due for review in the sidebar, one project at a time
 * in the outline, and Mark Reviewed moving on to the next unreviewed project.
 */
export function ReviewPage() {
  const { data: perspectives } = usePerspectives();
  const perspective = perspectives?.find((p) => p.id === "review");
  if (!perspective) return <p className="p-8 text-center text-muted">{perspectives ? "Perspective not found." : "Loading…"}</p>;
  return <ReviewView perspective={perspective} />;
}

interface Nav {
  item: ReviewItem;
  prev: string | null;
  next: string | null;
  go: (id: string) => void;
  markReviewed: () => void;
}

function ReviewView({ perspective }: { perspective: Perspective }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const current = params.get("project");
  const items = useReviewSession();
  const settings = useSettingsValue();

  const index = items?.findIndex((i) => i.project.id === current) ?? -1;
  const item = items?.[index];
  const nav = useMemo((): Nav | null => {
    if (!items || !item) return null;
    return {
      item,
      prev: items[index - 1]?.project.id ?? null,
      next: items[index + 1]?.project.id ?? null,
      go: (id) => navigate(reviewPath(id)),
      markReviewed: () => markReviewedAndAdvance(item.project.id, navigate),
    };
  }, [items, item, index, navigate]);

  // With no project open (or one no longer listed), open the first unreviewed one, if any.
  useEffect(() => {
    if (!items || item) return;
    const first = nextUnreviewed(items, null);
    if (first !== current) navigate(reviewPath(first), { replace: true });
  }, [items, item, current, navigate]);

  // A selection belongs to the project it was made in; the phone inspector sheet closes with it.
  useEffect(() => {
    clearSelection();
    ui.set({ inspectorSheet: false });
  }, [current]);

  // The open project is read from the URL at key time: navigate changes it before the page re-renders.
  useEffect(() => {
    if (!items) return;
    const list = items;
    function onKey(e: KeyboardEvent) {
      if (!hasCommandKey(e) || e.altKey || isTypingTarget(e.target) || overlayOpen()) return;
      const key = e.key.toLowerCase();
      const command = e.shiftKey ? (key === "r" ? "review" : null) : key === "[" ? "prev" : key === "]" ? "next" : null;
      const at = list.findIndex((i) => i.project.id === new URLSearchParams(window.location.search).get("project"));
      if (!command || at < 0) return;
      e.preventDefault();
      if (command === "review") markReviewedAndAdvance(list[at]!.project.id, navigate);
      else {
        const target = list[command === "prev" ? at - 1 : at + 1];
        if (target) navigate(reviewPath(target.project.id));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, navigate]);

  return (
    <Workspace
      title={item?.project.task.name ?? perspective.name}
      icon={perspectiveIcon(perspective)}
      color={perspectiveColor(perspective)}
      sidebar={items?.length ? <ReviewSidebar items={items} current={current} /> : undefined}
      sidebarTitle="Projects to review"
      contentLabel="Review outline"
      canReorder={!!nav}
      footer={nav ? <ReviewButtons nav={nav} className="flex items-center gap-2 px-3 py-2" /> : undefined}
    >
      {!items ? (
        <p className="px-6 py-16 text-center text-muted" aria-busy="true">
          Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="px-6 py-16 text-center text-muted">No projects to review</p>
      ) : !nav ? (
        <div className="flex flex-col items-center gap-2 px-6 py-16 text-center" data-testid="review-done">
          <Icon name="check" size={32} className="text-accent" />
          <p className="text-lg font-medium">All projects reviewed</p>
          <p className="text-sm text-muted">Clean Up clears the reviewed projects from the list.</p>
        </div>
      ) : (
        <>
          <ReviewBar key={nav.item.project.id} nav={nav} left={items.filter((i) => !i.reviewed).length} total={items.length} settings={settings} />
          <ProjectOutline id={nav.item.project.id} name={nav.item.project.task.name} />
        </>
      )}
    </Workspace>
  );
}

function ReviewButtons({ nav, className }: { nav: Nav; className: string }) {
  return (
    <div className={className}>
      <button type="button" className="pb-icon-btn" aria-label="Previous project" title="Previous project (⌘[)" disabled={!nav.prev} onClick={() => nav.prev && nav.go(nav.prev)}>
        <Icon name="arrow-up" />
      </button>
      <button type="button" className="pb-icon-btn" aria-label="Next project" title="Next project (⌘])" disabled={!nav.next} onClick={() => nav.next && nav.go(nav.next)}>
        <Icon name="arrow-down" />
      </button>
      <button type="button" className="pb-btn pb-btn-primary flex-1 md:flex-none" title="Mark Reviewed (⌘⇧R)" onClick={nav.markReviewed}>
        <Icon name="review" size={18} /> Mark Reviewed
      </button>
    </div>
  );
}

function ReviewBar({ nav, left, total, settings }: { nav: Nav; left: number; total: number; settings: Settings }) {
  const { project, reviewed } = nav.item;
  const scheduleBtn = useRef<HTMLButtonElement>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const last = toWall(project.lastReview, settings.timeZone);
  return (
    <div role="region" aria-label="Review" className="z-[2] flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-4 py-2 text-sm md:sticky md:top-0">
      <span data-testid="review-progress">
        <strong className="tabular-nums">{left}</strong> of {total} left
      </span>
      {reviewed && (
        <span className="inline-flex items-center gap-1 text-accent">
          <Icon name="check" size={16} strokeWidth={2.4} /> Reviewed
        </span>
      )}
      <span className="text-muted">
        Last reviewed {weekdayName(weekdayOf(last))} {formatDayOnly(last, settings.dateFormat)}
      </span>
      <button ref={scheduleBtn} type="button" className="pb-btn text-sm md:min-h-[36px]" aria-haspopup="dialog" onClick={() => setScheduleOpen(true)}>
        <Icon name="repeat" size={16} /> Review every {formatInterval(project.reviewInterval)}
      </button>
      <ReviewButtons nav={nav} className="ml-auto hidden items-center gap-1 md:flex" />
      {scheduleOpen && (
        <Popover anchor={() => scheduleBtn.current} onClose={() => setScheduleOpen(false)} label="Review schedule" width={340}>
          <div className="flex flex-col gap-3 p-4">
            <ReviewSchedule id={project.id} project={project} settings={settings} />
          </div>
        </Popover>
      )}
    </div>
  );
}

function ProjectOutline({ id, name }: { id: string; name: string }) {
  const params = useMemo(() => ({ project: id }), [id]);
  const newItemTarget = useMemo(() => ({ projectId: id }), [id]);
  const { data: contents, isPending, isError, isPlaceholderData } = useContents("review", params);
  // Never show the previous project's rows under this project's bar while it loads.
  if ((isPending && !contents) || isPlaceholderData) {
    return (
      <p className="px-6 py-16 text-center text-muted" aria-busy="true">
        Loading…
      </p>
    );
  }
  if (isError && !contents) return <p className="px-6 py-16 text-center text-muted">This project could not be loaded.</p>;
  return (
    <Outline
      groups={contents?.groups ?? []}
      scopeKey={`review?project=${id}`}
      newItemTarget={newItemTarget}
      showProject={false}
      emptyText={contents?.emptyText ?? "No items"}
      label={name}
    />
  );
}
