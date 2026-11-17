import type { Statement, Value } from "./db.ts";
import { authenticate, isGuardFailure, sha256Hex } from "./auth.ts";
import { invalid, loginSuccess, obj, requireAuthKey } from "./accounts.ts";
import { HttpError, json, readJSON } from "./http.ts";
import type { Env } from "./index.ts";
import { backupCodeHash, base32Encode, matchStep, newBackupCode, normaliseBackupCode, open, seal } from "./totp.ts";

const PENDING_TTL_MS = 15 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_ATTEMPTS = 5;
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60_000;
const BACKUP_COUNT = 8;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

type Factor = { kind: "code"; value: string } | { kind: "backup"; value: string };

const badCode = (extra?: Record<string, unknown>) => new HttpError("invalid_code", 401, "Invalid code", extra);
const badChallenge = () => new HttpError("invalid_challenge", 401, "Invalid or expired sign-in challenge");
const notEnabled = () => new HttpError("two_step_not_enabled", 409, "Two-step sign-in is off");

function bytesOf(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error("Unexpected blob type");
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const backupHash = (env: Env, userId: string, canonical: string) => backupCodeHash(env.TOTP_KEY, userId, canonical);

/** Batch statement that aborts the whole batch (CHECK on quota_guard) unless `sql` (an EXISTS subquery) holds. */
const guard = (env: Env, exists: string, ...args: Value[]) =>
  env.DB.prepare(`INSERT INTO quota_guard (ok) SELECT 0 WHERE NOT EXISTS (${exists})`).bind(...args);

/** `{code}` or `{backup_code}`, exactly one. Null when neither is present. Malformed is 400. */
export function parseFactor(b: Record<string, unknown>, allowBackup = true): Factor | null {
  const hasCode = b.code !== undefined && b.code !== null;
  const hasBackup = b.backup_code !== undefined && b.backup_code !== null;
  if (hasCode && hasBackup) throw invalid("Send code or backup_code, not both");
  if (hasCode) {
    const c = typeof b.code === "string" ? b.code.replace(/\s/g, "") : "";
    if (!/^\d{6}$/.test(c)) throw invalid("Invalid code");
    return { kind: "code", value: c };
  }
  if (hasBackup) {
    if (!allowBackup) throw invalid("A backup code can't be used here");
    const c = typeof b.backup_code === "string" ? normaliseBackupCode(b.backup_code) : null;
    if (!c) throw invalid("Invalid backup_code");
    return { kind: "backup", value: c };
  }
  return null;
}

export async function isEnabled(env: Env, userId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM totp WHERE user_id = ? AND enabled = 1").bind(userId).first());
}

export async function twoStepView(env: Env, userId: string): Promise<{ enabled: boolean; backup_codes_left: number }> {
  if (!(await isEnabled(env, userId))) return { enabled: false, backup_codes_left: 0 };
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NULL")
    .bind(userId)
    .first<{ n: number }>();
  return { enabled: true, backup_codes_left: n?.n ?? 0 };
}

/**
 * Records a second-factor attempt for the account, but only while it is under the limit: the conditional INSERT is one
 * statement, so concurrent guesses cannot all slip under it, and a blocked account gets 429 without extending its own
 * block. A success clears the rows.
 */
async function countAttempt(env: Env, userId: string): Promise<void> {
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - WINDOW_MS).toISOString();
  await env.DB.prepare("DELETE FROM two_step_failures WHERE at < ?").bind(cutoff).run();
  const r = await env.DB.prepare(
    `INSERT INTO two_step_failures (user_id, at) SELECT ?, ?
     WHERE (SELECT COUNT(*) FROM two_step_failures WHERE user_id = ? AND at >= ?) < ?`,
  )
    .bind(userId, new Date(nowMs).toISOString(), userId, cutoff, MAX_FAILURES)
    .run();
  if (r.meta.changes === 1) return;
  // Blocked: the next attempt is allowed once the oldest row in the window ages out.
  const row = await env.DB.prepare("SELECT at FROM two_step_failures WHERE user_id = ? AND at >= ? ORDER BY at ASC LIMIT 1")
    .bind(userId, cutoff)
    .first<{ at: string }>();
  const wait = row ? Math.ceil((Date.parse(row.at) + WINDOW_MS - nowMs) / 1000) : WINDOW_MS / 1000;
  throw new HttpError("rate_limited", 429, "Too many attempts, try again later", undefined, {
    "retry-after": String(Math.max(1, wait)),
  });
}

const clearFailures = (env: Env, userId: string) => env.DB.prepare("DELETE FROM two_step_failures WHERE user_id = ?").bind(userId);

/**
 * Checks the factor without spending it. When it is good, returns the statements that spend it: a guard (aborts the batch
 * if a concurrent request spent it first) and the write. Run them in one batch, alone or with other work.
 */
async function factorStatements(env: Env, userId: string, f: Factor): Promise<Statement[] | null> {
  if (f.kind === "backup") {
    const hash = await backupHash(env, userId, f.value);
    const live = "SELECT 1 FROM backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL";
    if (!(await env.DB.prepare(live).bind(userId, hash).first())) return null;
    return [
      guard(env, live, userId, hash),
      env.DB.prepare("UPDATE backup_codes SET used_at = ? WHERE user_id = ? AND code_hash = ?").bind(new Date().toISOString(), userId, hash),
    ];
  }
  const row = await env.DB.prepare("SELECT secret_enc, last_step FROM totp WHERE user_id = ? AND enabled = 1")
    .bind(userId)
    .first<{ secret_enc: unknown; last_step: number | null }>();
  if (!row || !row.secret_enc) return null;
  const secret = await open(env.TOTP_KEY, userId, bytesOf(row.secret_enc));
  const step = await matchStep(secret, f.value, Date.now(), row.last_step);
  if (step === null) return null;
  // Two concurrent requests with the same code cannot both pass this guard.
  return [
    guard(env, "SELECT 1 FROM totp WHERE user_id = ? AND enabled = 1 AND (last_step IS NULL OR last_step < ?)", userId, step),
    env.DB.prepare("UPDATE totp SET last_step = ?, updated_at = ? WHERE user_id = ?").bind(step, new Date().toISOString(), userId),
  ];
}

/** Checks and consumes the factor (TOTP step or backup code). True on success. Call countAttempt first. */
async function consume(env: Env, userId: string, f: Factor): Promise<boolean> {
  const stmts = await factorStatements(env, userId, f);
  if (!stmts) return false;
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (isGuardFailure(e)) return false;
    throw e;
  }
  return true;
}

async function verify(env: Env, userId: string, f: Factor): Promise<boolean> {
  await countAttempt(env, userId);
  const ok = await consume(env, userId, f);
  if (ok) await clearFailures(env, userId).run();
  return ok;
}

/**
 * For actions gated on two-step (turn off, new backup codes, delete account). No-op when two-step is off,
 * unless `mustBeEnabled`. Missing factor is 403 two_step_required; wrong is 401 invalid_code.
 */
export async function requireSecondFactor(env: Env, userId: string, b: Record<string, unknown>, mustBeEnabled = false): Promise<void> {
  if (!(await isEnabled(env, userId))) {
    if (mustBeEnabled) throw notEnabled();
    return;
  }
  const f = parseFactor(b);
  if (!f) {
    if (mustBeEnabled) throw invalid("code or backup_code is required");
    throw new HttpError("two_step_required", 403, "A two-step code or backup code is required");
  }
  if (!(await verify(env, userId, f))) throw badCode({ attempts_left: await accountAttemptsLeft(env, userId) });
}

/** Second-factor attempts the account has left in the current window before 429. */
async function accountAttemptsLeft(env: Env, userId: string): Promise<number> {
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM two_step_failures WHERE user_id = ? AND at >= ?")
    .bind(userId, new Date(Date.now() - WINDOW_MS).toISOString())
    .first<{ n: number }>())?.n ?? 0;
  return Math.max(0, MAX_FAILURES - n);
}

async function backupCodeStatements(env: Env, userId: string): Promise<{ codes: string[]; stmts: Statement[] }> {
  const codes = new Set<string>();
  while (codes.size < BACKUP_COUNT) codes.add(newBackupCode());
  const stmts = [env.DB.prepare("DELETE FROM backup_codes WHERE user_id = ?").bind(userId)];
  for (const c of codes) {
    stmts.push(env.DB.prepare("INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)").bind(userId, await backupHash(env, userId, c)));
  }
  return { codes: [...codes], stmts };
}

async function start(req: Request, env: Env): Promise<Response> {
  const a = await authenticate(req, env);
  // The password too, so a stolen session token alone can't put the account behind an authenticator it controls.
  await requireAuthKey(env, a.userId, obj(await readJSON(req), "body").authKey);
  if (await isEnabled(env, a.userId)) throw new HttpError("two_step_enabled", 409, "Two-step sign-in is already on");
  const u = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(a.userId).first<{ email: string }>();
  if (!u) throw new HttpError("unauthorized", 401, "Missing or invalid token");
  const secret = crypto.getRandomValues(new Uint8Array(20));
  const sealed = await seal(env.TOTP_KEY, a.userId, secret);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const r = await env.DB.prepare(
    `INSERT INTO totp (user_id, enabled, pending_secret_enc, pending_expires_at, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET pending_secret_enc = excluded.pending_secret_enc,
       pending_expires_at = excluded.pending_expires_at, updated_at = excluded.updated_at WHERE totp.enabled = 0`,
  )
    .bind(a.userId, sealed, new Date(nowMs + PENDING_TTL_MS).toISOString(), now, now)
    .run();
  if (r.meta.changes !== 1) throw new HttpError("two_step_enabled", 409, "Two-step sign-in is already on");
  const b32 = base32Encode(secret);
  return json({
    secret_base32: b32,
    otpauth_uri: `otpauth://totp/Tessh:${encodeURIComponent(u.email)}?secret=${b32}&issuer=Tessh&algorithm=SHA1&digits=6&period=30`,
  });
}

async function confirm(req: Request, env: Env): Promise<Response> {
  const a = await authenticate(req, env);
  const b = obj(await readJSON(req), "body");
  const f = parseFactor(b, false);
  if (!f) throw invalid("code is required");
  const now = new Date().toISOString();
  const row = await env.DB.prepare("SELECT enabled, pending_secret_enc, pending_expires_at FROM totp WHERE user_id = ?")
    .bind(a.userId)
    .first<{ enabled: number; pending_secret_enc: unknown; pending_expires_at: string | null }>();
  if (row?.enabled === 1) throw new HttpError("two_step_enabled", 409, "Two-step sign-in is already on");
  if (!row || !row.pending_secret_enc || !row.pending_expires_at || row.pending_expires_at <= now) {
    throw new HttpError("two_step_not_pending", 409, "No two-step setup in progress, start again");
  }
  await countAttempt(env, a.userId);
  const sealed = bytesOf(row.pending_secret_enc);
  const step = await matchStep(await open(env.TOTP_KEY, a.userId, sealed), f.value, Date.now(), null);
  if (step === null) throw badCode();
  const { codes, stmts } = await backupCodeStatements(env, a.userId);
  try {
    await env.DB.batch([
      // Aborts the batch unless this exact setup is still pending, so a double submit (or a concurrent restart)
      // can't replace the winner's backup codes.
      guard(env, "SELECT 1 FROM totp WHERE user_id = ? AND enabled = 0 AND pending_secret_enc = ?", a.userId, sealed),
      env.DB.prepare(
        `UPDATE totp SET secret_enc = pending_secret_enc, enabled = 1, last_step = ?, pending_secret_enc = NULL,
           pending_expires_at = NULL, updated_at = ? WHERE user_id = ?`,
      ).bind(step, now, a.userId),
      ...stmts,
      clearFailures(env, a.userId),
    ]);
  } catch (e) {
    if (!isGuardFailure(e)) throw e;
    if (await isEnabled(env, a.userId)) throw new HttpError("two_step_enabled", 409, "Two-step sign-in is already on");
    throw new HttpError("two_step_not_pending", 409, "No two-step setup in progress, start again");
  }
  return json({ backup_codes: codes });
}

async function disable(req: Request, env: Env): Promise<Response> {
  const a = await authenticate(req, env);
  const b = obj(await readJSON(req), "body");
  await requireSecondFactor(env, a.userId, b, true);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM totp WHERE user_id = ?").bind(a.userId),
    env.DB.prepare("DELETE FROM backup_codes WHERE user_id = ?").bind(a.userId),
    env.DB.prepare("DELETE FROM login_challenges WHERE user_id = ?").bind(a.userId),
  ]);
  return new Response(null, { status: 204 });
}

async function regenerate(req: Request, env: Env): Promise<Response> {
  const a = await authenticate(req, env);
  const b = obj(await readJSON(req), "body");
  await requireSecondFactor(env, a.userId, b, true);
  const { codes, stmts } = await backupCodeStatements(env, a.userId);
  await env.DB.batch(stmts);
  return json({ backup_codes: codes });
}

/** Called by /v1/login after a correct password when two-step is on. Creates no session. */
export async function issueChallenge(env: Env, userId: string, device: { name: string; platform: string }): Promise<string> {
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM login_challenges WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      "INSERT INTO login_challenges (challenge_hash, user_id, device_name, device_platform, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(await sha256Hex(challenge), userId, device.name, device.platform, now, new Date(nowMs + CHALLENGE_TTL_MS).toISOString()),
  ]);
  return challenge;
}

async function loginTwoStep(req: Request, env: Env): Promise<Response> {
  const b = obj(await readJSON(req), "body");
  if (typeof b.challenge !== "string") throw invalid("Invalid challenge");
  const f = parseFactor(b);
  if (!f) throw invalid("code or backup_code is required");
  if (!CHALLENGE_RE.test(b.challenge)) throw badChallenge();
  const hash = await sha256Hex(b.challenge);
  const now = new Date().toISOString();
  const c = await env.DB.prepare(
    "SELECT user_id, device_name, device_platform FROM login_challenges WHERE challenge_hash = ? AND expires_at > ? AND attempts < ?",
  )
    .bind(hash, now, CHALLENGE_ATTEMPTS)
    .first<{ user_id: string; device_name: string; device_platform: string }>();
  if (!c) throw badChallenge();

  // Account limit first, so a blocked attempt doesn't spend one of the challenge's five.
  await countAttempt(env, c.user_id);
  const bumped = await env.DB.prepare(
    "UPDATE login_challenges SET attempts = attempts + 1 WHERE challenge_hash = ? AND expires_at > ? AND attempts < ? RETURNING attempts",
  )
    .bind(hash, now, CHALLENGE_ATTEMPTS)
    .first<{ attempts: number }>();
  if (!bumped) throw badChallenge();

  const spend = await factorStatements(env, c.user_id, f);
  if (!spend) {
    const left = CHALLENGE_ATTEMPTS - bumped.attempts;
    if (left <= 0) await env.DB.prepare("DELETE FROM login_challenges WHERE challenge_hash = ?").bind(hash).run();
    throw badCode({ attempts_left: left });
  }

  try {
    // One batch: the factor is spent only if the challenge still makes a session, and one challenge makes at most one.
    return await loginSuccess(env, c.user_id, { name: c.device_name, platform: c.device_platform }, [
      guard(env, "SELECT 1 FROM login_challenges WHERE challenge_hash = ? AND expires_at > ?", hash, now),
      ...spend,
      env.DB.prepare("DELETE FROM login_challenges WHERE challenge_hash = ?").bind(hash),
      clearFailures(env, c.user_id),
    ]);
  } catch (e) {
    if (!isGuardFailure(e)) throw e;
    const still = await env.DB.prepare("SELECT attempts FROM login_challenges WHERE challenge_hash = ? AND expires_at > ?")
      .bind(hash, now)
      .first<{ attempts: number }>();
    if (!still) throw badChallenge();
    // The challenge is fine, so the factor was spent by a concurrent request.
    throw badCode({ attempts_left: Math.max(0, CHALLENGE_ATTEMPTS - still.attempts) });
  }
}

/** Returns null when the route is not a two-step route. */
export async function twoStepRoutes(req: Request, env: Env): Promise<Response | null> {
  if (req.method !== "POST") return null;
  switch (new URL(req.url).pathname) {
    case "/v1/account/two-step/start":
      return start(req, env);
    case "/v1/account/two-step/confirm":
      return confirm(req, env);
    case "/v1/account/two-step/disable":
      return disable(req, env);
    case "/v1/account/two-step/backup-codes":
      return regenerate(req, env);
    case "/v1/login/two-step":
      return loginTwoStep(req, env);
  }
  return null;
}
