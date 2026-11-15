import type { Locator } from "@playwright/test";
import type { Project, Task } from "../src/shared/schemas";
import { addDaysToKey, todayKey } from "../src/web/lib/dates";
import { expect, row, test, uniq } from "./fixtures";

const TZ = "Australia/Brisbane";

test("quick entry to the inbox, assign a project, then clean up", async ({ signedIn: page, api }) => {
  const projectName = uniq("Errands");
  await api.post<Project>("/projects", { name: projectName, type: "parallel" });
  await page.goto("/inbox");
  // Shortcuts only work once the app has mounted.
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

  await page.keyboard.press("c");
  const dialog = page.getByTestId("quick-entry");
  const title = uniq("Buy milk");
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("textbox", { name: /^Due/ }).fill("tomorrow 5pm");
  // Save immediately: the due date must be parsed before the task is created.
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, title)).toBeVisible();
  await expect(page.locator(`[data-row-id]`, { has: row(page, title) })).toContainText("Tomorrow 5:00 PM");

  await row(page, title).click();
  const inspector = page.getByTestId("inspector");
  await expect(inspector.getByLabel("Title")).toHaveValue(title);
  await inspector.getByRole("combobox", { name: "Project" }).fill(projectName.slice(0, 7));
  await page.getByRole("option", { name: projectName }).click();
  await expect(inspector.getByTestId("inspector-project")).toHaveText(projectName);

  await page.getByRole("button", { name: "Clean Up" }).click();
  await expect(row(page, title)).toHaveCount(0);

  await page.goto("/projects");
  await page.getByRole("complementary", { name: "Projects" }).getByRole("button", { name: projectName }).click();
  await expect(row(page, title)).toBeVisible();
});

test("?quickEntry=1 opens Quick Entry once and keeps the other query parameters", async ({ signedIn: page }) => {
  const dialog = page.getByTestId("quick-entry");
  // The Scriptable widget's "+" button.
  await page.goto("/forecast?quickEntry=1");
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/forecast$/);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/forecast?day=TODAY&quickEntry=1");
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/forecast\?day=TODAY$/);
  await expect(page.getByRole("heading", { level: 1, name: "Forecast" })).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Forecast" })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

test("?quickEntry=1 survives the redirects from / and from unknown paths", async ({ signedIn: page }) => {
  const dialog = page.getByTestId("quick-entry");
  for (const start of ["/?quickEntry=1", "/nope?quickEntry=1"]) {
    await page.goto(start);
    await expect.poll(() => new URL(page.url()).pathname, { message: start }).not.toMatch(/^\/(nope)?$/);
    await expect(dialog, start).toBeVisible();
    await expect(page).not.toHaveURL(/quickEntry/);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
});

test("folder renames and project folder changes show in the outline before the server answers", async ({ signedIn: page, api }) => {
  const folderName = uniq("Work");
  const folder = await api.post<{ id: string }>("/folders", { name: folderName });
  const projectName = uniq("Report");
  const project = await api.post<Project>("/projects", { name: projectName, type: "parallel", folderId: folder.id });
  await page.goto("/projects");
  const head = page.locator("[data-testid=project-row]", { has: row(page, projectName) });
  await expect(head).toContainText(`${folderName} :`);

  // Hold every folder and project save so only optimistic updates can change the outline.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/v1\/(folders|projects)\/[^/]+$/, async (route) => {
    if (route.request().method() === "PATCH") await held;
    await route.continue();
  });

  await page.getByRole("complementary", { name: "Projects" }).getByRole("button", { name: folderName }).click();
  const renamed = `${folderName} renamed`;
  const inspector = page.getByTestId("inspector");
  await inspector.getByLabel("Title").fill(renamed);
  await inspector.getByLabel("Title").press("Enter");
  await expect(head).toContainText(`${renamed} :`);

  await row(page, projectName).click();
  await inspector.getByLabel("Folder").selectOption({ label: "No folder" });
  await expect(head).not.toContainText(" :");

  release();
  await expect.poll(async () => (await api.get<Project>(`/projects/${project.id}`)).folderId).toBeNull();
  await expect.poll(async () => (await api.get<{ items: { id: string; name: string }[] }>("/folders")).items.find((f) => f.id === folder.id)?.name).toBe(renamed);
});

test("a sequential project shows later actions as blocked", async ({ signedIn: page }) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Sequential Project" }).click();
  const name = uniq("Move house");
  const titleInput = page.getByTestId("row-title-input");
  await titleInput.fill(name);
  await titleInput.press("Enter");
  await page.getByTestId("row-title-input").fill("Book truck");
  await page.getByTestId("row-title-input").press("Enter");
  await page.getByTestId("row-title-input").fill("Pack boxes");
  await page.getByTestId("row-title-input").press("Escape");

  const first = page.locator("[data-testid=row]", { has: row(page, "Book truck") });
  const second = page.locator("[data-testid=row]", { has: row(page, "Pack boxes") });
  await expect(first).toHaveAttribute("data-status", /next|available/);
  await expect(second).toHaveAttribute("data-status", "blocked");

  // Completing the first action unblocks the second.
  await first.getByRole("checkbox", { name: "Complete Book truck" }).click();
  await expect(second).toHaveAttribute("data-status", /next|available/);
});

test("tagging an item lists it in the Tags perspective", async ({ signedIn: page, api }) => {
  const title = uniq("Call Sam");
  const tagName = uniq("Phone");
  await api.post<Task>("/tasks", { name: title, inbox: true });
  await page.goto("/inbox");
  await row(page, title).click();
  const inspector = page.getByTestId("inspector");
  await inspector.getByRole("combobox", { name: "Add tag" }).fill(tagName);
  await page.getByRole("option", { name: `Create “${tagName}”` }).click();
  await expect(inspector.getByRole("list", { name: "Tags" })).toContainText(tagName);

  await page.goto("/tags");
  const group = page.getByRole("group", { name: tagName });
  await expect(group.getByRole("treeitem", { name: title })).toBeVisible();

  await page.getByRole("complementary", { name: "Tags" }).getByRole("button", { name: tagName }).click();
  await expect(page.getByRole("heading", { level: 1, name: tagName })).toBeVisible();
  await expect(row(page, title)).toBeVisible();
});

test("complete and uncomplete with undo and redo", async ({ signedIn: page, api }) => {
  const title = uniq("Water plants");
  await api.post<Task>("/tasks", { name: title, inbox: true });
  await page.goto("/inbox");
  const circle = page.getByRole("checkbox", { name: `Complete ${title}` });
  await circle.click();
  await expect(circle).toHaveAttribute("aria-checked", "true");
  // Completed rows stay (struck through) until Clean Up.
  await expect(row(page, title)).toBeVisible();

  await page.locator("body").press("z");
  await expect(circle).toHaveAttribute("aria-checked", "false");
  await page.locator("body").press("Shift+Z");
  await expect(circle).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(circle).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: /^Redo/ }).click();
  await expect(circle).toHaveAttribute("aria-checked", "true");

  await page.locator("body").press("k");
  await expect(row(page, title)).toHaveCount(0);
});

test("completing a multi-selection is one undo step", async ({ signedIn: page, api }) => {
  const titles = [uniq("Batch one"), uniq("Batch two"), uniq("Batch three")];
  for (const name of titles) await api.post<Task>("/tasks", { name, inbox: true });
  const tag = await api.post<{ id: string; name: string }>("/tags", { name: uniq("Batch tag") });
  const project = await api.post<Project>("/projects", { name: uniq("Batch project"), type: "parallel" });
  await page.goto("/inbox");
  await row(page, titles[0] ?? "").click();
  await row(page, titles[2] ?? "").click({ modifiers: ["Shift"] });
  for (const t of titles) await expect(row(page, t)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Space");
  for (const t of titles) await expect(page.getByRole("checkbox", { name: `Complete ${t}` })).toHaveAttribute("aria-checked", "true");

  // A single undo restores all three.
  await page.keyboard.press("z");
  for (const t of titles) await expect(page.getByRole("checkbox", { name: `Complete ${t}` })).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Shift+Z");
  for (const t of titles) await expect(page.getByRole("checkbox", { name: `Complete ${t}` })).toHaveAttribute("aria-checked", "true");

  // Tagging and assigning a project for the whole selection from the inspector are single undo steps too.
  const tagged = async () => (await api.get<{ items: Task[] }>(`/tasks?tagId=${tag.id}&availability=all`)).items.length;
  const multi = page.getByTestId("inspector-multi");
  await multi.getByRole("combobox", { name: "Add tag to all" }).fill(tag.name);
  await page.getByRole("option", { name: tag.name }).click();
  await expect.poll(tagged).toBe(3);
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect.poll(tagged).toBe(0);
  await multi.getByRole("combobox", { name: "Project" }).fill(project.task.name);
  await page.getByRole("option", { name: project.task.name }).click();
  const assigned = async () => {
    const all = await Promise.all(titles.map(async (t) => (await api.get<{ items: Task[] }>(`/tasks?inbox=true&availability=all&q=${encodeURIComponent(t)}`)).items));
    return all.flat().filter((t) => t.assignedProjectId === project.id).length;
  };
  await expect.poll(assigned).toBe(3);
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect.poll(assigned).toBe(0);
});

test("deleting a multi-selection is one undo step", async ({ signedIn: page, api }) => {
  const parent = await api.post<Task>("/tasks", { name: uniq("Delete group"), inbox: true });
  const child = await api.post<Task>("/tasks", { name: uniq("Delete child"), parentId: parent.id });
  const loose = await api.post<Task>("/tasks", { name: uniq("Delete loose"), inbox: true });
  const titles = [parent.name, child.name, loose.name];
  await page.goto("/inbox");
  // Parent, its child and another item: deleting must not fail on the child that the parent already removes.
  await row(page, parent.name).click();
  await row(page, loose.name).click({ modifiers: ["Shift"] });
  for (const t of titles) await expect(row(page, t)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Delete");
  for (const t of titles) await expect(row(page, t)).toHaveCount(0);
  const toastEl = page.getByTestId("toast").filter({ hasText: "Deleted 3 items" });
  await expect(toastEl).toBeVisible();
  await expect(page.getByTestId("toast").filter({ hasText: /not found/i })).toHaveCount(0);
  await toastEl.getByRole("button", { name: "Undo" }).click();
  for (const t of titles) await expect(row(page, t)).toBeVisible();
});

test("Enter then Tab on a new row indents it and keeps editing", async ({ signedIn: page }) => {
  const parent = uniq("Tab parent");
  const child = uniq("Tab child");
  await page.goto("/inbox");
  await page.locator("body").press("n");
  await page.getByTestId("row-title-input").fill(parent);
  await page.getByTestId("row-title-input").press("Enter");
  await page.getByTestId("row-title-input").press("Tab");
  await expect(page.getByTestId("row-title-input")).toBeVisible();
  await page.getByTestId("row-title-input").fill(child);
  await page.getByTestId("row-title-input").press("Escape");
  await expect(row(page, child)).toHaveAttribute("aria-level", "2");
  await expect(row(page, parent)).toHaveAttribute("aria-level", "1");
});

test("Tab under a collapsed group expands it and keeps editing; Escape discards the empty row", async ({ signedIn: page, api }) => {
  const group = await api.post<Task>("/tasks", { name: uniq("Collapsed group"), inbox: true });
  const child = await api.post<Task>("/tasks", { name: uniq("Hidden child"), parentId: group.id });
  await page.goto("/inbox");
  await page.getByRole("button", { name: `Collapse ${group.name}` }).click();
  await expect(row(page, child.name)).toHaveCount(0);
  await row(page, group.name).click();
  await page.keyboard.press("Enter");
  await page.getByTestId("row-title-input").press("Tab");
  // The new row is now inside the group, which is expanded so the editor stays visible.
  await expect(page.getByTestId("row-title-input")).toBeVisible();
  await expect(row(page, child.name)).toBeVisible();
  await page.getByTestId("row-title-input").press("Escape");
  await expect(page.getByTestId("row-title-input")).toHaveCount(0);
  await expect
    .poll(async () => (await api.get<{ children: Task[] }>(`/tasks/${group.id}`)).children.map((t) => t.name))
    .toEqual([child.name]);
});

test("completing a repeating task advances its due date", async ({ signedIn: page, api }) => {
  const title = uniq("Take out bins");
  const today = todayKey(TZ);
  const task = await api.post<Task>("/tasks", { name: title, inbox: true, dueDate: `${today}T17:00:00.000` });
  await page.goto("/inbox");
  await row(page, title).click();
  const inspector = page.getByTestId("inspector");
  await inspector.getByRole("button", { name: "Add repeat" }).click();
  await expect(inspector.getByTestId("repeat-summary")).toHaveText(/Every week/);
  await inspector.getByRole("combobox", { name: "Repeat unit" }).selectOption("DAILY");
  await expect(inspector.getByTestId("repeat-summary")).toHaveText(/Every day/);

  await page.getByRole("checkbox", { name: `Complete ${title}` }).click();
  await expect
    .poll(async () => (await api.get<Task>(`/tasks/${task.id}`)).dueDate)
    .toBe(`${addDaysToKey(today, 1)}T17:00:00.000`);
  const advanced = await api.get<Task>(`/tasks/${task.id}`);
  expect(advanced.completed).toBeNull();
  // The finished occurrence stays above it, struck through, until Clean Up.
  await expect(page.locator("[data-testid=row]", { has: row(page, title) }).last()).toContainText("Tomorrow 5:00 PM");
});

/**
 * A segmented control is as wide as its options and flush with the left edge of `column`, an
 * element spanning the space the control sits in.
 */
async function expectNaturalWidth(group: Locator, column: Locator, name: string) {
  const box = (await group.boundingBox())!;
  const space = (await column.boundingBox())!;
  const last = (await group.getByRole("button").last().boundingBox())!;
  expect(box.x, `${name} left edge`).toBeCloseTo(space.x, 0);
  // The group ends with its last option (plus its 1 px border), not at the column's margin.
  expect(box.x + box.width - (last.x + last.width), `${name} right edge`).toBeLessThanOrEqual(1.5);
  expect(box.width, `${name} width`).toBeLessThan(space.width);
}

test("repeat editor segmented controls keep their natural width, left aligned", async ({ signedIn: page, api }) => {
  const title = uniq("Water plants");
  await api.post<Task>("/tasks", { name: title, inbox: true });
  await page.goto("/inbox");
  await row(page, title).click();
  const inspector = page.getByTestId("inspector");
  await inspector.getByRole("button", { name: "Add repeat" }).click();
  for (const name of ["Repeat schedule", "Repeat anchor date", "Repeat end"]) {
    const group = inspector.getByRole("group", { name });
    await expectNaturalWidth(group, group.locator("xpath=.."), name);
  }
});

test("settings segmented controls keep their natural width, left aligned", async ({ signedIn: page }) => {
  await page.goto("/settings");
  // A full-width select in the same grid column marks out the space the controls sit in.
  const column = page.getByRole("combobox", { name: "Start of week" });
  for (const name of ["Theme", "Time format"]) {
    await expectNaturalWidth(page.getByRole("group", { name }), column, name);
  }
});

test("Forecast shows a due item on its day", async ({ signedIn: page, api }) => {
  const title = uniq("Dentist");
  const day = addDaysToKey(todayKey(TZ), 2);
  await api.post<Task>("/tasks", { name: title, inbox: true, dueDate: `${day}T10:00:00.000` });
  await page.goto("/forecast");
  const section = page.getByRole("group").filter({ has: page.getByRole("heading", { name: new RegExp(`${Number(day.slice(8))}$`) }) });
  await expect(section.getByRole("treeitem", { name: title })).toBeVisible();

  await page.goto(`/forecast?day=${day}`);
  await expect(page.getByRole("group")).toHaveCount(1);
  await expect(row(page, title)).toBeVisible();
});

test("Flagged can be grouped by tag", async ({ signedIn: page, api }) => {
  const tagA = await api.post<{ id: string; name: string }>("/tags", { name: uniq("Office") });
  const tagB = await api.post<{ id: string; name: string }>("/tags", { name: uniq("Garden") });
  const a = uniq("Print report");
  const b = uniq("Mow lawn");
  await api.post<Task>("/tasks", { name: a, inbox: true, flagged: true, tagIds: [tagA.id] });
  await api.post<Task>("/tasks", { name: b, inbox: true, flagged: true, tagIds: [tagB.id] });
  await page.goto("/flagged");
  await expect(row(page, a)).toBeVisible();
  await page.locator("body").press("v");
  await page.getByLabel("Group actions by").selectOption("tag");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: tagA.name }).getByRole("treeitem", { name: a })).toBeVisible();
  await expect(page.getByRole("group", { name: tagB.name }).getByRole("treeitem", { name: b })).toBeVisible();
  await page.locator("body").press("v");
  await page.getByLabel("Group actions by").selectOption("none");
});
