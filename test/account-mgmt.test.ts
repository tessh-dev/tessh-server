import type { Value } from "../src/db.ts";
import { SELF, env } from "./harness.ts";
import { describe, expect, it } from "vitest";
import { b64, bytes, call, registerBody, registerUser, uuid } from "./helpers.ts";

const push = (token: string, n: number) =>
  call("POST", "/v1/sync", { items: Array.from({ length: n }, () => ({ id: uuid(), deleted: false, blob: "QUJD" })) }, token);
const login = (email: string, key = 1, name = "Other") =>
  call("POST", "/v1/login", { email, authKey: b64(bytes(32, key)), device: { name, platform: "ios" } });
const count = async (sql: string, ...args: Value[]) =>
  (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;

describe("account management", () => {
  it("account shows usage and limits", async () => {
    const { token } = await registerUser("m1@x.com");
    await push(token, 2);
    const a = (await (await call("GET", "/v1/account", undefined, token)).json()) as any;
    expect(a.username).toBeNull();
    expect(a.usage).toEqual({ bytes: 8, items: 2 });
    expect(a.plan).toBe("self-hosted");
    expect(a.limits).toEqual({ bytes: 1073741824, items: 100000, devices: 50 });
  });

  it("username: valid, reserved, taken, and changing frees the old one", async () => {
    const bob = await registerUser("bob@x.com");
    const other = await registerUser("other@x.com");
    for (const bad of ["api", "a", "-ab", "a_b", "x".repeat(32), 5])
      expect((await call("PUT", "/v1/account/username", { username: bad }, bob.token)).status).toBe(400);
    const ok = await call("PUT", "/v1/account/username", { username: "Bob" }, bob.token);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).username).toBe("bob");
    expect((await call("PUT", "/v1/account/username", { username: "bob" }, bob.token)).status).toBe(200);
    const taken = await call("PUT", "/v1/account/username", { username: "bob" }, other.token);
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as any).error).toBe("username_taken");
    expect((await call("PUT", "/v1/account/username", { username: "rob" }, bob.token)).status).toBe(200);
    expect((await call("PUT", "/v1/account/username", { username: "bob" }, other.token)).status).toBe(200);
  });

  it("password change requires currentAuthKey, swaps salt and wrapped key, revokes other sessions only", async () => {
    const { token } = await registerUser("pw@x.com");
    const second = (await (await login("pw@x.com")).json()) as any;
    const body = {
      currentAuthKey: b64(bytes(32, 1)),
      authKey: b64(bytes(32, 9)),
      salt: b64(bytes(16, 8)),
      kdf: { alg: "argon2id", opslimit: 3, memlimit: 67108864 },
      wrappedVaultKey: b64(bytes(60, 7)),
    };
    const wrong = await call("PUT", "/v1/account/password", { ...body, currentAuthKey: b64(bytes(32, 5)) }, token);
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as any).error).toBe("invalid_credentials");
    expect((await call("PUT", "/v1/account/password", { ...body, kdf: { alg: "argon2id", opslimit: 1, memlimit: 1 } }, token)).status).toBe(400);
    expect((await call("PUT", "/v1/account/password", body)).status).toBe(401);
    expect((await call("PUT", "/v1/account/password", body, token)).status).toBe(204);
    expect((await call("GET", "/v1/account", undefined, token)).status).toBe(200);
    expect((await call("GET", "/v1/account", undefined, second.token)).status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM devices WHERE user_id = (SELECT id FROM users WHERE email = 'pw@x.com')")).toBe(1);
    expect((await login("pw@x.com", 1)).status).toBe(401);
    const l = (await (await login("pw@x.com", 9)).json()) as any;
    expect(l.wrappedVaultKey).toBe(body.wrappedVaultKey);
    const pre = (await (await call("POST", "/v1/prelogin", { email: "pw@x.com" })).json()) as any;
    expect(pre.salt).toBe(body.salt);
  });

  it("delete account requires authKey and removes every row", async () => {
    const { token, userId } = await registerUser("del@x.com");
    await push(token, 2);
    const bystander = await registerUser("bystander@x.com");
    await push(bystander.token, 3);
    await call("PUT", "/v1/account/username", { username: "delme" }, token);
    expect((await login("del@x.com", 5)).status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM login_failures WHERE email = ?", "del@x.com")).toBe(1);
    await env.DB.prepare("INSERT INTO recovery_failures (email, at) VALUES (?, ?)").bind("del@x.com", new Date().toISOString()).run();
    const wrong = await call("DELETE", "/v1/account", { authKey: b64(bytes(32, 5)) }, token);
    expect(wrong.status).toBe(401);
    expect((await call("DELETE", "/v1/account", { authKey: b64(bytes(32, 1)) }, token)).status).toBe(204);
    expect(await count("SELECT COUNT(*) AS n FROM login_failures WHERE email = ?", "del@x.com")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM recovery_failures WHERE email = ?", "del@x.com")).toBe(0);
    expect((await login("del@x.com")).status).toBe(401);
    for (const t of ["items", "devices", "sessions", "keypages", "users"]) {
      const col = t === "users" ? "id" : "user_id";
      expect(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`, userId)).toBe(0);
    }
    expect(await count("SELECT COUNT(*) AS n FROM items WHERE user_id = ?", bystander.userId)).toBe(3);
    expect(await count("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?", bystander.userId)).toBe(1);
    expect((await call("GET", "/v1/account", undefined, bystander.token)).status).toBe(200);
  });

  it("username availability: available, taken, reserved, invalid", async () => {
    const { token } = await registerUser("avail@x.com");
    await call("PUT", "/v1/account/username", { username: "alice" }, token);
    const get = async (n: string) => {
      const r = await call("GET", `/v1/username/${n}`);
      expect(r.status).toBe(200);
      return r.json();
    };
    expect(await get("free-name")).toEqual({ available: true, reason: null });
    expect(await get("alice")).toEqual({ available: false, reason: "taken" });
    expect(await get("ALICE")).toEqual({ available: false, reason: "taken" });
    expect(await get("api")).toEqual({ available: false, reason: "reserved" });
    expect(await get("Keys")).toEqual({ available: false, reason: "reserved" });
    for (const bad of ["a", "-ab", "a_b", "x".repeat(32), "%E2%9C%93", "%ZZ"])
      expect(await get(bad), bad).toEqual({ available: false, reason: "invalid" });
  });

  it("set recovery needs currentAuthKey; a stolen token alone gets 401", async () => {
    const { token } = await registerUser("setrec@x.com");
    const body = { currentAuthKey: b64(bytes(32, 1)), recoveryAuthKey: b64(bytes(32, 40)), wrappedVaultKeyRecovery: b64(bytes(60, 41)) };
    const before = ((await (await call("GET", "/v1/account", undefined, token)).json()) as any).recovery;
    const stolen = await call("PUT", "/v1/account/recovery", { ...body, currentAuthKey: b64(bytes(32, 5)) }, token);
    expect(stolen.status).toBe(401);
    expect(((await stolen.json()) as any).error).toBe("invalid_credentials");
    const { currentAuthKey: _omit, ...noKey } = body;
    expect((await call("PUT", "/v1/account/recovery", noKey, token)).status).toBe(400);
    expect((await call("PUT", "/v1/account/recovery", body)).status).toBe(401);
    expect((await call("PUT", "/v1/account/recovery", { ...body, recoveryAuthKey: b64(bytes(31)) }, token)).status).toBe(400);
    // A recovery token obtained with the old code dies with it.
    const old = (await (await call("POST", "/v1/recover/start", { email: "setrec@x.com", recoveryAuthKey: b64(bytes(32, 11)) })).json()) as any;
    expect((await call("PUT", "/v1/account/recovery", body, token)).status).toBe(204);
    expect((await call("DELETE", "/v1/account", { recoveryToken: old.recoveryToken })).status).toBe(401);
    expect((await call("POST", "/v1/recover/start", { email: "setrec@x.com", recoveryAuthKey: b64(bytes(32, 11)) })).status).toBe(401);
    const ok = await call("POST", "/v1/recover/start", { email: "setrec@x.com", recoveryAuthKey: body.recoveryAuthKey });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).wrappedVaultKeyRecovery).toBe(body.wrappedVaultKeyRecovery);
    const after = ((await (await call("GET", "/v1/account", undefined, token)).json()) as any).recovery;
    expect(after.enabled).toBe(true);
    expect(after.createdAt >= before.createdAt).toBe(true);
  });

  it("delete account with recoveryToken removes everything, including recovery_failures", async () => {
    const { token, userId } = await registerUser("rdel@x.com");
    await push(token, 2);
    await call("PUT", "/v1/account/username", { username: "rdel" }, token);
    expect((await call("POST", "/v1/recover/start", { email: "rdel@x.com", recoveryAuthKey: b64(bytes(32, 99)) })).status).toBe(401);
    expect((await login("rdel@x.com", 5)).status).toBe(401);
    const s = (await (await call("POST", "/v1/recover/start", { email: "rdel@x.com", recoveryAuthKey: b64(bytes(32, 11)) })).json()) as any;
    // Seed a failure after the successful start (which clears them) so delete must remove it.
    await env.DB.prepare("INSERT INTO recovery_failures (email, at) VALUES (?, ?)").bind("rdel@x.com", new Date().toISOString()).run();
    expect((await call("DELETE", "/v1/account", { recoveryToken: "trc_" + "A".repeat(43) })).status).toBe(401);
    expect((await call("DELETE", "/v1/account", { recoveryToken: s.recoveryToken })).status).toBe(204);
    expect((await call("DELETE", "/v1/account", { recoveryToken: s.recoveryToken })).status).toBe(401);
    for (const t of ["items", "devices", "sessions", "keypages", "recovery_tokens", "users"]) {
      const col = t === "users" ? "id" : "user_id";
      expect(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`, userId)).toBe(0);
    }
    for (const t of ["login_failures", "recovery_failures"])
      expect(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE email = ?`, "rdel@x.com")).toBe(0);
    expect(((await (await call("GET", "/v1/username/rdel")).json()) as any).available).toBe(true);
  });

  it("devices lists current flag; removing another device kills its token", async () => {
    const { token } = await registerUser("dev@x.com");
    const second = (await (await login("dev@x.com", 1, "Phone")).json()) as any;
    const list = (await (await call("GET", "/v1/devices", undefined, token)).json()) as any;
    expect(list.devices).toHaveLength(2);
    expect(list.devices.filter((d: any) => d.current)).toHaveLength(1);
    const phone = list.devices.find((d: any) => d.name === "Phone");
    expect(phone.current).toBe(false);
    expect(Object.keys(phone).sort()).toEqual(["createdAt", "current", "id", "lastSeenAt", "name", "platform"]);
    const stranger = await registerUser("stranger@x.com");
    expect((await call("DELETE", `/v1/devices/${phone.id}`, undefined, stranger.token)).status).toBe(404);
    expect((await call("DELETE", `/v1/devices/${uuid()}`, undefined, token)).status).toBe(404);
    expect((await call("DELETE", `/v1/devices/${phone.id}`, undefined, token)).status).toBe(204);
    expect((await call("GET", "/v1/account", undefined, second.token)).status).toBe(401);
    const me = list.devices.find((d: any) => d.current);
    expect((await call("DELETE", `/v1/devices/${me.id}`, undefined, token)).status).toBe(204);
    expect((await call("GET", "/v1/account", undefined, token)).status).toBe(401);
  });

  it("CORS: the API sends no CORS headers, key pages allow any origin", async () => {
    const o = "https://elsewhere.test";
    const ok = await SELF.fetch("https://api.test/v1/health", { headers: { origin: o } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    const keys = await SELF.fetch("https://keys.test/x", { headers: { origin: o } });
    expect(keys.headers.get("access-control-allow-origin")).toBe("*");
  });

  const pwBody = () => ({
    currentAuthKey: b64(bytes(32, 1)),
    authKey: b64(bytes(32, 9)),
    salt: b64(bytes(16, 8)),
    kdf: { alg: "argon2id", opslimit: 3, memlimit: 67108864 },
    wrappedVaultKey: b64(bytes(60, 7)),
  });
  const rcode = b64(bytes(32, 11));

  it("password change revokes outstanding recovery tokens", async () => {
    const { token } = await registerUser("pwrt@x.com");
    const s = (await (await call("POST", "/v1/recover/start", { email: "pwrt@x.com", recoveryAuthKey: rcode })).json()) as any;
    expect((await call("PUT", "/v1/account/password", pwBody(), token)).status).toBe(204);
    const fin = await call("POST", "/v1/recover/finish", {
      recoveryToken: s.recoveryToken, authKey: b64(bytes(32, 21)), salt: b64(bytes(16, 22)),
      kdf: { alg: "argon2id", opslimit: 3, memlimit: 67108864 }, wrappedVaultKey: b64(bytes(60, 23)),
      recoveryAuthKey: b64(bytes(32, 24)), wrappedVaultKeyRecovery: b64(bytes(60, 25)),
      device: { name: "Safari", platform: "web" },
    });
    expect(fin.status).toBe(401);
  });

  it("password change leaves recovery working", async () => {
    const { token } = await registerUser("pwrec@x.com");
    const get = async () => (await env.DB.prepare("SELECT wrapped_vault_key_recovery AS w FROM users WHERE email = ?").bind("pwrec@x.com").first<{ w: string }>())!.w;
    const before = await get();
    expect((await call("PUT", "/v1/account/password", pwBody(), token)).status).toBe(204);
    const r = await call("POST", "/v1/recover/start", { email: "pwrec@x.com", recoveryAuthKey: rcode });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).wrappedVaultKeyRecovery).toBe(before);
    expect(await get()).toBe(before);
  });

  it("a sign-in whose password check passed makes no session once the password has changed", async () => {
    const { token, userId } = await registerUser("pwrace@x.com");
    const db = env.DB as unknown as { batch: (s: unknown[]) => Promise<unknown> };
    const original = db.batch;
    // Hold the sign-in at its session write and change the password in between.
    db.batch = async function (this: unknown, stmts: unknown[]) {
      delete (db as { batch?: unknown }).batch;
      expect((await call("PUT", "/v1/account/password", pwBody(), token)).status).toBe(204);
      return original.call(env.DB, stmts);
    };
    try {
      const res = await login("pwrace@x.com");
      expect([res.status, ((await res.json()) as any).error]).toEqual([401, "invalid_credentials"]);
    } finally {
      delete (db as { batch?: unknown }).batch;
    }
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", userId)).toBe(1);
  });
});

describe("password checks behind a session token", () => {
  const wrong = b64(bytes(32, 5));
  const right = b64(bytes(32, 1));
  const routes = (token: string, key: string) => [
    () =>
      call("PUT", "/v1/account/password", {
        currentAuthKey: key,
        authKey: b64(bytes(32, 9)),
        salt: b64(bytes(16, 8)),
        kdf: { alg: "argon2id", opslimit: 3, memlimit: 67108864 },
        wrappedVaultKey: b64(bytes(60, 7)),
      }, token),
    () => call("PUT", "/v1/account/recovery", { currentAuthKey: key, recoveryAuthKey: b64(bytes(32, 3)), wrappedVaultKeyRecovery: b64(bytes(60, 4)) }, token),
    () => call("DELETE", "/v1/account", { authKey: key }, token),
  ];

  it("ten wrong passwords in 15 minutes rate-limit password change, recovery set and delete", async () => {
    for (const [i, email] of ["rl-pw@x.com", "rl-rc@x.com", "rl-del@x.com"].entries()) {
      const { token } = await registerUser(email);
      for (let n = 0; n < 10; n++) expect((await routes(token, wrong)[i]()).status).toBe(401);
      const blocked = await routes(token, right)[i]();
      expect(blocked.status, email).toBe(429);
      expect(((await blocked.json()) as any).error).toBe("rate_limited");
      expect((await call("GET", "/v1/account", undefined, token)).status).toBe(200); // still there
    }
  });

  it("shares the login limit for the account's email", async () => {
    const { token } = await registerUser("rl-shared@x.com");
    for (let n = 0; n < 6; n++) expect((await login("rl-shared@x.com", 5)).status).toBe(401);
    for (let n = 0; n < 4; n++) expect((await routes(token, wrong)[2]()).status).toBe(401);
    expect((await routes(token, right)[2]()).status).toBe(429);
    expect((await login("rl-shared@x.com", 1)).status).toBe(429);
  });

  it("concurrent wrong guesses cannot beat it", async () => {
    const { token } = await registerUser("rl-race@x.com");
    const statuses = (await Promise.all(Array.from({ length: 15 }, () => routes(token, wrong)[0]()))).map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
  });

  it("a right password still works under the limit", async () => {
    const { token } = await registerUser("rl-ok@x.com");
    for (let n = 0; n < 3; n++) expect((await routes(token, wrong)[1]()).status).toBe(401);
    expect((await routes(token, right)[1]()).status).toBe(204);
  });
});

describe("last_seen_at", () => {
  it("is written only when the stored value is more than 5 minutes old", async () => {
    const { token } = await registerUser("seen@x.com");
    const id = "(SELECT id FROM devices WHERE user_id = (SELECT id FROM users WHERE email = 'seen@x.com'))";
    const seen = async () =>
      (await env.DB.prepare(`SELECT last_seen_at AS t FROM devices WHERE id = ${id}`).first<{ t: string }>())!.t;
    const recent = new Date(Date.now() - 4 * 60_000).toISOString();
    await env.DB.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ${id}`).bind(recent).run();
    expect((await call("GET", "/v1/account", undefined, token)).status).toBe(200);
    expect(await seen()).toBe(recent);

    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    await env.DB.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ${id}`).bind(old).run();
    const before = Date.now();
    expect((await call("GET", "/v1/account", undefined, token)).status).toBe(200);
    expect(Date.parse(await seen())).toBeGreaterThanOrEqual(before - 1000);
  });
});
