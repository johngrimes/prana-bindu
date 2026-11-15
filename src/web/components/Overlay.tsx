import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps focus inside `container` while mounted; restores the previously focused element afterwards. */
function useFocusTrap(container: RefObject<HTMLElement | null>, onEscape: () => void) {
  const escapeRef = useRef(onEscape);
  useEffect(() => {
    escapeRef.current = onEscape;
  });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = container.current;
    if (el && !el.contains(document.activeElement)) {
      const auto = el.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el;
      auto.focus();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        escapeRef.current();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
    el?.addEventListener("keydown", onKey);
    return () => {
      el?.removeEventListener("keydown", onKey);
      // Unless closing moved focus on purpose (e.g. to a rename field the chosen action opened).
      const moved = document.activeElement && document.activeElement !== document.body && !el?.contains(document.activeElement);
      if (previous && document.contains(previous) && !moved) previous.focus();
    };
  }, [container]);
}

/**
 * Modal dialog: centred card on desktop, bottom sheet (or full screen with `fullOnMobile`) on phones.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide = false,
  fullOnMobile = false,
  hideTitle = false,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  fullOnMobile?: boolean;
  hideTitle?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center md:items-start md:pt-[12vh]">
      <div className="pb-anim-fade absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        tabIndex={-1}
        className={`pb-anim-up pb-safe-bottom relative flex w-full flex-col overflow-hidden bg-surface shadow-pop md:rounded-2xl ${
          wide ? "md:max-w-2xl" : "md:max-w-lg"
        } ${fullOnMobile ? "h-full md:h-auto md:max-h-[76vh]" : "max-h-[88vh] rounded-t-2xl md:max-h-[76vh]"}`}
      >
        <div className={`flex items-center gap-2 border-b border-line px-4 py-1.5 ${hideTitle ? "sr-only" : ""}`}>
          <h2 id={titleId} className="flex-1 text-base font-semibold">
            {title}
          </h2>
          <button type="button" className="pb-icon-btn -mr-2" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="pb-scroll min-h-0 flex-1">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Slide-over drawer from the left (mobile sidebar). */
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[55] md:hidden">
      <div className="pb-anim-fade absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="pb-anim-left pb-safe-bottom absolute inset-y-0 left-0 flex w-[92%] max-w-[360px] flex-col bg-surface shadow-pop"
      >
        <div className="flex items-center border-b border-line px-3 py-1.5">
          <h2 className="flex-1 px-1 font-semibold">{title}</h2>
          <button type="button" className="pb-icon-btn" aria-label="Close sidebar" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="pb-scroll min-h-0 flex-1">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Anchored popover (menus, view options). On phones it renders as a bottom sheet. */
export function Popover({
  anchor,
  onClose,
  children,
  label,
  align = "left",
  width = 300,
}: {
  /** Anchor element, or a getter resolved after mount (keeps ref reads out of render). */
  anchor: HTMLElement | null | (() => HTMLElement | null);
  onClose: () => void;
  children: ReactNode;
  label: string;
  align?: "left" | "right";
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  const mobile = window.matchMedia("(max-width: 767.98px)").matches;
  useLayoutEffect(() => {
    const el = ref.current;
    const anchorEl = typeof anchor === "function" ? anchor() : anchor;
    if (!el || mobile) return;
    const w = Math.min(width, window.innerWidth - 16);
    el.style.width = `${w}px`;
    if (!anchorEl) {
      el.style.top = "64px";
      el.style.left = `${Math.max(8, (window.innerWidth - w) / 2)}px`;
      return;
    }
    const rect = anchorEl.getBoundingClientRect();
    const left = align === "right" ? Math.max(8, rect.right - w) : Math.min(rect.left, window.innerWidth - w - 8);
    // Open upwards when the popover would run off the bottom of the viewport (e.g. sidebar "New" button).
    const height = el.offsetHeight;
    const below = rect.bottom + 6;
    el.style.top = `${below + height > window.innerHeight - 8 && rect.top - height - 6 > 8 ? rect.top - height - 6 : below}px`;
    el.style.left = `${Math.max(8, left)}px`;
  }, [anchor, align, width, mobile]);
  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <div className={`absolute inset-0 ${mobile ? "bg-black/40" : ""}`} onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        style={mobile ? undefined : { top: 64, width }}
        className={
          mobile
            ? "pb-anim-up pb-safe-bottom pb-scroll absolute inset-x-0 bottom-0 max-h-[80vh] rounded-t-2xl bg-surface shadow-pop"
            : "pb-anim-fade pb-scroll absolute max-h-[75vh] rounded-xl border border-line bg-surface shadow-pop"
        }
      >
        {mobile && <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-surface-3" aria-hidden="true" />}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon,
  label,
  onSelect,
  danger = false,
  shortcut,
  disabled,
}: {
  icon?: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  shortcut?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={`flex min-h-[44px] w-full items-center gap-3 px-4 text-left text-sm hover:bg-surface-2 disabled:opacity-40 ${danger ? "text-danger" : ""}`}
    >
      {icon && <Icon name={icon} size={18} />}
      <span className="flex-1">{label}</span>
      {shortcut && <kbd className="text-xs text-faint">{shortcut}</kbd>}
    </button>
  );
}
