/** True when keyboard focus is in a text-entry control (single-key shortcuts must not fire). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(type);
}

/** Platform "command" modifier: ⌘ on Apple platforms, Ctrl elsewhere. */
export function hasCommandKey(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}
