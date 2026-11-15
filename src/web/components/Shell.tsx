import { useEffect, useLayoutEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router";
import type { Perspective } from "../../shared/schemas";
import { actions, usePerspectives, useSettings } from "../api/queries";
import { cleanUp, redo, refresh, resetSticky, signOut, undo } from "../lib/commands";
import { browserTimeZone } from "../lib/dates";
import { hasCommandKey, isTypingTarget } from "../lib/keys";
import { perspectiveColor, perspectiveIcon, perspectiveIdFromPath, perspectivePath, sortPerspectives } from "../lib/perspectives";
import { useStore } from "../lib/store";
import { clearSelection, closeOverlays, outline, overlayOpen, ui } from "../lib/ui";
import { Icon, Logo } from "./Icons";
import { Dialog, MenuItem } from "./Overlay";
import { QuickEntry } from "./QuickEntry";
import { QuickOpen } from "./QuickOpen";
import { ShortcutsSheet } from "./ShortcutsSheet";

function useGlobalShortcuts() {
  const navigate = useNavigate();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const key = e.key;
      const cmd = hasCommandKey(e);
      if (cmd && key.toLowerCase() === "z") {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
        return;
      }
      if (cmd || e.altKey) return;
      if (overlayOpen()) return;
      const lower = key.toLowerCase();
      if (e.shiftKey) {
        if (lower === "s") ui.set((s) => ({ sidebarOpen: !s.sidebarOpen }));
        else if (lower === "i") ui.set((s) => ({ inspectorOpen: !s.inspectorOpen }));
        else if (lower === "z") void redo();
        else if (key === "?") ui.set({ shortcuts: true });
        else return;
        e.preventDefault();
        return;
      }
      switch (key) {
        case "c":
          ui.set({ quickEntry: true });
          break;
        case "o":
          ui.set({ quickOpen: true });
          break;
        case "p":
          ui.set({ perspectivesMenu: true });
          break;
        case "v":
          ui.set({ viewOptions: true });
          break;
        case "k":
          void cleanUp();
          break;
        case "z":
          void undo();
          break;
        case "s":
          refresh();
          break;
        case "n":
          if (outline()) outline()?.newItem();
          else ui.set({ quickEntry: true });
          break;
        case "/":
          navigate("/search");
          window.setTimeout(() => document.getElementById("pb-search-input")?.focus(), 30);
          break;
        case "?":
          ui.set({ shortcuts: true });
          break;
        case "Escape": {
          // While reordering, Escape clears a selection first, then ends reorder mode (whichever of this and the
          // outline's handler runs first takes the press).
          const s = ui.get();
          if (!s.reordering) return;
          if (s.selection.length) clearSelection();
          else ui.set({ reordering: false });
          break;
        }
        default:
          return;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
}

function railItems(perspectives: Perspective[], currentId: string | null): Perspective[] {
  const sorted = sortPerspectives(perspectives);
  const favorites = sorted.filter((p) => p.favorite);
  const current = currentId ? sorted.find((p) => p.id === currentId) : undefined;
  if (current && !current.favorite) favorites.push(current);
  return favorites;
}

function PerspectiveGlyph({ p, size = 22 }: { p: Perspective; size?: number }) {
  return (
    <span style={{ color: perspectiveColor(p) }} className="inline-flex">
      <Icon name={perspectiveIcon(p)} size={size} />
    </span>
  );
}

function Rail({ perspectives, currentId }: { perspectives: Perspective[]; currentId: string | null }) {
  const items = railItems(perspectives, currentId);
  return (
    <nav aria-label="Perspectives" className="hidden w-[68px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface-2 py-3 md:flex">
      <div className="mb-3">
        <Logo size={32} />
      </div>
      <div className="pb-scroll flex min-h-0 flex-1 flex-col items-center gap-1">
        {items.map((p) => (
          <NavLink
            key={p.id}
            to={perspectivePath(p)}
            title={p.name}
            aria-label={p.name}
            className={({ isActive }) =>
              `flex h-12 w-12 items-center justify-center rounded-xl transition-colors ${isActive ? "bg-surface shadow-sm ring-1 ring-line" : "hover:bg-surface"} ${
                p.favorite ? "" : "opacity-70"
              }`
            }
          >
            <PerspectiveGlyph p={p} />
          </NavLink>
        ))}
      </div>
      <NavLink
        to="/settings"
        title="Settings"
        aria-label="Settings"
        className={({ isActive }) => `pb-icon-btn ${isActive ? "bg-surface text-fg" : ""}`}
      >
        <Icon name="gear" />
      </NavLink>
    </nav>
  );
}

function BottomBar({ perspectives, currentId }: { perspectives: Perspective[]; currentId: string | null }) {
  const items = railItems(perspectives, currentId).slice(0, 4);
  const [more, setMore] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <nav
        aria-label="Perspectives"
        className="pb-safe-bottom fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-surface/95 backdrop-blur md:hidden"
      >
        {items.map((p) => (
          <NavLink
            key={p.id}
            to={perspectivePath(p)}
            className={({ isActive }) =>
              `flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${isActive ? "font-semibold text-fg" : "text-muted"}`
            }
          >
            <PerspectiveGlyph p={p} size={22} />
            <span className="max-w-full truncate px-1">{p.name}</span>
          </NavLink>
        ))}
        <button type="button" className="flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-muted" onClick={() => setMore(true)}>
          <Icon name="more" size={22} strokeWidth={3} />
          <span>More</span>
        </button>
      </nav>
      {more && (
        <Dialog title="All perspectives" onClose={() => setMore(false)}>
          <PerspectiveList
            perspectives={perspectives}
            onPick={(p) => {
              setMore(false);
              navigate(perspectivePath(p));
            }}
          />
          <div className="border-t border-line py-1">
            <MenuItem icon="plus" label="New perspective" onSelect={() => { setMore(false); navigate(NEW_PERSPECTIVE_PATH); }} />
            <MenuItem icon="gear" label="Settings" onSelect={() => { setMore(false); navigate("/settings"); }} />
            <MenuItem icon="help" label="Keyboard shortcuts" onSelect={() => { setMore(false); ui.set({ shortcuts: true }); }} />
            <MenuItem icon="logout" label="Sign out" onSelect={() => void signOut()} />
          </div>
        </Dialog>
      )}
    </>
  );
}

/** The editor for a not-yet-saved perspective; it is only created on Save. */
const NEW_PERSPECTIVE_PATH = "/perspectives/new/edit";

/** All perspectives with favourite stars (perspectives menu and mobile "More"). */
export function PerspectiveList({ perspectives, onPick }: { perspectives: Perspective[]; onPick: (p: Perspective) => void }) {
  return (
    <ul role="list" className="py-1">
      {sortPerspectives(perspectives).map((p) => (
        <li key={p.id} className="flex items-center">
          <button type="button" className="flex min-h-[48px] flex-1 items-center gap-3 px-4 text-left hover:bg-surface-2" onClick={() => onPick(p)}>
            <PerspectiveGlyph p={p} />
            <span className="flex-1">{p.name}</span>
          </button>
          <button
            type="button"
            className={`pb-icon-btn mr-1 ${p.favorite ? "text-gold" : "text-faint"}`}
            aria-label={p.favorite ? `Remove ${p.name} from favorites` : `Add ${p.name} to favorites`}
            aria-pressed={p.favorite}
            onClick={() => void actions.patchPerspective(p.id, { favorite: !p.favorite })}
          >
            <Icon name="star" filled={p.favorite} size={18} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function TimeZoneBanner() {
  const { data: settings } = useSettings();
  const browserTz = browserTimeZone();
  const dismissKey = settings ? `pb.tzdismiss.${settings.timeZone}.${browserTz}` : "";
  const [dismissed, setDismissed] = useState(() => (dismissKey ? localStorage.getItem(dismissKey) === "1" : false));
  if (!settings || settings.timeZone === browserTz || dismissed || localStorage.getItem(dismissKey) === "1") return null;
  return (
    <div role="region" aria-label="Time zone" className="flex flex-wrap items-center gap-2 border-b border-line bg-warn-soft px-4 py-2 text-sm">
      <Icon name="globe" size={18} className="text-warn" />
      <span className="min-w-0 flex-1">
        Your device is in <strong>{browserTz}</strong> but prana-bindu uses <strong>{settings.timeZone}</strong>. Floating dates follow the app setting.
      </span>
      <button type="button" className="pb-btn md:min-h-[36px]" onClick={() => void actions.patchSettings({ timeZone: browserTz })}>
        Use {browserTz}
      </button>
      <button
        type="button"
        className="pb-btn md:min-h-[36px]"
        onClick={() => {
          localStorage.setItem(dismissKey, "1");
          setDismissed(true);
        }}
      >
        Keep
      </button>
    </div>
  );
}

function PerspectivesMenu({ perspectives }: { perspectives: Perspective[] }) {
  const navigate = useNavigate();
  const close = () => ui.set({ perspectivesMenu: false });
  return (
    <Dialog title="Perspectives" onClose={close}>
      <PerspectiveList
        perspectives={perspectives}
        onPick={(p) => {
          close();
          navigate(perspectivePath(p));
        }}
      />
      <div className="border-t border-line py-1">
        <MenuItem icon="plus" label="New perspective" onSelect={() => { close(); navigate(NEW_PERSPECTIVE_PATH); }} />
      </div>
    </Dialog>
  );
}

export function Shell() {
  const location = useLocation();
  const { data: perspectives = [] } = usePerspectives();
  const currentId = perspectiveIdFromPath(location.pathname);
  const quickEntry = useStore(ui, (s) => s.quickEntry);
  const quickOpen = useStore(ui, (s) => s.quickOpen);
  const shortcuts = useStore(ui, (s) => s.shortcuts);
  const perspectivesMenu = useStore(ui, (s) => s.perspectivesMenu);
  useGlobalShortcuts();

  // Navigating to another view drops kept-visible rows and the selection (as Clean Up would), and ends reorder mode.
  // A layout effect, so that it runs before the pages' effects (QuickEntryFromUrl opens Quick Entry in one).
  useLayoutEffect(() => {
    resetSticky();
    clearSelection();
    closeOverlays();
    ui.set({ reordering: false });
  }, [location.pathname]);

  return (
    <div className="flex h-full flex-col">
      <a href="#pb-main" className="sr-only focus:not-sr-only focus:absolute focus:z-[90] focus:m-2 focus:rounded focus:bg-surface focus:p-2">
        Skip to content
      </a>
      <TimeZoneBanner />
      <div className="flex min-h-0 flex-1">
        <Rail perspectives={perspectives} currentId={currentId} />
        <div className="flex min-w-0 flex-1 flex-col pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-0">
          <Outlet />
        </div>
      </div>
      <BottomBar perspectives={perspectives} currentId={currentId} />
      {quickEntry && <QuickEntry />}
      {quickOpen && <QuickOpen />}
      {shortcuts && <ShortcutsSheet />}
      {perspectivesMenu && <PerspectivesMenu perspectives={perspectives} />}
    </div>
  );
}

/**
 * Layout route around the pages: `?quickEntry=1` opens Quick Entry (the Scriptable widget's "+" button uses it), then
 * is removed from the URL so that a reload or Back does not reopen it. Redirect routes are outside this layout and keep
 * the query string, so the parameter takes effect where they land.
 */
export function QuickEntryFromUrl() {
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get("quickEntry") !== "1") return;
    ui.set({ quickEntry: true });
    const rest = new URLSearchParams(searchParams);
    rest.delete("quickEntry");
    setSearchParams(rest, { replace: true });
  }, [searchParams, setSearchParams]);
  return <Outlet />;
}
