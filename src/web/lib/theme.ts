export type ThemeSetting = "system" | "light" | "dark";

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let current: ThemeSetting = "system";

function resolve(): "light" | "dark" {
  if (current === "system") return media?.matches ? "dark" : "light";
  return current;
}

function paint(): void {
  document.documentElement.dataset.theme = resolve();
}

media?.addEventListener("change", () => {
  if (current === "system") paint();
});

/** Applies the theme setting (system follows the OS preference live) and remembers it for the next load. */
export function applyTheme(setting: ThemeSetting): void {
  current = setting;
  try {
    localStorage.setItem("pb.theme", setting);
  } catch {
    // storage unavailable: theme still applies for this session
  }
  paint();
}
