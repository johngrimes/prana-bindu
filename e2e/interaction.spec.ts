import type { Locator, Page } from "@playwright/test";
import type { Project, Task } from "../src/shared/schemas";
import { expect, row, test, uniq } from "./fixtures";

/** Dispatches a horizontal touch-pointer swipe across a row. */
async function swipe(page: Page, target: Locator, dx: number) {
  const box = await target.boundingBox();
  if (!box) throw new Error("row not visible");
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width / 2 - dx / 2;
  const opts = { pointerType: "touch", pointerId: 7, isPrimary: true, bubbles: true, button: 0, buttons: 1 };
  await target.dispatchEvent("pointerdown", { ...opts, clientX: x0, clientY: y });
  for (let i = 1; i <= 8; i++) await target.dispatchEvent("pointermove", { ...opts, clientX: x0 + (dx * i) / 8, clientY: y });
  await target.dispatchEvent("pointerup", { ...opts, buttons: 0, clientX: x0 + dx, clientY: y });
}

/** Real touch drag (CDP touch events, so the browser derives pointer events and touch-action) with no pause. */
async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

const grips = (page: Page) => page.locator("[data-drag-handle]");

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("bottom bar navigation, inspector sheet and swipe to complete", async ({ signedIn: page, api }) => {
    const title = uniq("Swipe me");
    const flagged = uniq("Flag via swipe");
    await api.post<Task>("/tasks", { name: title, inbox: true });
    await api.post<Task>("/tasks", { name: flagged, inbox: true });

    const bar = page.getByRole("navigation", { name: "Perspectives" }).last();
    await bar.getByRole("link", { name: "Projects" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
    await bar.getByRole("button", { name: "More" }).click();
    await page.getByRole("dialog", { name: "All perspectives" }).getByRole("button", { name: "Flagged", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Flagged" })).toBeVisible();
    await bar.getByRole("link", { name: "Inbox" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

    // Tapping a row opens the full-screen inspector sheet.
    await row(page, title).click();
    const sheet = page.getByRole("dialog", { name: "Inspector" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel("Title")).toHaveValue(title);
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toBeHidden();

    // Swipe right completes; swipe left reveals Flag / Delete.
    await swipe(page, row(page, title), 160);
    await expect(page.getByRole("checkbox", { name: `Complete ${title}` })).toHaveAttribute("aria-checked", "true");
    await swipe(page, row(page, flagged), -170);
    const container = page.locator("[data-testid=row]", { has: row(page, flagged) });
    await container.getByRole("button", { name: "Flag" }).click();
    await expect(container.getByRole("button", { name: `Unflag ${flagged}` })).toBeVisible();

    // The sidebar is a drawer on phones.
    await page.goto("/projects");
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await expect(page.getByRole("dialog", { name: "Projects" })).toBeVisible();
  });

  test("top bar Clean Up, instant project change, greyed leaving row and native date picker", async ({ signedIn: page, api }) => {
    const projectName = uniq("Garden");
    await api.post<Project>("/projects", { name: projectName, type: "parallel" });
    const title = uniq("Prune roses");
    const created = await api.post<Task>("/tasks", { name: title, inbox: true });
    await page.goto("/inbox");

    // Undo moved from the top bar into the More menu; Clean Up took its place.
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Undo" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Clean Up" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await row(page, title).click();
    const sheet = page.getByRole("dialog", { name: "Inspector" });
    // Hold the server's answer: the inspector must show the new project before the request completes.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/v1/tasks/${created.id}`, async (route) => {
      if (route.request().method() === "PATCH") await held;
      await route.continue();
    });
    await sheet.getByRole("combobox", { name: "Project" }).fill(projectName.slice(0, 7));
    await page.getByRole("option", { name: projectName }).click();
    await expect(sheet.getByTestId("inspector-project")).toHaveText(projectName);
    release();
    await expect.poll(async () => (await api.get<Task>(`/tasks/${created.id}`)).assignedProjectId).not.toBeNull();

    // The calendar button is the native date-time input itself, committed when the picker closes.
    const picker = sheet.getByRole("textbox", { name: "Pick Due from calendar" });
    await expect(picker).toHaveAttribute("type", "datetime-local");
    await picker.fill("2030-01-15T10:30");
    // Nothing is saved while the picker is open; tapping elsewhere closes it and commits.
    expect((await api.get<Task>(`/tasks/${created.id}`)).dueDate).toBeNull();
    await sheet.getByRole("textbox", { name: "Title" }).click();
    await expect.poll(async () => (await api.get<Task>(`/tasks/${created.id}`)).dueDate).toBe("2030-01-15T10:30:00.000");
    await sheet.getByRole("button", { name: "Done" }).click();

    // Filed into a project, the item greys out until Clean Up removes it from the inbox.
    await expect(page.locator("[data-testid=row]", { has: row(page, title) })).toHaveAttribute("data-leaving", "true");
    await page.getByRole("banner").getByRole("button", { name: "Clean Up" }).click();
    await expect(row(page, title)).toHaveCount(0);
  });

  test("Reorder shows trailing grips that drag at once; Done and navigation hide them", async ({ signedIn: page, api }) => {
    const project = await api.post<Project>("/projects", { name: uniq("Reorder") });
    const alpha = await api.post<Task>("/tasks", { name: "alpha", projectId: project.id });
    await api.post<Task>("/tasks", { name: "alpha child", parentId: alpha.id });
    await api.post<Task>("/tasks", { name: "beta", projectId: project.id });
    await api.post<Task>("/tasks", { name: "gamma", projectId: project.id });
    await page.goto(`/projects?project=${project.id}`);
    await expect(row(page, "gamma")).toBeVisible();
    await expect(grips(page)).toHaveCount(0);

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Reorder" }).click();
    // One grip per action (the project row cannot be dragged), at the trailing edge of the row.
    await expect(grips(page)).toHaveCount(4);
    const rowBox = (await row(page, "beta").boundingBox())!;
    const gripBox = (await row(page, "beta").locator("[data-drag-handle]").boundingBox())!;
    expect(gripBox.x + gripBox.width).toBeGreaterThan(rowBox.x + rowBox.width - 8);
    expect(gripBox.width).toBeGreaterThanOrEqual(44);
    // Done replaces the view actions on phones; a tap on a grip neither selects nor opens the inspector.
    await expect(page.getByRole("banner").getByRole("button", { name: "Search" })).toHaveCount(0);
    await page.touchscreen.tap(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await expect(row(page, "beta")).toHaveAttribute("aria-selected", "false");
    await expect(page.getByRole("dialog", { name: "Inspector" })).toHaveCount(0);

    // A touch drag from the grip starts without a long press.
    const target = (await row(page, "alpha").boundingBox())!;
    await touchDrag(page, { x: gripBox.x + gripBox.width / 2, y: (await row(page, "gamma").boundingBox())!.y + 24 }, { x: gripBox.x + gripBox.width / 2, y: target.y + 4 });
    await expect.poll(async () => (await page.getByTestId("row-title").allTextContents()).slice(1)).toEqual(["gamma", "alpha", "alpha child", "beta"]);

    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Done Reordering" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("banner").getByRole("button", { name: "Done reordering" }).click();
    await expect(grips(page)).toHaveCount(0);

    // Navigating to another view ends reorder mode.
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Reorder" }).click();
    await expect(grips(page)).toHaveCount(4);
    await page.getByRole("navigation", { name: "Perspectives" }).last().getByRole("link", { name: "Inbox" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    await expect(page.getByRole("banner").getByRole("button", { name: "Done reordering" })).toHaveCount(0);
    await page.goto(`/projects?project=${project.id}`);
    await expect(row(page, "gamma")).toBeVisible();
    await expect(grips(page)).toHaveCount(0);
  });
});

test("desktop keyboard flow: N, Enter, ], [, Shift-arrows, K", async ({ signedIn: page }) => {
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  const parent = uniq("Plan trip");
  const child = uniq("Book flights");
  const sibling = uniq("Pack bag");

  // A new row left untitled is discarded on Escape, without leaving an undo step behind.
  const undoLabelBefore = await page.getByRole("button", { name: /^Undo/ }).getAttribute("aria-label");
  await page.locator("body").press("n");
  await expect(page.getByTestId("row-title-input")).toBeVisible();
  await page.getByTestId("row-title-input").press("Escape");
  await expect(page.getByRole("treeitem", { name: "Untitled" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Undo/ })).toHaveAttribute("aria-label", undoLabelBefore ?? "Undo");

  await page.locator("body").press("n");
  await page.getByTestId("row-title-input").fill(parent);
  await page.getByTestId("row-title-input").press("Enter");
  await page.getByTestId("row-title-input").fill(child);
  await page.getByTestId("row-title-input").press("Enter");
  await page.getByTestId("row-title-input").fill(sibling);
  await page.getByTestId("row-title-input").press("Escape");
  await expect(row(page, sibling)).toBeFocused();

  // ] indents the selected row under the previous sibling; [ outdents it again.
  await page.keyboard.press("ArrowUp");
  await expect(row(page, child)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("]");
  await expect(row(page, child)).toHaveAttribute("aria-level", "2");
  await page.keyboard.press("[");
  await expect(row(page, child)).toHaveAttribute("aria-level", "1");
  // Shift+→ / Shift+← move the item in and out as well.
  await page.keyboard.press("Shift+ArrowRight");
  await expect(row(page, child)).toHaveAttribute("aria-level", "2");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(row(page, child)).toHaveAttribute("aria-level", "1");

  // Shift+↓ extends the selection; the inspector edits both.
  await page.keyboard.press("Shift+ArrowDown");
  await expect(row(page, child)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, sibling)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("inspector-multi")).toContainText("2 items selected");

  // Space completes the selection, K cleans the completed rows away.
  await page.keyboard.press("Space");
  await expect(page.getByRole("checkbox", { name: `Complete ${sibling}` })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("k");
  await expect(row(page, sibling)).toHaveCount(0);
  await expect(row(page, child)).toHaveCount(0);
  await expect(row(page, parent)).toBeVisible();
});

test("desktop Reorder from the app menu; Escape ends it", async ({ signedIn: page, api }) => {
  const project = await api.post<Project>("/projects", { name: uniq("Desk reorder") });
  await api.post<Task>("/tasks", { name: "first", projectId: project.id });
  await api.post<Task>("/tasks", { name: "second", projectId: project.id });
  await page.goto(`/projects?project=${project.id}`);
  await row(page, "first").hover();
  await expect(grips(page)).toHaveCount(0);

  await page.getByRole("button", { name: "App menu" }).click();
  await page.getByRole("menuitem", { name: "Reorder" }).click();
  await expect(grips(page)).toHaveCount(2);
  await expect(page.getByRole("banner").getByRole("button", { name: "Done reordering" })).toBeVisible();
  // Focus returns to the App menu button; Escape still ends reorder mode.
  await page.keyboard.press("Escape");
  await expect(grips(page)).toHaveCount(0);

  // With a selection, Escape clears it first, then ends reorder mode, wherever focus is.
  await row(page, "first").click();
  await page.getByRole("button", { name: "App menu" }).click();
  await page.getByRole("menuitem", { name: "Reorder" }).click();
  await page.keyboard.press("Escape");
  await expect(row(page, "first")).toHaveAttribute("aria-selected", "false");
  await expect(grips(page)).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(grips(page)).toHaveCount(0);

  // Same with focus in the outline.
  await page.getByRole("button", { name: "App menu" }).click();
  await page.getByRole("menuitem", { name: "Reorder" }).click();
  await row(page, "first").click();
  await page.keyboard.press("Escape");
  await expect(row(page, "first")).toHaveAttribute("aria-selected", "false");
  await expect(grips(page)).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(grips(page)).toHaveCount(0);
});
