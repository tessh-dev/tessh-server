import type { Statement } from "./db.ts";
import {
  RECOVERY_TOKEN_RE,
  authenticate,
  decodeBase64,
  encodeBase64,
  isGuardFailure,
  newToken,
  recoveryTokenGuard,
  sha256Hex,
  timingSafeEqualHex,
} from "./auth.ts";
import { HttpError, json, readJSON } from "./http.ts";
import type { Env } from "./index.ts";
import { DEFAULT_PLAN_SQL, assertCanSignIn, effectiveLimits } from "./limits.ts";
import { issueChallenge, isEnabled, requireSecondFactor, twoStepView } from "./two-step.ts";

const KDF = { alg: "argon2id", opslimit: 3, memlimit: 67_108_864 };
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60_000;
const enc = new TextEncoder();

export const invalid = (msg: string) => new HttpError("invalid_request", 400, msg);

export function normaliseEmail(v: unknown): string {
  if (typeof v !== "string") throw invalid("Invalid email");
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw invalid("Invalid email");
  return e;
}

export function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalid(`Invalid ${what}`);
  return v as Record<string, unknown>;
}

export function b64Field(v: unknown, name: string, len?: number): string {
  const d = decodeBase64(v);
  if (!d || d.length === 0 || (len !== undefined && d.length !== len)) throw invalid(`Invalid ${name}`);
  return v as string;
}

export function parseDevice(v: unknown): { name: string; platform: string } {
  const d = obj(v, "device");
  if (typeof d.name !== "string" || d.name.length < 1 || d.name.length > 64) throw invalid("Invalid device name");
  if (d.platform !== "macos" && d.platform !== "ios" && d.platform !== "web") throw invalid("Invalid device platform");
  return { name: d.name, platform: d.platform };
}

export function parseKdf(v: unknown): typeof KDF {
  const k = obj(v, "kdf");
  if (k.alg !== "argon2id" || !Number.isInteger(k.opslimit) || !Number.isInteger(k.memlimit)) throw invalid("Invalid kdf");
  const ops = k.opslimit as number;
  const mem = k.memlimit as number;
  if (ops < 3 || ops > 10 || mem < 67_108_864 || mem > 1_073_741_824) throw invalid("kdf parameters out of range");
  return { alg: "argon2id", opslimit: k.opslimit as number, memlimit: k.memlimit as number };
}

export async function accountView(env: Env, userId: string) {
  const u = await env.DB.prepare("SELECT email, username, plan, recovery_hash, recovery_created_at, created_at FROM users WHERE id = ?")
    .bind(userId)
    .first<{
      email: string;
      username: string | null;
      plan: string;
      recovery_hash: string | null;
      recovery_created_at: string | null;
      created_at: string;
    }>();
  if (!u) throw new HttpError("unauthorized", 401, "Missing or invalid token");
  const use = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS items FROM items WHERE user_id = ?")
    .bind(userId)
    .first<{ bytes: number; items: number }>();
  const page = await env.DB.prepare("SELECT seq FROM keypages WHERE user_id = ?").bind(userId).first<{ seq: number }>();
  const lim = await effectiveLimits(env, userId);
  return {
    email: u.email,
    username: u.username,
    plan: u.plan,
    planName: lim.planName,
    usage: { bytes: use?.bytes ?? 0, items: use?.items ?? 0 },
    limits: { bytes: lim.bytes, items: lim.items, devices: lim.devices },
    recovery: u.recovery_hash ? { enabled: true, createdAt: u.recovery_created_at } : { enabled: false, createdAt: null },
    createdAt: u.created_at,
    keyPageSeq: page?.seq ?? 0,
    two_step: await twoStepView(env, userId),
  };
}

/**
 * Records a password attempt for `email` first, then counts the window (including it), so concurrent
 * guesses cannot all slip under the limit. More than 10 in 15 minutes is 429. Shared by login and every
 * password check behind a session token; a success clears the email's rows.
 */
async function countAttempt(env: Env, email: string): Promise<void> {
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  await env.DB.prepare("DELETE FROM login_failures WHERE at < ?").bind(cutoff).run();
  await env.DB.prepare("INSERT INTO login_failures (email, at) VALUES (?, ?)").bind(email, new Date().toISOString()).run();
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at >= ?")
    .bind(email, cutoff)
    .first<{ n: number }>();
  if ((count?.n ?? 0) > MAX_FAILURES) throw new HttpError("rate_limited", 429, "Too many attempts, try again later");
}

async function fakeSalt(env: Env, email: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.PRELOGIN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(email)));
  return encodeBase64(mac.slice(0, 16));
}

async function prelogin(req: Request, env: Env): Promise<Response> {
  const body = obj(await readJSON(req), "body");
  const email = normaliseEmail(body.email);
  const u = await env.DB.prepare("SELECT salt, kdf FROM users WHERE email = ?").bind(email).first<{ salt: string; kdf: string }>();
  if (u) return json({ salt: u.salt, kdf: JSON.parse(u.kdf) });
  return json({ salt: await fakeSalt(env, email), kdf: KDF });
}

export function sessionStatements(env: Env, userId: string, deviceId: string, tokenHash: string, device: { name: string; platform: string }, now: string) {
  return [
    env.DB.prepare("INSERT INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
      deviceId, userId, device.name, device.platform, now, now,
    ),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, device_id, created_at) VALUES (?, ?, ?, ?)").bind(tokenHash, userId, deviceId, now),
  ];
}

/** SIGNUPS: `open` lets anyone sign up, `invite` only emails on the admin's invite list, `closed` nobody. */
async function assertCanSignUp(env: Env, email: string): Promise<void> {
  if (env.SIGNUPS === "open") return;
  if (env.SIGNUPS === "invite" && (await env.DB.prepare("SELECT 1 FROM invites WHERE email = ?").bind(email).first())) return;
  if (env.SIGNUPS === "invite") throw new HttpError("invite_required", 403, "This email hasn't been invited to this server. Ask its admin for an invite.");
  throw new HttpError("signups_closed", 403, "This server isn't accepting new accounts");
}

async function register(req: Request, env: Env): Promise<Response> {
  const b = obj(await readJSON(req), "body");
  const email = normaliseEmail(b.email);
  const authKey = decodeBase64(b64Field(b.authKey, "authKey", 32))!;
  const salt = b64Field(b.salt, "salt", 16);
  const kdf = parseKdf(b.kdf);
  const wrapped = b64Field(b.wrappedVaultKey, "wrappedVaultKey");
  const sealedSigning = b64Field(b.encryptedSigningKey, "encryptedSigningKey");
  if (typeof b.signerPublicKey !== "string" || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(b.signerPublicKey)) {
    throw invalid("Invalid signerPublicKey");
  }
  const recoveryKey = decodeBase64(b64Field(b.recoveryAuthKey, "recoveryAuthKey", 32))!;
  const wrappedRecovery = b64Field(b.wrappedVaultKeyRecovery, "wrappedVaultKeyRecovery");
  const device = parseDevice(b.device);

  await assertCanSignUp(env, email);
  if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) {
    throw new HttpError("email_taken", 409, "Email already registered");
  }
  const userId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const token = newToken();
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, email, auth_hash, salt, kdf, wrapped_vault_key, encrypted_signing_key, signer_public_key,
           recovery_hash, wrapped_vault_key_recovery, recovery_created_at, created_at, plan)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${DEFAULT_PLAN_SQL})`,
      ).bind(
        userId, email, await sha256Hex(authKey), salt, JSON.stringify(kdf), wrapped, sealedSigning, b.signerPublicKey,
        await sha256Hex(recoveryKey), wrappedRecovery, now, now,
      ),
      ...sessionStatements(env, userId, deviceId, await sha256Hex(token), device, now),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError("email_taken", 409, "Email already registered");
    throw e;
  }
  return json({ token, deviceId, account: await accountView(env, userId) }, 201);
}

async function login(req: Request, env: Env): Promise<Response> {
  const b = obj(await readJSON(req), "body");
  const email = normaliseEmail(b.email);
  const authKey = decodeBase64(b64Field(b.authKey, "authKey", 32))!;
  const device = parseDevice(b.device);

  await countAttempt(env, email);

  const u = await env.DB.prepare("SELECT id, auth_hash FROM users WHERE email = ?").bind(email).first<{ id: string; auth_hash: string }>();
  const given = await sha256Hex(authKey);
  const ok = timingSafeEqualHex(given, u?.auth_hash ?? "0".repeat(64));
  if (!u || !ok) {
    throw new HttpError("invalid_credentials", 401, "Invalid email or password");
  }
  const clear = env.DB.prepare("DELETE FROM login_failures WHERE email = ?").bind(email);
  // Only after the password is right, so a suspended or full account isn't revealed to a guesser.
  await assertCanSignIn(env, u.id);
  if (await isEnabled(env, u.id)) {
    // Password right, but no session until the second factor: POST /v1/login/two-step.
    await clear.run();
    return json({ two_step_required: true, challenge: await issueChallenge(env, u.id, device) });
  }
  return loginSuccess(env, u.id, device, [clear]);
}

/** Creates a session for the device (after `pre` in the same batch) and returns the /v1/login success body. */
export async function loginSuccess(
  env: Env,
  userId: string,
  device: { name: string; platform: string },
  pre: Statement[],
): Promise<Response> {
  const u = await env.DB.prepare("SELECT wrapped_vault_key, encrypted_signing_key, signer_public_key FROM users WHERE id = ?")
    .bind(userId)
    .first<{ wrapped_vault_key: string; encrypted_signing_key: string; signer_public_key: string }>();
  if (!u) throw new HttpError("invalid_credentials", 401, "Invalid email or password");
  await assertCanSignIn(env, userId);
  const deviceId = crypto.randomUUID();
  const token = newToken();
  const now = new Date().toISOString();
  await env.DB.batch([...pre, ...sessionStatements(env, userId, deviceId, await sha256Hex(token), device, now)]);
  return json({
    token,
    deviceId,
    wrappedVaultKey: u.wrapped_vault_key,
    encryptedSigningKey: u.encrypted_signing_key,
    signerPublicKey: u.signer_public_key,
    account: await accountView(env, userId),
  });
}

async function logout(req: Request, env: Env): Promise<Response> {
  const a = await authenticate(req, env);
  // Deleting the device cascades to its sessions.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(a.tokenHash),
    env.DB.prepare("DELETE FROM devices WHERE id = ?").bind(a.deviceId),
  ]);
  return new Response(null, { status: 204 });
}

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
// Key pages share the URL space with the API (/v1/...), so API path names are reserved too.
const RESERVED = new Set("api www admin keys install help about login signup account settings static assets v1 v2 server health".split(" "));

/** Unauthenticated. Precedence: invalid, then reserved, then taken. */
async function usernameAvailability(env: Env, raw: string): Promise<Response> {
  let name: string;
  try {
    name = decodeURIComponent(raw).toLowerCase();
  } catch {
    return json({ available: false, reason: "invalid" });
  }
  if (!USERNAME_RE.test(name)) return json({ available: false, reason: "invalid" });
  if (RESERVED.has(name)) return json({ available: false, reason: "reserved" });
  if (await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(name).first()) {
    return json({ available: false, reason: "taken" });
  }
  return json({ available: true, reason: null });
}

async function setUsername(req: Request, env: Env): Promise<Response> {
  const a = await authenticate(req, env);
  const b = obj(await readJSON(req), "body");
  if (typeof b.username !== "string") throw invalid("Invalid username");
  const username = b.username.toLowerCase();
  if (!USERNAME_RE.test(username) || RESERVED.has(username)) throw invalid("Invalid username");
  const holder = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first<{ id: string }>();
  if (holder && holder.id !== a.userId) throw new HttpError("username_taken", 409, "Username is taken");
  if (!holder) {
    try {
      await env.DB.prepare("UPDATE users SET username = ? WHERE id = ?").bind(username, a.userId).run();
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError("username_taken", 409, "Username is taken");
      throw e;
    }
  }
  return json(await accountView(env, a.userId));
}

/**
 * Bearer token plus the auth key: both are required for destructive account changes (password change,
 * recovery set, delete). Throttled with login, under the account's email, so a stolen token can't be
 * used to guess the password.
 */
export async function requireAuthKey(env: Env, userId: string, key: unknown): Promise<void> {
  const bytes = decodeBase64(b64Field(key, "authKey", 32))!;
  const u = await env.DB.prepare("SELECT auth_hash, email FROM users WHERE id = ?")
    .bind(userId)
    .first<{ auth_hash: string; email: string }>();
  if (!u) throw new HttpError("invalid_credentials", 401, "Invalid password");
  await countAttempt(env, u.email);
  if (!timingSafeEqualHex(await sha256Hex(bytes), u.auth_hash)) {
    throw new HttpError("invalid_credentials", 401, "Invalid password");
  }
  await env.DB.prepare("DELETE FROM login_failures WHERE email = ?").bind(u.email).run();
}

async function changePassword(req: Request, env: Env): Promise<Response> {
  const a = await authenticate(req, env);
  const b = obj(await readJSON(req), "body");
  const newKey = decodeBase64(b64Field(b.authKey, "authKey", 32))!;
  const salt = b64Field(b.salt, "salt", 16);
  const kdf = parseKdf(b.kdf);
  const wrapped = b64Field(b.wrappedVaultKey, "wrappedVaultKey");
  await requireAuthKey(env, a.userId, b.currentAuthKey);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET auth_hash = ?, salt = ?, kdf = ?, wrapped_vault_key = ? WHERE id = ?").bind(
      await sha256Hex(newKey), salt, JSON.stringify(kdf), wrapped, a.userId,
    ),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(a.userId, a.tokenHash),
    env.DB.prepare("DELETE FROM devices WHERE user_id = ? AND id != ?").bind(a.userId, a.deviceId),
    env.DB.prepare("DELETE FROM recovery_tokens WHERE user_id = ?").bind(a.userId),
  ]);
  return new Response(null, { status: 204 });
}

export function deleteUserStatements(env: Env, userId: string): Statement[] {
  return ["recovery_tokens", "login_challenges", "two_step_failures", "backup_codes", "totp", "sessions", "devices", "items", "keypages"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId))
    // The failure tables have no FK (keyed by email), so they must go before the users row does.
    .concat(
      ["login_failures", "recovery_failures"].map((t) =>
        env.DB.prepare(`DELETE FROM ${t} WHERE email = (SELECT email FROM users WHERE id = ?)`).bind(userId),
      ),
    )
    .concat(env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId));
}

const badRecoveryToken = () => new HttpError("invalid_credentials", 401, "Invalid or expired recovery token");

/** `{authKey}` needs a bearer token too. `{recoveryToken}` needs no bearer token and consumes the token. */
async function deleteAccount(req: Request, env: Env): Promise<Response> {
  const b = obj(await readJSON(req), "body");
  if (b.recoveryToken === undefined) {
    const a = await authenticate(req, env);
    await requireAuthKey(env, a.userId, b.authKey);
    await requireSecondFactor(env, a.userId, b);
    await env.DB.batch(deleteUserStatements(env, a.userId));
    return new Response(null, { status: 204 });
  }
  if (typeof b.recoveryToken !== "string") throw invalid("Invalid recoveryToken");
  if (!RECOVERY_TOKEN_RE.test(b.recoveryToken)) throw badRecoveryToken();
  const tokenHash = await sha256Hex(b.recoveryToken);
  const now = new Date().toISOString();
  const t = await env.DB.prepare("SELECT user_id FROM recovery_tokens WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, now)
    .first<{ user_id: string }>();
  if (!t) throw badRecoveryToken();
  // Checked before the token is consumed, so a wrong code doesn't burn it.
  await requireSecondFactor(env, t.user_id, b);
  try {
    await env.DB.batch([recoveryTokenGuard(env, tokenHash, now), ...deleteUserStatements(env, t.user_id)]);
  } catch (e) {
    if (isGuardFailure(e)) throw badRecoveryToken();
    throw e;
  }
  return new Response(null, { status: 204 });
}

async function listDevices(req: Request, env: Env): Promise<Response> {
  const a = await authenticate(req, env);
  const { results } = await env.DB.prepare(
    "SELECT id, name, platform, created_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY created_at, id",
  )
    .bind(a.userId)
    .all<{ id: string; name: string; platform: string; created_at: string; last_seen_at: string }>();
  return json({
    devices: results.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      createdAt: d.created_at,
      lastSeenAt: d.last_seen_at,
      current: d.id === a.deviceId,
    })),
  });
}

async function removeDevice(req: Request, env: Env, id: string): Promise<Response> {
  const a = await authenticate(req, env);
  const d = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?").bind(id, a.userId).first();
  if (!d) throw new HttpError("not_found", 404, "Device not found");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE device_id = ?").bind(id),
    env.DB.prepare("DELETE FROM devices WHERE id = ?").bind(id),
  ]);
  return new Response(null, { status: 204 });
}

/** Returns null when the route is not an accounts route. */
export async function accountRoutes(req: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  const m = req.method;
  if (m === "POST" && pathname === "/v1/prelogin") return prelogin(req, env);
  if (m === "POST" && pathname === "/v1/register") return register(req, env);
  if (m === "POST" && pathname === "/v1/login") return login(req, env);
  if (m === "POST" && pathname === "/v1/logout") return logout(req, env);
  if (m === "GET" && pathname === "/v1/account") {
    const a = await authenticate(req, env);
    return json(await accountView(env, a.userId));
  }
  if (m === "PUT" && pathname === "/v1/account/username") return setUsername(req, env);
  if (m === "PUT" && pathname === "/v1/account/password") return changePassword(req, env);
  if (m === "DELETE" && pathname === "/v1/account") return deleteAccount(req, env);
  if (m === "GET" && pathname === "/v1/devices") return listDevices(req, env);
  const um = /^\/v1\/username\/([^/]+)$/.exec(pathname);
  if (m === "GET" && um) return usernameAvailability(env, um[1]);
  const dm = /^\/v1\/devices\/([^/]+)$/.exec(pathname);
  if (m === "DELETE" && dm) return removeDevice(req, env, dm[1]);
  return null;
}
