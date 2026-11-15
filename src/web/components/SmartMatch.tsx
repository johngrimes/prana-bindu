import { useId, useMemo, useState, type ReactNode } from "react";
import { fuzzyFilter } from "../lib/fuzzy";

export function Highlight({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([start, end], i) => {
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(
      <mark key={i} className="pb-hl">
        {text.slice(start, end)}
      </mark>,
    );
    pos = end;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}

export interface MatchItem {
  id: string;
  name: string;
  detail?: string;
  icon?: ReactNode;
}

/**
 * Smart-match combobox for project/tag fields: fuzzy matches existing items and offers `Create "<text>"`.
 */
export function SmartMatch({
  items,
  onPick,
  onCreate,
  placeholder,
  label,
  autoFocus,
  onEscape,
  initialText = "",
  testId,
}: {
  items: MatchItem[];
  onPick: (item: MatchItem) => void;
  onCreate?: (name: string) => void;
  placeholder: string;
  label: string;
  autoFocus?: boolean;
  onEscape?: () => void;
  initialText?: string;
  testId?: string;
}) {
  const [text, setText] = useState(initialText);
  const [open, setOpen] = useState(!!autoFocus);
  const [active, setActive] = useState(0);
  const listId = useId();
  const matches = useMemo(() => fuzzyFilter(text, items, (i) => i.name, 12), [text, items]);
  const exact = items.some((i) => i.name.toLowerCase() === text.trim().toLowerCase());
  const showCreate = !!onCreate && text.trim().length > 0 && !exact;
  const total = matches.length + (showCreate ? 1 : 0);

  function choose(index: number) {
    const m = matches[index];
    if (m) onPick(m.item);
    else if (showCreate) onCreate?.(text.trim());
    setText("");
    setActive(0);
  }

  return (
    <div className="relative">
      <input
        className="pb-input"
        role="combobox"
        aria-label={label}
        aria-expanded={open && total > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && total > 0 ? `${listId}-${active}` : undefined}
        placeholder={placeholder}
        value={text}
        autoFocus={autoFocus}
        data-testid={testId}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(total - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter") {
            if (total > 0 && open) {
              e.preventDefault();
              e.stopPropagation();
              choose(active);
            }
          } else if (e.key === "Escape" && onEscape) {
            e.stopPropagation();
            onEscape();
          }
        }}
      />
      {open && total > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="pb-scroll absolute inset-x-0 top-full z-10 mt-1 max-h-64 rounded-lg border border-line bg-surface py-1 shadow-pop"
        >
          {matches.map((m, i) => (
            <li
              key={m.item.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`flex min-h-[44px] cursor-pointer items-center gap-2 px-3 text-sm ${i === active ? "bg-select" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
              onMouseEnter={() => setActive(i)}
            >
              {m.item.icon}
              <span className="min-w-0 flex-1 truncate">
                <Highlight text={m.item.name} ranges={m.ranges} />
              </span>
              {m.item.detail && <span className="truncate text-xs text-muted">{m.item.detail}</span>}
            </li>
          ))}
          {showCreate && (
            <li
              id={`${listId}-${matches.length}`}
              role="option"
              aria-selected={active === matches.length}
              className={`flex min-h-[44px] cursor-pointer items-center gap-2 px-3 text-sm font-medium text-accent ${active === matches.length ? "bg-select" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(matches.length)}
              onMouseEnter={() => setActive(matches.length)}
            >
              Create “{text.trim()}”
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
