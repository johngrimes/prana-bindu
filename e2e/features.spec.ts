import { readFileSync } from "node:fs";
import type { Project, Task } from "../src/shared/schemas";
import { expect, row, test, uniq } from "./fixtures";

test("create and edit a custom perspective with a nested rule group", async ({ signedIn: page, api }) => {
  const withDue = uniq("Flagged with due");
  const withoutDue = uniq("Flagged without due");
  const notFlagged = uniq("Not flagged");
  await api.post<Task>("/tasks", { name: withDue, inbox: true, flagged: true, dueDate: "2030-01-15T17:00:00.000" });
  await api.post<Task>("/tasks", { name: withoutDue, inbox: true, flagged: true });
  await api.post<Task>("/tasks", { name: notFlagged, inbox: true, dueDate: "2030-01-15T17:00:00.000" });

  await page.goto("/inbox");
  await page.locator("body").press("p");
  await page.getByRole("menuitem", { name: "New perspective" }).click();
  await expect(page).toHaveURL(/\/perspectives\/[^/]+\/edit$/);

  const name = uniq("Due flagged");
  await page.getByLabel("Perspective name").fill(name);
  await page.getByRole("radio", { name: "bolt" }).click();
  // Replace the default availability rule with "Status: flagged".
  const rules = page.getByTestId("rule");
  await rules.first().getByLabel("Rule type").selectOption("status");
  await rules.first().getByLabel("Status").selectOption("flagged");
  // Add a nested "any of" group containing "has a due date", plus a disabled rule that would exclude everything.
  await page.getByLabel("Add rule", { exact: true }).selectOption("group");
  const group = page.locator("[data-testid=rule][data-rule-kind=group]");
  await group.getByLabel("Add rule to group").selectOption("boolean");
  await group.locator("[data-testid=rule]").getByLabel("Property").selectOption("actionHasDueDate");
  await page.getByLabel("Add rule", { exact: true }).selectOption("boolean");
  const last = rules.last();
  await last.getByLabel("Property").selectOption("actionIsProject");
  await last.getByLabel("Rule enabled").uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Perspective saved")).toBeVisible();

  const saved = (await api.get<{ items: Array<{ name: string; rules: unknown[] }> }>("/perspectives")).items.find((p) => p.name === name);
  expect(saved?.rules).toEqual([
    { actionStatus: "flagged" },
    { aggregateType: "any", aggregateRules: [{ actionHasDueDate: true }] },
    { disabledRule: { actionIsProject: true } },
  ]);

  await page.getByRole("button", { name: "View" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(row(page, withDue)).toBeVisible();
  await expect(row(page, withoutDue)).toHaveCount(0);
  await expect(row(page, notFlagged)).toHaveCount(0);

  // It is a favourite by default, so it shows in the perspectives rail.
  await expect(page.getByRole("navigation", { name: "Perspectives" }).first().getByRole("link", { name })).toBeVisible();
});

test("search finds tasks by note and Quick Open jumps to a project", async ({ signedIn: page, api }) => {
  const word = `zebra${Date.now().toString(36)}`;
  const title = uniq("Research");
  await api.post<Task>("/tasks", { name: title, inbox: true, note: `Look at the ${word} crossing plans` });
  const projectName = uniq("Quarantine kitchen");
  const project = await api.post<Project>("/projects", { name: projectName, type: "parallel" });

  await page.goto("/inbox");
  await page.locator("body").press("/");
  await expect(page).toHaveURL(/\/search/);
  await page.getByRole("searchbox", { name: "Search" }).fill(word);
  const result = page.getByTestId("search-task").filter({ hasText: title });
  await expect(result).toBeVisible();
  await expect(result.locator("mark")).toHaveText(word);

  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.getByRole("searchbox", { name: "Search" }).blur();
  await page.locator("body").press("o");
  const quickOpen = page.getByTestId("quick-open");
  await quickOpen.getByRole("combobox", { name: "Quick Open" }).fill(projectName.slice(0, 10));
  await expect(quickOpen.getByRole("option").first()).toContainText(projectName);
  await quickOpen.getByRole("combobox", { name: "Quick Open" }).press("Enter");
  await expect(page).toHaveURL(new RegExp(`/projects\\?project=${project.id}`));
  await expect(page.getByRole("heading", { level: 1, name: projectName })).toBeVisible();
});

test("attachments upload, download and delete", async ({ signedIn: page, api }) => {
  const title = uniq("Receipt");
  await api.post<Task>("/tasks", { name: title, inbox: true });
  await page.goto("/inbox");
  await row(page, title).click();
  const inspector = page.getByTestId("inspector");
  await inspector.getByTestId("attachment-input").setInputFiles({ name: "receipt.txt", mimeType: "text/plain", buffer: Buffer.from("total: 42\n") });
  const item = inspector.getByTestId("attachment");
  await expect(item).toContainText("receipt.txt");
  await expect(item).toContainText("10 B");

  const downloadPromise = page.waitForEvent("download");
  await item.getByRole("link", { name: "Download receipt.txt" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("receipt.txt");
  const path = await download.path();
  expect(readFileSync(path, "utf8")).toBe("total: 42\n");

  await item.getByRole("button", { name: "Delete receipt.txt" }).click();
  await expect(item).toHaveCount(0);
});

test("changing the date format is reflected in dates", async ({ signedIn: page, api }) => {
  const title = uniq("Renew passport");
  await api.post<Task>("/tasks", { name: title, inbox: true, dueDate: "2030-03-07T09:00:00.000" });
  await page.goto("/inbox");
  const r = page.locator("[data-testid=row]", { has: row(page, title) });
  await expect(r).toContainText("03/07/2030");

  await page.goto("/settings");
  await page.getByLabel("Date format").selectOption("yyyy-MM-dd");
  await expect(page.getByLabel("Date format")).toHaveValue("yyyy-MM-dd");
  await page.goto("/inbox");
  await expect(r).toContainText("2030-03-07");
  await page.goto("/settings");
  await page.getByLabel("Date format").selectOption("MM/dd/yyyy");
  await expect(page.getByLabel("Date format")).toHaveValue("MM/dd/yyyy");
});

test("create an API token, use it, and revoke it", async ({ signedIn: page, playwright, baseURL }) => {
  await page.goto("/settings");
  const name = uniq("CLI token");
  await page.getByLabel("Token name").fill(name);
  await page.getByRole("button", { name: "Create token" }).click();
  const plaintext = (await page.getByTestId("token-plaintext").textContent())?.trim() ?? "";
  expect(plaintext).toMatch(/^pb_/);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("api-token").filter({ hasText: name })).toBeVisible();

  const bearer = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${plaintext}` } });
  expect((await bearer.get("/api/v1/settings")).status()).toBe(200);
  await page.getByRole("button", { name: `Revoke ${name}` }).click();
  await expect(page.getByTestId("api-token").filter({ hasText: name })).toHaveCount(0);
  expect((await bearer.get("/api/v1/settings")).status()).toBe(401);
  await bearer.dispose();
});
