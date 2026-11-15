import { useState } from "react";
import { useNavigate } from "react-router";
import type { QuickOpenResult } from "../../shared/schemas";
import { usePerspectives, useQuickOpen } from "../api/queries";
import { perspectivePath } from "../lib/perspectives";
import { ui } from "../lib/ui";
import { Icon } from "./Icons";
import { Dialog } from "./Overlay";
import { Highlight } from "./SmartMatch";

const TYPE_ICON: Record<QuickOpenResult["type"], string> = {
  perspective: "layers",
  folder: "folder",
  project: "project-parallel",
  tag: "tag",
};

/** Quick Open (O): fuzzy jump to a perspective, folder, project or tag. */
export function QuickOpen() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const { data: results = [] } = useQuickOpen(q);
  const { data: perspectives = [] } = usePerspectives();
  const close = () => ui.set({ quickOpen: false });

  function open(r: QuickOpenResult | undefined) {
    if (!r) return;
    close();
    if (r.type === "perspective") {
      const p = perspectives.find((x) => x.id === r.id);
      navigate(p ? perspectivePath(p) : `/perspectives/${encodeURIComponent(r.id)}`);
    } else if (r.type === "project") navigate(`/projects?project=${encodeURIComponent(r.id)}`);
    else if (r.type === "folder") navigate(`/projects?folder=${encodeURIComponent(r.id)}`);
    else navigate(`/tags?tag=${encodeURIComponent(r.id)}`);
  }

  return (
    <Dialog title="Quick Open" onClose={close} hideTitle testId="quick-open">
      <div className="flex items-center gap-2 border-b border-line px-4">
        <Icon name="search" className="text-muted" />
        <input
          className="min-h-[52px] flex-1 bg-transparent text-base outline-none"
          placeholder="Perspective, Folder, Project, or Tag"
          aria-label="Quick Open"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="pb-quick-open-list"
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              open(results[active]);
            }
          }}
        />
      </div>
      <ul id="pb-quick-open-list" role="listbox" aria-label="Matches" className="py-1">
        {results.map((r, i) => (
          <li
            key={`${r.type}:${r.id}`}
            role="option"
            aria-selected={i === active}
            className={`flex min-h-[44px] cursor-pointer items-center gap-3 px-4 ${i === active ? "bg-select" : ""}`}
            onClick={() => open(r)}
            onMouseEnter={() => setActive(i)}
          >
            <Icon name={TYPE_ICON[r.type]} size={18} className="text-muted" />
            <span className="flex-1 truncate">
              <Highlight text={r.name} ranges={r.matches} />
            </span>
            <span className="text-xs capitalize text-faint">{r.type}</span>
          </li>
        ))}
        {q && results.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">No matches</li>}
      </ul>
    </Dialog>
  );
}
