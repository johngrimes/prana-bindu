import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";

/** Prints a one-time enrollment link with the CLI against the e2e server's data dir. */
export function enrollmentUrl(): string {
  const out = execFileSync("node", ["dist/server/cli/main.js", "passkey", "enroll"], {
    env: {
      ...process.env,
      PRANA_DATA_DIR: process.env.PRANA_E2E_DATA_DIR,
      PRANA_ORIGIN: process.env.PRANA_E2E_ORIGIN,
    },
    encoding: "utf8",
  });
  const match = /(https?:\/\/\S+\/enroll#\S+)/.exec(out);
  if (!match?.[1]) throw new Error(`No enrollment URL in CLI output: ${out}`);
  return match[1];
}

/** Adds a CDP WebAuthn virtual authenticator (resident keys, auto user verification) to the page. */
export async function addVirtualAuthenticator(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}

/** Enrolls a passkey through the UI using a fresh CLI link; the app is signed in afterwards. */
export async function enroll(page: Page, name = "E2E passkey"): Promise<void> {
  await page.goto(enrollmentUrl());
  await page.getByLabel("Passkey name").fill(name);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(page).not.toHaveURL(/\/(enroll|login)/);
}

const HEADERS = { "X-Requested-With": "prana-bindu" };

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, data?: unknown): Promise<T>;
  patch<T>(path: string, data: unknown): Promise<T>;
  put<T>(path: string, data: unknown): Promise<T>;
  del(path: string): Promise<void>;
}

/** Small REST helper bound to the signed-in browser context (shares its session cookie). */
export function apiFor(request: APIRequestContext): Api {
  async function call<T>(method: string, path: string, data?: unknown): Promise<T> {
    const res = await request.fetch(`/api/v1${path}`, { method, data, headers: HEADERS });
    if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
    return (res.status() === 204 ? undefined : await res.json()) as T;
  }
  return {
    get: <T>(path: string) => call<T>("GET", path),
    post: <T>(path: string, data: unknown = {}) => call<T>("POST", path, data),
    patch: <T>(path: string, data: unknown) => call<T>("PATCH", path, data),
    put: <T>(path: string, data: unknown) => call<T>("PUT", path, data),
    del: (path: string) => call<void>("DELETE", path),
  };
}

/** Unique suffix so specs sharing one server never collide on names. */
export const uniq = (label: string) => `${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

export const test = base.extend<{ api: Api; signedIn: Page }>({
  signedIn: async ({ page }, use) => {
    await addVirtualAuthenticator(page);
    await enroll(page);
    // Keep the user time zone aligned with the browser so the time-zone banner stays out of the way.
    await apiFor(page.request).patch("/settings", { timeZone: "Australia/Brisbane" });
    await use(page);
  },
  api: async ({ signedIn }, use) => {
    await use(apiFor(signedIn.request));
  },
});

export { expect };

/** Saves a full-page screenshot under test-results/screenshots for visual review. */
export async function snap(page: Page, name: string): Promise<void> {
  mkdirSync("test-results/screenshots", { recursive: true });
  await page.screenshot({ path: `test-results/screenshots/${name}.png`, fullPage: false });
}

/** Locates an outline row by its exact title. */
export function row(page: Page, title: string) {
  return page.getByRole("treeitem", { name: title, exact: true });
}
