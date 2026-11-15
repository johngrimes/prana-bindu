import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useHistory } from "../api/queries";
import { cleanUp, redo, signOut, undo } from "../lib/commands";
import { useStore } from "../lib/store";
import { outline, ui } from "../lib/ui";
import { useStalled } from "../lib/writes";
import { Icon } from "./Icons";
import { Drawer, MenuItem, Popover } from "./Overlay";
import { Inspector } from "./inspector/Inspector";

function HeaderButton({
  icon,
  label,
  onClick,
  disabled,
  pressed,
  shortcut,
  className = "",
  buttonRef,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  shortcut?: string;
  className?: string;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`pb-icon-btn ${pressed ? "bg-surface-2 text-fg" : ""} ${className}`}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

/**
 * Page frame for every signed-in view: header actions (docs/spec.md §2), optional sidebar (column ≥ 768 px,
 * drawer below), content, and the inspector (column or full-screen sheet). `footer` is a bar pinned under
 * the content on phones only.
 */
export function Workspace({
  title,
  icon,
  color,
  sidebar,
  sidebarTitle,
  viewOptions,
  children,
  inspector = true,
  canCleanUp = true,
  canCreate = true,
  canReorder = true,
  contentLabel,
  footer,
}: {
  title: string;
  icon: string;
  color?: string;
  sidebar?: ReactNode;
  sidebarTitle?: string;
  viewOptions?: ReactNode;
  children: ReactNode;
  inspector?: boolean;
  canCleanUp?: boolean;
  canCreate?: boolean;
  /** The page shows an outline whose actions can be dragged (Reorder in the menus). */
  canReorder?: boolean;
  contentLabel?: string;
  footer?: ReactNode;
}) {
  const navigate = useNavigate();
  const sidebarOpen = useStore(ui, (s) => s.sidebarOpen);
  const inspectorOpen = useStore(ui, (s) => s.inspectorOpen);
  const drawerOpen = useStore(ui, (s) => s.drawerOpen);
  const viewOptionsOpen = useStore(ui, (s) => s.viewOptions);
  const appMenu = useStore(ui, (s) => s.appMenu);
  const reordering = useStore(ui, (s) => s.reordering);
  const { data: history } = useHistory();
  const stalled = useStalled();
  const viewBtnDesktop = useRef<HTMLButtonElement>(null);
  const viewBtnMobile = useRef<HTMLButtonElement>(null);
  const menuBtnDesktop = useRef<HTMLButtonElement>(null);
  const menuBtnMobile = useRef<HTMLButtonElement>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const mobile = () => window.matchMedia("(max-width: 767.98px)").matches;
  const newItem = () => {
    const o = outline();
    if (o) o.newItem();
    else ui.set({ quickEntry: true });
  };
  // V on a page without view options would leave an invisible overlay that suspends every shortcut.
  const hasViewOptions = !!viewOptions;
  useEffect(() => {
    if (viewOptionsOpen && !hasViewOptions) ui.set({ viewOptions: false });
  }, [viewOptionsOpen, hasViewOptions]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-[56px] shrink-0 items-center gap-0.5 border-b border-line bg-surface px-1.5 md:px-2">
        {sidebar && (
          <>
            <HeaderButton icon="sidebar" label="Show sidebar" className="md:hidden" onClick={() => ui.set({ drawerOpen: true })} />
            <HeaderButton
              icon="sidebar"
              label="Toggle sidebar"
              shortcut="⇧S"
              className="hidden md:inline-flex"
              pressed={sidebarOpen}
              onClick={() => ui.set((s) => ({ sidebarOpen: !s.sidebarOpen }))}
            />
          </>
        )}
        <HeaderButton icon="menu" label="Perspectives" shortcut="P" className="hidden md:inline-flex" onClick={() => ui.set({ perspectivesMenu: true })} />
        <h1 className="flex min-w-0 flex-1 items-center gap-2 px-2 text-lg font-semibold md:flex-none md:pr-4">
          <span style={{ color }} className="hidden shrink-0 sm:inline-flex">
            <Icon name={icon} />
          </span>
          <span className="truncate">{title}</span>
        </h1>
        {stalled && (
          <span role="status" className="shrink-0 px-2 text-sm text-muted" data-testid="saving">
            Saving…
          </span>
        )}
        {reordering && (
          <button type="button" className="pb-btn pb-btn-primary text-sm md:min-h-[36px]" aria-label="Done reordering" onClick={() => ui.set({ reordering: false })}>
            Done
          </button>
        )}
        <div className="hidden items-center gap-0.5 md:flex">
          {viewOptions && (
            <HeaderButton buttonRef={viewBtnDesktop} icon="sliders" label="View options" shortcut="V" pressed={viewOptionsOpen} onClick={() => ui.set({ viewOptions: true })} />
          )}
          {canCleanUp && <HeaderButton icon="broom" label="Clean Up" shortcut="K" onClick={() => void cleanUp()} />}
          <div className="mx-1 h-6 w-px bg-line" />
          <button type="button" className="pb-btn min-h-[36px] text-sm" onClick={() => ui.set({ quickEntry: true })} title="Quick Entry (C)">
            <Icon name="plus" size={16} /> Quick Entry
          </button>
          {canCreate && <HeaderButton icon="edit" label="New item" shortcut="N" onClick={newItem} />}
        </div>
        <div className="hidden flex-1 md:block" />
        <div className="hidden items-center gap-0.5 md:flex">
          <HeaderButton icon="undo" label={history?.undoLabel ? `Undo ${history.undoLabel}` : "Undo"} shortcut="Z" disabled={!history?.canUndo} onClick={() => void undo()} />
          <HeaderButton icon="redo" label={history?.redoLabel ? `Redo ${history.redoLabel}` : "Redo"} shortcut="⇧Z" disabled={!history?.canRedo} onClick={() => void redo()} />
          <HeaderButton icon="search" label="Search" shortcut="/" onClick={() => navigate("/search")} />
          {inspector && (
            <HeaderButton icon="inspector" label="Toggle inspector" shortcut="⇧I" pressed={inspectorOpen} onClick={() => ui.set((s) => ({ inspectorOpen: !s.inspectorOpen }))} />
          )}
          <HeaderButton buttonRef={menuBtnDesktop} icon="more" label="App menu" onClick={() => ui.set({ appMenu: true })} />
        </div>
        <div className="flex items-center md:hidden">
          {/* While reordering, Done takes the room of the view actions so the title stays readable. */}
          {!reordering && (
            <>
              {canCleanUp && <HeaderButton icon="broom" label="Clean Up" onClick={() => void cleanUp()} />}
              <HeaderButton icon="search" label="Search" onClick={() => navigate("/search")} />
              {viewOptions && <HeaderButton buttonRef={viewBtnMobile} icon="sliders" label="View options" onClick={() => ui.set({ viewOptions: true })} />}
            </>
          )}
          <HeaderButton buttonRef={menuBtnMobile} icon="more" label="More actions" onClick={() => setMobileMenu(true)} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {sidebar && sidebarOpen && (
          <aside aria-label={sidebarTitle ?? "Sidebar"} className="pb-scroll hidden w-64 shrink-0 border-r border-line bg-surface-2/50 md:block lg:w-72">
            {sidebar}
          </aside>
        )}
        <main id="pb-main" aria-label={contentLabel ?? title} className="pb-scroll min-w-0 flex-1 bg-surface md:bg-bg">
          <div className="mx-auto min-h-full max-w-4xl bg-surface md:my-0 md:min-h-full md:border-x md:border-line">{children}</div>
        </main>
        {inspector && inspectorOpen && (
          <aside aria-label="Inspector" className="pb-scroll hidden w-[340px] shrink-0 border-l border-line bg-surface md:block lg:w-[380px]">
            <Inspector />
          </aside>
        )}
      </div>
      {footer && <div className="shrink-0 border-t border-line bg-surface md:hidden">{footer}</div>}
      {inspector && <MobileInspector />}
      <button
        type="button"
        className={`fixed ${footer ? "bottom-[calc(132px+env(safe-area-inset-bottom))]" : "bottom-[calc(68px+env(safe-area-inset-bottom))]"} right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-on-accent shadow-pop md:hidden`}
        aria-label="Quick Entry"
        onClick={() => ui.set({ quickEntry: true })}
      >
        <Icon name="plus" size={26} strokeWidth={2.4} />
      </button>
      {sidebar && drawerOpen && (
        <Drawer title={sidebarTitle ?? "Sidebar"} onClose={() => ui.set({ drawerOpen: false })}>
          <div onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest("[data-closes-drawer]")) window.setTimeout(() => ui.set({ drawerOpen: false }), 0);
          }}>
            {sidebar}
          </div>
        </Drawer>
      )}
      {viewOptions && viewOptionsOpen && (
        <Popover anchor={() => (mobile() ? viewBtnMobile.current : viewBtnDesktop.current)} onClose={() => ui.set({ viewOptions: false })} label="View options" width={320}>
          {viewOptions}
        </Popover>
      )}
      {appMenu && (
        <Popover anchor={() => menuBtnDesktop.current} onClose={() => ui.set({ appMenu: false })} label="App menu" align="right" width={240}>
          {canReorder && (
            <div role="menu" className="border-b border-line py-1">
              <ReorderMenuItem close={() => ui.set({ appMenu: false })} />
            </div>
          )}
          <AppMenuItems close={() => ui.set({ appMenu: false })} />
        </Popover>
      )}
      {mobileMenu && (
        <Popover anchor={() => menuBtnMobile.current} onClose={() => setMobileMenu(false)} label="More actions" align="right" width={260}>
          <div role="menu" className="py-1">
            {canCreate && <MenuItem icon="edit" label="New item" onSelect={() => { setMobileMenu(false); newItem(); }} />}
            <MenuItem icon="undo" label="Undo" disabled={!history?.canUndo} onSelect={() => { setMobileMenu(false); void undo(); }} />
            <MenuItem icon="redo" label="Redo" disabled={!history?.canRedo} onSelect={() => { setMobileMenu(false); void redo(); }} />
            {canReorder && <ReorderMenuItem close={() => setMobileMenu(false)} />}
          </div>
          <div className="border-t border-line">
            <AppMenuItems close={() => setMobileMenu(false)} />
          </div>
        </Popover>
      )}
    </div>
  );
}

function ReorderMenuItem({ close }: { close: () => void }) {
  const reordering = useStore(ui, (s) => s.reordering);
  return (
    <MenuItem
      icon="grip"
      label={reordering ? "Done Reordering" : "Reorder"}
      onSelect={() => {
        close();
        ui.set({ reordering: !reordering });
      }}
    />
  );
}

function AppMenuItems({ close }: { close: () => void }) {
  const navigate = useNavigate();
  return (
    <div role="menu" className="py-1">
      <MenuItem icon="gear" label="Settings" onSelect={() => { close(); navigate("/settings"); }} />
      <MenuItem icon="help" label="Keyboard shortcuts" shortcut="?" onSelect={() => { close(); ui.set({ shortcuts: true }); }} />
      <MenuItem icon="logout" label="Sign out" onSelect={() => { close(); void signOut(); }} />
    </div>
  );
}

function MobileInspector() {
  const open = useStore(ui, (s) => s.inspectorSheet);
  if (!open) return null;
  return <InspectorSheet />;
}

function InspectorSheet() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      className="pb-anim-up fixed inset-0 z-50 flex flex-col bg-surface md:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Inspector"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape") ui.set({ inspectorSheet: false });
      }}
    >
      <div className="flex min-h-[56px] items-center border-b border-line px-2">
        <button type="button" className="pb-btn border-0 font-semibold text-accent" onClick={() => ui.set({ inspectorSheet: false })}>
          <Icon name="chevron-left" /> Done
        </button>
      </div>
      <div className="pb-scroll pb-safe-bottom min-h-0 flex-1">
        <Inspector />
      </div>
    </div>
  );
}
