import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "../../db/connection.js";
import { oauthClients, oauthGrants } from "../../db/schema.js";
import { createDomain } from "../../domain/index.js";
import { FsBlobStore } from "../../storage/fs.js";
import { createApp } from "../app.js";
import { AuthService } from "../auth/service.js";
import { OAuthService } from "./service.js";

const ORIGIN = "https://tasks.example.com";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CSRF = { "X-Requested-With": "prana-bindu" };
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

describe("OAuth for /mcp", () => {
  let dir: string;
  let handle: DbHandle;
  let app: Hono;
  let auth: AuthService;
  let now: Date;
  let session: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pb-oauth-"));
    handle = openDatabase(":memory:");
    now = new Date("2026-11-15T00:00:00.000Z");
    const config = { origin: ORIGIN, rpId: "tasks.example.com", rpName: "prana-bindu" };
    const blobStore = new FsBlobStore(join(dir, "data"));
    app = createApp({
      config,
      db: handle.db,
      domain: createDomain({ ...handle, blobStore }),
      blobStore,
      runImport: () => Promise.reject(new Error("not used")),
      webDir: join(dir, "web"),
      now: () => now,
    });
    auth = new AuthService(handle.db, config, () => now);
    session = { Cookie: `pb_session=${auth.createSession()}`, ...CSRF };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
    // Keep the browser session alive across long jumps.
    session = { Cookie: `pb_session=${auth.createSession()}`, ...CSRF };
  };

  const register = async (body: unknown = { client_name: "Claude", redirect_uris: [REDIRECT] }) =>
    app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  /** `extra` values replace the defaults; null omits the parameter. */
  const authorizeUrl = (clientId: string, challenge: string, extra: Record<string, string | null> = {}) => {
    const params: Record<string, string | null> = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      resource: RESOURCE,
      scope: "prana",
      ...extra,
    };
    return `/oauth/authorize?${new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== null))}`;
  };

  const token = (params: Record<string, string>) =>
    app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });

  const mcp = (accessToken: string, headers: Record<string, string> = {}) =>
    app.request("/mcp", { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${accessToken}`, ...headers }, body: JSON.stringify(INITIALIZE) });

  /** Registers, authorizes and approves; returns the client, verifier and code. */
  async function approved() {
    const client = await (await register()).json();
    const { verifier, challenge } = pkce();
    const authorized = await app.request(authorizeUrl(client.client_id, challenge));
    const requestId = new URL(authorized.headers.get("location")!, ORIGIN).searchParams.get("request")!;
    const res = await app.request(`/api/v1/auth/oauth/requests/${requestId}/approve`, { method: "POST", headers: session });
    expect(res.status).toBe(200);
    const redirect = new URL((await res.json()).redirectTo);
    return { clientId: client.client_id, verifier, code: redirect.searchParams.get("code")!, redirect };
  }

  async function connected() {
    const { clientId, verifier, code } = await approved();
    const res = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    expect(res.status).toBe(200);
    const tokens: { access_token: string; refresh_token: string } = await res.json();
    return { clientId, tokens };
  }

  describe("discovery", () => {
    it("publishes protected resource and authorization server metadata", async () => {
      for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const res = await app.request(path);
        expect(res.status, path).toBe(200);
        expect(await res.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [ORIGIN], scopes_supported: ["prana"] });
      }
      const as = await (await app.request("/.well-known/oauth-authorization-server")).json();
      expect(as).toMatchObject({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/oauth/authorize`,
        token_endpoint: `${ORIGIN}/oauth/token`,
        registration_endpoint: `${ORIGIN}/oauth/register`,
        revocation_endpoint: `${ORIGIN}/oauth/revoke`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    });

    it("answers /mcp 401s with the resource metadata challenge", async () => {
      const anon = await app.request("/mcp", { method: "POST" });
      expect(anon.status).toBe(401);
      expect(anon.headers.get("www-authenticate")).toBe(
        `Bearer realm="prana-bindu", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
      );
      const bad = await mcp("not-a-token");
      expect(bad.status).toBe(401);
      expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect((await bad.json()).error.code).toBe("invalid_token");
    });

    it("never serves the SPA shell for OAuth paths", async () => {
      for (const path of ["/oauth/nope", "/.well-known/oauth-nope"]) {
        const res = await app.request(path, { headers: { Accept: "text/html" } });
        expect(res.status, path).toBe(404);
        expect(res.headers.get("content-type"), path).toContain("application/json");
      }
    });
  });

  describe("registration", () => {
    it("registers a public client", async () => {
      const res = await register();
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        client_id: expect.any(String),
        client_name: "Claude",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      });
      expect((await (await register({ redirect_uris: ["http://127.0.0.1:33418/cb"] })).json()).client_name).toBe("Unnamed client");
    });

    it.each([
      ["no redirect URIs", { redirect_uris: [] }, "invalid_redirect_uri"],
      ["plain http on a public host", { redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri"],
      ["a fragment", { redirect_uris: ["https://a.example/cb#x"] }, "invalid_redirect_uri"],
      ["a custom scheme", { redirect_uris: ["javascript:alert(1)"] }, "invalid_redirect_uri"],
      ["eleven redirect URIs", { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) }, "invalid_redirect_uri"],
      ["a long name", { redirect_uris: [REDIRECT], client_name: "x".repeat(101) }, "invalid_client_metadata"],
      ["a non-string name", { redirect_uris: [REDIRECT], client_name: 3 }, "invalid_client_metadata"],
      ["an array body", [], "invalid_client_metadata"],
    ])("rejects %s", async (_, body, error) => {
      const res = await register(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(error);
    });

    it("rejects oversized bodies with 413", async () => {
      const res = await register({ redirect_uris: [REDIRECT], padding: "x".repeat(40 * 1024) });
      expect(res.status).toBe(413);
      expect((await res.json()).error).toBe("invalid_request");
    });
  });

  describe("authorization", () => {
    it("refuses to redirect for an unknown client or unregistered redirect URI", async () => {
      expect((await app.request(authorizeUrl("nope", pkce().challenge))).status).toBe(400);
      const { client_id } = await (await register()).json();
      const res = await app.request(authorizeUrl(client_id, pkce().challenge, { redirect_uri: "https://evil.example/cb" }));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    });

    it.each([
      ["a missing PKCE challenge", { code_challenge: null }, "invalid_request"],
      ["the plain PKCE method", { code_challenge_method: "plain" }, "invalid_request"],
      ["another response type", { response_type: "token" }, "unsupported_response_type"],
      ["another resource", { resource: "https://other.example/mcp" }, "invalid_target"],
      ["another scope", { scope: "admin" }, "invalid_scope"],
    ])("redirects back with an error for %s", async (_, extra, error) => {
      const { client_id } = await (await register()).json();
      const res = await app.request(authorizeUrl(client_id, pkce().challenge, extra));
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(REDIRECT);
      expect(location.searchParams.get("error")).toBe(error);
      expect(location.searchParams.get("state")).toBe("xyz");
      expect(location.searchParams.get("iss")).toBe(ORIGIN);
    });

    it("sends the browser to the consent page, which describes the request", async () => {
      const { client_id } = await (await register()).json();
      // Both optional: Claude omits scope, older clients omit resource.
      const res = await app.request(authorizeUrl(client_id, pkce().challenge, { resource: null, scope: null }));
      expect(res.status).toBe(302);
      const location = res.headers.get("location")!;
      expect(location).toMatch(/^\/authorize\?request=/);
      const id = new URL(location, ORIGIN).searchParams.get("request")!;
      const info = await app.request(`/api/v1/auth/oauth/requests/${id}`, { headers: session });
      expect(await info.json()).toEqual({ id, clientName: "Claude", redirectHost: "claude.ai", expiresAt: "2026-11-15T00:10:00.000Z" });
    });

    it("lets only a browser session decide, once, within 10 minutes", async () => {
      const { client_id } = await (await register()).json();
      const requestId = async () =>
        new URL((await app.request(authorizeUrl(client_id, pkce().challenge))).headers.get("location")!, ORIGIN).searchParams.get("request")!;

      const id = await requestId();
      expect((await app.request(`/api/v1/auth/oauth/requests/${id}`)).status).toBe(401);
      const apiToken = { Authorization: `Bearer ${auth.createApiToken("t").plaintext}` };
      const viaToken = await app.request(`/api/v1/auth/oauth/requests/${id}/approve`, { method: "POST", headers: apiToken });
      expect(viaToken.status).toBe(403);
      expect((await app.request(`/api/v1/auth/oauth/requests/${id}/approve`, { method: "POST", headers: { Cookie: session.Cookie! } })).status).toBe(403);

      const denied = await app.request(`/api/v1/auth/oauth/requests/${id}/deny`, { method: "POST", headers: session });
      const redirect = new URL((await denied.json()).redirectTo);
      expect(redirect.searchParams.get("error")).toBe("access_denied");
      expect(redirect.searchParams.get("state")).toBe("xyz");
      expect((await app.request(`/api/v1/auth/oauth/requests/${id}/approve`, { method: "POST", headers: session })).status).toBe(404);

      const late = await requestId();
      advance(10 * 60 * 1000);
      expect((await app.request(`/api/v1/auth/oauth/requests/${late}`, { headers: session })).status).toBe(404);
      expect((await app.request(`/api/v1/auth/oauth/requests/${late}/approve`, { method: "POST", headers: session })).status).toBe(404);
    });
  });

  describe("tokens", () => {
    it("exchanges an approved code for tokens that work on /mcp only", async () => {
      const { clientId, verifier, code, redirect } = await approved();
      expect(redirect.searchParams.get("state")).toBe("xyz");
      expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
      const res = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const tokens = await res.json();
      expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "prana", access_token: expect.any(String), refresh_token: expect.any(String) });

      const init = await mcp(tokens.access_token);
      expect(init.status).toBe(200);
      expect((await init.json()).result.serverInfo.name).toBe("prana-bindu");
      expect((await app.request("/api/v1/settings", { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);

      const apps = await (await app.request("/api/v1/auth/oauth/grants", { headers: session })).json();
      expect(apps.items).toEqual([{ id: expect.any(String), clientName: "Claude", createdAt: now.toISOString(), lastUsedAt: now.toISOString() }]);
    });

    it("accepts a JSON token request too", async () => {
      const { clientId, verifier, code } = await approved();
      const res = await app.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
      });
      expect(res.status).toBe(200);
    });

    it.each([
      ["a wrong verifier", { code_verifier: pkce().verifier }],
      ["another client", { client_id: "other" }],
      ["another redirect URI", { redirect_uri: "https://claude.ai/other" }],
    ])("rejects a code with %s", async (_, override) => {
      const { clientId, verifier, code } = await approved();
      const res = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, ...override });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_grant");
    });

    it("expires codes after 60 seconds", async () => {
      const { clientId, verifier, code } = await approved();
      advance(60 * 1000);
      const res = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
      expect((await res.json()).error).toBe("invalid_grant");
    });

    it("revokes everything a replayed code issued", async () => {
      const { clientId, verifier, code } = await approved();
      const params = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier };
      const { access_token } = await (await token(params)).json();
      const replay = await token(params);
      expect(replay.status).toBe(400);
      expect((await replay.json()).error).toBe("invalid_grant");
      expect((await mcp(access_token)).status).toBe(401);
    });

    it("rotates refresh tokens and revokes the grant when a rotated one is reused", async () => {
      const { clientId, tokens } = await connected();
      advance(HOUR);
      expect((await mcp(tokens.access_token)).status).toBe(401);

      const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
      expect(refreshed.status).toBe(200);
      const next = await refreshed.json();
      expect(next.refresh_token).not.toBe(tokens.refresh_token);
      expect((await mcp(next.access_token)).status).toBe(200);

      const reuse = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
      expect((await reuse.json()).error).toBe("invalid_grant");
      expect((await mcp(next.access_token)).status).toBe(401);
      expect((await token({ grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: clientId })).status).toBe(400);
    });

    it("rejects a refresh by another client, with another scope, or after 30 days", async () => {
      const { clientId, tokens } = await connected();
      const refresh = (extra: Record<string, string>) => token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId, ...extra });
      expect((await (await refresh({ client_id: "other" })).json()).error).toBe("invalid_grant");
      expect((await (await refresh({ scope: "admin" })).json()).error).toBe("invalid_scope");
      advance(30 * DAY);
      expect((await (await refresh({})).json()).error).toBe("invalid_grant");
    });

    it("reports missing and unsupported grant types", async () => {
      expect((await (await token({})).json()).error).toBe("invalid_request");
      expect((await (await token({ grant_type: "password" })).json()).error).toBe("unsupported_grant_type");
      expect((await (await token({ grant_type: "authorization_code" })).json()).error).toBe("invalid_request");
    });

    it("revokes a grant through RFC 7009 only for the owning client", async () => {
      const { clientId, tokens } = await connected();
      const revoke = (client_id: string) =>
        app.request("/oauth/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: tokens.refresh_token, client_id }).toString(),
        });
      expect((await revoke("other")).status).toBe(200);
      expect((await mcp(tokens.access_token)).status).toBe(200);
      expect((await revoke(clientId)).status).toBe(200);
      expect((await mcp(tokens.access_token)).status).toBe(401);
    });
  });

  describe("/mcp", () => {
    it("still accepts API tokens", async () => {
      expect((await mcp(auth.createApiToken("CLI").plaintext)).status).toBe(200);
    });

    it("rejects requests from a foreign browser origin", async () => {
      const { tokens } = await connected();
      const res = await mcp(tokens.access_token, { Origin: "https://evil.example" });
      expect(res.status).toBe(403);
      expect((await mcp(tokens.access_token, { Origin: ORIGIN })).status).toBe(200);
    });
  });

  describe("connected apps", () => {
    it("disconnects an app, cutting its access immediately", async () => {
      const { tokens } = await connected();
      const [app0] = (await (await app.request("/api/v1/auth/oauth/grants", { headers: session })).json()).items;
      expect((await app.request(`/api/v1/auth/oauth/grants/${app0.id}`, { method: "DELETE" })).status).toBe(401);
      expect((await app.request(`/api/v1/auth/oauth/grants/${app0.id}`, { method: "DELETE", headers: session })).status).toBe(204);
      expect((await mcp(tokens.access_token)).status).toBe(401);
      expect((await (await app.request("/api/v1/auth/oauth/grants", { headers: session })).json()).items).toEqual([]);
      expect((await app.request(`/api/v1/auth/oauth/grants/${app0.id}`, { method: "DELETE", headers: session })).status).toBe(404);
    });

    it("documents the consent and connected-apps routes in OpenAPI", async () => {
      const doc = await (await app.request("/api/v1/openapi.json")).json();
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining(["/auth/oauth/requests/{id}", "/auth/oauth/requests/{id}/approve", "/auth/oauth/grants", "/auth/oauth/grants/{id}"]),
      );
    });
  });

  describe("sweep", () => {
    it("drops dead grants and unused clients", async () => {
      const oauth = new OAuthService(handle.db, ORIGIN, () => now);
      await register(); // never granted
      const { clientId } = await connected();
      oauth.sweep();
      expect(handle.db.select().from(oauthClients).all()).toHaveLength(2);

      advance(DAY);
      oauth.sweep();
      expect(handle.db.select().from(oauthClients).all().map((c) => c.id)).toEqual([clientId]);

      // Once the refresh token expires the grant is dead; the client stays 30 days after its last grant.
      advance(30 * DAY);
      oauth.sweep();
      expect(handle.db.select().from(oauthGrants).all()).toEqual([]);
      expect(handle.db.select().from(oauthClients).all()).toHaveLength(0);
    });
  });
});
