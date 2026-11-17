import { env } from "./harness.ts";
import { describe, expect, it } from "vitest";
import { b64, bytes, call, registerBody } from "./helpers.ts";
import { HttpError, MAX_BODY_BYTES, readJSON } from "../src/http.ts";

const GOOD = b64(bytes(32, 1));
const BAD = b64(bytes(32, 9));
const dev = { name: "Phone", platform: "ios" };

describe("accounts", () => {
  it("register then login returns a working token", async () => {
    const reg = await call("POST", "/v1/register", registerBody("a@x.com"));
    expect(reg.status).toBe(201);
    const r = (await reg.json()) as any;
    expect(r.token).toMatch(/^tsk_[A-Za-z0-9_-]{43}$/);
    expect(r.account.email).toBe("a@x.com");
    const login = await call("POST", "/v1/login", { email: "a@x.com", authKey: GOOD, device: dev });
    expect(login.status).toBe(200);
    const l = (await login.json()) as any;
    expect(l.wrappedVaultKey).toBe(registerBody("a@x.com").wrappedVaultKey);
    expect(l.encryptedSigningKey).toBeTruthy();
    expect(l.signerPublicKey).toMatch(/^ssh-ed25519 /);
    expect((await call("GET", "/v1/account", undefined, l.token)).status).toBe(200);
    expect((await call("GET", "/v1/account")).status).toBe(401);
    expect((await call("GET", "/v1/account", undefined, "tsk_nope")).status).toBe(401);
  });

  it("email is normalised", async () => {
    await call("POST", "/v1/register", registerBody("Bob@X.com"));
    const res = await call("POST", "/v1/login", { email: "bob@x.com ", authKey: GOOD, device: dev });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).account.email).toBe("bob@x.com");
  });

  it("duplicate email is 409 email_taken", async () => {
    await call("POST", "/v1/register", registerBody("dup@x.com"));
    const res = await call("POST", "/v1/register", registerBody(" DUP@x.com"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe("email_taken");
  });

  it("prelogin returns stored salt and kdf for a real account", async () => {
    await call("POST", "/v1/register", registerBody("real@x.com"));
    const p = (await (await call("POST", "/v1/prelogin", { email: "REAL@x.com" })).json()) as any;
    expect(p.salt).toBe(registerBody("real@x.com").salt);
    expect(p.kdf).toEqual({ alg: "argon2id", opslimit: 3, memlimit: 67108864 });
  });

  it("unknown email gets a stable fake salt", async () => {
    const get = async (email: string) =>
      ((await (await call("POST", "/v1/prelogin", { email })).json()) as any).salt as string;
    const a1 = await get("nobody@x.com");
    expect(await get("Nobody@x.com ")).toBe(a1);
    expect(atob(a1).length).toBe(16);
    expect(await get("other@x.com")).not.toBe(a1);
  });

  it("wrong password and unknown email look the same", async () => {
    await call("POST", "/v1/register", registerBody("same@x.com"));
    const a = await call("POST", "/v1/login", { email: "same@x.com", authKey: BAD, device: dev });
    const b = await call("POST", "/v1/login", { email: "ghost@x.com", authKey: BAD, device: dev });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const ja = (await a.json()) as any;
    const jb = (await b.json()) as any;
    expect(ja.error).toBe("invalid_credentials");
    expect(ja).toEqual(jb);
  });

  it("ten failures in 15 minutes rate-limit the email", async () => {
    await call("POST", "/v1/register", registerBody("rl@x.com"));
    for (let i = 0; i < 10; i++) {
      const r = await call("POST", "/v1/login", { email: "rl@x.com", authKey: BAD, device: dev });
      expect(r.status).toBe(401);
    }
    const blocked = await call("POST", "/v1/login", { email: "rl@x.com", authKey: GOOD, device: dev });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as any).error).toBe("rate_limited");
  });

  it("concurrent wrong guesses cannot beat the rate limit", async () => {
    await call("POST", "/v1/register", registerBody("race@x.com"));
    const rs = await Promise.all(
      Array.from({ length: 15 }, () => call("POST", "/v1/login", { email: "race@x.com", authKey: BAD, device: dev })),
    );
    const statuses = rs.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
  });

  it("rejects a kdf weaker or stronger than the allowed range", async () => {
    const bad = [
      { alg: "argon2id", opslimit: 2, memlimit: 67108864 },
      { alg: "argon2id", opslimit: 3, memlimit: 67108863 },
      { alg: "argon2id", opslimit: 11, memlimit: 67108864 },
      { alg: "argon2id", opslimit: 3, memlimit: 1073741825 },
    ];
    for (const kdf of bad) {
      const r = await call("POST", "/v1/register", registerBody("kdf@x.com", { kdf }));
      expect(r.status, JSON.stringify(kdf)).toBe(400);
    }
    const ok = await call("POST", "/v1/register", registerBody("kdf@x.com", { kdf: { alg: "argon2id", opslimit: 10, memlimit: 1073741824 } }));
    expect(ok.status).toBe(201);
  });

  it("a success clears the failures", async () => {
    await call("POST", "/v1/register", registerBody("clr@x.com"));
    for (let i = 0; i < 5; i++) await call("POST", "/v1/login", { email: "clr@x.com", authKey: BAD, device: dev });
    expect((await call("POST", "/v1/login", { email: "clr@x.com", authKey: GOOD, device: dev })).status).toBe(200);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE email = ?").bind("clr@x.com").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("failures older than 15 minutes are pruned and not counted", async () => {
    await call("POST", "/v1/register", registerBody("old@x.com"));
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    for (let i = 0; i < 10; i++) await env.DB.prepare("INSERT INTO login_failures (email, at) VALUES (?, ?)").bind("old@x.com", old).run();
    expect((await call("POST", "/v1/login", { email: "old@x.com", authKey: GOOD, device: dev })).status).toBe(200);
  });

  it("logout revokes the token and removes the device", async () => {
    const reg = (await (await call("POST", "/v1/register", registerBody("out@x.com"))).json()) as any;
    expect((await call("POST", "/v1/logout", undefined, reg.token)).status).toBe(204);
    expect((await call("GET", "/v1/account", undefined, reg.token)).status).toBe(401);
    const d = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE id = ?").bind(reg.deviceId).first<{ n: number }>();
    expect(d!.n).toBe(0);
  });

  it("authKey must be 32 bytes base64", async () => {
    for (const authKey of [b64(bytes(31)), b64(bytes(33)), "not base64!!", 5, ""]) {
      const r = await call("POST", "/v1/register", registerBody("bad@x.com", { authKey }));
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error).toBe("invalid_request");
    }
    const l = await call("POST", "/v1/login", { email: "bad@x.com", authKey: b64(bytes(5)), device: dev });
    expect(l.status).toBe(400);
  });

  it("register requires recovery fields and account shows recovery enabled", async () => {
    for (const over of [
      { recoveryAuthKey: undefined },
      { recoveryAuthKey: b64(bytes(31)) },
      { wrappedVaultKeyRecovery: undefined },
      { wrappedVaultKeyRecovery: "###" },
    ]) {
      const r = await call("POST", "/v1/register", registerBody("rec@x.com", over));
      expect(r.status, JSON.stringify(over)).toBe(400);
    }
    const reg = await call("POST", "/v1/register", registerBody("rec@x.com"));
    expect(reg.status).toBe(201);
    const r = (await reg.json()) as any;
    expect(r.account.recovery.enabled).toBe(true);
    expect(Date.parse(r.account.recovery.createdAt)).toBeGreaterThan(Date.now() - 60_000);
    const a = (await (await call("GET", "/v1/account", undefined, r.token)).json()) as any;
    expect(a.recovery).toEqual(r.account.recovery);
    const row = await env.DB.prepare("SELECT recovery_hash, wrapped_vault_key_recovery FROM users WHERE email = 'rec@x.com'")
      .first<{ recovery_hash: string; wrapped_vault_key_recovery: string }>();
    expect(row!.recovery_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.wrapped_vault_key_recovery).toBe(registerBody("x").wrappedVaultKeyRecovery);
  });

  it("an account with no recovery code reports recovery disabled", async () => {
    const reg = (await (await call("POST", "/v1/register", registerBody("norec@x.com"))).json()) as any;
    await env.DB.prepare("UPDATE users SET recovery_hash = NULL, wrapped_vault_key_recovery = NULL, recovery_created_at = NULL WHERE email = 'norec@x.com'").run();
    const a = (await (await call("GET", "/v1/account", undefined, reg.token)).json()) as any;
    expect(a.recovery).toEqual({ enabled: false, createdAt: null });
  });

  it("platform web is accepted, other values are 400", async () => {
    const web = { name: "Safari on Mac", platform: "web" };
    const reg = await call("POST", "/v1/register", registerBody("web@x.com", { device: web }));
    expect(reg.status).toBe(201);
    expect((await call("POST", "/v1/login", { email: "web@x.com", authKey: GOOD, device: web })).status).toBe(200);
    for (const platform of ["Web", "android", "", 1])
      expect((await call("POST", "/v1/login", { email: "web@x.com", authKey: GOOD, device: { name: "x", platform } })).status).toBe(400);
  });

  it("rejects bad register fields", async () => {
    const cases: Record<string, unknown>[] = [
      { email: "nope" },
      { salt: b64(bytes(8)) },
      { kdf: { alg: "scrypt", opslimit: 3, memlimit: 1 } },
      { kdf: { alg: "argon2id", opslimit: 1.5, memlimit: 1 } },
      { signerPublicKey: "ssh-rsa AAAA" },
      { device: { name: "", platform: "macos" } },
      { device: { name: "x".repeat(65), platform: "macos" } },
      { device: { name: "x", platform: "linux" } },
      { wrappedVaultKey: "###" },
    ];
    for (const over of cases) {
      const r = await call("POST", "/v1/register", registerBody("v@x.com", over));
      expect(r.status, JSON.stringify(over)).toBe(400);
    }
  });
});

describe("readJSON", () => {
  it("bad JSON gives 400 invalid_request", async () => {
    const req = new Request("https://api.test/x", { method: "POST", body: "{nope" });
    await expect(readJSON(req)).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    const res = await call("POST", "/v1/prelogin", undefined);
    expect(res.status).toBe(400);
  });

  it("a body over 1 MiB gives 400", async () => {
    const req = new Request("https://api.test/x", { method: "POST", body: "a".repeat(MAX_BODY_BYTES + 1) });
    const err = (await readJSON(req).catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
  });
});
