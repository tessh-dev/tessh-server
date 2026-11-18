// The owner's web sign-in: a scrypt password, cookie sessions and an optional authenticator app.
// Only hashes are stored: the password hash, and a SHA-256 of each session token.
import { createHash, randomBytes, scrypt, timingSafeEqual as bytesEqual } from "node:crypto";
import { normaliseEmail } from "./accounts.ts";
import { HttpError, clientIP } from "./http.ts";
import type { Env } from "./index.ts";
import { originFor } from "./settings.ts";
import { base32Encode, matchStep, open, seal } from "./totp.ts";

const COOKIE = "tessh_owner";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_MAX_MS = 90 * 24 * 60 * 60 * 1000;
const TOUCH_MS = 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_WRONG = 5;
const MAX_WRONG_ALL = 50;
const MAX_TRACKED = 10_000;
const PENDING_MS = 10 * 60 * 1000;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;
const N = 32768;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
/** scrypt needs 128 * N * r bytes, which is exactly Node's default limit. */
const MAXMEM = 64 * 1024 * 1024;

const WRONG = "Wrong email or password";
const wrongLogin = () => new HttpError("invalid_credentials", 401, WRONG);
const unauthorized = () => new HttpError("unauthorized", 401, "Sign in required");
const invalid = (msg: string) => new HttpError("invalid_request", 400, msg);
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- Passwords ----

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, len, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

function checkPassword(password: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw invalid(`Use at least ${MIN_PASSWORD} characters for the password`);
  if (password.length > MAX_PASSWORD) throw invalid("That password is too long");
  return password;
}

/** `scrypt$N=32768,r=8,p=1$<salt b64>$<hash b64>`. */
export async function hashPassword(password: string): Promise<string> {
  checkPassword(password);
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, N, R, P, KEY_LEN);
  return `scrypt$N=${N},r=${R},p=${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored);
  if (!m || typeof password !== "string" || password.length > MAX_PASSWORD) return false;
  const [n, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Only the cost this server writes; a tampered row can't ask for unbounded memory.
  if (n !== N || r !== R || p !== P) return false;
  const want = Buffer.from(m[5], "base64");
  if (want.length !== KEY_LEN) return false;
  const got = await derive(password, Buffer.from(m[4], "base64"), n, r, p, want.length);
  return bytesEqual(got, want);
}

/** A valid hash nobody knows the password to, so an unknown email costs the same time as a wrong password. */
const dummyHash: Promise<string> = hashPassword(randomBytes(24).toString("base64"));
dummyHash.catch(() => {});

// ---- Failed sign-in limits ----

const attempts = new Map<string, { count: number; since: number }>();
let global = { count: 0, since: 0 };

/** Forgets every address's failed tries. */
export function resetOwnerAttempts(): void {
  attempts.clear();
  global = { count: 0, since: 0 };
}

function prune(now: number): void {
  for (const [ip, a] of attempts) if (now - a.since > WINDOW_MS) attempts.delete(ip);
  while (attempts.size >= MAX_TRACKED) attempts.delete(attempts.keys().next().value as string);
  if (now - global.since > WINDOW_MS) global = { count: 0, since: now };
}

/** The bucket for an address: IPv6 by its /64 prefix, IPv4 (and IPv4-mapped IPv6) as is. */
export function limitKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const zone = ip.split("%")[0];
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/i.exec(zone);
  if (mapped) return mapped[1];
  const [head, tail] = zone.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length !== 8) return ip;
  const g = groups.map((x) => parseInt(x || "0", 16));
  if (g.some(Number.isNaN)) return ip;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return g.slice(0, 4).map((x) => x.toString(16)).join(":") + "::/64";
}

const tooMany = (since: number, now: number) =>
  new HttpError("too_many_attempts", 429, "Too many failed sign-ins. Try again in 15 minutes.", undefined, {
    "retry-after": String(Math.max(1, Math.ceil((WINDOW_MS - (now - since)) / 1000))),
  });

/**
 * Counts an attempt before any await, so concurrent requests can't all slip past the limit. Refunded with `refund`
 * unless the attempt turns out to be a failure. The shared cap only stops addresses that already have a failure in
 * the window, so the owner on a clean address is never locked out by others.
 */
function reserve(key: string, now = Date.now()): () => void {
  prune(now);
  const a = attempts.get(key);
  if (a && a.count >= MAX_WRONG) throw tooMany(a.since, now);
  if (a && global.count >= MAX_WRONG_ALL) throw tooMany(global.since, now);
  global.count++;
  const mine = a ?? { count: 0, since: now };
  mine.count++;
  attempts.set(key, mine);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (global.count > 0) global.count--;
    const cur = attempts.get(key);
    if (cur === mine && --cur.count <= 0) attempts.delete(key);
  };
}

// ---- The owner ----

interface OwnerRow {
  email: string;
  password_hash: string;
  totp_secret: Uint8Array | null;
  totp_last_step: number | null;
}

const loadOwner = (env: Env) =>
  env.DB.prepare("SELECT email, password_hash, totp_secret, totp_last_step FROM owner WHERE id = 1").first<OwnerRow>();

/** Makes the owner. Only when there is none, or while an owner-scope setup code is live (then it resets the password, the authenticator and every session). */
export async function createOwner(env: Env, email: string, password: string): Promise<void> {
  const e = normaliseEmail(email);
  checkPassword(password);
  const existing = await env.DB.prepare("SELECT 1 FROM owner WHERE id = 1").first();
  const reset = env.SETUP?.scope === "owner" && Date.now() <= env.SETUP.expiresAt;
  if (existing && !reset) throw new HttpError("conflict", 409, "This server already has an owner");
  const hash = await hashPassword(password);
  const now = new Date().toISOString();
  try {
    if (existing) {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE owner SET email = ?, password_hash = ?, totp_secret = NULL, totp_last_step = NULL, updated_at = ? WHERE id = 1",
        ).bind(e, hash, now),
        env.DB.prepare("DELETE FROM owner_sessions"),
      ]);
    } else {
      // A concurrent first sign-up hits the primary key and fails here.
      await env.DB.prepare(
        "INSERT INTO owner (id, email, password_hash, totp_secret, totp_last_step, created_at, updated_at) VALUES (1, ?, ?, NULL, NULL, ?, ?)",
      )
        .bind(e, hash, now, now)
        .run();
    }
  } catch (err) {
    if (!existing && err instanceof Error && /UNIQUE constraint|PRIMARY KEY/i.test(err.message)) {
      throw new HttpError("conflict", 409, "This server already has an owner");
    }
    throw err;
  }
  env.OWNER_TOTP_PENDING = null;
}

// ---- Authenticator ----

/** The link an authenticator app takes; `account` is the name it shows under "Tessh Server". */
export const totpURI = (account: string, secretB32: string): string =>
  `otpauth://totp/Tessh%20Server:${encodeURIComponent(account)}?secret=${secretB32}&issuer=Tessh%20Server`;

/** Starts enrolling an authenticator. Held in memory until `confirmTotp` or ten minutes pass. */
export async function startTotp(env: Env): Promise<{ secret: string; uri: string }> {
  const owner = await loadOwner(env);
  if (!owner) throw unauthorized();
  if (owner.totp_secret) throw new HttpError("two_step_enabled", 409, "The authenticator is already on");
  const secret = randomBytes(20);
  env.OWNER_TOTP_PENDING = { secret, expiresAt: Date.now() + PENDING_MS };
  const b32 = base32Encode(secret);
  return { secret: b32, uri: totpURI(owner.email, b32) };
}

/** With `req`, wrong codes count against that address like wrong passwords do. */
export async function confirmTotp(env: Env, code: string, req?: Request): Promise<void> {
  const pending = env.OWNER_TOTP_PENDING;
  if (!pending || Date.now() > pending.expiresAt) {
    env.OWNER_TOTP_PENDING = null;
    throw new HttpError("two_step_not_pending", 409, "No authenticator setup in progress, start again");
  }
  const refund = req ? reserve(limitKey(clientIP(req))) : () => {};
  let step: number | null;
  try {
    step = typeof code === "string" ? await matchStep(pending.secret, code.replace(/\s/g, ""), Date.now(), null) : null;
  } catch (e) {
    refund();
    throw e;
  }
  if (step === null) throw new HttpError("invalid_code", 401, "Invalid code");
  refund();
  const sealed = await seal(env.TOTP_KEY, "owner", pending.secret);
  const r = await env.DB.prepare("UPDATE owner SET totp_secret = ?, totp_last_step = ?, updated_at = ? WHERE id = 1 AND totp_secret IS NULL")
    .bind(sealed, step, new Date().toISOString())
    .run();
  env.OWNER_TOTP_PENDING = null;
  if (r.meta.changes !== 1) throw new HttpError("two_step_enabled", 409, "The authenticator is already on");
}

export async function disableTotp(env: Env, req: Request, password: string): Promise<void> {
  const refund = reserve(limitKey(clientIP(req)));
  let failed = false;
  try {
    const owner = await loadOwner(env);
    if (!owner) throw unauthorized();
    if (!(await verifyPassword(password, owner.password_hash))) {
      failed = true;
      throw new HttpError("invalid_credentials", 401, "Wrong password");
    }
  } finally {
    if (!failed) refund();
  }
  await env.DB.prepare("UPDATE owner SET totp_secret = NULL, totp_last_step = NULL, updated_at = ? WHERE id = 1").bind(new Date().toISOString()).run();
}

/** Changes the owner password after checking the current one, and ends every other session. */
export async function changeOwnerPassword(env: Env, req: Request, keepHash: string, current: string, next: string): Promise<void> {
  checkPassword(next);
  const refund = reserve(limitKey(clientIP(req)));
  let failed = false;
  try {
    const owner = await loadOwner(env);
    if (!owner) throw unauthorized();
    if (!(await verifyPassword(current, owner.password_hash))) {
      failed = true;
      throw new HttpError("invalid_credentials", 401, "Wrong password");
    }
  } finally {
    if (!failed) refund();
  }
  const hash = await hashPassword(next);
  await env.DB.batch([
    env.DB.prepare("UPDATE owner SET password_hash = ?, updated_at = ? WHERE id = 1").bind(hash, new Date().toISOString()),
    env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash != ?").bind(keepHash),
  ]);
}

/** The owner's email and whether the authenticator is on; null before setup made an owner. */
export async function ownerInfo(env: Env): Promise<{ email: string; totp: boolean } | null> {
  const o = await loadOwner(env);
  return o ? { email: o.email, totp: o.totp_secret !== null } : null;
}

// ---- Sessions ----

const cookieValue = (token: string, secure: boolean, maxAge: number) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
const isSecure = (req: Request, env: Env) => originFor(req, env).startsWith("https:");

function tokenOf(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/** Starts a session and returns the `Set-Cookie` value. */
export async function createOwnerSession(env: Env, req: Request): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM owner_sessions WHERE last_seen_at < ? OR created_at < ?").bind(
      new Date(Date.now() - SESSION_MS).toISOString(),
      new Date(Date.now() - SESSION_MAX_MS).toISOString(),
    ),
    env.DB.prepare("INSERT INTO owner_sessions (token_hash, created_at, last_seen_at, ip, agent) VALUES (?, ?, ?, ?, ?)").bind(
      sha256hex(token),
      now,
      now,
      clientIP(req),
      (req.headers.get("user-agent") ?? "").slice(0, 200),
    ),
  ]);
  return cookieValue(token, isSecure(req, env), SESSION_MS / 1000);
}

export async function signIn(env: Env, req: Request, input: { email: unknown; password: unknown; code?: unknown }): Promise<{ cookie: string }> {
  const now = Date.now();
  const refund = reserve(limitKey(clientIP(req)), now);
  let failed = false;
  const fail = (e: HttpError): never => {
    failed = true;
    throw e;
  };
  try {
    let email: string | null = null;
    try {
      email = normaliseEmail(input.email);
    } catch {
      email = null;
    }
    const owner = await loadOwner(env);
    const known = owner !== null && email !== null && email === owner.email;
    // Always one scrypt run, against a dummy hash when the email isn't the owner's.
    const passwordOK = await verifyPassword(typeof input.password === "string" ? input.password : "", known ? owner.password_hash : await dummyHash);
    if (!known || !passwordOK) return fail(wrongLogin());

    if (owner.totp_secret) {
      const code = typeof input.code === "string" ? input.code.replace(/\s/g, "") : "";
      // Not a failure: the password was right, the page just has to ask for the code.
      if (!code) throw new HttpError("code_required", 401, "Enter the code from your authenticator");
      const secret = await open(env.TOTP_KEY, "owner", owner.totp_secret);
      const step = await matchStep(secret, code, now, owner.totp_last_step);
      // The step only moves forward, and the update is conditional, so two requests can't both use one code.
      const used =
        step === null
          ? null
          : await env.DB.prepare("UPDATE owner SET totp_last_step = ? WHERE id = 1 AND (totp_last_step IS NULL OR totp_last_step < ?)").bind(step, step).run();
      if (used === null || used.meta.changes !== 1) return fail(new HttpError("invalid_code", 401, "Invalid code"));
    }
    return { cookie: await createOwnerSession(env, req) };
  } finally {
    if (!failed) refund();
  }
}

/**
 * A write from the panel or setup pages: the custom header (which a cross-site form can't send) and, when the browser
 * sends one, an Origin from `origins` or the request's own origin. Accepting its own origin keeps the owner able to
 * sign in and fix a mistyped saved address from the address they are really on; either way it is same-origin.
 */
export function checkWrite(req: Request, origins: string[]): void {
  const origin = req.headers.get("origin");
  const allowed = [...origins, new URL(req.url).origin];
  if (req.headers.get("x-tessh-owner") !== "1" || (origin !== null && !allowed.includes(origin))) {
    throw new HttpError("forbidden", 403, "Request not allowed");
  }
}

/** Throws unless the request carries a live owner session. Writes also need the panel header and a same-origin Origin. */
export async function requireOwner(env: Env, req: Request): Promise<{ tokenHash: string }> {
  const token = tokenOf(req);
  if (!token) throw unauthorized();
  const tokenHash = sha256hex(token);
  const row = await env.DB.prepare("SELECT last_seen_at, created_at FROM owner_sessions WHERE token_hash = ?").bind(tokenHash).first<{ last_seen_at: string; created_at: string }>();
  const now = Date.now();
  const seen = row ? Date.parse(row.last_seen_at) : NaN;
  if (!row || !(now - seen < SESSION_MS) || !(now - Date.parse(row.created_at) < SESSION_MAX_MS)) {
    if (row) await env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash = ?").bind(tokenHash).run();
    throw unauthorized();
  }
  if (req.method !== "GET" && req.method !== "HEAD") checkWrite(req, [new URL(originFor(req, env)).origin]);
  if (now - seen >= TOUCH_MS) {
    await env.DB.prepare("UPDATE owner_sessions SET last_seen_at = ? WHERE token_hash = ?").bind(new Date(now).toISOString(), tokenHash).run();
  }
  return { tokenHash };
}

export interface OwnerSessionInfo {
  created_at: string;
  last_seen_at: string;
  ip: string;
  agent: string;
  current: boolean;
}

/** Signed-in browsers, newest first. Never includes the token hashes. */
export async function listOwnerSessions(env: Env, currentHash: string): Promise<OwnerSessionInfo[]> {
  const rows = await env.DB.prepare("SELECT token_hash, created_at, last_seen_at, ip, agent FROM owner_sessions ORDER BY last_seen_at DESC")
    .all<{ token_hash: string; created_at: string; last_seen_at: string; ip: string; agent: string }>();
  return rows.results.map((r) => ({ created_at: r.created_at, last_seen_at: r.last_seen_at, ip: r.ip, agent: r.agent, current: r.token_hash === currentHash }));
}

/** Ends every session except `keepHash`. Returns how many ended. */
export async function endOtherSessions(env: Env, keepHash: string): Promise<number> {
  const r = await env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash != ?").bind(keepHash).run();
  return r.meta.changes;
}

/** Ends this browser's session and returns a `Set-Cookie` value that clears the cookie. */
export async function signOut(env: Env, req: Request): Promise<string> {
  const token = tokenOf(req);
  if (token) await env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash = ?").bind(sha256hex(token)).run();
  return cookieValue("", isSecure(req, env), 0);
}
