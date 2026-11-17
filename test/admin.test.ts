import { ADMIN, SELF, basic, env } from "./harness.ts";
import { describe, expect, it } from "vitest";
import { resolveLimits } from "../src/limits.ts";
import { writeItems } from "../src/sync.ts";
import { handleAdmin } from "../src/admin.ts";
import { b64, bytes, call, registerUser, uuid } from "./helpers.ts";

const ADMIN_NAME = "ops";

async function admin(method: string, path: string, body?: unknown, opts: { auth?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  const auth = opts.auth === undefined ? basic() : opts.auth;
  if (auth) headers.authorization = auth;
  if (method !== "GET") headers["x-tessh-admin"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  return ADMIN.fetch(`https://admin.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const j = async (r: Response) => (await r.json()) as any;
const audits = async (action: string, userId?: string) =>
  (
    await env.DB.prepare(`SELECT * FROM admin_audit WHERE action = ? ${userId ? "AND user_id = ?" : ""} ORDER BY id`)
      .bind(...(userId ? [action, userId] : [action]))
      .all<{ admin_email: string; detail: string; user_id: string | null }>()
  ).results;

const login = (email: string, name = "Other Mac") =>
  call("POST", "/v1/login", { email, authKey: b64(bytes(32, 1)), device: { name, platform: "macos" } });
const push = (token: string, blob = "QUFB") => call("POST", "/v1/sync", { items: [{ id: uuid(), deleted: false, blob }] }, token);

describe("admin password", () => {
  it("the right password gets in, with any user name", async () => {
    expect((await admin("GET", "/api/overview")).status).toBe(200);
    expect((await admin("GET", "/")).status).toBe(200);
    expect((await admin("GET", "/", undefined, { auth: basic(undefined, "") })).status).toBe(200);
  });

  it("no password, a wrong one or a malformed header is 401 with a Basic challenge", async () => {
    const bad = [null, basic("wrong"), basic(""), "Basic !!!", "Bearer abc", `Basic ${Buffer.from("no-colon").toString("base64")}`];
    for (const auth of bad) {
      for (const path of ["/api/overview", "/", "/admin.js", "/accounts"]) {
        const res = await admin("GET", path, undefined, { auth });
        expect(res.status, `${path} ${auth}`).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
      }
    }
    const write = await admin("POST", "/api/invites", { email: "x@example.com" }, { auth: basic("wrong") });
    expect(write.status).toBe(401);
  });

  it("refuses everything when no admin password is configured", async () => {
    const res = await handleAdmin(
      new Request("https://admin.test/", { headers: { authorization: basic() } }),
      { ...env, ADMIN_PASSWORD: null },
    );
    expect(res.status).toBe(403);
  });

  it("admin routes don't exist on the public port", async () => {
    for (const path of ["/api/overview", "/api/accounts", "/admin.js", "/accounts", "/invites"]) {
      const res = await SELF.fetch(`https://keys.test${path}`, { headers: { authorization: basic() } });
      expect(res.status, path).toBe(404);
    }
  });
});

describe("admin pages", () => {
  it("serve HTML with a strict CSP and separate JS/CSS, no inline script or style", async () => {
    const { userId } = await registerUser("page1@x.com");
    for (const path of ["/", "/accounts", `/accounts/${userId}`, "/invites", "/plans", "/audit", "/accounts?filter=near&q=page"]) {
      const res = await admin("GET", path);
      expect(res.status, path).toBe(200);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      const html = await res.text();
      expect(html).not.toMatch(/<script>|<script(?![^>]*src=)|<style|style="/);
      expect(html).toContain('src="/admin.js"');
    }
    expect((await admin("GET", "/admin.js")).headers.get("content-type")).toContain("javascript");
    expect((await admin("GET", "/admin.css")).headers.get("content-type")).toContain("text/css");
    expect((await admin("GET", "/nope")).status).toBe(404);
  });

  it("never exposes blobs, keys, hashes or auth data", async () => {
    const { token, userId } = await registerUser("zk@x.com");
    await push(token, "U0VDUkVUQkxPQg==");
    const u = await env.DB.prepare("SELECT auth_hash, salt, wrapped_vault_key, encrypted_signing_key, recovery_hash FROM users WHERE id = ?")
      .bind(userId)
      .first<Record<string, string>>();
    const bodies = await Promise.all(
      [`/api/accounts/${userId}`, "/api/accounts", `/accounts/${userId}`, "/accounts", "/"].map(async (p) => (await admin("GET", p)).text()),
    );
    for (const b of bodies) {
      expect(b).not.toContain("U0VDUkVUQkxPQg==");
      for (const v of Object.values(u!)) expect(b).not.toContain(v);
      expect(b).not.toContain("AAAAC3NzaC1lZDI1NTE5");
    }
  });
});

describe("effective limits", () => {
  const row = (o: Partial<Parameters<typeof resolveLimits>[0]>) =>
    resolveLimits({
      plan: "x", suspended_at: null, u_bytes: null, u_items: null, u_devices: null,
      p_name: null, p_bytes: null, p_items: null, p_devices: null, p_found: 0, ...o,
    });

  it("override > plan > built-in default", () => {
    expect(row({})).toMatchObject({ bytes: 5242880, items: 10000, devices: null });
    expect(row({ p_found: 1, p_name: "Pro", p_bytes: 100, p_items: 10, p_devices: 3 })).toMatchObject({ bytes: 100, items: 10, devices: 3, planName: "Pro" });
    expect(row({ p_found: 1, p_bytes: 100, p_items: 10, p_devices: 3, u_bytes: 7, u_devices: 9 })).toMatchObject({ bytes: 7, items: 10, devices: 9 });
  });

  it("new sign-ups get the default plan; GET /v1/account reports plan and limits", async () => {
    const a = await registerUser("lim1@x.com");
    let acct = await j(await call("GET", "/v1/account", undefined, a.token));
    expect(acct.plan).toBe("free");
    expect(acct.limits).toEqual({ bytes: 5242880, items: 10000, devices: null });

    await env.DB.prepare(
      "INSERT INTO plans (id, name, bytes_limit, items_limit, devices_limit, created_at, updated_at) VALUES ('starter', 'Starter', 1000, 50, 2, 'x', 'x')",
    ).run();
    expect((await admin("POST", "/api/plans/starter/default")).status).toBe(200);
    const b = await registerUser("lim2@x.com");
    acct = await j(await call("GET", "/v1/account", undefined, b.token));
    expect(acct.plan).toBe("starter");
    expect(acct.planName).toBe("Starter");
    expect(acct.limits).toEqual({ bytes: 1000, items: 50, devices: 2 });
    // Put free back as the default for the other tests.
    expect((await admin("POST", "/api/plans/free/default")).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM plans WHERE is_default = 1").first<{ n: number }>())!.n).toBe(1);
  });

  it("quota follows a custom plan, then an override beats it", async () => {
    const { token, userId } = await registerUser("lim3@x.com");
    expect(
      (await admin("POST", "/api/plans", { id: "tiny", name: "Tiny", bytes: 8, items: 100, devices: null })).status,
    ).toBe(201);
    expect((await admin("POST", `/api/accounts/${userId}/plan`, { plan: "tiny" })).status).toBe(200);
    expect((await push(token, "QUFB")).status).toBe(200); // 4 bytes
    expect((await push(token, "QUFB")).status).toBe(200); // 8 bytes
    const over = await push(token, "QUFB");
    expect(over.status).toBe(413);
    expect((await j(over)).error).toBe("quota_exceeded");
    // The in-batch guard uses the same limits even when the pre-check is bypassed.
    await expect(writeItems(env as any, userId, [{ id: uuid(), deleted: false, blob: "QUFB", size: 4 }])).rejects.toMatchObject({ code: "quota_exceeded" });

    expect((await admin("POST", `/api/accounts/${userId}/limits`, { bytes: 12, items: null, devices: null })).status).toBe(200);
    expect((await push(token, "QUFB")).status).toBe(200);
    expect((await push(token, "QUFB")).status).toBe(413);
    expect((await j(await call("GET", "/v1/account", undefined, token))).limits.bytes).toBe(12);

    // Editing the plan applies to everyone on it right away; the override still wins for bytes.
    expect((await admin("PUT", "/api/plans/tiny", { name: "Tiny", bytes: 1000, items: 3, devices: null })).status).toBe(200);
    const acct = await j(await call("GET", "/v1/account", undefined, token));
    expect(acct.limits).toEqual({ bytes: 12, items: 3, devices: null });
    expect((await push(token, "QQ==")).status).toBe(413); // 3 items already, limit 3
    expect((await audits("custom_limits", userId))[0].admin_email).toBe(ADMIN_NAME);
  });

  it("devices_limit blocks a new sign-in beyond the limit", async () => {
    const { userId } = await registerUser("lim4@x.com");
    expect((await admin("POST", `/api/accounts/${userId}/limits`, { bytes: null, items: null, devices: 2 })).status).toBe(200);
    expect((await login("lim4@x.com")).status).toBe(200);
    const res = await login("lim4@x.com", "Third");
    expect(res.status).toBe(403);
    expect((await j(res)).error).toBe("device_limit");
  });

  it("rejects bad limit values", async () => {
    const { userId } = await registerUser("lim5@x.com");
    for (const body of [{ bytes: -1 }, { items: 1.5 }, { devices: "3" }, { bytes: 1e12 }]) {
      expect((await admin("POST", `/api/accounts/${userId}/limits`, body)).status).toBe(400);
    }
  });
});

describe("account actions", () => {
  it("suspend blocks login and sync, keeps sessions; unsuspend restores them", async () => {
    const { token, userId } = await registerUser("sus@x.com");
    expect((await admin("POST", `/api/accounts/${userId}/suspend`)).status).toBe(200);
    const l = await login("sus@x.com");
    expect(l.status).toBe(403);
    expect((await j(l)).error).toBe("account_suspended");
    // A wrong password stays a plain 401, so a guesser learns nothing.
    const wrong = await call("POST", "/v1/login", { email: "sus@x.com", authKey: b64(bytes(32, 9)), device: { name: "x", platform: "macos" } });
    expect(wrong.status).toBe(401);
    for (const res of [await push(token), await call("GET", "/v1/sync?since=0", undefined, token)]) {
      expect(res.status).toBe(403);
      expect((await j(res)).error).toBe("account_suspended");
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(userId).first<{ n: number }>())!.n).toBe(1);
    expect((await j(await admin("GET", "/api/accounts?filter=suspended"))).accounts.map((a: any) => a.id)).toContain(userId);

    expect((await admin("POST", `/api/accounts/${userId}/unsuspend`)).status).toBe(200);
    expect((await push(token)).status).toBe(200);
    expect((await login("sus@x.com")).status).toBe(200);
    expect((await audits("suspend", userId)).length).toBe(1);
    expect((await audits("unsuspend", userId)).length).toBe(1);
  });

  it("reset two-step turns TOTP off and deletes backup codes", async () => {
    const { userId } = await registerUser("r2fa@x.com");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO totp (user_id, enabled, created_at, updated_at) VALUES (?, 1, 'x', 'x')").bind(userId),
      env.DB.prepare("INSERT INTO backup_codes (user_id, code_hash) VALUES (?, 'h1'), (?, 'h2')").bind(userId, userId),
    ]);
    expect((await j(await admin("GET", `/api/accounts/${userId}`))).twoStep).toBe(true);
    const before = await j(await login("r2fa@x.com"));
    expect(before.two_step_required).toBe(true);
    expect((await admin("POST", `/api/accounts/${userId}/reset-two-step`)).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM totp WHERE user_id = ?").bind(userId).first()).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ?").bind(userId).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM login_challenges WHERE user_id = ?").bind(userId).first<{ n: number }>())!.n).toBe(0);
    expect((await login("r2fa@x.com")).status).toBe(200);
    expect((await audits("reset_two_step", userId))[0].admin_email).toBe(ADMIN_NAME);
  });

  it("sign out all devices ends every session", async () => {
    const { token, userId } = await registerUser("so@x.com");
    await login("so@x.com");
    expect((await admin("POST", `/api/accounts/${userId}/sign-out`)).status).toBe(200);
    expect((await call("GET", "/v1/account", undefined, token)).status).toBe(401);
    expect(JSON.parse((await audits("sign_out_all", userId))[0].detail)).toEqual({ devices: 2 });
  });

  it("delete needs the typed email, then removes everything and is audited", async () => {
    const { token, userId } = await registerUser("del@x.com");
    await push(token);
    expect((await admin("DELETE", `/api/accounts/${userId}`, { confirm_email: "nope@x.com" })).status).toBe(400);
    expect((await admin("DELETE", `/api/accounts/${userId}`, {})).status).toBe(400);
    expect((await admin("DELETE", `/api/accounts/${userId}`, { confirm_email: " DEL@x.com " })).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(userId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM items WHERE user_id = ?").bind(userId).first()).toBeNull();
    const a = await audits("delete_account", userId);
    expect(a.length).toBe(1);
    expect(JSON.parse(a[0].detail)).toEqual({ email: "del@x.com" });
    expect((await admin("GET", `/api/accounts/${userId}`)).status).toBe(404);
    const log = await j(await admin("GET", `/api/audit?user=${userId}`));
    expect(log.audit[0]).toMatchObject({ action: "delete_account", email: "del@x.com", admin: ADMIN_NAME });
  });

  it("change plan refuses archived and unknown plans", async () => {
    const { userId } = await registerUser("cp@x.com");
    expect((await admin("POST", `/api/accounts/${userId}/plan`, { plan: "ghost" })).status).toBe(404);
    expect((await admin("POST", `/api/accounts/${userId}/plan`, { plan: "pro" })).status).toBe(200);
    expect(JSON.parse((await audits("change_plan", userId))[0].detail)).toEqual({ from: "free", to: "pro" });
    expect((await admin("POST", `/api/accounts/${uuid()}/plan`, { plan: "pro" })).status).toBe(404);
  });

  it("search and filters", async () => {
    const { userId } = await registerUser("findme_42@x.com");
    await env.DB.prepare("UPDATE users SET username = 'finder' WHERE id = ?").bind(userId).run();
    const ids = async (qs: string) => (await j(await admin("GET", `/api/accounts?${qs}`))).accounts.map((a: any) => a.id);
    expect(await ids("q=findme_42")).toEqual([userId]);
    expect(await ids("q=FINDER")).toEqual([userId]);
    expect(await ids("q=%25")).not.toContain("nothing"); // a literal % is escaped, not a wildcard error
    expect(await ids("filter=plan:free&q=findme")).toEqual([userId]);
    expect(await ids("filter=plan:pro&q=findme")).toEqual([]);
    await env.DB.prepare("UPDATE users SET bytes_limit = 10 WHERE id = ?").bind(userId).run();
    await env.DB.prepare("INSERT INTO items (user_id, id, version, deleted, blob, size) VALUES (?, ?, 1, 0, 'x', 8)").bind(userId, uuid()).run();
    expect(await ids("filter=near&q=findme")).toEqual([userId]);
  });
});

describe("plans", () => {
  it("archive: refused while in use unless accounts are moved; never the default", async () => {
    const { userId } = await registerUser("arch@x.com");
    expect((await admin("POST", "/api/plans", { id: "old", name: "Old", bytes: 100, items: 10 })).status).toBe(201);
    expect((await admin("POST", "/api/plans", { id: "old", name: "Dup", bytes: 100, items: 10 })).status).toBe(409);
    expect((await admin("POST", `/api/accounts/${userId}/plan`, { plan: "old" })).status).toBe(200);

    const inUse = await admin("POST", "/api/plans/old/archive");
    expect(inUse.status).toBe(409);
    expect(await j(inUse)).toMatchObject({ error: "plan_in_use", accounts: 1 });
    expect((await admin("POST", "/api/plans/old/archive", { move_to: "old" })).status).toBe(400);
    expect((await admin("POST", "/api/plans/old/archive", { move_to: "pro" })).status).toBe(200);
    expect((await env.DB.prepare("SELECT plan FROM users WHERE id = ?").bind(userId).first<{ plan: string }>())!.plan).toBe("pro");
    const plans = (await j(await admin("GET", "/api/plans"))).plans;
    expect(plans.find((p: any) => p.id === "old")).toMatchObject({ archived: true, accounts: 0 });
    expect(JSON.parse((await audits("archive_plan")).at(-1)!.detail)).toEqual({ plan: "old", moved: 1, to: "pro" });

    // Archived plans can't be chosen or made default; the default can't be archived.
    expect((await admin("POST", `/api/accounts/${userId}/plan`, { plan: "old" })).status).toBe(400);
    expect((await admin("POST", "/api/plans/old/default")).status).toBe(400);
    expect((await admin("POST", "/api/plans/free/archive")).status).toBe(400);
  });

  it("validates plan fields", async () => {
    for (const body of [
      { id: "Bad Id", name: "x", bytes: 1, items: 1 },
      { id: "ok-id", name: "", bytes: 1, items: 1 },
      { id: "ok-id", name: "x", bytes: 0, items: 1 },
      { id: "ok-id", name: "x", bytes: 1 },
    ]) {
      expect((await admin("POST", "/api/plans", body)).status).toBe(400);
    }
  });
});

describe("write protection and audit", () => {
  it("writes need the custom header and a same-origin request", async () => {
    const { userId } = await registerUser("csrf@x.com");
    const path = `https://admin.test/api/accounts/${userId}/suspend`;
    const base = { authorization: basic(), "content-type": "application/json" };
    expect((await ADMIN.fetch(path, { method: "POST", headers: base, body: "{}" })).status).toBe(403);
    expect((await ADMIN.fetch(path, { method: "POST", headers: { ...base, "x-tessh-admin": "1", origin: "https://evil.test" }, body: "{}" })).status).toBe(403);
    expect((await ADMIN.fetch(path, { method: "POST", headers: { ...base, "x-tessh-admin": "1", "sec-fetch-site": "cross-site" }, body: "{}" })).status).toBe(403);
    expect((await ADMIN.fetch(path, { method: "POST", headers: { ...base, "x-tessh-admin": "1", origin: "https://admin.test" }, body: "{}" })).status).toBe(200);
    expect((await admin("POST", `/api/accounts/${userId}/suspend`, undefined, { auth: null })).status).toBe(401);
  });

  it("audit log is newest first and filters by account", async () => {
    const a = await registerUser("aud1@x.com");
    const b = await registerUser("aud2@x.com");
    await admin("POST", `/api/accounts/${a.userId}/suspend`);
    await admin("POST", `/api/accounts/${b.userId}/suspend`);
    await admin("POST", `/api/accounts/${a.userId}/unsuspend`);
    const all = (await j(await admin("GET", "/api/audit"))).audit;
    expect(all[0]).toMatchObject({ action: "unsuspend", userId: a.userId, email: "aud1@x.com", admin: ADMIN_NAME });
    const onlyA = (await j(await admin("GET", `/api/audit?user=${a.userId}`))).audit;
    expect(onlyA.map((x: any) => x.action)).toEqual(["unsuspend", "suspend"]);
    const page = await (await admin("GET", `/audit?user=${a.userId}`)).text();
    expect(page).toContain("Unsuspended");
  });

  it("overview counts", async () => {
    await registerUser("ov@x.com");
    const o = await j(await admin("GET", "/api/overview"));
    expect(o.accounts).toBeGreaterThan(0);
    expect(o.signups30d).toHaveLength(30);
    expect(o.signups30d.at(-1).count).toBeGreaterThan(0);
    expect(o.storage.capacity).toBeGreaterThan(0);
  });
});

