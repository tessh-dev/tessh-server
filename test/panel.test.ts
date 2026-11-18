import { assetURL } from "../src/web/assets.ts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, effectiveLimits, resolveLimits } from "../src/limits.ts";
import { createOwner, resetOwnerAttempts } from "../src/owner.ts";
import { listInvites } from "../src/invites.ts";
import { writeItems } from "../src/sync.ts";
import { base32Decode, stepAt, totpAt } from "../src/totp.ts";
import { SELF, env } from "./harness.ts";
import { b64, bytes, call, registerUser, uuid } from "./helpers.ts";

const BASE = "https://keys.test";
const OWNER = "owner@example.com";
const PW = "a long enough password";
let cookie = "";

const j = async (r: Response) => (await r.json()) as any;
const cookieOf = (setCookie: string | null) => (setCookie ?? "").split(";")[0];

function panel(method: string, path: string, body?: unknown, opts: { cookie?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "x-tessh-client-ip": "10.0.0.9", ...opts.headers };
  const c = opts.cookie === undefined ? cookie : opts.cookie;
  if (c) headers.cookie = c;
  if (method !== "GET") {
    headers["x-tessh-owner"] ??= "1";
    headers.origin ??= BASE;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  return SELF.fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
}

async function signInOwner(code?: string): Promise<Response> {
  return panel("POST", "/admin/login", { email: OWNER, password: PW, ...(code ? { code } : {}) }, { cookie: null });
}

const audits = async (action: string) =>
  (await env.DB.prepare("SELECT actor, user_id, detail FROM admin_audit WHERE action = ? ORDER BY id").bind(action).all<{ actor: string; user_id: string | null; detail: string }>())
    .results;

const login = (email: string, name = "Other Mac") =>
  call("POST", "/v1/login", { email, authKey: b64(bytes(32, 1)), device: { name, platform: "macos" } });
const push = (token: string, blob = "QUFB") => call("POST", "/v1/sync", { items: [{ id: uuid(), deleted: false, blob }] }, token);

beforeAll(async () => {
  await createOwner(env, OWNER, PW);
  resetOwnerAttempts();
  const res = await signInOwner();
  expect(res.status).toBe(200);
  cookie = cookieOf(res.headers.get("set-cookie"));
  expect(cookie).toMatch(/^tessh_owner=/);
});
beforeEach(() => resetOwnerAttempts());

describe("panel sign-in", () => {
  it("not signed in: pages go to the sign-in page, the API is 401", async () => {
    for (const path of ["/admin", "/admin/team", "/admin/invites", "/admin/activity", "/admin/settings", `/admin/team/${uuid()}`]) {
      const res = await panel("GET", path, undefined, { cookie: null });
      expect([res.status, res.headers.get("location")], path).toEqual([302, "/admin/login"]);
    }
    for (const path of ["/admin/api/team", "/admin/api/overview", "/admin/api/activity"]) {
      const res = await panel("GET", path, undefined, { cookie: null });
      expect(res.status, path).toBe(401);
    }
    expect((await panel("POST", "/admin/api/invites", { label: "x", days: 7 }, { cookie: null })).status).toBe(401);
    const login = await panel("GET", "/admin/login", undefined, { cookie: null });
    expect(login.status).toBe(200);
    const html = await login.text();
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('data-code-row data-otp data-name="code"');
    expect(html).not.toContain('href="/admin/team"');
  });

  it("the sign-in page sends a signed-in owner on to the panel", async () => {
    const res = await panel("GET", "/admin/login");
    expect([res.status, res.headers.get("location")]).toEqual([302, "/admin"]);
  });

  it("a wrong password is 401; a right one sets the cookie", async () => {
    const wrong = await panel("POST", "/admin/login", { email: OWNER, password: "not the password" }, { cookie: null });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const ok = await signInOwner();
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await panel("GET", "/admin", undefined, { cookie: cookieOf(ok.headers.get("set-cookie")) })).status).toBe(200);
  });

  it("writes need the panel header and a same-origin request", async () => {
    const { userId } = await registerUser("csrf@x.com");
    const path = `/admin/api/team/${userId}/suspend`;
    expect((await panel("POST", path, { suspended: true }, { headers: { "x-tessh-owner": "0" } })).status).toBe(403);
    expect((await panel("POST", path, { suspended: true }, { headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await panel("POST", "/admin/login", { email: OWNER, password: PW }, { cookie: null, headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await panel("POST", path, { suspended: true })).status).toBe(200);
  });
});

describe("panel pages", () => {
  it("serve HTML with a strict CSP, versioned assets and no inline script or style", async () => {
    const { userId } = await registerUser("page@x.com");
    for (const path of ["/admin", "/admin/team", `/admin/team/${userId}`, "/admin/invites", "/admin/activity", "/admin/settings", "/admin/login"]) {
      const res = await panel("GET", path, undefined, path === "/admin/login" ? { cookie: null } : {});
      expect(res.status, path).toBe(200);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).not.toMatch(/<script(?![^>]*\ssrc=)|<style|\sstyle=/);
      expect(html).toContain(`<script src="${assetURL("one-time-code.js")}" defer></script><script src="${assetURL("panel.js")}" defer>`);
      expect(html).toContain(`href="${assetURL("tessh.css")}"`);
      expect(html).not.toContain("?v=");
    }
    expect((await panel("GET", "/admin/nope")).status).toBe(404);
  });

  it("the sidebar shows the server, counts, version and sign out", async () => {
    const html = await (await panel("GET", "/admin")).text();
    expect(html).toContain(env.SETTINGS.name);
    expect(html).toContain("keys.test");
    expect(html).toContain(`Running · ${env.VERSION}`);
    expect(html).toContain("Sign out");
    for (const label of ["Overview", "Team", "Invites", "Activity", "Settings"]) expect(html).toContain(label);
  });

  it("Team carries the privacy note, the key page and the owner chip", async () => {
    const { userId } = await registerUser("keyed@x.com");
    await env.DB.prepare("UPDATE users SET username = 'keyed' WHERE id = ?").bind(userId).run();
    const html = await (await panel("GET", `/admin/team/${userId}`)).text();
    expect(html).toContain("The panel never shows anyone&#39;s hosts, snippets or keys. It can&#39;t: they&#39;re encrypted on their devices.");
    expect(html).toContain("keys.test/keyed");
    expect(html).toContain("Test Mac");
    expect(html).toContain("Storage limit");
    expect(html).toContain("Suspend");
    expect(html).toContain("Remove");
  });

  it("a person without a username has no key page link", async () => {
    const { userId } = await registerUser("nokey@x.com");
    const html = await (await panel("GET", `/admin/team/${userId}`)).text();
    expect(html).toContain("No key page yet");
  });
});

describe("panel API", () => {
  it("overview counts people, devices and storage", async () => {
    const before = await j(await panel("GET", "/admin/api/overview"));
    const a = await registerUser("ov1@x.com");
    await registerUser("ov2@x.com");
    await push(a.token, "QUFBQUFBQUE="); // sizes count the stored text: 12
    const o = await j(await panel("GET", "/admin/api/overview"));
    expect(o.people).toBe(before.people + 2);
    expect(o.devices).toBe(before.devices + 2);
    expect(o.storage.bytes).toBe(before.storage.bytes + 12);
    expect(o.version).toBe(env.VERSION);
    expect(o.recent.length).toBeLessThanOrEqual(5);
    expect(o.recent[0]).toMatchObject({ kind: "signup", text: "ov2 joined" });
  });

  it("device sign-out deletes that device and its sessions only, and is audited", async () => {
    const { token, userId } = await registerUser("dev@x.com");
    const second = await j(await login("dev@x.com", "Dev's iPhone"));
    const team = await j(await panel("GET", "/admin/api/team"));
    const person = team.people.find((p: any) => p.id === userId);
    expect(person.devices.map((d: any) => d.name).sort()).toEqual(["Dev's iPhone", "Test Mac"]);
    const res = await panel("POST", `/admin/api/team/${userId}/devices/${second.deviceId}/sign-out`);
    expect(res.status).toBe(200);
    expect((await call("GET", "/v1/account", undefined, second.token)).status).toBe(401);
    expect((await call("GET", "/v1/account", undefined, token)).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM devices WHERE id = ?").bind(second.deviceId).first()).toBeNull();
    const a = await audits("device_sign_out");
    expect(a.at(-1)).toMatchObject({ actor: OWNER, user_id: userId });
    expect((await panel("POST", `/admin/api/team/${userId}/devices/${uuid()}/sign-out`)).status).toBe(404);
    // Another person's device can't be signed out through this account.
    const other = await registerUser("dev2@x.com");
    const otherDevice = (await env.DB.prepare("SELECT id FROM devices WHERE user_id = ?").bind(other.userId).first<{ id: string }>())!.id;
    expect((await panel("POST", `/admin/api/team/${userId}/devices/${otherDevice}/sign-out`)).status).toBe(404);
  });

  it("a storage limit override changes the effective limits; null goes back to the default", async () => {
    const { userId } = await registerUser("lim@x.com");
    expect((await effectiveLimits(env, userId)).bytes).toBe(DEFAULT_LIMITS.bytes);
    expect((await panel("POST", `/admin/api/team/${userId}/limit`, { bytes: 5000 })).status).toBe(200);
    expect((await effectiveLimits(env, userId)).bytes).toBe(5000);
    expect((await panel("POST", `/admin/api/team/${userId}/limit`, { bytes: -1 })).status).toBe(200);
    expect((await effectiveLimits(env, userId)).bytes).toBe(Infinity);
    expect((await panel("POST", `/admin/api/team/${userId}/limit`, { bytes: null })).status).toBe(200);
    expect((await effectiveLimits(env, userId)).bytes).toBe(DEFAULT_LIMITS.bytes);
    for (const body of [{ bytes: -2 }, { bytes: 0 }, { bytes: 1.5 }, { bytes: "3" }, {}]) {
      expect((await panel("POST", `/admin/api/team/${userId}/limit`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await audits("storage_limit")).at(-1)).toMatchObject({ actor: OWNER, user_id: userId });
    expect((await panel("POST", `/admin/api/team/${uuid()}/limit`, { bytes: 1 })).status).toBe(404);
  });

  it("suspend and unsuspend", async () => {
    const { token, userId } = await registerUser("sus@x.com");
    expect((await panel("POST", `/admin/api/team/${userId}/suspend`, { suspended: true })).status).toBe(200);
    expect((await effectiveLimits(env, userId)).suspended).toBe(true);
    expect((await push(token)).status).toBe(403);
    expect((await panel("POST", `/admin/api/team/${userId}/suspend`, { suspended: "yes" })).status).toBe(400);
    expect((await panel("POST", `/admin/api/team/${userId}/suspend`, { suspended: false })).status).toBe(200);
    expect((await push(token)).status).toBe(200);
    expect((await audits("suspend")).at(-1)).toMatchObject({ actor: OWNER, user_id: userId });
    expect((await audits("unsuspend")).at(-1)).toMatchObject({ actor: OWNER, user_id: userId });
  });

  it("remove deletes the account and everything it owns, and is audited", async () => {
    const { token, userId } = await registerUser("del@x.com");
    await push(token);
    const res = await panel("DELETE", `/admin/api/team/${userId}`);
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(userId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM items WHERE user_id = ?").bind(userId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM devices WHERE user_id = ?").bind(userId).first()).toBeNull();
    const a = (await audits("remove")).at(-1)!;
    expect(a).toMatchObject({ actor: OWNER, user_id: userId });
    expect(JSON.parse(a.detail)).toMatchObject({ name: "del", email: "del@x.com" });
    expect((await panel("DELETE", `/admin/api/team/${userId}`)).status).toBe(404);
    // The person is gone, so only the full log has them.
    expect((await panel("GET", `/admin/api/activity?user=${userId}`)).status).toBe(404);
    const activity = await j(await panel("GET", "/admin/api/activity"));
    expect(activity.events.find((e: any) => e.userId === userId && e.kind === "audit")).toMatchObject({ text: "You removed del" });
  });

  it("the owner's own account can't be suspended or removed", async () => {
    const { userId } = await registerUser("me@x.com");
    env.SETTINGS.ownerUserId = userId;
    try {
      for (const res of [await panel("POST", `/admin/api/team/${userId}/suspend`, { suspended: true }), await panel("DELETE", `/admin/api/team/${userId}`)]) {
        expect(res.status).toBe(409);
        expect(await j(res)).toEqual({ error: "cannot_remove_owner", message: "That's your own account. Remove it from the app instead." });
      }
      expect(await env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND suspended_at IS NULL").bind(userId).first()).not.toBeNull();
      const person = (await j(await panel("GET", "/admin/api/team"))).people.find((p: any) => p.id === userId);
      expect(person.role).toBe("owner");
    } finally {
      env.SETTINGS.ownerUserId = null;
    }
  });

  it("invites: create, list, cancel", async () => {
    const res = await panel("POST", "/admin/api/invites", { label: "Alex", days: 30 });
    expect(res.status).toBe(200);
    const { code, url } = await j(res);
    expect(url).toBe(`${BASE}/join/${code}`);
    const waiting = listInvites(env).waiting.find((i) => i.code === code)!;
    expect(waiting.label).toBe("Alex");
    expect(Date.parse(waiting.expiresAt!) - Date.now()).toBeGreaterThan(29.9 * 86_400_000);
    expect((await panel("DELETE", `/admin/api/invites/${code}`)).status).toBe(200);
    expect(listInvites(env).waiting.some((i) => i.code === code)).toBe(false);
    expect((await panel("DELETE", `/admin/api/invites/${code}`)).status).toBe(404);
    for (const body of [{ label: "", days: 7 }, { label: "x".repeat(65), days: 7 }, { label: "Al", days: 14 }, { label: "Al" }]) {
      expect((await panel("POST", "/admin/api/invites", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await audits("invite_create")).at(-1)).toMatchObject({ actor: OWNER });
    expect(JSON.parse((await audits("invite_cancel")).at(-1)!.detail)).toEqual({ label: "Alex" });
    const html = await (await panel("GET", "/admin/invites")).text();
    expect(html).toContain("it for? A name, just for you");
  });

  it("settings save and are audited; a locked one is 409; a bad address says how to write it", async () => {
    const was = { name: env.SERVER_NAME, signups: env.SIGNUPS, bytes: env.SETTINGS.defaultBytes };
    try {
      expect((await panel("POST", "/admin/api/settings", { name: "Holmes Lab", signups: "invite", defaultBytes: 524_288_000 })).status).toBe(200);
      expect([env.SETTINGS.name, env.SERVER_NAME, env.SIGNUPS, env.SETTINGS.defaultBytes]).toEqual(["Holmes Lab", "Holmes Lab", "invite", 524_288_000]);
      expect((await audits("setting")).slice(-3).map((a) => JSON.parse(a.detail).key)).toEqual(["name", "signups", "default_bytes"]);

      const bad = await panel("POST", "/admin/api/settings", { address: "ftp://nope" });
      expect(bad.status).toBe(400);
      const msg = (await j(bad)).message;
      expect(msg).toBe("Enter the address as https://your.domain");

      // Nothing saves when any value is wrong.
      expect((await panel("POST", "/admin/api/settings", { name: "Changed", signups: "everyone" })).status).toBe(400);
      expect(env.SETTINGS.name).toBe("Holmes Lab");
      expect((await panel("POST", "/admin/api/settings", { defaultBytes: 0 })).status).toBe(400);

      env.SETTINGS.locked.name = true;
      const locked = await panel("POST", "/admin/api/settings", { name: "Other" });
      expect(locked.status).toBe(409);
      expect((await j(locked)).error).toBe("locked_by_env");
      expect(env.SETTINGS.name).toBe("Holmes Lab");
    } finally {
      delete env.SETTINGS.locked.name;
      await panel("POST", "/admin/api/settings", { name: was.name, signups: was.signups, defaultBytes: was.bytes });
      await env.DB.prepare("DELETE FROM settings WHERE key IN ('name', 'signups', 'default_bytes')").run();
    }
  });

  it("activity has sign-ups, new devices and panel changes, newest first, and filters by person", async () => {
    const a = await registerUser("act1@x.com");
    await login("act1@x.com", "Act iPhone");
    const b = await registerUser("act2@x.com");
    await panel("POST", `/admin/api/team/${a.userId}/suspend`, { suspended: true });
    await panel("POST", `/admin/api/team/${a.userId}/suspend`, { suspended: false });
    const all = (await j(await panel("GET", "/admin/api/activity"))).events;
    expect(all[0]).toMatchObject({ kind: "audit", text: "You lifted act1's suspension", userId: a.userId });
    expect(all.some((e: any) => e.kind === "signup" && e.userId === b.userId)).toBe(true);
    const mine = (await j(await panel("GET", `/admin/api/activity?user=${a.userId}`))).events.map((e: any) => e.text);
    expect(mine).toEqual(["You lifted act1's suspension", "You suspended act1", "act1 signed in on Act iPhone", "act1 joined"]);
    const html = await (await panel("GET", "/admin/activity")).text();
    expect(html).toContain("act1 signed in on Act iPhone");
  });

  it("no API response or page carries vault data, keys or hashes", async () => {
    const { token, userId } = await registerUser("zk@x.com");
    await push(token, "U0VDUkVUQkxPQg==");
    await env.DB.prepare("UPDATE users SET username = 'zk' WHERE id = ?").bind(userId).run();
    const u = await env.DB.prepare("SELECT auth_hash, salt, wrapped_vault_key, encrypted_signing_key, recovery_hash FROM users WHERE id = ?")
      .bind(userId)
      .first<Record<string, string>>();
    const paths = ["/admin/api/overview", "/admin/api/team", "/admin/api/activity", `/admin/api/activity?user=${userId}`, "/admin", "/admin/team", `/admin/team/${userId}`, "/admin/invites", "/admin/activity", "/admin/settings"];
    for (const p of paths) {
      const res = await panel("GET", p);
      expect(res.status, p).toBe(200);
      const body = await res.text();
      for (const s of ["authKey", "salt", "wrapped", "blob", "token_hash", "U0VDUkVUQkxPQg==", "AAAAC3NzaC1lZDI1NTE5", "scrypt$"]) expect(body, `${p} ${s}`).not.toContain(s);
      for (const v of Object.values(u!)) expect(body, p).not.toContain(v);
    }
  });
});

describe("fix: address, activity filter, enrolment limits", () => {
  it("after saving a different address, sign-in and writes from the old origin still work", async () => {
    try {
      expect((await panel("POST", "/admin/api/settings", { address: "https://typo.example" })).status).toBe(200);
      expect(env.PUBLIC_URL).toBe("https://typo.example");
      const res = await signInOwner();
      expect(res.status).toBe(200);
      const fresh = cookieOf(res.headers.get("set-cookie"));
      expect((await panel("POST", "/admin/api/invites", { label: "Still works", days: 7 }, { cookie: fresh })).status).toBe(200);
      expect((await panel("POST", "/admin/api/invites", { label: "x", days: 7 }, { headers: { origin: "https://evil.test" } })).status).toBe(403);
      expect((await panel("POST", "/admin/login", { email: OWNER, password: PW }, { cookie: null, headers: { origin: "null" } })).status).toBe(403);
    } finally {
      await panel("POST", "/admin/api/settings", { address: BASE });
      await env.DB.prepare("DELETE FROM settings WHERE key = 'public_url'").run();
      env.SETTINGS.publicURL = null;
    }
  });

  it("an unknown or malformed person in Activity is a 404", async () => {
    for (const user of ["nope", uuid()]) {
      expect((await panel("GET", `/admin/api/activity?user=${user}`)).status, user).toBe(404);
      expect((await panel("GET", `/admin/activity?user=${user}`)).status, user).toBe(404);
    }
  });

  it("the address field shows the request origin only as a placeholder when none is saved", async () => {
    const html = await (await panel("GET", "/admin/settings")).text();
    expect(html).toMatch(/<input data-setting="address" value="" placeholder="https:\/\/keys\.test"/);
  });

  it("the sixth wrong enrolment code is 429", async () => {
    expect((await panel("POST", "/admin/api/owner/totp/start")).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await panel("POST", "/admin/api/owner/totp/confirm", { code: "000000" })).status).toBe(401);
    expect((await panel("POST", "/admin/api/owner/totp/confirm", { code: "000000" })).status).toBe(429);
  });
});

describe("owner login in settings", () => {
  it("authenticator on, sign in with a code, then off", async () => {
    const start = await j(await panel("POST", "/admin/api/owner/totp/start"));
    expect(start.uri).toContain("otpauth://totp/");
    const key = base32Decode(start.secret);
    expect((await panel("POST", "/admin/api/owner/totp/confirm", { code: "000000" })).status).toBe(401);
    expect((await panel("POST", "/admin/api/owner/totp/confirm", { code: await totpAt(key, stepAt(Date.now())) })).status).toBe(200);
    expect((await audits("totp_on")).length).toBe(1);
    expect((await j(await signInOwner())).error).toBe("code_required");
    expect((await signInOwner(await totpAt(key, stepAt(Date.now()) + 1))).status).toBe(200);
    expect((await panel("POST", "/admin/api/owner/totp/disable", { password: "wrong password!!" })).status).toBe(401);
    expect((await panel("POST", "/admin/api/owner/totp/disable", { password: PW })).status).toBe(200);
    expect((await audits("totp_off")).length).toBe(1);
    expect((await signInOwner()).status).toBe(200);
  });

  it("end other sessions keeps this one", async () => {
    const other = cookieOf((await signInOwner()).headers.get("set-cookie"));
    const html = await (await panel("GET", "/admin/settings")).text();
    expect(html).toContain("This browser");
    expect((await panel("POST", "/admin/api/owner/sessions/end-others")).status).toBe(200);
    expect((await panel("GET", "/admin/api/team", undefined, { cookie: other })).status).toBe(401);
    expect((await panel("GET", "/admin/api/team")).status).toBe(200);
    expect((await audits("sessions_end_others")).at(-1)).toMatchObject({ actor: OWNER });
  });

  it("change password needs the current one and ends other sessions", async () => {
    const other = cookieOf((await signInOwner()).headers.get("set-cookie"));
    expect((await panel("POST", "/admin/api/owner/password", { current: "wrong password!!", next: "a different long password" })).status).toBe(401);
    expect((await panel("POST", "/admin/api/owner/password", { current: PW, next: "short" })).status).toBe(400);
    expect((await panel("POST", "/admin/api/owner/password", { current: PW, next: "a different long password" })).status).toBe(200);
    expect((await panel("GET", "/admin/api/team", undefined, { cookie: other })).status).toBe(401);
    expect((await panel("GET", "/admin/api/team")).status).toBe(200);
    expect((await panel("POST", "/admin/login", { email: OWNER, password: "a different long password" }, { cookie: null })).status).toBe(200);
    expect((await audits("owner_password")).length).toBe(1);
    expect((await panel("POST", "/admin/api/owner/password", { current: "a different long password", next: PW })).status).toBe(200);
  });

  it("sign out ends this session and clears the cookie", async () => {
    const mine = cookieOf((await signInOwner()).headers.get("set-cookie"));
    const res = await panel("POST", "/admin/api/signout", undefined, { cookie: mine });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^tessh_owner=; .*Max-Age=0/);
    expect((await panel("GET", "/admin/api/team", undefined, { cookie: mine })).status).toBe(401);
  });
});

describe("storage limits", () => {
  it("an account's own limit beats the server default; a negative size is no limit", () => {
    expect(resolveLimits({ bytes_limit: null }, 1000)).toMatchObject({ bytes: 1000, items: 100_000, devices: 50 });
    expect(resolveLimits({ bytes_limit: 7 }, 1000).bytes).toBe(7);
    expect(resolveLimits({ bytes_limit: null }, -1).bytes).toBe(Infinity);
    expect(resolveLimits({ bytes_limit: -1 }, 1000).bytes).toBe(Infinity);
  });

  it("GET /v1/account reports the built-in limit, then the server default; no limit is a number the apps decode", async () => {
    const a = await registerUser("lim1@x.com");
    let acct = await j(await call("GET", "/v1/account", undefined, a.token));
    expect(acct.plan).toBe("self-hosted");
    expect(acct.limits).toEqual({ bytes: DEFAULT_LIMITS.bytes, items: 100_000, devices: 50 });
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('default_bytes', '1000')").run();
    try {
      acct = await j(await call("GET", "/v1/account", undefined, a.token));
      expect(acct.limits).toEqual({ bytes: 1000, items: 100_000, devices: 50 });
      await env.DB.prepare("UPDATE settings SET value = '-1' WHERE key = 'default_bytes'").run();
      acct = await j(await call("GET", "/v1/account", undefined, a.token));
      expect(acct.limits.bytes).toBe(Number.MAX_SAFE_INTEGER);
    } finally {
      await env.DB.prepare("DELETE FROM settings WHERE key = 'default_bytes'").run();
    }
  });

  it("quota follows the server default, then a panel override beats it", async () => {
    const { token, userId } = await registerUser("lim3@x.com");
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('default_bytes', '8')").run();
    try {
      expect((await push(token)).status).toBe(200);
      expect((await push(token)).status).toBe(200);
      expect((await j(await push(token))).error).toBe("quota_exceeded");
      // The in-batch guard uses the same limits even when the pre-check is bypassed.
      await expect(writeItems(env as any, userId, [{ id: uuid(), deleted: false, blob: "QUFB", size: 4 }])).rejects.toMatchObject({ code: "quota_exceeded" });
      expect((await panel("POST", `/admin/api/team/${userId}/limit`, { bytes: 12 })).status).toBe(200);
      expect((await push(token)).status).toBe(200);
      expect((await push(token)).status).toBe(413);
      expect((await j(await call("GET", "/v1/account", undefined, token))).limits.bytes).toBe(12);
    } finally {
      await env.DB.prepare("DELETE FROM settings WHERE key = 'default_bytes'").run();
    }
  });

  it("a new sign-in beyond the device limit is refused", async () => {
    const { userId } = await registerUser("lim4@x.com");
    const now = new Date().toISOString();
    for (let i = 0; i < DEFAULT_LIMITS.devices - 1; i++) {
      await env.DB.prepare("INSERT INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, 'd', 'macos', ?, ?)")
        .bind(uuid(), userId, now, now)
        .run();
    }
    const res = await login("lim4@x.com");
    expect(res.status).toBe(403);
    expect((await j(res)).error).toBe("device_limit");
  });
});
