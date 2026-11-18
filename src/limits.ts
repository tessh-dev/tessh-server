import { HttpError } from "./http.ts";
import type { Env } from "./index.ts";

/** Built-in limits. Storage per person is the only one the owner can change (settings.default_bytes, or per account). */
export const DEFAULT_LIMITS = { bytes: 1_073_741_824, items: 100_000, devices: 50 };

/** The value stored in settings and in users.bytes_limit for "no limit". */
export const NO_LIMIT = -1;

export interface EffectiveLimits {
  bytes: number;
  items: number;
  devices: number;
  suspended: boolean;
}

/** The account's own limit, else the server default. A negative size (NO_LIMIT) means no limit. */
export function resolveLimits(r: { bytes_limit: number | null }, defaultBytes: number): EffectiveLimits {
  const b = r.bytes_limit ?? defaultBytes;
  return { bytes: b < 0 ? Infinity : b, items: DEFAULT_LIMITS.items, devices: DEFAULT_LIMITS.devices, suspended: false };
}

/** The one place effective limits come from. A missing account gets the defaults (callers 401 on their own). */
export async function effectiveLimits(env: Env, userId: string): Promise<EffectiveLimits> {
  const r = await env.DB.prepare(
    `SELECT u.suspended_at, u.bytes_limit, (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'default_bytes') AS default_bytes
     FROM users u WHERE u.id = ?`,
  )
    .bind(userId)
    .first<{ suspended_at: string | null; bytes_limit: number | null; default_bytes: number | null }>();
  if (!r) return resolveLimits({ bytes_limit: null }, DEFAULT_LIMITS.bytes);
  return { ...resolveLimits(r, r.default_bytes ?? DEFAULT_LIMITS.bytes), suspended: r.suspended_at !== null };
}

/**
 * The same rule as resolveLimits, as SQL over `users u` (LIMIT_SQL.from). Used by the in-batch quota guard (so a
 * limit change lands even mid-request) and the owner's account lists. Keep the two in step.
 */
export const LIMIT_SQL = {
  from: "users u",
  bytes: `(SELECT CASE WHEN b < 0 THEN 9007199254740991 ELSE b END FROM (SELECT COALESCE(u.bytes_limit,
    (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'default_bytes'), ${DEFAULT_LIMITS.bytes}) AS b))`,
  items: String(DEFAULT_LIMITS.items),
  devices: String(DEFAULT_LIMITS.devices),
};

export const suspendedError = () => new HttpError("account_suspended", 403, "This account is suspended");

export async function assertNotSuspended(env: Env, userId: string): Promise<EffectiveLimits> {
  const l = await effectiveLimits(env, userId);
  if (l.suspended) throw suspendedError();
  return l;
}

/** Before a new session: not suspended, and room for one more device. */
export async function assertCanSignIn(env: Env, userId: string): Promise<void> {
  const l = await assertNotSuspended(env, userId);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?").bind(userId).first<{ n: number }>();
  if ((n?.n ?? 0) >= l.devices) {
    throw new HttpError("device_limit", 403, "This account has reached its device limit", { limit: l.devices });
  }
}
