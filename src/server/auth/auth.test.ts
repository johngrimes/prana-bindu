import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "../../db/connection.js";
import { apiTokens, sessions } from "../../db/schema.js";
import { handleError } from "../errors.js";
import { requireAuth, requireBearer, type AuthEnv } from "./middleware.js";
import { createAuthRoutes } from "./routes.js";
import { AuthService } from "./service.js";
import { OAuthService } from "../oauth/service.js";

const ORIGIN = "https://tasks.example.com";
const RP_ID = "tasks.example.com";
const DAY = 24 * 60 * 60 * 1000;
type CBORType = Parameters<typeof isoCBOR.encode>[0];
const b64u = (b: Uint8Array | Buffer | string) => Buffer.from(b).toString("base64url");

/** A software ES256 platform authenticator producing real attestation/assertion responses. */
class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly cosePublicKey: Uint8Array;
  private signCount = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cosePublicKey = isoCBOR.encode(
      new Map<number, CBORType>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
  }

  private authData(rpId: string, attested: boolean): Buffer {
    const flags = 0x01 | 0x04 | (attested ? 0x40 : 0); // UP | UV | AT
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.signCount);
    const parts = [createHash("sha256").update(rpId).digest(), Buffer.from([flags]), counter];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, Buffer.from(this.cosePublicKey));
    }
    return Buffer.concat(parts);
  }

  register(challenge: string, { origin = ORIGIN, rpId = RP_ID } = {}) {
    const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false });
    const attestationObject = isoCBOR.encode(
      new Map<string, CBORType>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", this.authData(rpId, true)],
      ]),
    );
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  assert(challenge: string, { origin = ORIGIN, rpId = RP_ID } = {}) {
    this.signCount += 1;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const authenticatorData = this.authData(rpId, false);
    const signature = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), this.privateKey);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature) },
      clientExtensionResults: {},
    };
  }
}

const CSRF = { "X-Requested-With": "prana-bindu" };

describe("auth", () => {
  let handle: DbHandle;
  let now: Date;
  let auth: AuthService;
  let app: OpenAPIHono<AuthEnv>;

  beforeEach(() => {
    handle = openDatabase(":memory:");
    now = new Date("2026-10-31T00:00:00.000Z");
    auth = new AuthService(handle.db, { origin: ORIGIN, rpId: RP_ID, rpName: "prana-bindu" }, () => now);
    app = new OpenAPIHono<AuthEnv>();
    app.onError(handleError);
    app.route("/api/v1/auth", createAuthRoutes({ auth }));
    app.use("/api/v1/things", requireAuth(auth));
    app.get("/api/v1/things", (c) => c.json({ via: c.var.auth.kind }));
    app.post("/api/v1/things", (c) => c.json({ via: c.var.auth.kind }, 201));
    app.use("/mcp", requireBearer(auth, new OAuthService(handle.db, ORIGIN, () => now)));
    app.post("/mcp", (c) => c.json({ ok: true }));
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...CSRF, ...headers }, body: JSON.stringify(body) });
  const sessionCookie = (res: Response): string | undefined => /pb_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  const withSession = (id: string, headers: Record<string, string> = {}) => ({ Cookie: `pb_session=${id}`, ...headers });

  async function enroll(device: SoftAuthenticator, token = auth.createEnrollmentToken()) {
    const options = await (await post("/api/v1/auth/enroll/options", { token })).json();
    return post("/api/v1/auth/enroll/verify", { token, name: "Phone", response: device.register(options.challenge) });
  }

  async function login(device: SoftAuthenticator): Promise<string> {
    const { challenge } = await (await post("/api/v1/auth/login/options", {})).json();
    const res = await post("/api/v1/auth/login/verify", device.assert(challenge));
    expect(res.status).toBe(200);
    return sessionCookie(res)!;
  }

  describe("enrollment", () => {
    it("registers a passkey with a CLI token, signs in, and offers discoverable/UV-preferred options", async () => {
      const token = auth.createEnrollmentToken();
      const optRes = await post("/api/v1/auth/enroll/options", { token });
      expect(optRes.status).toBe(200);
      const options = await optRes.json();
      expect(options.rp).toEqual({ id: RP_ID, name: "prana-bindu" });
      expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "preferred" });

      const device = new SoftAuthenticator();
      const res = await post("/api/v1/auth/enroll/verify", { token, name: "Phone", response: device.register(options.challenge) });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ id: b64u(device.credentialId), name: "Phone", lastUsedAt: null });
      const cookie = res.headers.get("set-cookie")!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Max-Age=2592000/);
      const session = await app.request("/api/v1/auth/session", { headers: withSession(sessionCookie(res)!) });
      expect(await session.json()).toEqual({ authenticated: true, via: "session" });
    });

    it("makes enrollment tokens single-use", async () => {
      const token = auth.createEnrollmentToken();
      expect((await enroll(new SoftAuthenticator(), token)).status).toBe(201);
      const again = await post("/api/v1/auth/enroll/options", { token });
      expect(again.status).toBe(401);
      expect((await again.json()).error.code).toBe("invalid_enrollment_token");
    });

    it("rejects a token used concurrently by two registrations after the first completes", async () => {
      const token = auth.createEnrollmentToken();
      const a = await (await post("/api/v1/auth/enroll/options", { token })).json();
      const b = await (await post("/api/v1/auth/enroll/options", { token })).json();
      const first = await post("/api/v1/auth/enroll/verify", { token, name: "A", response: new SoftAuthenticator().register(a.challenge) });
      expect(first.status).toBe(201);
      const second = await post("/api/v1/auth/enroll/verify", { token, name: "B", response: new SoftAuthenticator().register(b.challenge) });
      expect(second.status).toBe(401);
      expect(auth.listPasskeys().map((p) => p.name)).toEqual(["A"]);
    });

    it("expires enrollment tokens after 15 minutes", async () => {
      const token = auth.createEnrollmentToken();
      now = new Date(now.getTime() + 15 * 60 * 1000 + 1);
      expect((await post("/api/v1/auth/enroll/options", { token })).status).toBe(401);
    });

    it("stores only a hash of the enrollment token", () => {
      const token = auth.createEnrollmentToken();
      const raw = JSON.stringify(handle.sqlite.prepare("select * from enrollment_tokens").all());
      expect(raw).not.toContain(token);
    });

    it("requires a token or a session, and lets a signed-in user add another passkey", async () => {
      expect((await post("/api/v1/auth/enroll/options", {})).status).toBe(401);
      const phone = new SoftAuthenticator();
      await enroll(phone);
      const sid = await login(phone);
      const options = await (await post("/api/v1/auth/enroll/options", {}, withSession(sid))).json();
      const laptop = new SoftAuthenticator();
      expect(options.excludeCredentials).toEqual([{ id: b64u(phone.credentialId), type: "public-key", transports: ["internal"] }]);
      const res = await post("/api/v1/auth/enroll/verify", { name: "Laptop", response: laptop.register(options.challenge) }, withSession(sid));
      expect(res.status).toBe(201);
      expect(auth.listPasskeys().map((p) => p.name)).toEqual(["Phone", "Laptop"]);
    });

    it("rejects a registration for a different origin", async () => {
      const token = auth.createEnrollmentToken();
      const options = await (await post("/api/v1/auth/enroll/options", { token })).json();
      const res = await post("/api/v1/auth/enroll/verify", {
        token,
        name: "Evil",
        response: new SoftAuthenticator().register(options.challenge, { origin: "https://evil.example" }),
      });
      expect(res.status).toBe(400);
      expect(auth.listPasskeys()).toEqual([]);
      // The token was not consumed by the failed attempt.
      expect((await post("/api/v1/auth/enroll/options", { token })).status).toBe(200);
    });
  });

  describe("login", () => {
    let device: SoftAuthenticator;
    beforeEach(async () => {
      device = new SoftAuthenticator();
      await enroll(device);
    });

    it("signs in with a discoverable credential and tracks counter/last use", async () => {
      const options = await (await post("/api/v1/auth/login/options", {})).json();
      expect(options.allowCredentials).toBeUndefined();
      expect(options.userVerification).toBe("preferred");
      const res = await post("/api/v1/auth/login/verify", device.assert(options.challenge));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ authenticated: true, via: "session" });
      expect(sessionCookie(res)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(auth.listPasskeys()[0]!.lastUsedAt).toBe(now.toISOString());
    });

    it("makes challenges single-use", async () => {
      const { challenge } = await (await post("/api/v1/auth/login/options", {})).json();
      expect((await post("/api/v1/auth/login/verify", device.assert(challenge))).status).toBe(200);
      const replay = await post("/api/v1/auth/login/verify", device.assert(challenge));
      expect(replay.status).toBe(401);
    });

    it("expires challenges after 5 minutes", async () => {
      const { challenge } = await (await post("/api/v1/auth/login/options", {})).json();
      now = new Date(now.getTime() + 5 * 60 * 1000 + 1);
      expect((await post("/api/v1/auth/login/verify", device.assert(challenge))).status).toBe(401);
    });

    it("rejects a registration challenge used for login, unknown credentials and bad signatures", async () => {
      const reg = await (await post("/api/v1/auth/enroll/options", { token: auth.createEnrollmentToken() })).json();
      expect((await post("/api/v1/auth/login/verify", device.assert(reg.challenge))).status).toBe(401);

      const { challenge } = await (await post("/api/v1/auth/login/options", {})).json();
      const stranger = await post("/api/v1/auth/login/verify", new SoftAuthenticator().assert(challenge));
      expect((await stranger.json()).error.code).toBe("unknown_passkey");

      const c2 = (await (await post("/api/v1/auth/login/options", {})).json()).challenge;
      const forged = device.assert(c2);
      forged.response.signature = b64u(randomBytes(70));
      expect((await post("/api/v1/auth/login/verify", forged)).status).toBe(401);
    });

    it("signs out by destroying the session", async () => {
      const sid = await login(device);
      const res = await post("/api/v1/auth/logout", {}, withSession(sid));
      expect(res.status).toBe(204);
      expect(res.headers.get("set-cookie")).toMatch(/pb_session=;/);
      expect((await app.request("/api/v1/things", { headers: withSession(sid) })).status).toBe(401);
    });
  });

  describe("sessions", () => {
    let sid: string;
    beforeEach(async () => {
      const device = new SoftAuthenticator();
      await enroll(device);
      sid = await login(device);
    });

    it("stores only the SHA-256 hash of the session id", () => {
      const rows = handle.db.select().from(sessions).all();
      expect(rows.map((r) => r.idHash)).toContain(createHash("sha256").update(sid).digest("hex"));
      expect(JSON.stringify(rows)).not.toContain(sid);
    });

    it("slides the 30-day expiry on use and re-issues the cookie", async () => {
      now = new Date(now.getTime() + 29 * DAY);
      const res = await app.request("/api/v1/things", { headers: withSession(sid) });
      expect(res.status).toBe(200);
      expect(sessionCookie(res)).toBe(sid);
      now = new Date(now.getTime() + 29 * DAY);
      expect((await app.request("/api/v1/things", { headers: withSession(sid) })).status).toBe(200);
    });

    it("does not rewrite the session on every request", async () => {
      now = new Date(now.getTime() + 60 * 1000);
      const res = await app.request("/api/v1/things", { headers: withSession(sid) });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("expires after 30 idle days and clears the cookie", async () => {
      now = new Date(now.getTime() + 30 * DAY + 1);
      const res = await app.request("/api/v1/things", { headers: withSession(sid) });
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toMatch(/pb_session=;/);
      expect(handle.db.select().from(sessions).all()).toEqual([]);
    });

    it("enforces the CSRF header on unsafe cookie requests only", async () => {
      const blocked = await app.request("/api/v1/things", { method: "POST", headers: withSession(sid) });
      expect(blocked.status).toBe(403);
      expect((await blocked.json()).error.code).toBe("csrf");
      expect((await app.request("/api/v1/things", { method: "POST", headers: withSession(sid, CSRF) })).status).toBe(201);
      expect((await app.request("/api/v1/things", { headers: withSession(sid) })).status).toBe(200);
      const logout = await app.request("/api/v1/auth/logout", { method: "POST", headers: withSession(sid) });
      expect(logout.status).toBe(403);
    });

    it("does not accept the session cookie on bearer-only endpoints", async () => {
      const res = await app.request("/mcp", { method: "POST", headers: withSession(sid, CSRF) });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    });

    it("manages passkeys: list, rename, delete, 404s", async () => {
      const list = await (await app.request("/api/v1/auth/passkeys", { headers: withSession(sid) })).json();
      expect(list.items).toHaveLength(1);
      const id = list.items[0].id as string;
      const renamed = await app.request(`/api/v1/auth/passkeys/${id}`, {
        method: "PATCH",
        headers: withSession(sid, { ...CSRF, "Content-Type": "application/json" }),
        body: JSON.stringify({ name: "  Work phone " }),
      });
      expect((await renamed.json()).name).toBe("Work phone");
      const bad = await app.request(`/api/v1/auth/passkeys/${id}`, {
        method: "PATCH",
        headers: withSession(sid, { ...CSRF, "Content-Type": "application/json" }),
        body: JSON.stringify({ name: "" }),
      });
      expect(bad.status).toBe(400);
      expect((await app.request(`/api/v1/auth/passkeys/${id}`, { method: "DELETE", headers: withSession(sid, CSRF) })).status).toBe(204);
      const missing = await app.request(`/api/v1/auth/passkeys/${id}`, { method: "DELETE", headers: withSession(sid, CSRF) });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: { code: "not_found", message: "Passkey not found" } });
    });
  });

  describe("API tokens", () => {
    let sid: string;
    beforeEach(async () => {
      const device = new SoftAuthenticator();
      await enroll(device);
      sid = await login(device);
    });

    it("creates a token shown once, authenticates bearer requests without CSRF, tracks use, and revokes", async () => {
      const created = await post("/api/v1/auth/tokens", { name: "Claude" }, withSession(sid));
      expect(created.status).toBe(201);
      const { token, plaintext } = await created.json();
      expect(plaintext).toMatch(/^pb_[A-Za-z0-9_-]{43}$/);
      expect(token).toMatchObject({ name: "Claude", prefix: plaintext.slice(0, 10), lastUsedAt: null });
      expect(JSON.stringify(handle.db.select().from(apiTokens).all())).not.toContain(plaintext);

      now = new Date(now.getTime() + 1000);
      const bearer = { Authorization: `Bearer ${plaintext}` };
      const res = await app.request("/api/v1/things", { method: "POST", headers: bearer });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ via: "token" });
      expect((await app.request("/mcp", { method: "POST", headers: bearer })).status).toBe(200);

      const listed = await (await app.request("/api/v1/auth/tokens", { headers: withSession(sid) })).json();
      expect(listed.items).toEqual([{ ...token, lastUsedAt: now.toISOString() }]);
      const listedJson = JSON.stringify(listed);
      expect(listedJson).not.toContain(plaintext);

      expect((await app.request(`/api/v1/auth/tokens/${token.id}`, { method: "DELETE", headers: bearer })).status).toBe(204);
      expect((await app.request("/api/v1/things", { headers: bearer })).status).toBe(401);
      expect((await app.request("/mcp", { method: "POST", headers: bearer })).status).toBe(401);
      expect((await (await app.request("/api/v1/auth/tokens", { headers: withSession(sid) })).json()).items).toEqual([]);
      expect((await app.request(`/api/v1/auth/tokens/${token.id}`, { method: "DELETE", headers: withSession(sid, CSRF) })).status).toBe(404);
    });

    it("never falls back to the cookie when a bearer token is invalid", async () => {
      const res = await app.request("/api/v1/things", { headers: withSession(sid, { Authorization: "Bearer pb_nope" }) });
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("invalid_token");
    });

    it("requires authentication for token and passkey management", async () => {
      expect((await app.request("/api/v1/auth/tokens")).status).toBe(401);
      expect((await post("/api/v1/auth/tokens", { name: "x" })).status).toBe(401);
      expect((await app.request("/api/v1/auth/passkeys")).status).toBe(401);
      expect((await app.request("/api/v1/auth/session")).status).toBe(401);
    });
  });
});
