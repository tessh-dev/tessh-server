import type { Statement } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Env } from "./index.ts";

const enc = new TextEncoder();

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time for equal-length inputs; unequal lengths return false. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Standard-alphabet base64 (non-empty, up to two pad characters). Used for item blobs. */
export const BASE64_BLOB_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strict standard padded base64. Returns null if the input is not canonical. */
export function decodeBase64(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function randomBase64Url32(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return encodeBase64(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newToken(): string {
  return "tsk_" + randomBase64Url32();
}

/** Recovery tokens: `trc_` + base64url(32 bytes). Only their SHA-256 is stored. */
export const RECOVERY_TOKEN_RE = /^trc_[A-Za-z0-9_-]{43}$/;
export const RECOVERY_TOKEN_TTL_MS = 15 * 60_000;

export function newRecoveryToken(): string {
  return "trc_" + randomBase64Url32();
}

/**
 * Batch statement that aborts the whole batch (CHECK constraint on quota_guard) unless the
 * recovery token still exists and is unexpired. Put it first, with a DELETE of the token after it,
 * so two concurrent batches cannot both consume one token.
 */
export function recoveryTokenGuard(env: Env, tokenHash: string, nowIso: string): Statement {
  return env.DB.prepare(
    "INSERT INTO quota_guard (ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM recovery_tokens WHERE token_hash = ? AND expires_at > ?)",
  ).bind(tokenHash, nowIso);
}

export const isGuardFailure = (e: unknown): boolean => {
  const m = String(e);
  return m.includes("quota_guard") || m.includes("CHECK constraint");
};

const LAST_SEEN_EVERY_MS = 5 * 60_000;

export interface AuthContext {
  userId: string;
  deviceId: string;
  tokenHash: string;
}

export async function authenticate(req: Request, env: Env): Promise<AuthContext> {
  const m = /^Bearer (tsk_[A-Za-z0-9_-]+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) throw new HttpError("unauthorized", 401, "Missing or invalid token");
  const tokenHash = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    "SELECT s.user_id, s.device_id, d.last_seen_at FROM sessions s JOIN devices d ON d.id = s.device_id WHERE s.token_hash = ?",
  )
    .bind(tokenHash)
    .first<{ user_id: string; device_id: string; last_seen_at: string }>();
  if (!row) throw new HttpError("unauthorized", 401, "Missing or invalid token");
  // A write per request is wasted on a value shown to the minute: only refresh it when 5 minutes stale.
  const now = Date.now();
  if (!(Date.parse(row.last_seen_at) > now - LAST_SEEN_EVERY_MS)) {
    await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
      .bind(new Date(now).toISOString(), row.device_id)
      .run();
  }
  return { userId: row.user_id, deviceId: row.device_id, tokenHash };
}
