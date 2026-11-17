import type { Value } from "../src/db.ts";
import { env } from "./harness.ts";
import { describe, expect, it } from "vitest";
import { KDF, b64, bytes, call, registerUser } from "./helpers.ts";

const CODE = b64(bytes(32, 11)); // registerBody's recoveryAuthKey
const WRAPPED_RECOVERY = b64(bytes(60, 12));
const dev = { name: "Safari on Mac", platform: "web" };
const count = async (sql: string, ...args: Value[]) =>
  (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;
const start = (email: string, key = CODE) => call("POST", "/v1/recover/start", { email, recoveryAuthKey: key });
const login = (email: string, key: number) =>
  call("POST", "/v1/login", { email, authKey: b64(bytes(32, key)), device: { name: "Mac", platform: "macos" } });
const finishBody = (recoveryToken: string, over: Record<string, unknown> = {}) => ({
  recoveryToken,
  authKey: b64(bytes(32, 21)),
  salt: b64(bytes(16, 22)),
  kdf: KDF,
  wrappedVaultKey: b64(bytes(60, 23)),
  recoveryAuthKey: b64(bytes(32, 24)),
  wrappedVaultKeyRecovery: b64(bytes(60, 25)),
  device: dev,
  ...over,
});
const tokenOf = async (email: string) => ((await (await start(email)).json()) as any).recoveryToken as string;

describe("recovery", () => {
  it("recover start: right code returns token and wrapped key; wrong code and unknown email look identical", async () => {
    await registerUser("rs@x.com");
    const ok = await start("RS@x.com ");
    expect(ok.status).toBe(200);
    const r = (await ok.json()) as any;
    expect(Object.keys(r).sort()).toEqual(["encryptedSigningKey", "recoveryToken", "signerPublicKey", "wrappedVaultKeyRecovery"]);
    expect(r.recoveryToken).toMatch(/^trc_[A-Za-z0-9_-]{43}$/);
    expect(r.wrappedVaultKeyRecovery).toBe(WRAPPED_RECOVERY);
    expect(r.signerPublicKey).toMatch(/^ssh-ed25519 /);
    const stored = await env.DB.prepare("SELECT token_hash, expires_at FROM recovery_tokens").all<{ token_hash: string; expires_at: string }>();
    expect(stored.results.some((t) => t.token_hash === r.recoveryToken)).toBe(false);
    const exp = Date.parse(stored.results[stored.results.length - 1].expires_at) - Date.now();
    expect(exp).toBeGreaterThan(14 * 60_000);
    expect(exp).toBeLessThanOrEqual(15 * 60_000);

    // An old-style account with no recovery code set.
    await env.DB.prepare(
      "INSERT INTO users (id, email, auth_hash, salt, kdf, wrapped_vault_key, encrypted_signing_key, signer_public_key, created_at) VALUES (?, 'old@x.com', 'h', 's', '{}', 'w', 'e', 'p', 'now')",
    ).bind(crypto.randomUUID()).run();
    const wrong = await start("rs@x.com", b64(bytes(32, 99)));
    const ghost = await start("ghost@x.com");
    const unset = await start("old@x.com");
    const bodies = [];
    for (const res of [wrong, ghost, unset]) {
      expect(res.status).toBe(401);
      bodies.push(await res.json());
    }
    expect((bodies[0] as any).error).toBe("invalid_credentials");
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect((await start("rs@x.com", b64(bytes(5)))).status).toBe(400);
  });

  it("recover start rate limit: the 6th attempt in an hour is 429, even with concurrent requests", async () => {
    await registerUser("rrl@x.com");
    for (let i = 0; i < 5; i++) expect((await start("rrl@x.com", b64(bytes(32, 99)))).status).toBe(401);
    const blocked = await start("rrl@x.com");
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as any).error).toBe("rate_limited");

    await registerUser("rrace@x.com");
    const rs = await Promise.all(Array.from({ length: 12 }, () => start("rrace@x.com", b64(bytes(32, 99)))));
    const statuses = rs.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(7);

    // Old failures do not count, and a success clears the email's rows.
    await registerUser("rold@x.com");
    const old = new Date(Date.now() - 61 * 60_000).toISOString();
    for (let i = 0; i < 6; i++) await env.DB.prepare("INSERT INTO recovery_failures (email, at) VALUES (?, ?)").bind("rold@x.com", old).run();
    await start("rold@x.com", b64(bytes(32, 99)));
    expect((await start("rold@x.com")).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM recovery_failures WHERE email = ?", "rold@x.com")).toBe(0);
  });

  it("recover finish: new password works, old password fails, every old session revoked, old code fails, new code works", async () => {
    const { token, userId } = await registerUser("rf@x.com");
    const second = (await (await login("rf@x.com", 1)).json()) as any;
    const rt = await tokenOf("rf@x.com");
    const res = await call("POST", "/v1/recover/finish", finishBody(rt));
    expect(res.status).toBe(200);
    const f = (await res.json()) as any;
    expect(f.token).toMatch(/^tsk_/);
    expect(f.account.email).toBe("rf@x.com");
    expect(f.account.recovery.enabled).toBe(true);
    expect((await call("GET", "/v1/account", undefined, f.token)).status).toBe(200);
    expect((await call("GET", "/v1/account", undefined, token)).status).toBe(401);
    expect((await call("GET", "/v1/account", undefined, second.token)).status).toBe(401);
    const devices = await env.DB.prepare("SELECT id, platform FROM devices WHERE user_id = ?").bind(userId).all<{ id: string; platform: string }>();
    expect(devices.results).toEqual([{ id: f.deviceId, platform: "web" }]);
    expect(await count("SELECT COUNT(*) AS n FROM recovery_tokens WHERE user_id = ?", userId)).toBe(0);
    expect((await login("rf@x.com", 1)).status).toBe(401);
    const l = (await (await login("rf@x.com", 21)).json()) as any;
    expect(l.wrappedVaultKey).toBe(b64(bytes(60, 23)));
    const pre = (await (await call("POST", "/v1/prelogin", { email: "rf@x.com" })).json()) as any;
    expect(pre.salt).toBe(b64(bytes(16, 22)));
    expect((await start("rf@x.com")).status).toBe(401);
    const again = await start("rf@x.com", b64(bytes(32, 24)));
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).wrappedVaultKeyRecovery).toBe(b64(bytes(60, 25)));
  });

  it("finish validates everything before consuming the token", async () => {
    await registerUser("rv@x.com");
    const rt = await tokenOf("rv@x.com");
    const bad: Record<string, unknown>[] = [
      { kdf: { alg: "argon2id", opslimit: 2, memlimit: 67108864 } },
      { authKey: b64(bytes(31)) },
      { recoveryAuthKey: b64(bytes(33)) },
      { salt: "###" },
      { wrappedVaultKey: "" },
      { wrappedVaultKeyRecovery: 5 },
      { device: { name: "x", platform: "linux" } },
    ];
    for (const over of bad) {
      const r = await call("POST", "/v1/recover/finish", finishBody(rt, over));
      expect(r.status, JSON.stringify(over)).toBe(400);
    }
    expect((await call("POST", "/v1/recover/finish", finishBody(rt))).status).toBe(200);
  });

  it("recovery token is single use and expires after 15 minutes", async () => {
    await registerUser("rt@x.com");
    const rt = await tokenOf("rt@x.com");
    expect((await call("POST", "/v1/recover/finish", finishBody(rt))).status).toBe(200);
    const reuse = await call("POST", "/v1/recover/finish", finishBody(rt, { recoveryAuthKey: b64(bytes(32, 30)) }));
    expect(reuse.status).toBe(401);
    expect(((await reuse.json()) as any).error).toBe("invalid_credentials");

    await registerUser("rexp@x.com");
    const rt2 = await tokenOf("rexp@x.com");
    await env.DB.prepare("UPDATE recovery_tokens SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = 'rexp@x.com')")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    const expired = await call("POST", "/v1/recover/finish", finishBody(rt2));
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as any).error).toBe("invalid_credentials");
    expect((await call("POST", "/v1/recover/finish", finishBody("trc_" + "A".repeat(43)))).status).toBe(401);
    expect((await login("rexp@x.com", 1)).status).toBe(200);
  });

  it("concurrent finishes with one token: only one succeeds", async () => {
    await registerUser("rcon@x.com");
    const rt = await tokenOf("rcon@x.com");
    const rs = await Promise.all([0, 1, 2].map(() => call("POST", "/v1/recover/finish", finishBody(rt))));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401, 401]);
  });

  it("finish with the same recovery code is 400", async () => {
    await registerUser("rsame@x.com");
    const rt = await tokenOf("rsame@x.com");
    const r = await call("POST", "/v1/recover/finish", finishBody(rt, { recoveryAuthKey: CODE }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid_request");
    expect((await call("POST", "/v1/recover/finish", finishBody(rt))).status).toBe(200);
  });
});
