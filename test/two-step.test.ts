import type { Value } from "../src/db.ts";
import { env } from "./harness.ts";
import { describe, expect, it } from "vitest";
import { KDF, b64, bytes, call, registerUser } from "./helpers.ts";
import {
  base32Decode,
  base32Encode,
  matchStep,
  newBackupCode,
  normaliseBackupCode,
  backupCodeHash,
  open,
  seal,
  stepAt,
  totpAt,
} from "../src/totp.ts";

const enc = new TextEncoder();
const RFC_SECRET = enc.encode("12345678901234567890");
const device = { name: "Mac", platform: "macos" };
const login = (email: string) => call("POST", "/v1/login", { email, authKey: b64(bytes(32, 1)), device });
const two = (body: Record<string, unknown>) => call("POST", "/v1/login/two-step", body);
const count = async (sql: string, ...args: Value[]) =>
  (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;
const PW = { authKey: b64(bytes(32, 1)) };
const startFor = (token: string) => call("POST", "/v1/account/two-step/start", PW, token);
const codeAt = (secret: Uint8Array, offset = 0) => totpAt(secret, stepAt(Date.now()) + offset);
/** Forget the last accepted step so the current code can be used again (tests only). */
const rewind = (userId: string) => env.DB.prepare("UPDATE totp SET last_step = NULL WHERE user_id = ?").bind(userId).run();
const challengeFor = async (email: string) => {
  const r = (await (await login(email)).json()) as any;
  expect(r).toEqual({ two_step_required: true, challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  return r.challenge as string;
};

async function enrol(email: string) {
  const u = await registerUser(email);
  const s = (await (await startFor(u.token)).json()) as any;
  const secret = base32Decode(s.secret_base32);
  const c = await call("POST", "/v1/account/two-step/confirm", { code: await codeAt(secret) }, u.token);
  expect(c.status).toBe(200);
  const backup = ((await c.json()) as any).backup_codes as string[];
  await rewind(u.userId);
  return { ...u, secret, backup };
}

describe("totp primitives", () => {
  it("RFC 6238 SHA-1 vectors (8 digits) and 6-digit truncation", async () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, want] of vectors) {
      expect(await totpAt(RFC_SECRET, Math.floor(t / 30), 8)).toBe(want);
      expect(await totpAt(RFC_SECRET, Math.floor(t / 30))).toBe(want.slice(2));
    }
    expect(await totpAt(RFC_SECRET, 1)).toBe("287082");
  });

  it("window ±1 step, replay refused at or below last step", async () => {
    const now = 59_000; // step 1
    expect(await matchStep(RFC_SECRET, await totpAt(RFC_SECRET, 0), now, null)).toBe(0);
    expect(await matchStep(RFC_SECRET, await totpAt(RFC_SECRET, 1), now, null)).toBe(1);
    expect(await matchStep(RFC_SECRET, await totpAt(RFC_SECRET, 2), now, null)).toBe(2);
    expect(await matchStep(RFC_SECRET, await totpAt(RFC_SECRET, 3), now + 60_000 * 0, null)).toBeNull();
    expect(await matchStep(RFC_SECRET, await totpAt(RFC_SECRET, 1), now + 90_000, null)).toBeNull(); // step 4
    expect(await matchStep(RFC_SECRET, await totpAt(RFC_SECRET, 1), now, 1)).toBeNull();
    expect(await matchStep(RFC_SECRET, await totpAt(RFC_SECRET, 2), now, 1)).toBe(2);
  });

  it("base32 round trip", () => {
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const r = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(r))).toEqual(r);
  });

  it("AES-GCM seal/open round trip; wrong user id (AAD) or key fails", async () => {
    const key = "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=";
    const sealed = await seal(key, "user-a", RFC_SECRET);
    expect(sealed.length).toBe(12 + 20 + 16);
    expect(await open(key, "user-a", sealed)).toEqual(RFC_SECRET);
    await expect(open(key, "user-b", sealed)).rejects.toThrow();
    await expect(open(b64(bytes(32, 9)), "user-a", sealed)).rejects.toThrow();
    await expect(seal(b64(bytes(16)), "u", RFC_SECRET)).rejects.toThrow();
  });

  it("backup codes: format and normalisation", () => {
    for (let i = 0; i < 50; i++) expect(newBackupCode()).toMatch(/^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/);
    expect(normaliseBackupCode(" AB2C-D3EF ")).toBe("ab2c-d3ef");
    expect(normaliseBackupCode("ab2cd3ef")).toBe("ab2c-d3ef");
    expect(normaliseBackupCode("oIlz-zzzz")).toBe("011z-zzzz");
    expect(normaliseBackupCode("abcd-efg")).toBeNull();
    expect(normaliseBackupCode("abcd-efgu")).toBeNull();
  });
});

describe("two-step enrolment", () => {
  it("start → confirm turns it on, secret encrypted at rest, backup codes shown once", async () => {
    const u = await registerUser("en@x.com");
    let acct = (await (await call("GET", "/v1/account", undefined, u.token)).json()) as any;
    expect(acct.two_step).toEqual({ enabled: false, backup_codes_left: 0 });

    expect((await call("POST", "/v1/account/two-step/start", PW)).status).toBe(401);
    // The password is required too: a stolen session token alone can't turn two-step on.
    expect((await call("POST", "/v1/account/two-step/start", undefined, u.token)).status).toBe(400);
    expect((await call("POST", "/v1/account/two-step/start", {}, u.token)).status).toBe(400);
    const wrongPw = await call("POST", "/v1/account/two-step/start", { authKey: b64(bytes(32, 9)) }, u.token);
    expect(wrongPw.status).toBe(401);
    expect(((await wrongPw.json()) as any).error).toBe("invalid_credentials");
    expect(await count("SELECT COUNT(*) AS n FROM totp WHERE user_id = ?", u.userId)).toBe(0);
    const res = await startFor(u.token);
    expect(res.status).toBe(200);
    const s = (await res.json()) as any;
    expect(Object.keys(s).sort()).toEqual(["otpauth_uri", "secret_base32"]);
    expect(s.secret_base32).toMatch(/^[A-Z2-7]{32}$/);
    expect(s.otpauth_uri).toBe(
      `otpauth://totp/Tessh:en%40x.com?secret=${s.secret_base32}&issuer=Tessh&algorithm=SHA1&digits=6&period=30`,
    );
    const secret = base32Decode(s.secret_base32);

    // Pending only: still off, login unchanged.
    acct = (await (await call("GET", "/v1/account", undefined, u.token)).json()) as any;
    expect(acct.two_step.enabled).toBe(false);
    expect(((await (await login("en@x.com")).json()) as any).token).toMatch(/^tsk_/);

    const row = await env.DB.prepare("SELECT pending_secret_enc FROM totp WHERE user_id = ?").bind(u.userId).first<any>();
    const sealed = new Uint8Array(row.pending_secret_enc);
    expect(sealed.length).toBe(48);
    expect(await open(env.TOTP_KEY, u.userId, sealed)).toEqual(secret);

    expect((await call("POST", "/v1/account/two-step/confirm", { code: "12345" }, u.token)).status).toBe(400);
    expect((await call("POST", "/v1/account/two-step/confirm", { backup_code: "abcd-efgh" }, u.token)).status).toBe(400);
    const wrong = await call("POST", "/v1/account/two-step/confirm", { code: await codeAt(secret, 3) }, u.token);
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as any).error).toBe("invalid_code");

    const ok = await call("POST", "/v1/account/two-step/confirm", { code: await codeAt(secret) }, u.token);
    expect(ok.status).toBe(200);
    const codes = ((await ok.json()) as any).backup_codes as string[];
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(/^[0-9a-z]{4}-[0-9a-z]{4}$/);
    const stored = await env.DB.prepare("SELECT code_hash FROM backup_codes WHERE user_id = ?").bind(u.userId).all<any>();
    expect(stored.results.some((r) => codes.includes(r.code_hash))).toBe(false);
    // Keyed hash (HMAC under a key derived from TOTP_KEY), not a plain SHA-256 an offline attacker could brute-force.
    const hashes = stored.results.map((r) => r.code_hash).sort();
    expect(hashes).toEqual((await Promise.all(codes.map((c) => backupCodeHash(env.TOTP_KEY, u.userId, c)))).sort());
    const plain = [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(u.userId + codes[0])))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hashes).not.toContain(plain);

    acct = (await (await call("GET", "/v1/account", undefined, u.token)).json()) as any;
    expect(acct.two_step).toEqual({ enabled: true, backup_codes_left: 8 });
    const t = await env.DB.prepare("SELECT secret_enc, pending_secret_enc, enabled FROM totp WHERE user_id = ?").bind(u.userId).first<any>();
    expect(t.enabled).toBe(1);
    expect(t.pending_secret_enc).toBeNull();
    expect(await open(env.TOTP_KEY, u.userId, new Uint8Array(t.secret_enc))).toEqual(secret);

    const again = await startFor(u.token);
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error).toBe("two_step_enabled");
    expect((await call("POST", "/v1/account/two-step/confirm", { code: await codeAt(secret) }, u.token)).status).toBe(409);
  });

  it("confirm with no setup, or a setup older than 15 minutes, is 409 two_step_not_pending", async () => {
    const u = await registerUser("np@x.com");
    const none = await call("POST", "/v1/account/two-step/confirm", { code: "123456" }, u.token);
    expect(none.status).toBe(409);
    expect(((await none.json()) as any).error).toBe("two_step_not_pending");
    const s = (await (await startFor(u.token)).json()) as any;
    await env.DB.prepare("UPDATE totp SET pending_expires_at = ? WHERE user_id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), u.userId)
      .run();
    const late = await call("POST", "/v1/account/two-step/confirm", { code: await codeAt(base32Decode(s.secret_base32)) }, u.token);
    expect(late.status).toBe(409);
    // Restarting replaces the secret.
    const s2 = (await (await startFor(u.token)).json()) as any;
    expect(s2.secret_base32).not.toBe(s.secret_base32);
    const ok = await call("POST", "/v1/account/two-step/confirm", { code: await codeAt(base32Decode(s2.secret_base32)) }, u.token);
    expect(ok.status).toBe(200);
  });
});

describe("two-step enrolment races", () => {
  it("a double-submitted confirm turns it on once; the losers get 409 and the winner's codes stand", async () => {
    const u = await registerUser("dbl@x.com");
    const s = (await (await startFor(u.token)).json()) as any;
    const code = await codeAt(base32Decode(s.secret_base32));
    const rs = await Promise.all([1, 2, 3].map(() => call("POST", "/v1/account/two-step/confirm", { code }, u.token)));
    const ok = rs.filter((r) => r.status === 200);
    const lost = rs.filter((r) => r.status !== 200);
    expect(ok).toHaveLength(1);
    for (const r of lost) {
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).error).toBe("two_step_enabled");
    }
    const codes = ((await ok[0].json()) as any).backup_codes as string[];
    const stored = await env.DB.prepare("SELECT code_hash FROM backup_codes WHERE user_id = ?").bind(u.userId).all<any>();
    expect(stored.results.map((r) => r.code_hash).sort()).toEqual(
      (await Promise.all(codes.map((c) => backupCodeHash(env.TOTP_KEY, u.userId, c)))).sort(),
    );
    expect((await two({ challenge: await challengeFor("dbl@x.com"), backup_code: codes[0] })).status).toBe(200);
  });

  it("a confirm racing a restart never leaves backup codes without two-step on", async () => {
    const u = await registerUser("rst@x.com");
    const s = (await (await startFor(u.token)).json()) as any;
    const code = await codeAt(base32Decode(s.secret_base32));
    const [c] = await Promise.all([call("POST", "/v1/account/two-step/confirm", { code }, u.token), startFor(u.token)]);
    const on = await count("SELECT COUNT(*) AS n FROM totp WHERE user_id = ? AND enabled = 1", u.userId);
    expect(c.status === 200 ? 1 : 0).toBe(on);
    if (c.status !== 200) {
      expect(c.status).toBe(409);
      expect(await count("SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ?", u.userId)).toBe(0);
    }
  });
});

describe("two-step sign-in", () => {
  it("login returns a challenge and no session; the code finishes it with the normal login body", async () => {
    const u = await enrol("li@x.com");
    const sessions = await count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", u.userId);
    const challenge = await challengeFor("li@x.com");
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", u.userId)).toBe(sessions);
    expect(await count("SELECT COUNT(*) AS n FROM login_challenges WHERE challenge_hash = ?", challenge)).toBe(0);

    const res = await two({ challenge, code: await codeAt(u.secret) });
    expect(res.status).toBe(200);
    const r = (await res.json()) as any;
    expect(Object.keys(r).sort()).toEqual(["account", "deviceId", "encryptedSigningKey", "signerPublicKey", "token", "wrappedVaultKey"]);
    expect(r.account.two_step).toEqual({ enabled: true, backup_codes_left: 8 });
    expect((await call("GET", "/v1/account", undefined, r.token)).status).toBe(200);
    const d = await env.DB.prepare("SELECT name, platform FROM devices WHERE id = ?").bind(r.deviceId).first<any>();
    expect(d).toEqual(device);

    // The challenge is single use.
    await rewind(u.userId);
    const reuse = await two({ challenge, code: await codeAt(u.secret) });
    expect(reuse.status).toBe(401);
    expect(((await reuse.json()) as any).error).toBe("invalid_challenge");
    // Wrong password still 401 invalid_credentials.
    expect((await call("POST", "/v1/login", { email: "li@x.com", authKey: b64(bytes(32, 9)), device })).status).toBe(401);
  });

  it("accepts the previous and next step, refuses ±2 and replays", async () => {
    const u = await enrol("win@x.com");
    for (const off of [-1, 1]) {
      await rewind(u.userId);
      expect((await two({ challenge: await challengeFor("win@x.com"), code: await codeAt(u.secret, off) })).status).toBe(200);
    }
    await rewind(u.userId);
    for (const off of [-2, 2]) {
      expect((await two({ challenge: await challengeFor("win@x.com"), code: await codeAt(u.secret, off) })).status).toBe(401);
    }
    // Replay: the same code twice.
    const code = await codeAt(u.secret);
    expect((await two({ challenge: await challengeFor("win@x.com"), code })).status).toBe(200);
    const replay = await two({ challenge: await challengeFor("win@x.com"), code });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as any).error).toBe("invalid_code");
    // An older step after a newer one is also a replay.
    expect((await two({ challenge: await challengeFor("win@x.com"), code: await codeAt(u.secret, -1) })).status).toBe(401);
  });

  it("backup codes work once, in any case or without the dash", async () => {
    const u = await enrol("bk@x.com");
    const r1 = await two({ challenge: await challengeFor("bk@x.com"), backup_code: u.backup[0].toUpperCase().replace("-", " ") });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as any).account.two_step.backup_codes_left).toBe(7);
    const again = await two({ challenge: await challengeFor("bk@x.com"), backup_code: u.backup[0] });
    expect(again.status).toBe(401);
    expect(((await again.json()) as any).error).toBe("invalid_code");
    // Another account's code is no good here.
    const other = await enrol("bk2@x.com");
    expect((await two({ challenge: await challengeFor("bk@x.com"), backup_code: other.backup[0] })).status).toBe(401);
  });

  it("a backup code isn't spent when its challenge can no longer make a session", async () => {
    const u = await enrol("bs@x.com");
    const challenge = await challengeFor("bs@x.com");
    // Two requests race on one challenge with different backup codes: one session, only the winner's code is spent.
    const rs = await Promise.all([two({ challenge, backup_code: u.backup[0] }), two({ challenge, backup_code: u.backup[1] })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401]);
    const loser = rs.find((r) => r.status === 401)!;
    expect(((await loser.json()) as any).error).toBe("invalid_challenge");
    expect(await count("SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NULL", u.userId)).toBe(7);
    const loserCode = rs[0].status === 401 ? u.backup[0] : u.backup[1];
    expect((await two({ challenge: await challengeFor("bs@x.com"), backup_code: loserCode })).status).toBe(200);
  });

  it("bad requests: both factors, malformed, missing, bad challenge", async () => {
    const u = await enrol("br@x.com");
    const challenge = await challengeFor("br@x.com");
    expect((await two({ challenge, code: "123456", backup_code: u.backup[0] })).status).toBe(400);
    expect((await two({ challenge, code: "12a456" })).status).toBe(400);
    expect((await two({ challenge, code: 123456 })).status).toBe(400);
    expect((await two({ challenge, backup_code: "abc" })).status).toBe(400);
    expect((await two({ challenge })).status).toBe(400);
    expect((await two({ code: "123456" })).status).toBe(400);
    const bad = await two({ challenge: "x".repeat(43), code: "123456" });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as any).error).toBe("invalid_challenge");
    expect((await two({ challenge: "short", code: "123456" })).status).toBe(401);
    // None of these spent an attempt.
    expect((await two({ challenge, code: await codeAt(u.secret) })).status).toBe(200);
  });

  it("five wrong codes use up a challenge", async () => {
    const u = await enrol("at@x.com");
    const challenge = await challengeFor("at@x.com");
    const wrong = await codeAt(u.secret, 5);
    for (let left = 4; left >= 0; left--) {
      const r = await two({ challenge, code: wrong });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "invalid_code", message: "Invalid code", attempts_left: left });
    }
    const gone = await two({ challenge, code: await codeAt(u.secret) });
    expect(gone.status).toBe(401);
    expect(((await gone.json()) as any).error).toBe("invalid_challenge");
    expect(await count("SELECT COUNT(*) AS n FROM login_challenges WHERE user_id = ?", u.userId)).toBe(0);
  });

  it("challenges expire after 5 minutes", async () => {
    const u = await enrol("ex@x.com");
    const challenge = await challengeFor("ex@x.com");
    const exp = await env.DB.prepare("SELECT expires_at FROM login_challenges WHERE user_id = ?").bind(u.userId).first<any>();
    const ttl = Date.parse(exp.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);
    await env.DB.prepare("UPDATE login_challenges SET expires_at = ? WHERE user_id = ?")
      .bind(new Date(Date.now() - 1).toISOString(), u.userId)
      .run();
    const r = await two({ challenge, code: await codeAt(u.secret) });
    expect(r.status).toBe(401);
    expect(((await r.json()) as any).error).toBe("invalid_challenge");
  });

  it("more than 10 second-factor attempts in 15 minutes is 429 with Retry-After, even with the right code", async () => {
    const u = await enrol("rl@x.com");
    const wrong = await codeAt(u.secret, 5);
    for (let i = 0; i < 2; i++) {
      const challenge = await challengeFor("rl@x.com");
      for (let j = 0; j < 5; j++) expect((await two({ challenge, code: wrong })).status).toBe(401);
    }
    const blocked = await two({ challenge: await challengeFor("rl@x.com"), code: await codeAt(u.secret) });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as any).error).toBe("rate_limited");
    const ra = Number(blocked.headers.get("retry-after"));
    expect(ra).toBeGreaterThan(0);
    expect(ra).toBeLessThanOrEqual(900);
    // Attempts while blocked are refused without adding rows, so they don't extend the block.
    const newest = async () => (await env.DB.prepare("SELECT MAX(at) AS at FROM two_step_failures WHERE user_id = ?").bind(u.userId).first<any>()).at;
    expect(await count("SELECT COUNT(*) AS n FROM two_step_failures WHERE user_id = ?", u.userId)).toBe(10);
    const before = await newest();
    for (let i = 0; i < 3; i++) expect((await two({ challenge: await challengeFor("rl@x.com"), code: wrong })).status).toBe(429);
    expect(await count("SELECT COUNT(*) AS n FROM two_step_failures WHERE user_id = ?", u.userId)).toBe(10);
    expect(await newest()).toBe(before);
    // Session endpoints share the account limit.
    const s = (await (await login("rl@x.com")).json()) as any;
    expect(s.two_step_required).toBe(true);
    expect((await call("POST", "/v1/account/two-step/disable", { code: await codeAt(u.secret) }, u.token)).status).toBe(429);

    // Old failures age out, and a success clears the account's rows.
    await env.DB.prepare("UPDATE two_step_failures SET at = ? WHERE user_id = ?")
      .bind(new Date(Date.now() - 16 * 60_000).toISOString(), u.userId)
      .run();
    expect((await two({ challenge: await challengeFor("rl@x.com"), code: await codeAt(u.secret) })).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM two_step_failures WHERE user_id = ?", u.userId)).toBe(0);
  });

  it("recovery resets the password but leaves two-step on", async () => {
    const u = await enrol("rc@x.com");
    const st = (await (await call("POST", "/v1/recover/start", { email: "rc@x.com", recoveryAuthKey: b64(bytes(32, 11)) })).json()) as any;
    await challengeFor("rc@x.com"); // an open challenge, dropped by finish
    const fin = await call("POST", "/v1/recover/finish", {
      recoveryToken: st.recoveryToken,
      authKey: b64(bytes(32, 21)),
      salt: b64(bytes(16, 22)),
      kdf: KDF,
      wrappedVaultKey: b64(bytes(60, 23)),
      recoveryAuthKey: b64(bytes(32, 24)),
      wrappedVaultKeyRecovery: b64(bytes(60, 25)),
      device,
    });
    expect(fin.status).toBe(200);
    expect(((await fin.json()) as any).account.two_step.enabled).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM login_challenges WHERE user_id = ?", u.userId)).toBe(0);
    const l = (await (await call("POST", "/v1/login", { email: "rc@x.com", authKey: b64(bytes(32, 21)), device })).json()) as any;
    expect(l.two_step_required).toBe(true);
    expect(l.token).toBeUndefined();
    expect((await two({ challenge: l.challenge, backup_code: u.backup[1] })).status).toBe(200);
  });
});

describe("two-step management", () => {
  it("new backup codes need a code, replace the old ones, and spend the backup code used", async () => {
    const u = await enrol("rg@x.com");
    expect((await call("POST", "/v1/account/two-step/backup-codes", {}, u.token)).status).toBe(400);
    expect((await call("POST", "/v1/account/two-step/backup-codes", { code: await codeAt(u.secret, 5) }, u.token)).status).toBe(401);
    const r = await call("POST", "/v1/account/two-step/backup-codes", { backup_code: u.backup[0] }, u.token);
    expect(r.status).toBe(200);
    const fresh = ((await r.json()) as any).backup_codes as string[];
    expect(fresh).toHaveLength(8);
    expect(fresh.some((c) => u.backup.includes(c))).toBe(false);
    expect((await (await call("GET", "/v1/account", undefined, u.token)).json() as any).two_step.backup_codes_left).toBe(8);
    expect((await two({ challenge: await challengeFor("rg@x.com"), backup_code: u.backup[1] })).status).toBe(401);
    expect((await two({ challenge: await challengeFor("rg@x.com"), backup_code: fresh[0] })).status).toBe(200);
    const viaCode = await call("POST", "/v1/account/two-step/backup-codes", { code: await codeAt(u.secret) }, u.token);
    expect(viaCode.status).toBe(200);
  });

  it("turning off needs a code; afterwards login is password only", async () => {
    const u = await enrol("off@x.com");
    expect((await call("POST", "/v1/account/two-step/disable", {}, u.token)).status).toBe(400);
    const wrong = await call("POST", "/v1/account/two-step/disable", { backup_code: "zzzz-zzzz" }, u.token);
    expect(wrong.status).toBe(401);
    // attempts_left here is the account's second-factor budget (10 per 15 minutes), not a challenge's.
    expect(await wrong.json()).toEqual({ error: "invalid_code", message: "Invalid code", attempts_left: 9 });
    const wrong2 = await call("POST", "/v1/account/two-step/disable", { code: await codeAt(u.secret, 5) }, u.token);
    expect(((await wrong2.json()) as any).attempts_left).toBe(8);
    const pending = await challengeFor("off@x.com");
    expect((await call("POST", "/v1/account/two-step/disable", { code: await codeAt(u.secret) }, u.token)).status).toBe(204);
    expect(await count("SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ?", u.userId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM totp WHERE user_id = ?", u.userId)).toBe(0);
    expect((await two({ challenge: pending, backup_code: u.backup[0] })).status).toBe(401);
    expect(((await (await login("off@x.com")).json()) as any).token).toMatch(/^tsk_/);
    const off = await call("POST", "/v1/account/two-step/disable", { code: "123456" }, u.token);
    expect(off.status).toBe(409);
    expect(((await off.json()) as any).error).toBe("two_step_not_enabled");
    expect((await call("POST", "/v1/account/two-step/backup-codes", { code: "123456" }, u.token)).status).toBe(409);
  });

  it("deleting the account needs a code when two-step is on", async () => {
    const u = await enrol("del@x.com");
    const authKey = b64(bytes(32, 1));
    const missing = await call("DELETE", "/v1/account", { authKey }, u.token);
    expect(missing.status).toBe(403);
    expect(((await missing.json()) as any).error).toBe("two_step_required");
    expect((await call("DELETE", "/v1/account", { authKey, code: await codeAt(u.secret, 5) }, u.token)).status).toBe(401);
    expect((await call("DELETE", "/v1/account", { authKey: b64(bytes(32, 9)), code: await codeAt(u.secret) }, u.token)).status).toBe(401);
    expect((await call("DELETE", "/v1/account", { authKey, code: await codeAt(u.secret) }, u.token)).status).toBe(204);
    for (const t of ["totp", "backup_codes", "login_challenges", "two_step_failures"]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, u.userId)).toBe(0);
    }

    // Recovery-token delete too; a missing or wrong code does not consume the token.
    const v = await enrol("del2@x.com");
    const st = (await (await call("POST", "/v1/recover/start", { email: "del2@x.com", recoveryAuthKey: b64(bytes(32, 11)) })).json()) as any;
    expect((await call("DELETE", "/v1/account", { recoveryToken: st.recoveryToken })).status).toBe(403);
    expect((await call("DELETE", "/v1/account", { recoveryToken: st.recoveryToken, backup_code: "zzzz-zzzz" })).status).toBe(401);
    expect((await call("DELETE", "/v1/account", { recoveryToken: st.recoveryToken, backup_code: v.backup[0] })).status).toBe(204);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?", v.userId)).toBe(0);
  });
});
