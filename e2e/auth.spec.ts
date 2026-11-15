import { addVirtualAuthenticator, enroll, enrollmentUrl, expect, test } from "./fixtures";

test("enroll a passkey, sign out, and sign back in", async ({ page }) => {
  await addVirtualAuthenticator(page);
  await enroll(page, "E2E laptop");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

  await page.getByRole("button", { name: "App menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  // Protected pages redirect to sign-in and return afterwards.
  await page.goto("/flagged");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page).toHaveURL(/\/flagged$/);
  await expect(page.getByRole("heading", { level: 1, name: "Flagged" })).toBeVisible();

  const session = await page.request.get("/api/v1/auth/session");
  expect(session.status()).toBe(200);
});

test("an enrollment link cannot be used twice", async ({ page, browser }) => {
  await addVirtualAuthenticator(page);
  const url = enrollmentUrl();
  await page.goto(url);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(page).not.toHaveURL(/\/enroll/);

  const other = await browser.newPage();
  await addVirtualAuthenticator(other);
  await other.goto(url);
  await other.getByRole("button", { name: "Create passkey" }).click();
  await expect(other.getByRole("alert")).toBeVisible();
  await expect(other).toHaveURL(/\/enroll/);
  await other.close();
});
