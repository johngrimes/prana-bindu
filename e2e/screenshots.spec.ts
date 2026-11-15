import type { Project, Task } from "../src/shared/schemas";
import { addDaysToKey, todayKey } from "../src/web/lib/dates";
import { expect, snap, test } from "./fixtures";

// Captures every perspective at phone and desktop sizes into test-results/screenshots for visual review.
const PAGES = ["inbox", "projects", "tags", "forecast", "flagged", "review", "completed", "changed", "search?q=report", "settings"];

test("screenshots of every perspective at mobile and desktop sizes", async ({ signedIn: page, api }) => {
  test.setTimeout(120_000);
  const today = todayKey("Australia/Brisbane");
  const tag = await api.post<{ id: string }>("/tags", { name: "Home" });
  const work = await api.post<{ id: string }>("/folders", { name: "Work" });
  const project = await api.post<Project>("/projects", { name: "Quarterly report", type: "sequential", folderId: work.id });
  await api.post<Task>("/tasks", { name: "Draft outline", projectId: project.id, dueDate: `${today}T17:00:00.000`, flagged: true });
  await api.post<Task>("/tasks", { name: "Collect figures", projectId: project.id, tagIds: [tag.id] });
  await api.post<Task>("/tasks", { name: "Buy groceries", inbox: true, tagIds: [tag.id], dueDate: `${addDaysToKey(today, 1)}T09:00:00.000` });
  const done = await api.post<Task>("/tasks", { name: "Send invoice", inbox: true });
  await api.post(`/tasks/${done.id}/complete`, { completed: true });
  await api.patch(`/projects/${project.id}`, { nextReview: `${today}T00:00:00.000` });

  for (const [label, size] of [
    ["desktop", { width: 1280, height: 860 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    for (const p of PAGES) {
      await page.goto(`/${p}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await snap(page, `${label}-${p.split("?")[0]}`);
    }
    await page.goto("/inbox");
    await page.getByRole("treeitem", { name: "Buy groceries" }).click();
    await page.waitForLoadState("networkidle");
    await snap(page, `${label}-inspector`);
  }
});
