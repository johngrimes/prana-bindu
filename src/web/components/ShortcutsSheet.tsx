import { ui } from "../lib/ui";
import { Dialog } from "./Overlay";

const SECTIONS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: "Global",
    keys: [
      ["C", "Quick Entry"],
      ["N", "New item in current location"],
      ["O", "Quick Open"],
      ["P", "Perspectives"],
      ["V", "View options"],
      ["K", "Clean Up"],
      ["S", "Refresh"],
      ["/", "Search"],
      ["Z / ⌘Z", "Undo"],
      ["⇧Z / ⌘⇧Z", "Redo"],
      ["⇧S", "Toggle sidebar"],
      ["⇧I", "Toggle inspector"],
      ["?", "Keyboard shortcuts"],
    ],
  },
  {
    title: "Outline",
    keys: [
      ["↑ / ↓", "Move selection"],
      ["⇧↑ / ⇧↓", "Extend selection"],
      ["← / →", "Collapse / expand"],
      ["Enter", "New item after selection"],
      ["⇧Enter", "New item above"],
      ["E, Tab, ⌘Enter", "Edit title"],
      ["'", "Edit note"],
      ["] / [", "Indent / outdent"],
      ["} / {", "Add child / add outdented item"],
      ["G / U", "Group / ungroup"],
      ["⇧← / ⇧→", "Move item out / in"],
      ["⌥⇧↑ / ⌥⇧↓", "Move item up / down"],
      ["Space", "Complete / uncomplete"],
      ["F", "Toggle flag"],
      ["⌫ / Delete", "Delete selection"],
      ["Esc", "Stop editing / clear selection / end reorder"],
    ],
  },
  {
    title: "Review",
    keys: [
      ["⌘⇧R", "Mark Reviewed"],
      ["⌘[ / ⌘]", "Previous / next project"],
    ],
  },
];

export function ShortcutsSheet() {
  return (
    <Dialog title="Keyboard shortcuts" onClose={() => ui.set({ shortcuts: false })} wide>
      <div className="grid gap-6 p-4 md:grid-cols-2">
        {SECTIONS.map((s) => (
          <section key={s.title}>
            <h3 className="pb-label mb-2">{s.title}</h3>
            <dl className="flex flex-col gap-1.5 text-sm">
              {s.keys.map(([k, label]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <dt className="text-muted">{label}</dt>
                  <dd>
                    <kbd className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{k}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="px-4 pb-4 text-xs text-muted">Single-key shortcuts are ignored while typing in a field.</p>
    </Dialog>
  );
}
