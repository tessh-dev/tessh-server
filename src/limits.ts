import { HttpError } from "./http.ts";
import type { Env } from "./index.ts";

/** Built-in fallback when an account's plan row is missing. Matches the seeded `free` plan. */
export const DEFAULT_LIMITS = { bytes: 5_242_880, items: 10_000, devices: null as number | null };

export interface EffectiveLimits {
  plan: string;
  planName: string;
  bytes: number;
  items: number;
  /** null = unlimited. */
  devices: number | null;
  suspended: boolean;
}

interface Row {
  plan: string;
  suspended_at: string | null;
  u_bytes: number | null;
  u_items: number | null;
  u_devices: number | null;
  p_name: string | null;
  p_bytes: number | null;
  p_items: number | null;
  p_devices: number | null;
  p_found: number | null;
}

const SELECT = `SELECT u.plan, u.suspended_at, u.bytes_limit AS u_bytes, u.items_limit AS u_items, u.devices_limit AS u_devices,
  p.name AS p_name, p.bytes_limit AS p_bytes, p.items_limit AS p_items, p.devices_limit AS p_devices, (p.id IS NOT NULL) AS p_found
  FROM users u LEFT JOIN plans p ON p.id = u.plan`;

/** Override ?? plan ?? built-in default. Pure, so the admin views and tests use the same rule. */
export function resolveLimits(r: Row): EffectiveLimits {
  return {
    plan: r.plan,
    planName: r.p_name ?? r.plan,
    bytes: r.u_bytes ?? r.p_bytes ?? DEFAULT_LIMITS.bytes,
    items: r.u_items ?? r.p_items ?? DEFAULT_LIMITS.items,
    devices: r.u_devices ?? (r.p_found ? r.p_devices : DEFAULT_LIMITS.devices),
    suspended: r.suspended_at !== null,
  };
}

/** The one place effective limits come from. A missing account gets the defaults (callers 401 on their own). */
export async function effectiveLimits(env: Env, userId: string): Promise<EffectiveLimits> {
  const r = await env.DB.prepare(`${SELECT} WHERE u.id = ?`).bind(userId).first<Row>();
  if (!r) return { plan: "free", planName: "Free", ...DEFAULT_LIMITS, suspended: false };
  return resolveLimits(r);
}

/**
 * The same rule as resolveLimits, as SQL over `users u LEFT JOIN plans p` (LIMIT_SQL.from). Used by the in-batch quota
 * guard (so a limit change lands even mid-request) and the admin lists. Keep the two in step.
 */
export const LIMIT_SQL = {
  from: "users u LEFT JOIN plans p ON p.id = u.plan",
  bytes: `COALESCE(u.bytes_limit, p.bytes_limit, ${DEFAULT_LIMITS.bytes})`,
  items: `COALESCE(u.items_limit, p.items_limit, ${DEFAULT_LIMITS.items})`,
  devices: "CASE WHEN u.devices_limit IS NOT NULL THEN u.devices_limit WHEN p.id IS NOT NULL THEN p.devices_limit ELSE NULL END",
};

/** SQL for the plan new sign-ups get. */
export const DEFAULT_PLAN_SQL = "COALESCE((SELECT id FROM plans WHERE is_default = 1 AND archived = 0), 'free')";

export const suspendedError = () => new HttpError("account_suspended", 403, "This account is suspended");

export async function assertNotSuspended(env: Env, userId: string): Promise<EffectiveLimits> {
  const l = await effectiveLimits(env, userId);
  if (l.suspended) throw suspendedError();
  return l;
}

/** Before a new session: not suspended, and room for one more device. */
export async function assertCanSignIn(env: Env, userId: string): Promise<void> {
  const l = await assertNotSuspended(env, userId);
  if (l.devices === null) return;
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?").bind(userId).first<{ n: number }>();
  if ((n?.n ?? 0) >= l.devices) {
    throw new HttpError("device_limit", 403, "This account has reached its device limit", { limit: l.devices });
  }
}
