import { createHash, randomBytes } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { addVirtualAuthenticator, enroll, expect, test, uniq } from "./fixtures";

// A loopback redirect URI, as desktop MCP clients use; the browser never reaches it (routed below).
const CALLBACK = "http://127.0.0.1:47123/callback";
const MCP_HEADERS = { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };

async function registerClient(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post("/oauth/register", { data: { client_name: name, redirect_uris: [CALLBACK] } });
  expect(res.status()).toBe(201);
  return (await res.json()).client_id;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const authorizePath = (clientId: string, challenge: string, state: string) =>
  `/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })}`;

test("an MCP client connects with OAuth, uses /mcp and is disconnected in Settings", async ({ page, request }) => {
  await page.route(`${CALLBACK}**`, (route) => route.fulfill({ contentType: "text/html", body: "<title>callback</title>" }));
  await addVirtualAuthenticator(page);
  await enroll(page);
  await page.request.post("/api/v1/auth/logout", { headers: { "X-Requested-With": "prana-bindu" } });

  // Discovery from the 401 challenge, as a client does it.
  const challenge401 = await request.post("/mcp", { data: {} });
  expect(challenge401.status()).toBe(401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge401.headers()["www-authenticate"] ?? "")?.[1];
  expect(metadataUrl).toBeTruthy();
  const resource = await (await request.get(metadataUrl!)).json();
  const server = await (await request.get(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  expect(server.registration_endpoint).toMatch(/\/oauth\/register$/);

  const name = uniq("Claude");
  const clientId = await registerClient(request, name);
  const { verifier, challenge } = pkce();

  // Signed out: the consent page asks for the passkey first, then comes back.
  await page.goto(authorizePath(clientId, challenge, "s1"));
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page).toHaveURL(/\/authorize\?request=/);
  const consentUrl = page.url();
  await expect(page.getByRole("heading", { name: `Allow ${name} to access prana-bindu?` })).toBeVisible();
  await expect(page.getByText("After you decide, you return to 127.0.0.1:47123.")).toBeVisible();

  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(`${CALLBACK}**`);
  const callback = new URL(page.url());
  expect(callback.searchParams.get("state")).toBe("s1");
  const code = callback.searchParams.get("code")!;
  expect(code).toBeTruthy();

  const tokenRes = await request.post("/oauth/token", {
    form: { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier },
  });
  expect(tokenRes.status()).toBe(200);
  const { access_token } = await tokenRes.json();

  const taskName = uniq("From OAuth");
  const call = await request.post("/mcp", {
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${access_token}` },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_task", arguments: { name: taskName } } },
  });
  expect(call.status()).toBe(200);
  expect((await call.json()).result.structuredContent.name).toBe(taskName);

  // A decided request cannot be reused.
  await page.goto(consentUrl);
  await expect(page.getByRole("heading", { name: "Request expired" })).toBeVisible();

  await page.goto("/settings");
  const app = page.getByTestId("connected-app").filter({ hasText: name });
  await expect(app).toContainText("last used");
  await app.getByRole("button", { name: `Disconnect ${name}` }).click();
  await expect(page.getByText(`Disconnected ${name}`)).toBeVisible();
  await expect(app).toHaveCount(0);

  const after = await request.post("/mcp", { headers: { ...MCP_HEADERS, Authorization: `Bearer ${access_token}` }, data: {} });
  expect(after.status()).toBe(401);
  expect(after.headers()["www-authenticate"]).toContain('error="invalid_token"');
});

test("denying returns access_denied to the client", async ({ page, request }) => {
  await page.route(`${CALLBACK}**`, (route) => route.fulfill({ contentType: "text/html", body: "<title>callback</title>" }));
  await addVirtualAuthenticator(page);
  await enroll(page);
  const clientId = await registerClient(request, uniq("Untrusted"));
  await page.goto(authorizePath(clientId, pkce().challenge, "s2"));
  await page.getByRole("button", { name: "Deny" }).click();
  await page.waitForURL(`${CALLBACK}**`);
  const callback = new URL(page.url());
  expect(callback.searchParams.get("error")).toBe("access_denied");
  expect(callback.searchParams.get("state")).toBe("s2");
  expect(callback.searchParams.get("code")).toBeNull();
});
