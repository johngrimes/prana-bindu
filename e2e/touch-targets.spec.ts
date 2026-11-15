import type { Page } from "@playwright/test";
import type { Task } from "../src/shared/schemas";
import { expect, row, test, uniq } from "./fixtures";

/**
 * Lists visible interactive controls whose effective hit area is smaller than 44×44 px (spec §12).
 * The hit area is the element's box, widened to 44 px for `.pb-hit` controls (they expand via ::after),
 * and the enclosing <label> for checkboxes and radios.
 */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector = "button, a[href], input:not([type=hidden]), select, textarea, [role=checkbox], [role=option], [role=menuitem], [role=gridcell]";
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.pointerEvents === "none" || el.closest("[aria-hidden=true], .sr-only")) continue;
      const target = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio" || el.type === "file") ? el.closest("label") : el;
      if (!target) continue;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) continue;
      const hit = el.classList.contains("pb-hit") ? 44 : 0;
      const w = Math.max(rect.width, hit);
      const h = Math.max(rect.height, hit);
      if (w < 43.5 || h < 43.5) {
        const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? el.tagName;
        out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(w)}×${Math.round(h)}`);
      }
    }
    return out;
  });
}

test.describe("touch targets at 360 px", () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

  test("interactive controls on the main screens are at least 44×44 px", async ({ signedIn: page, api }) => {
    const tag = await api.post<{ id: string }>("/tags", { name: uniq("Errands") });
    const title = uniq("Touch target task");
    await api.post<Task>("/tasks", { name: title, inbox: true, tagIds: [tag.id], dueDate: "2030-01-15T17:00:00.000", flagged: true });
    const custom = await api.post<{ id: string }>("/perspectives", {
      name: uniq("Touch perspective"),
      rules: [{ actionAvailability: "available" }, { aggregateType: "any", aggregateRules: [{ actionHasDueDate: true }, { actionHasAnyOfTags: [tag.id] }] }],
    });

    const failures: string[] = [];
    const check = async (label: string) => failures.push(...(await smallTargets(page)).map((f) => `${label}: ${f}`));

    // Long pages (perspective editors) are checked while scrolling through them.
    for (const path of ["/perspectives/new/edit", `/perspectives/${custom.id}/edit`]) {
      await page.goto(path);
      await expect(page.getByLabel("Perspective name")).toBeVisible();
      await page.waitForLoadState("networkidle");
      for (let i = 0; i < 8; i++) {
        await check(path);
        await page.locator("#pb-main").evaluate((el) => el.scrollBy(0, 500));
      }
    }

    for (const path of ["/inbox", "/projects", "/tags", "/forecast", "/flagged", "/review", "/search?q=touch", "/settings"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await check(path);
    }

    await page.goto("/inbox");
    // Tap the title: the row's centre can fall on the tag pill's remove button.
    await row(page, title).getByTestId("row-title").click();
    const sheet = page.getByRole("dialog", { name: "Inspector" });
    await expect(sheet).toBeVisible();
    await check("inspector sheet");
    for (let i = 0; i < 6; i++) {
      await sheet.locator(".pb-scroll").first().evaluate((el) => el.scrollBy(0, 600));
      await check("inspector sheet (scrolled)");
    }
    await sheet.getByRole("button", { name: "Done" }).click();

    await page.getByRole("button", { name: "Quick Entry" }).click();
    await expect(page.getByTestId("quick-entry")).toBeVisible();
    await check("quick entry");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "View options" }).click();
    await check("view options");
    await page.keyboard.press("Escape");

    await page.goto("/inbox");
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Reorder" }).click();
    await expect(page.locator("[data-drag-handle]").first()).toBeVisible();
    await check("reorder mode");
    await page.getByRole("button", { name: "Done reordering" }).click();

    await page.goto("/forecast");
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await check("forecast calendar drawer");

    expect([...new Set(failures)]).toEqual([]);
  });
});
