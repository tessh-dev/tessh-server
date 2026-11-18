import { beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/http.ts";
import {
  confirmTotp,
  createOwner,
  createOwnerSession,
  disableTotp,
  endOtherSessions,
  hashPassword,
  listOwnerSessions,
  requireOwner,
  resetOwnerAttempts,
  signIn,
  signOut,
  startTotp,
  verifyPassword,
} from "../src/owner.ts";
import { base32Decode, stepAt, totpAt } from "../src/totp.ts";
import { makeEnv } from "./harness.ts";

const PW = "a long enough password";
const EMAIL = "owner@example.com";
const req = (over: { ip?: string; cookie?: string; method?: string; headers?: Record<string, string>; url?: string } = {}) =>
  new Request(over.url ?? "https://keys.test/panel/api/x", {
    method: over.method ?? "GET",
    headers: {
      "x-tessh-client-ip": over.ip ?? "1.1.1.1",
      "user-agent": "TestAgent/1",
      ...(over.cookie ? { cookie: over.cookie } : {}),
      ...over.headers,
    },
  });
const failure = async (p: Promise<unknown>): Promise<HttpError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected an HttpError");
};
const cookieOf = (setCookie: string) => setCookie.split(";")[0];
const setup = async (over = {}) => {
  const env = makeEnv(over);
  await createOwner(env, EMAIL, PW);
  return env;
};
const enrol = async (env: ReturnType<typeof makeEnv>) => {
  const { secret } = await startTotp(env);
  const key = base32Decode(secret);
  const step = stepAt(Date.now());
  await confirmTotp(env, await totpAt(key, step));
  return { key, step };
};

describe("owner login", () => {
  beforeEach(() => resetOwnerAttempts());

  it("hashes with scrypt and verifies", async () => {
    const h = await hashPassword(PW);
    expect(h).toMatch(/^scrypt\$N=32768,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword(PW, h)).toBe(true);
    expect(await verifyPassword("another password!", h)).toBe(false);
    expect(await verifyPassword(PW, "garbage")).toBe(false);
    expect((await failure(hashPassword("short"))).status).toBe(400);
  });

  it("signs in with the right password and sets a strict cookie", async () => {
    const env = await setup();
    const { cookie } = await signIn(env, req(), { email: " Owner@Example.com ", password: PW });
    expect(cookie).toMatch(/^tessh_owner=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).toContain("Secure");
    const row = await env.DB.prepare("SELECT token_hash FROM owner_sessions").first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).not.toContain(row!.token_hash);
  });

  it("omits Secure on a plain http origin", async () => {
    const env = await setup({ PUBLIC_URL: "http://keys.test" });
    const { cookie } = await signIn(env, req(), { email: EMAIL, password: PW });
    expect(cookie).not.toContain("Secure");
  });

  it("gives the same answer for an unknown email and a wrong password", async () => {
    const env = await setup();
    const a = await failure(signIn(env, req(), { email: "nobody@example.com", password: PW }));
    const b = await failure(signIn(env, req(), { email: EMAIL, password: "wrong password here" }));
    const c = await failure(signIn(makeEnv(), req(), { email: EMAIL, password: PW }));
    for (const e of [a, b, c]) {
      expect(e.status).toBe(401);
      expect(e.code).toBe("invalid_credentials");
      expect(e.message).toBe("Wrong email or password");
    }
  });

  it("blocks the 6th bad password from one address, then even the right one", async () => {
    const env = await setup();
    for (let i = 0; i < 5; i++) {
      expect((await failure(signIn(env, req({ ip: "9.9.9.9" }), { email: EMAIL, password: "wrong password here" }))).status).toBe(401);
    }
    const e = await failure(signIn(env, req({ ip: "9.9.9.9" }), { email: EMAIL, password: "wrong password here" }));
    expect(e.status).toBe(429);
    expect((await failure(signIn(env, req({ ip: "9.9.9.9" }), { email: EMAIL, password: PW }))).status).toBe(429);
    await expect(signIn(env, req({ ip: "8.8.8.8" }), { email: EMAIL, password: PW })).resolves.toBeTruthy();
  });

  it("requires an authenticator code once enrolled, and refuses a replayed step", async () => {
    const env = await setup();
    const { cookie: first } = await signIn(env, req(), { email: EMAIL, password: PW });
    await requireOwner(env, req({ cookie: cookieOf(first) }));
    const { key, step } = await enrol(env);
    // The code used to confirm can't be used again.
    expect((await failure(signIn(env, req(), { email: EMAIL, password: PW, code: await totpAt(key, step) }))).status).toBe(401);
    const missing = await failure(signIn(env, req(), { email: EMAIL, password: PW }));
    expect(missing.status).toBe(401);
    expect(missing.code).toBe("code_required");
    expect((await failure(signIn(env, req(), { email: EMAIL, password: PW, code: "000000" }))).code).toBe("invalid_code");
    const code = await totpAt(key, step + 1);
    await expect(signIn(env, req(), { email: EMAIL, password: PW, code })).resolves.toBeTruthy();
    expect((await failure(signIn(env, req(), { email: EMAIL, password: PW, code }))).status).toBe(401);
  });

  it("keeps the secret sealed and builds the otpauth link", async () => {
    const env = await setup();
    const { secret, uri } = await startTotp(env);
    expect(uri).toBe(`otpauth://totp/Tessh%20Server:owner%40example.com?secret=${secret}&issuer=Tessh%20Server`);
    await confirmTotp(env, await totpAt(base32Decode(secret), stepAt(Date.now())));
    const row = await env.DB.prepare("SELECT totp_secret FROM owner").first<{ totp_secret: Uint8Array }>();
    expect(row!.totp_secret.length).toBe(12 + 20 + 16);
    expect(env.OWNER_TOTP_PENDING).toBeNull();
    expect((await failure(startTotp(env))).status).toBe(409);
  });

  it("rejects a wrong or expired enrolment code", async () => {
    const env = await setup();
    expect((await failure(confirmTotp(env, "123456"))).code).toBe("two_step_not_pending");
    const { secret } = await startTotp(env);
    expect((await failure(confirmTotp(env, "abcdef"))).status).toBe(401);
    env.OWNER_TOTP_PENDING!.expiresAt = Date.now() - 1;
    expect((await failure(confirmTotp(env, await totpAt(base32Decode(secret), stepAt(Date.now()))))).code).toBe("two_step_not_pending");
  });

  it("turns the authenticator off only with the password", async () => {
    const env = await setup();
    await enrol(env);
    expect((await failure(disableTotp(env, "wrong password here"))).status).toBe(401);
    await disableTotp(env, PW);
    await expect(signIn(env, req(), { email: EMAIL, password: PW })).resolves.toBeTruthy();
  });

  it("only accepts writes with the panel header and a same-origin Origin", async () => {
    const env = await setup();
    const cookie = cookieOf((await signIn(env, req(), { email: EMAIL, password: PW })).cookie);
    const post = (headers: Record<string, string> = {}) => req({ method: "POST", cookie, headers });
    expect((await failure(requireOwner(env, post()))).code).toBe("forbidden");
    expect((await failure(requireOwner(env, post({ "x-tessh-owner": "1", origin: "https://evil.test" })))).status).toBe(403);
    await expect(requireOwner(env, post({ "x-tessh-owner": "1" }))).resolves.toBeTruthy();
    await expect(requireOwner(env, post({ "x-tessh-owner": "1", origin: "https://keys.test" }))).resolves.toBeTruthy();
    await expect(requireOwner(env, req({ cookie }))).resolves.toBeTruthy();
  });

  it("refuses a missing, wrong or idle-expired session", async () => {
    const env = await setup();
    expect((await failure(requireOwner(env, req()))).status).toBe(401);
    expect((await failure(requireOwner(env, req({ cookie: "tessh_owner=nope" })))).code).toBe("unauthorized");
    const cookie = cookieOf((await signIn(env, req(), { email: EMAIL, password: PW })).cookie);
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    await env.DB.prepare("UPDATE owner_sessions SET last_seen_at = ?").bind(old).run();
    expect((await failure(requireOwner(env, req({ cookie })))).status).toBe(401);
  });

  it("touches last_seen_at at most once a minute", async () => {
    const env = await setup();
    const cookie = cookieOf((await signIn(env, req(), { email: EMAIL, password: PW })).cookie);
    const seen = () => env.DB.prepare("SELECT last_seen_at AS t FROM owner_sessions").first<{ t: string }>().then((r) => r!.t);
    const t0 = await seen();
    await requireOwner(env, req({ cookie }));
    expect(await seen()).toBe(t0);
    const stale = new Date(Date.now() - 120_000).toISOString();
    await env.DB.prepare("UPDATE owner_sessions SET last_seen_at = ?").bind(stale).run();
    await requireOwner(env, req({ cookie }));
    expect(await seen()).not.toBe(stale);
  });

  it("lists sessions without hashes, ends the others, signs out", async () => {
    const env = await setup();
    const a = cookieOf(await createOwnerSession(env, req({ ip: "2.2.2.2" })));
    const b = cookieOf(await createOwnerSession(env, req({ ip: "3.3.3.3" })));
    const me = await requireOwner(env, req({ cookie: a }));
    const list = await listOwnerSessions(env, me.tokenHash);
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/[0-9a-f]{64}/);
    await endOtherSessions(env, me.tokenHash);
    await expect(requireOwner(env, req({ cookie: a }))).resolves.toBeTruthy();
    expect((await failure(requireOwner(env, req({ cookie: b })))).status).toBe(401);
    expect(await signOut(env, req({ cookie: a }))).toContain("Max-Age=0");
    expect((await failure(requireOwner(env, req({ cookie: a })))).status).toBe(401);
  });

  it("creates the owner once; only an owner-scope setup code replaces it", async () => {
    const env = await setup();
    await enrol(env);
    await createOwnerSession(env, req());
    expect((await failure(createOwner(env, "x@example.com", PW))).status).toBe(409);
    env.SETUP = { hash: "x", expiresAt: Date.now() - 1, scope: "owner" };
    expect((await failure(createOwner(env, "x@example.com", PW))).status).toBe(409);
    env.SETUP = { hash: "x", expiresAt: Date.now() + 1000, scope: "owner" };
    await createOwner(env, "New@Example.com", "another long password");
    const row = await env.DB.prepare("SELECT email, totp_secret FROM owner").first<{ email: string; totp_secret: unknown }>();
    expect(row).toEqual({ email: "new@example.com", totp_secret: null });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM owner_sessions").first<{ n: number }>())!.n).toBe(0);
    await expect(signIn(env, req(), { email: "new@example.com", password: "another long password" })).resolves.toBeTruthy();
  });

  it("validates the owner's email and password", async () => {
    const env = makeEnv();
    expect((await failure(createOwner(env, "not-an-email", PW))).status).toBe(400);
    expect((await failure(createOwner(env, EMAIL, "short"))).status).toBe(400);
  });
});
