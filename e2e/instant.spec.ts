import type { Page, Route } from "@playwright/test";
import type { Folder, Project, Settings, Tag, Task } from "../src/shared/schemas";
import { expect, row, test, uniq } from "./fixtures";

/** Instant means "before the server could have answered": every change is checked while all writes are held. */
const INSTANT = { timeout: 1000 };

/** Holds every app write (not sign-in) until `release`; reads pass. */
async function holdWrites(page: Page) {
  const held: Route[] = [];
  let open = false;
  await page.route(/\/api\/v1\/(?!auth\/)/, async (route) => {
    if (route.request().method() === "GET" || open) return route.fallback();
    held.push(route);
  });
  return {
    held: () => held.length,
    async release() {
      open = true;
      for (const r of held.splice(0)) await r.fallback();
    },
  };
}

const circle = (page: Page, title: string) => page.getByRole("checkbox", { name: `Complete ${title}` });

test("outline gestures show at once and reach the server in order", async ({ signedIn: page, api }) => {
  const [a, b, c] = [uniq("Instant A"), uniq("Instant B"), uniq("Instant C")];
  for (const name of [a, b, c]) await api.post<Task>("/tasks", { name, inbox: true });
  const created = uniq("Typed while saving");
  await page.goto("/inbox");
  await expect(row(page, c)).toBeVisible();
  const writes = await holdWrites(page);

  await circle(page, a).click();
  await expect(circle(page, a)).toHaveAttribute("aria-checked", "true", INSTANT);
  await page.getByRole("button", { name: `Flag ${b}`, exact: true }).click();
  await expect(page.getByRole("button", { name: `Unflag ${b}`, exact: true })).toBeVisible(INSTANT);

  await row(page, c).click();
  await page.keyboard.press("]");
  await expect(row(page, c)).toHaveAttribute("aria-level", "2", INSTANT);

  // A new row is editable at once; typing, Enter and Escape on the next empty row all happen while nothing is saved.
  await page.keyboard.press("Enter");
  const editor = page.getByTestId("row-title-input");
  await expect(editor).toBeFocused(INSTANT);
  await editor.fill(created);
  await editor.press("Enter");
  await expect(row(page, created)).toBeVisible(INSTANT);
  await expect(row(page, created)).toHaveAttribute("aria-level", "2");
  await expect(page.getByTestId("row-title-input")).toBeFocused(INSTANT);
  await page.getByTestId("row-title-input").press("Escape");

  await row(page, a).click();
  await page.keyboard.press("Backspace");
  await expect(row(page, a)).toBeHidden(INSTANT);
  await expect(page.getByTestId("toast").filter({ hasText: "Deleted 1 item" })).toBeVisible(INSTANT);
  expect(writes.held()).toBeGreaterThan(0);

  await writes.release();
  const inbox = async () => (await api.get<{ items: Task[] }>("/tasks?inbox=true&availability=all")).items;
  // The delete was the last write sent: once it has landed, so have the others.
  await expect.poll(async () => (await inbox()).some((t) => t.name === a)).toBe(false);
  const after = await inbox();
  expect(after.find((t) => t.name === created)?.parentId).toBe(after.find((t) => t.name === b)?.id);
  expect(after.find((t) => t.name === b)?.flagged).toBe(true);
  expect(after.find((t) => t.name === c)?.parentId).toBe(after.find((t) => t.name === b)?.id);
  // The empty row left with Escape was discarded, not saved.
  expect(after.filter((t) => t.name === "")).toEqual([]);
});

test("undo and redo show at once", async ({ signedIn: page, api }) => {
  const title = uniq("Undo instantly");
  await api.post<Task>("/tasks", { name: title, inbox: true });
  await page.goto("/inbox");
  await expect(row(page, title)).toBeVisible();
  const writes = await holdWrites(page);

  await circle(page, title).click();
  await expect(circle(page, title)).toHaveAttribute("aria-checked", "true", INSTANT);
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(circle(page, title)).toHaveAttribute("aria-checked", "false", INSTANT);
  await page.getByRole("button", { name: /^Redo/ }).click();
  await expect(circle(page, title)).toHaveAttribute("aria-checked", "true", INSTANT);
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(circle(page, title)).toHaveAttribute("aria-checked", "false", INSTANT);

  await writes.release();
  const find = async () => (await api.get<{ items: Task[] }>(`/tasks?inbox=true&availability=all&q=${encodeURIComponent(title)}`)).items[0];
  await expect.poll(async () => (await find())?.completed ?? null).toBeNull();
  await page.waitForTimeout(500);
  await expect(circle(page, title)).toHaveAttribute("aria-checked", "false");
});

test("Quick Entry, sidebar creation and settings show at once", async ({ signedIn: page, api }) => {
  const quick = uniq("Quick while saving");
  const folderName = uniq("Folder while saving");
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  const writes = await holdWrites(page);

  await page.getByRole("button", { name: "Quick Entry" }).first().click();
  const dialog = page.getByTestId("quick-entry");
  await dialog.getByLabel("Title").fill(quick);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden(INSTANT);
  await expect(row(page, quick)).toBeVisible(INSTANT);

  // Release before navigating: leaving with unsent changes would ask first.
  await writes.release();
  await expect.poll(async () => (await api.get<{ items: Task[] }>(`/tasks?inbox=true&q=${encodeURIComponent(quick)}`)).items.length).toBe(1);
  await page.goto("/projects");

  const moreWrites = await holdWrites(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Folder" }).click();
  const rename = page.getByRole("textbox", { name: "Rename Untitled Folder" });
  await expect(rename).toBeVisible(INSTANT);
  await rename.fill(folderName);
  await rename.press("Enter");
  await expect(page.getByRole("complementary", { name: "Projects" }).getByRole("button", { name: folderName })).toBeVisible(INSTANT);

  await moreWrites.release();
  await expect.poll(async () => (await api.get<{ items: Folder[] }>("/folders")).items.filter((f) => f.name === folderName).length).toBe(1);

  await page.goto("/settings");
  const theme = page.getByRole("group", { name: "Theme" });
  await expect(theme).toBeVisible();
  const settingsWrites = await holdWrites(page);
  await theme.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark", INSTANT);
  await expect(theme.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true", INSTANT);
  await settingsWrites.release();
  await expect.poll(async () => (await api.get<Settings>("/settings")).theme).toBe("dark");
  await api.patch("/settings", { theme: "system" });
});

test("a rejected write is reverted, with later changes, and reported once", async ({ signedIn: page, api }) => {
  const [first, second] = [uniq("Rejected flag"), uniq("Discarded after")];
  for (const name of [first, second]) await api.post<Task>("/tasks", { name, inbox: true });
  await page.goto("/inbox");
  await expect(row(page, second)).toBeVisible();
  // Registered before the hold, so released requests reach it (later routes run first).
  await page.route(/\/api\/v1\/tasks\/[^/]+$/, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: { code: "invalid", message: "Rejected for the test." } }) });
  });
  const writes = await holdWrites(page);

  await page.getByRole("button", { name: `Flag ${first}`, exact: true }).click();
  await circle(page, second).click();
  await expect(page.getByRole("button", { name: `Unflag ${first}`, exact: true })).toBeVisible(INSTANT);
  await expect(circle(page, second)).toHaveAttribute("aria-checked", "true", INSTANT);

  await writes.release();
  const message = page.getByTestId("toast").filter({ hasText: "Couldn't save: Rejected for the test. 1 later change was undone." });
  await expect(message).toBeVisible();
  await expect(message).toHaveCount(1);
  await expect(page.getByRole("button", { name: `Flag ${first}`, exact: true })).toBeVisible();
  await expect(circle(page, second)).toHaveAttribute("aria-checked", "false");
  const tasks = (await api.get<{ items: Task[] }>("/tasks?inbox=true&availability=all")).items;
  expect(tasks.find((t) => t.name === first)?.flagged).toBe(false);
  expect(tasks.find((t) => t.name === second)?.completed).toBeNull();
});

test("network failures retry, show Saving… while stalled, and apply once", async ({ signedIn: page, api }) => {
  const tagName = uniq("Retried tag");
  await page.goto("/tags");
  await expect(page.getByRole("heading", { level: 1, name: "Tags" })).toBeVisible();
  let attempts = 0;
  const keys = new Set<string>();
  await page.route(/\/api\/v1\/tags$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    attempts++;
    keys.add(route.request().headers()["idempotency-key"] ?? "");
    // The first try reaches the server but its answer is lost; the next two fail outright.
    if (attempts === 1) {
      await route.fetch();
      return route.abort("connectionreset");
    }
    if (attempts <= 3) return route.abort("connectionrefused");
    return route.continue();
  });

  await page.getByRole("button", { name: "New Tag" }).click();
  const rename = page.getByRole("textbox", { name: "Rename Untitled Tag" });
  await expect(rename).toBeVisible(INSTANT);
  await rename.fill(tagName);
  await rename.press("Enter");
  await expect(page.getByRole("complementary", { name: "Tags" }).getByRole("button", { name: tagName })).toBeVisible(INSTANT);
  await expect(page.getByTestId("saving")).toBeVisible();
  await expect(page.getByTestId("saving")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("toast").filter({ hasText: "Couldn't save" })).toHaveCount(0);
  expect(attempts).toBe(4);
  expect(keys.size).toBe(1);
  await expect.poll(async () => (await api.get<{ items: Tag[] }>("/tags")).items.filter((t) => t.name === tagName).length).toBe(1);
});

test("a Clean Up that files nothing away is not an undo step", async ({ signedIn: page, api }) => {
  const [flagged, done] = [uniq("Stays flagged"), uniq("Completed then undone")];
  for (const name of [flagged, done]) await api.post<Task>("/tasks", { name, inbox: true });
  await page.goto("/inbox");
  await expect(row(page, done)).toBeVisible();

  await page.getByRole("button", { name: `Flag ${flagged}`, exact: true }).click();
  await circle(page, done).click();
  await page.getByRole("button", { name: "Clean Up" }).click();
  await expect(row(page, done)).toBeHidden();
  await expect(page.getByRole("button", { name: "Undo Complete" })).toBeVisible();

  await page.getByRole("button", { name: "Undo Complete" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Undid Complete" })).toBeVisible(INSTANT);
  await expect(circle(page, done)).toHaveAttribute("aria-checked", "false");
  const tasks = async () => (await api.get<{ items: Task[] }>("/tasks?inbox=true&availability=all")).items;
  await expect.poll(async () => (await tasks()).find((t) => t.name === done)?.completed ?? null).toBeNull();
  expect((await tasks()).find((t) => t.name === flagged)?.flagged).toBe(true);
});

test("Clean Up right after completing, before it is saved, still clears the row", async ({ signedIn: page, api }) => {
  const title = uniq("Done then cleaned");
  await api.post<Task>("/tasks", { name: title, inbox: true });
  await page.goto("/inbox");
  await expect(row(page, title)).toBeVisible();
  const writes = await holdWrites(page);
  await circle(page, title).click();
  await page.getByRole("button", { name: "Clean Up" }).click();
  await writes.release();
  await expect(row(page, title)).toBeHidden();
  await page.waitForTimeout(500);
  await expect(row(page, title)).toBeHidden();
});

test("undoing a Clean Up that filed nothing away, before it is saved, undoes nothing else", async ({ signedIn: page, api }) => {
  const title = uniq("Stays completed");
  const task = await api.post<Task>("/tasks", { name: title, inbox: true });
  await page.goto("/inbox");
  await circle(page, title).click();
  await expect.poll(async () => (await api.get<Task>(`/tasks/${task.id}`)).completed).not.toBeNull();

  const writes = await holdWrites(page);
  await page.getByRole("button", { name: "Clean Up" }).click();
  await page.getByRole("button", { name: "Undo Clean Up" }).click();
  await writes.release();
  await expect(page.getByRole("button", { name: "Undo Complete" })).toBeVisible();
  await page.waitForTimeout(500);
  expect((await api.get<Task>(`/tasks/${task.id}`)).completed).not.toBeNull();
});

test("completing a repeating task shows the finished occurrence at once", async ({ signedIn: page, api }) => {
  const title = uniq("Water plants");
  await api.post<Task>("/tasks", {
    name: title,
    inbox: true,
    dueDate: "2030-01-01T17:00:00.000",
    repeat: { rule: "FREQ=DAILY", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: false },
  });
  await page.goto("/inbox");
  await expect(circle(page, title)).toHaveCount(1);
  const writes = await holdWrites(page);
  await circle(page, title).click();
  await expect(circle(page, title)).toHaveCount(2, INSTANT);
  await expect(circle(page, title).first()).toHaveAttribute("aria-checked", "true");
  await expect(circle(page, title).last()).toHaveAttribute("aria-checked", "false");
  await writes.release();
  // The server's finished occurrence takes the stand-in's place, and the next one moves on a day.
  await expect(page.locator("[data-testid=row]", { has: row(page, title) }).last()).toContainText("01/02/2030");
  await expect(circle(page, title)).toHaveCount(2);
  await expect(circle(page, title).first()).toHaveAttribute("aria-checked", "true");
});

test("a finished occurrence's stand-in cannot be clicked before the server's copy arrives", async ({ signedIn: page, api }) => {
  const title = uniq("Feed cat");
  await api.post<Task>("/tasks", {
    name: title,
    inbox: true,
    dueDate: "2030-01-01T17:00:00.000",
    repeat: { rule: "FREQ=DAILY", scheduleType: "regularly", anchorDate: "due", catchUpAutomatically: false },
  });
  await page.goto("/inbox");
  const writes = await holdWrites(page);
  await circle(page, title).click();
  await expect(circle(page, title)).toHaveCount(2, INSTANT);
  // The stand-in sits where the clicked circle was; a quick second click there does nothing.
  await circle(page, title).first().click({ force: true });
  expect(writes.held()).toBe(1);
  await writes.release();
  await expect(page.locator("[data-testid=row]", { has: row(page, title) }).last()).toContainText("01/02/2030");
  await expect(page.getByTestId("toast").filter({ hasText: "Couldn't save" })).toHaveCount(0);
});

test("a new project opens as a project in the inspector before it is saved", async ({ signedIn: page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  const writes = await holdWrites(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Sequential Project" }).click();
  const inspector = page.getByTestId("inspector");
  await expect(inspector.getByLabel("Folder")).toBeVisible(INSTANT);
  await expect(inspector.getByRole("button", { name: "Clear project" })).toHaveCount(0);
  await writes.release();
});

test("several new rows selected before they are saved show in the inspector", async ({ signedIn: page, api }) => {
  const [one, two] = [uniq("Unsaved one"), uniq("Unsaved two")];
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  const writes = await holdWrites(page);
  await page.locator("body").press("n");
  await page.getByTestId("row-title-input").fill(one);
  await page.getByTestId("row-title-input").press("Enter");
  await page.getByTestId("row-title-input").fill(two);
  await page.getByTestId("row-title-input").press("Escape");
  await row(page, one).click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("inspector-multi")).toContainText("2 items selected", INSTANT);
  await writes.release();
  // Let every write land, so no half-saved row is left for later tests.
  const inbox = async () => (await api.get<{ items: Task[] }>("/tasks?inbox=true&availability=all")).items.map((t) => t.name);
  await expect.poll(inbox).toEqual(expect.arrayContaining([one, two]));
  expect(await inbox()).not.toContain("");
});

test("a new project's name typed while it is being saved is kept whole", async ({ signedIn: page, api }) => {
  const name = uniq("Fix the leaking roof");
  await page.goto("/projects");
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  // Ordinary latency: every write takes a moment, and the project's view loads while the name is typed.
  await page.route(/\/api\/v1\/(?!auth\/)/, async (route) => {
    if (route.request().method() !== "GET") await new Promise((r) => setTimeout(r, 150));
    await route.fallback();
  });
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Parallel Project" }).click();
  const editor = page.getByTestId("row-title-input");
  await expect(editor).toBeFocused();
  await page.keyboard.type(name, { delay: 40 });
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await api.get<{ items: Project[] }>("/projects")).items.some((p) => p.task.name === name), { timeout: 15_000 })
    .toBe(true);
});

test("undo after a change made elsewhere undoes that change, not this tab's", async ({ signedIn: page, api }) => {
  const [mine, theirs] = [uniq("Completed here"), uniq("Flagged elsewhere")];
  const a = await api.post<Task>("/tasks", { name: mine, inbox: true });
  const b = await api.post<Task>("/tasks", { name: theirs, inbox: true });
  await page.goto("/inbox");
  await circle(page, mine).click();
  await expect.poll(async () => (await api.get<Task>(`/tasks/${a.id}`)).completed).not.toBeNull();
  await api.patch(`/tasks/${b.id}`, { flagged: true });

  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect.poll(async () => (await api.get<Task>(`/tasks/${b.id}`)).flagged).toBe(false);
  expect((await api.get<Task>(`/tasks/${a.id}`)).completed).not.toBeNull();
  await expect(page.getByTestId("toast").filter({ hasText: "Undid Edit Action" })).toBeVisible();
  await expect(circle(page, mine)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: /^Redo/ })).toHaveAttribute("aria-label", "Redo Edit Action");
});

test("undoing twice after saved changes shows both at once", async ({ signedIn: page, api }) => {
  const [first, second] = [uniq("Undo me second"), uniq("Undo me first")];
  const a = await api.post<Task>("/tasks", { name: first, inbox: true });
  const b = await api.post<Task>("/tasks", { name: second, inbox: true });
  await page.goto("/inbox");
  await circle(page, first).click();
  await page.getByRole("button", { name: `Flag ${second}`, exact: true }).click();
  await expect.poll(async () => (await api.get<Task>(`/tasks/${b.id}`)).flagged).toBe(true);
  // The refresh after both writes has landed, so the cached history names this tab's newest step.
  await page.waitForTimeout(500);

  const writes = await holdWrites(page);
  await page.getByRole("button", { name: "Undo Edit Action" }).click();
  await expect(page.getByRole("button", { name: `Flag ${second}`, exact: true })).toBeVisible(INSTANT);
  await page.getByRole("button", { name: "Undo Complete" }).click();
  await expect(circle(page, first)).toHaveAttribute("aria-checked", "false", INSTANT);
  await page.getByRole("button", { name: "Redo Complete" }).click();
  await expect(circle(page, first)).toHaveAttribute("aria-checked", "true", INSTANT);
  const redone = page.waitForResponse((r) => r.url().endsWith("/api/v1/redo"));
  await writes.release();
  await redone;
  expect((await api.get<Task>(`/tasks/${b.id}`)).flagged).toBe(false);
  expect((await api.get<Task>(`/tasks/${a.id}`)).completed).not.toBeNull();
});

test("undoing past a change made elsewhere between this tab's changes waits for the server", async ({ signedIn: page, api }) => {
  const [a, b, c] = [uniq("Mine first"), uniq("Theirs between"), uniq("Mine last")];
  const [ta, tb, tc] = await Promise.all([a, b, c].map((name) => api.post<Task>("/tasks", { name, inbox: true })));
  await page.goto("/inbox");
  await circle(page, a).click();
  await expect.poll(async () => (await api.get<Task>(`/tasks/${ta?.id}`)).completed).not.toBeNull();
  await api.patch(`/tasks/${tb?.id}`, { flagged: true });
  // The tab's history is not refetched in time: it must rely on what its own writes were told.
  await page.route(/\/api\/v1\/history$/, async (route) => {
    await new Promise((r) => setTimeout(r, 5000));
    await route.fallback();
  });
  const flagged = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(`/tasks/${tc?.id}`));
  await page.getByRole("button", { name: `Flag ${c}`, exact: true }).click();
  await flagged;

  const writes = await holdWrites(page);
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(page.getByRole("button", { name: `Flag ${c}`, exact: true })).toBeVisible(INSTANT);
  await page.getByRole("button", { name: /^Undo/ }).click();
  // The server's next undo is the other device's flag, so this tab's Complete is not undone here.
  await page.waitForTimeout(300);
  await expect(circle(page, a)).toHaveAttribute("aria-checked", "true");
  await writes.release();
  await expect.poll(async () => (await api.get<Task>(`/tasks/${tb?.id}`)).flagged).toBe(false);
  expect((await api.get<Task>(`/tasks/${ta?.id}`)).completed).not.toBeNull();
  await expect(circle(page, a)).toHaveAttribute("aria-checked", "true");
});

test("leaving with unsent changes asks first", async ({ signedIn: page, api }) => {
  const title = uniq("Unsent");
  await api.post<Task>("/tasks", { name: title, inbox: true });
  await page.goto("/inbox");
  await expect(row(page, title)).toBeVisible();
  await holdWrites(page);
  await circle(page, title).click();
  const dialog = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const prompt = await dialog;
  expect(prompt.type()).toBe("beforeunload");
  await prompt.dismiss();
});
