import type { Page } from "@playwright/test";
import type { Project, Task } from "../src/shared/schemas";
import { addDaysToKey, todayKey } from "../src/web/lib/dates";
import { expect, row, test, uniq, type Api } from "./fixtures";

const TZ = "Australia/Brisbane";

/** Marks every project currently due reviewed, then makes the given projects due (oldest first). */
async function onlyDue(api: Api, ...projects: Project[]): Promise<void> {
  for (const p of (await api.get<{ items: Project[] }>("/review")).items) await api.post(`/projects/${p.id}/review`);
  for (const [i, p] of projects.entries()) await api.patch(`/projects/${p.id}`, { nextReview: `2000-01-0${i + 1}T00:00:00.000` });
}

async function dueProject(api: Api, label: string, action: string): Promise<Project> {
  const project = await api.post<Project>("/projects", { name: uniq(label), type: "parallel" });
  await api.post<Task>("/tasks", { name: action, projectId: project.id });
  return project;
}

const sidebarEntry = (page: Page, name: string) =>
  page.getByRole("complementary", { name: "Projects to review" }).getByTestId("review-sidebar-project").filter({ hasText: name });

test("Review walks through due projects one at a time, editing each and marking it reviewed", async ({ signedIn: page, api }) => {
  const a = await dueProject(api, "Garden", uniq("Prune roses"));
  const b = await dueProject(api, "Taxes", uniq("Find receipts"));
  await onlyDue(api, a, b);
  const aTask = (await api.get<{ children: Task[] }>(`/tasks/${a.id}`)).children[0]!;

  await page.goto("/review");
  await expect(page).toHaveURL(`/review?project=${a.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(a.task.name);
  await expect(page.getByTestId("review-progress")).toHaveText("2 of 2 left");
  await expect(sidebarEntry(page, a.task.name)).toBeVisible();
  await expect(sidebarEntry(page, b.task.name)).toBeVisible();
  // Only the open project's actions are in the outline.
  await expect(row(page, aTask.name)).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /Find receipts/ })).toHaveCount(0);

  // Edit the project in place: complete an action and change its review interval.
  await page.getByRole("checkbox", { name: `Complete ${aTask.name}` }).click();
  await expect.poll(async () => (await api.get<Task>(`/tasks/${aTask.id}`)).completed).not.toBeNull();
  const bar = page.getByRole("region", { name: "Review" });
  await bar.getByRole("button", { name: "Review every 1 week" }).click();
  const schedule = page.getByRole("dialog", { name: "Review schedule" });
  await schedule.getByLabel("Review interval steps").fill("2");
  await expect(bar.getByRole("button", { name: "Review every 2 weeks" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Mark Reviewed moves on to the next project; the reviewed one stays listed and checked.
  await bar.getByRole("button", { name: "Mark Reviewed" }).click();
  await expect(page).toHaveURL(`/review?project=${b.id}`);
  await expect(row(page, (await api.get<{ children: Task[] }>(`/tasks/${b.id}`)).children[0]!.name)).toBeVisible();
  await expect(page.getByTestId("review-progress")).toHaveText("1 of 2 left");
  await expect(sidebarEntry(page, a.task.name).getByRole("img", { name: "Reviewed" })).toBeVisible();
  const reviewedA = await api.get<Project>(`/projects/${a.id}`);
  expect(reviewedA.nextReview?.slice(0, 10)).toBe(addDaysToKey(todayKey(TZ), 14));

  // Previous goes back to the reviewed project; Next returns.
  await bar.getByRole("button", { name: "Previous project" }).click();
  await expect(page).toHaveURL(`/review?project=${a.id}`);
  await expect(bar).toContainText("Reviewed");
  await page.keyboard.press("ControlOrMeta+BracketRight");
  await expect(page).toHaveURL(`/review?project=${b.id}`);

  // The shortcut marks the last project reviewed: nothing is left.
  await page.keyboard.press("ControlOrMeta+Shift+KeyR");
  await expect(page.getByTestId("review-done")).toContainText("All projects reviewed");
  await expect(sidebarEntry(page, b.task.name).getByRole("img", { name: "Reviewed" })).toBeVisible();

  // Clean Up clears reviewed projects from the list.
  await page.getByRole("button", { name: "Clean Up" }).click();
  await expect(page.getByText("No projects to review")).toBeVisible();
});

test("Review keeps a project listed when it stops being due, and Mark Reviewed wraps to skipped projects", async ({ signedIn: page, api }) => {
  const a = await dueProject(api, "Skipped", "first action");
  const b = await dueProject(api, "Dropped later", "second action");
  const c = await dueProject(api, "Last", "third action");
  await api.post<Task>("/tasks", { name: "fourth action", projectId: c.id });
  await onlyDue(api, a, b, c);

  await page.goto(`/review?project=${b.id}`);
  await expect(page.getByTestId("review-progress")).toHaveText("3 of 3 left");
  // Dropping the open project does not remove it from the list.
  await api.patch(`/projects/${b.id}`, { status: "dropped" });
  await page.keyboard.press("s");
  await expect(sidebarEntry(page, b.task.name)).toBeVisible();
  await expect(page).toHaveURL(`/review?project=${b.id}`);

  const bar = page.getByRole("region", { name: "Review" });
  await bar.getByRole("button", { name: "Mark Reviewed" }).click();
  await expect(page).toHaveURL(`/review?project=${c.id}`);

  // Reordering actions by drag (which clears kept rows like Clean Up does) keeps the list intact.
  const from = (await row(page, "fourth action").boundingBox())!;
  const to = (await row(page, "third action").boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y - 10, { steps: 4 });
  await page.mouse.move(to.x + 20, to.y + 3, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await api.get<{ children: Task[] }>(`/tasks/${c.id}`)).children.map((t) => t.name)).toEqual(["fourth action", "third action"]);
  await expect(sidebarEntry(page, b.task.name).getByRole("img", { name: "Reviewed" })).toBeVisible();
  await expect(page.getByTestId("review-progress")).toHaveText("2 of 3 left");

  await bar.getByRole("button", { name: "Mark Reviewed" }).click();
  // Wraps round to the project skipped at the start.
  await expect(page).toHaveURL(`/review?project=${a.id}`);
  await expect(page.getByTestId("review-progress")).toHaveText("1 of 3 left");

  // Undoing Mark Reviewed un-checks the project.
  await page.keyboard.press("z");
  await expect(sidebarEntry(page, c.task.name).getByRole("img", { name: "Reviewed" })).toHaveCount(0);
  await expect(page.getByTestId("review-progress")).toHaveText("2 of 3 left");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("opens the first due project with Previous, Next and Mark Reviewed pinned to the bottom", async ({ signedIn: page, api }) => {
    const a = await dueProject(api, "Phone review", "call plumber");
    const b = await dueProject(api, "Phone second", "book dentist");
    await onlyDue(api, a, b);

    await page.goto("/review");
    await expect(page).toHaveURL(`/review?project=${a.id}`);
    const mark = page.getByRole("button", { name: "Mark Reviewed" });
    await expect(mark).toBeVisible();
    const box = (await mark.boundingBox())!;
    // Above the 56 px perspective bar, at the bottom of the screen.
    expect(box.y + box.height).toBeGreaterThan(844 - 56 - 70);
    expect(box.y + box.height).toBeLessThanOrEqual(844 - 56);
    await expect(page.getByRole("button", { name: "Previous project" })).toBeDisabled();

    // Mark Reviewed in the full-screen inspector moves on and closes the sheet.
    await row(page, a.task.name).click();
    const sheet = page.getByRole("dialog", { name: "Inspector" });
    await sheet.getByRole("button", { name: "Mark Reviewed" }).click();
    await expect(page).toHaveURL(`/review?project=${b.id}`);
    await expect(sheet).toBeHidden();

    await page.getByRole("button", { name: "Show sidebar" }).click();
    const drawer = page.getByRole("dialog", { name: "Projects to review" });
    await expect(drawer.getByTestId("review-sidebar-project").filter({ hasText: a.task.name }).getByRole("img", { name: "Reviewed" })).toBeVisible();
    await drawer.getByTestId("review-sidebar-project").filter({ hasText: b.task.name }).getByRole("button").click();
    await expect(drawer).toBeHidden();

    await mark.click();
    await expect(page.getByTestId("review-done")).toBeVisible();
  });
});
