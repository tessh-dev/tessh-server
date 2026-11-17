import {
  RECOVERY_TOKEN_RE,
  RECOVERY_TOKEN_TTL_MS,
  authenticate,
  decodeBase64,
  isGuardFailure,
  newRecoveryToken,
  newToken,
  recoveryTokenGuard,
  sha256Hex,
  timingSafeEqualHex,
} from "./auth.ts";
import { accountView, b64Field, invalid, normaliseEmail, obj, parseDevice, parseKdf, requireAuthKey, sessionStatements } from "./accounts.ts";
import { HttpError, json, readJSON } from "./http.ts";
import { assertNotSuspended } from "./limits.ts";
import type { Env } from "./index.ts";

const MAX_FAILURES = 5;
const WINDOW_MS = 60 * 60_000;
// Compared against when the email is unknown or has no code set, so every miss does the same work.
const DUMMY_HASH = "0".repeat(64);

const badCode = () => new HttpError("invalid_credentials", 401, "Invalid email or recovery code");
const badToken = () => new HttpError("invalid_credentials", 401, "Invalid or expired recovery token");

/** Bearer token plus currentAuthKey: a stolen session token alone cannot plant a recovery code. */
async function setRecovery(req: Request, env: Env): Promise<Response> {
  const a = await authenticate(req, env);
  const b = obj(await readJSON(req), "body");
  const recoveryKey = decodeBase64(b64Field(b.recoveryAuthKey, "recoveryAuthKey", 32))!;
  const wrapped = b64Field(b.wrappedVaultKeyRecovery, "wrappedVaultKeyRecovery");
  await requireAuthKey(env, a.userId, b.currentAuthKey);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET recovery_hash = ?, wrapped_vault_key_recovery = ?, recovery_created_at = ? WHERE id = ?").bind(
      await sha256Hex(recoveryKey), wrapped, new Date().toISOString(), a.userId,
    ),
    // Tokens issued for the old code die with it.
    env.DB.prepare("DELETE FROM recovery_tokens WHERE user_id = ?").bind(a.userId),
  ]);
  return new Response(null, { status: 204 });
}

async function start(req: Request, env: Env): Promise<Response> {
  const b = obj(await readJSON(req), "body");
  const email = normaliseEmail(b.email);
  const given = await sha256Hex(decodeBase64(b64Field(b.recoveryAuthKey, "recoveryAuthKey", 32))!);

  // Record the attempt first, then count (including it): concurrent guesses cannot all slip under the limit.
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - WINDOW_MS).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  await env.DB.prepare("DELETE FROM recovery_failures WHERE at < ?").bind(cutoff).run();
  await env.DB.prepare("INSERT INTO recovery_failures (email, at) VALUES (?, ?)").bind(email, nowIso).run();
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM recovery_failures WHERE email = ? AND at >= ?")
    .bind(email, cutoff)
    .first<{ n: number }>();
  if ((count?.n ?? 0) > MAX_FAILURES) throw new HttpError("rate_limited", 429, "Too many attempts, try again later");

  const u = await env.DB.prepare(
    "SELECT id, recovery_hash, wrapped_vault_key_recovery, encrypted_signing_key, signer_public_key FROM users WHERE email = ?",
  )
    .bind(email)
    .first<{
      id: string;
      recovery_hash: string | null;
      wrapped_vault_key_recovery: string | null;
      encrypted_signing_key: string;
      signer_public_key: string;
    }>();
  const ok = timingSafeEqualHex(given, u?.recovery_hash ?? DUMMY_HASH);
  if (!u || !u.recovery_hash || !u.wrapped_vault_key_recovery || !ok) throw badCode();

  const token = newRecoveryToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM recovery_tokens WHERE expires_at <= ?").bind(nowIso),
    env.DB.prepare("INSERT INTO recovery_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(
      await sha256Hex(token), u.id, new Date(nowMs + RECOVERY_TOKEN_TTL_MS).toISOString(),
    ),
    env.DB.prepare("DELETE FROM recovery_failures WHERE email = ?").bind(email),
  ]);
  return json({
    recoveryToken: token,
    wrappedVaultKeyRecovery: u.wrapped_vault_key_recovery,
    encryptedSigningKey: u.encrypted_signing_key,
    signerPublicKey: u.signer_public_key,
  });
}

async function finish(req: Request, env: Env): Promise<Response> {
  const b = obj(await readJSON(req), "body");
  // Validate everything before touching the token.
  if (typeof b.recoveryToken !== "string") throw invalid("Invalid recoveryToken");
  const authKey = decodeBase64(b64Field(b.authKey, "authKey", 32))!;
  const salt = b64Field(b.salt, "salt", 16);
  const kdf = parseKdf(b.kdf);
  const wrapped = b64Field(b.wrappedVaultKey, "wrappedVaultKey");
  const recoveryKey = decodeBase64(b64Field(b.recoveryAuthKey, "recoveryAuthKey", 32))!;
  const wrappedRecovery = b64Field(b.wrappedVaultKeyRecovery, "wrappedVaultKeyRecovery");
  const device = parseDevice(b.device);
  if (!RECOVERY_TOKEN_RE.test(b.recoveryToken)) throw badToken();

  const tokenHash = await sha256Hex(b.recoveryToken);
  const now = new Date().toISOString();
  const t = await env.DB.prepare(
    "SELECT u.id, u.email, u.recovery_hash FROM recovery_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.expires_at > ?",
  )
    .bind(tokenHash, now)
    .first<{ id: string; email: string; recovery_hash: string | null }>();
  if (!t) throw badToken();
  // Finishing recovery signs the device in, so a suspended account can't use it to get a session.
  await assertNotSuspended(env, t.id);
  const newRecoveryHash = await sha256Hex(recoveryKey);
  if (t.recovery_hash && timingSafeEqualHex(newRecoveryHash, t.recovery_hash)) {
    throw invalid("The new recovery code must differ from the old one");
  }

  const deviceId = crypto.randomUUID();
  const token = newToken();
  try {
    await env.DB.batch([
      // Aborts the batch if a concurrent finish (or delete) already consumed the token.
      recoveryTokenGuard(env, tokenHash, now),
      env.DB.prepare("DELETE FROM recovery_tokens WHERE user_id = ?").bind(t.id),
      env.DB.prepare(
        `UPDATE users SET auth_hash = ?, salt = ?, kdf = ?, wrapped_vault_key = ?,
           recovery_hash = ?, wrapped_vault_key_recovery = ?, recovery_created_at = ? WHERE id = ?`,
      ).bind(await sha256Hex(authKey), salt, JSON.stringify(kdf), wrapped, newRecoveryHash, wrappedRecovery, now, t.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(t.id),
      env.DB.prepare("DELETE FROM devices WHERE user_id = ?").bind(t.id),
      env.DB.prepare("DELETE FROM login_failures WHERE email = ?").bind(t.email),
      // Two-step stays on; only pending sign-ins started with the old password are dropped.
      env.DB.prepare("DELETE FROM login_challenges WHERE user_id = ?").bind(t.id),
      ...sessionStatements(env, t.id, deviceId, await sha256Hex(token), device, now),
    ]);
  } catch (e) {
    if (isGuardFailure(e)) throw badToken();
    throw e;
  }
  return json({ token, deviceId, account: await accountView(env, t.id) });
}

/** Returns null when the route is not a recovery route. */
export async function recoveryRoutes(req: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  const m = req.method;
  if (m === "PUT" && pathname === "/v1/account/recovery") return setRecovery(req, env);
  if (m === "POST" && pathname === "/v1/recover/start") return start(req, env);
  if (m === "POST" && pathname === "/v1/recover/finish") return finish(req, env);
  return null;
}
