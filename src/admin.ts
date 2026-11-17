// The admin panel, on its own port: server-rendered pages, /admin.css + /admin.js, and JSON under /api/. Every
// request needs the admin password (HTTP Basic, src/admin-auth.ts); every write is audited with the name the admin
// signed in with. Zero-knowledge stays: only counts, sizes, dates, emails, usernames and device names leave here.
// Never blobs, keys, hashes or auth data.
import type { Statement, Value } from "./db.ts";
import { verifyAdmin } from "./admin-auth.ts";
import { deleteUserStatements, invalid, normaliseEmail, obj } from "./accounts.ts";
import {
  ADMIN_CSS,
  ADMIN_JS,
  renderAccount,
  renderAccounts,
  renderAudit,
  renderInvites,
  renderOverview,
  renderPlans,
  renderNotFound,
} from "./admin-ui.ts";
import { HttpError, MAX_BODY_BYTES, errorFrom, json } from "./http.ts";
import type { Env } from "./index.ts";
import { LIMIT_SQL } from "./limits.ts";

const DAY = 86_400_000;
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'";
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const MAX_BYTES = 10 * 1024 ** 3;
const MAX_ITEMS = 10_000_000;
const MAX_DEVICES = 1000;

const notFound = (what = "Not found") => new HttpError("not_found", 404, what);

// ---------- data ----------

export interface AccountRow {
  id: string;
  email: string;
  username: string | null;
  plan: string;
  plan_name: string;
  created_at: string;
  suspended_at: string | null;
  bytes: number;
  items: number;
  devices: number;
  seen: string | null;
  two_step: number;
  lim_bytes: number;
  lim_items: number;
  lim_devices: number | null;
}

const ACCOUNT_SELECT = `SELECT u.id, u.email, u.username, u.plan, COALESCE(p.name, u.plan) AS plan_name, u.created_at, u.suspended_at,
  (SELECT COALESCE(SUM(size), 0) FROM items WHERE user_id = u.id) AS bytes,
  (SELECT COUNT(*) FROM items WHERE user_id = u.id) AS items,
  (SELECT COUNT(*) FROM devices WHERE user_id = u.id) AS devices,
  (SELECT MAX(last_seen_at) FROM devices WHERE user_id = u.id) AS seen,
  COALESCE((SELECT enabled FROM totp WHERE user_id = u.id), 0) AS two_step,
  ${LIMIT_SQL.bytes} AS lim_bytes, ${LIMIT_SQL.items} AS lim_items, ${LIMIT_SQL.devices} AS lim_devices
  FROM ${LIMIT_SQL.from}`;

export function accountSummary(r: AccountRow) {
  return {
    id: r.id,
    email: r.email,
    username: r.username,
    plan: { id: r.plan, name: r.plan_name },
    createdAt: r.created_at,
    lastSeenAt: r.seen,
    suspended: r.suspended_at !== null,
    suspendedAt: r.suspended_at,
    twoStep: r.two_step === 1,
    devices: r.devices,
    usage: { bytes: r.bytes, items: r.items },
    limits: { bytes: r.lim_bytes, items: r.lim_items, devices: r.lim_devices },
  };
}
export type AccountSummary = ReturnType<typeof accountSummary>;

export async function overview(env: Env) {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users) AS accounts,
       (SELECT COUNT(*) FROM users WHERE created_at >= ?1) AS week,
       (SELECT COUNT(DISTINCT user_id) FROM devices WHERE last_seen_at >= ?1) AS active,
       (SELECT COALESCE(SUM(size), 0) FROM items) AS bytes,
       (SELECT COALESCE(SUM(${LIMIT_SQL.bytes}), 0) FROM ${LIMIT_SQL.from}) AS capacity,
       (SELECT COUNT(*) FROM totp WHERE enabled = 1) AS two_step,
       (SELECT COUNT(*) FROM users WHERE suspended_at IS NOT NULL) AS suspended,
       (SELECT COUNT(*) FROM login_failures WHERE at >= ?2) AS failed_logins,
       (SELECT COUNT(*) FROM two_step_failures WHERE at >= ?2) AS failed_codes,
       (SELECT COUNT(*) FROM devices) AS devices`,
  )
    .bind(iso(now - 7 * DAY), iso(now - 3_600_000))
    .first<Record<string, number>>();
  const since = new Date(now - 29 * DAY).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day",
  )
    .bind(since)
    .all<{ day: string; n: number }>();
  const byDay = new Map(results.map((x) => [x.day, x.n]));
  const signups = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(now - (29 - i) * DAY).toISOString().slice(0, 10);
    return { day, count: byDay.get(day) ?? 0 };
  });
  const s = r ?? {};
  return {
    accounts: s.accounts ?? 0,
    newThisWeek: s.week ?? 0,
    active7d: s.active ?? 0,
    storage: { bytes: s.bytes ?? 0, capacity: s.capacity ?? 0 },
    twoStep: s.two_step ?? 0,
    suspended: s.suspended ?? 0,
    devices: s.devices ?? 0,
    signups30d: signups,
    health: { failedLogins1h: s.failed_logins ?? 0, failedCodes1h: s.failed_codes ?? 0 },
    updatedAt: new Date(now).toISOString(),
  };
}

export type Filter = "all" | "two_step" | "near" | "suspended" | `plan:${string}`;

export function parseFilter(v: string | null): Filter {
  if (v === "two_step" || v === "near" || v === "suspended") return v;
  if (v && v.startsWith("plan:") && PLAN_ID_RE.test(v.slice(5))) return v as Filter;
  return "all";
}

export async function listAccounts(env: Env, q: string, filter: Filter, limit = 200): Promise<AccountSummary[]> {
  const where: string[] = [];
  const args: Value[] = [];
  const query = q.trim().toLowerCase().slice(0, 254);
  if (query) {
    const like = `%${query.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    where.push("(u.email LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  if (filter === "suspended") where.push("u.suspended_at IS NOT NULL");
  if (filter.startsWith("plan:")) {
    where.push("u.plan = ?");
    args.push(filter.slice(5));
  }
  const inner = `${ACCOUNT_SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""}`;
  const outer: string[] = [];
  if (filter === "two_step") outer.push("two_step = 1");
  if (filter === "near") outer.push("(bytes * 5 >= lim_bytes * 4 OR items * 5 >= lim_items * 4)");
  const sql = `SELECT * FROM (${inner})${outer.length ? " WHERE " + outer.join(" AND ") : ""}
    ORDER BY COALESCE(seen, created_at) DESC, id LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all<AccountRow>();
  return results.map(accountSummary);
}

export async function accountDetail(env: Env, id: string) {
  const r = await env.DB.prepare(`${ACCOUNT_SELECT} WHERE u.id = ?`).bind(id).first<AccountRow>();
  if (!r) throw notFound("Account not found");
  const extra = await env.DB.prepare(
    `SELECT u.bytes_limit, u.items_limit, u.devices_limit, p.bytes_limit AS p_bytes, p.items_limit AS p_items,
       p.devices_limit AS p_devices, (p.id IS NOT NULL) AS p_found,
       (SELECT seq FROM keypages WHERE user_id = u.id) AS keypage_seq,
       (SELECT COUNT(*) FROM backup_codes WHERE user_id = u.id AND used_at IS NULL) AS backup_left,
       (u.recovery_hash IS NOT NULL) AS recovery
     FROM ${LIMIT_SQL.from} WHERE u.id = ?`,
  )
    .bind(id)
    .first<{
      bytes_limit: number | null;
      items_limit: number | null;
      devices_limit: number | null;
      p_bytes: number | null;
      p_items: number | null;
      p_devices: number | null;
      p_found: number;
      keypage_seq: number | null;
      backup_left: number;
      recovery: number;
    }>();
  const { results: devices } = await env.DB.prepare(
    "SELECT id, name, platform, created_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC, id",
  )
    .bind(id)
    .all<{ id: string; name: string; platform: string; created_at: string; last_seen_at: string }>();
  return {
    ...accountSummary(r),
    overrides: { bytes: extra?.bytes_limit ?? null, items: extra?.items_limit ?? null, devices: extra?.devices_limit ?? null },
    planLimits: extra?.p_found
      ? { bytes: extra.p_bytes, items: extra.p_items, devices: extra.p_devices }
      : { bytes: null, items: null, devices: null },
    keyPage: r.username ? { username: r.username, seq: extra?.keypage_seq ?? null } : null,
    backupCodesLeft: extra?.backup_left ?? 0,
    recovery: extra?.recovery === 1,
    deviceList: devices.map((d) => ({ id: d.id, name: d.name, platform: d.platform, createdAt: d.created_at, lastSeenAt: d.last_seen_at })),
  };
}
export type AccountDetail = Awaited<ReturnType<typeof accountDetail>>;

export async function listPlans(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.bytes_limit, p.items_limit, p.devices_limit, p.is_default, p.archived, p.created_at, p.updated_at,
       (SELECT COUNT(*) FROM users WHERE plan = p.id) AS accounts
     FROM plans p ORDER BY p.archived, p.bytes_limit, p.id`,
  ).all<{
    id: string;
    name: string;
    bytes_limit: number;
    items_limit: number;
    devices_limit: number | null;
    is_default: number;
    archived: number;
    created_at: string;
    updated_at: string;
    accounts: number;
  }>();
  return results.map((p) => ({
    id: p.id,
    name: p.name,
    limits: { bytes: p.bytes_limit, items: p.items_limit, devices: p.devices_limit },
    default: p.is_default === 1,
    archived: p.archived === 1,
    accounts: p.accounts,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }));
}
export type Plan = Awaited<ReturnType<typeof listPlans>>[number];

export async function listAudit(env: Env, userId: string | null, limit = 200) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.at, a.admin_email, a.action, a.user_id, a.detail, u.email AS email
     FROM admin_audit a LEFT JOIN users u ON u.id = a.user_id
     ${userId ? "WHERE a.user_id = ?" : ""} ORDER BY a.id DESC LIMIT ?`,
  )
    .bind(...(userId ? [userId, limit] : [limit]))
    .all<{ id: number; at: string; admin_email: string; action: string; user_id: string | null; detail: string; email: string | null }>();
  return results.map((a) => {
    let detail: Record<string, unknown> = {};
    try {
      detail = JSON.parse(a.detail);
    } catch {}
    return {
      id: a.id,
      at: a.at,
      admin: a.admin_email,
      action: a.action,
      userId: a.user_id,
      email: a.email ?? (typeof detail.email === "string" ? detail.email : null),
      detail,
    };
  });
}
export type AuditRow = Awaited<ReturnType<typeof listAudit>>[number];

export async function listInvites(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT i.email, i.created_at, i.created_by, u.id AS user_id, u.created_at AS joined_at
     FROM invites i LEFT JOIN users u ON u.email = i.email ORDER BY i.created_at DESC, i.email`,
  ).all<{ email: string; created_at: string; created_by: string; user_id: string | null; joined_at: string | null }>();
  return results.map((r) => ({
    email: r.email,
    createdAt: r.created_at,
    createdBy: r.created_by,
    userId: r.user_id,
    joinedAt: r.joined_at,
  }));
}
export type Invite = Awaited<ReturnType<typeof listInvites>>[number];

// ---------- writes ----------

function audit(env: Env, admin: string, action: string, userId: string | null, detail: Record<string, unknown> = {}) {
  return env.DB.prepare("INSERT INTO admin_audit (at, admin_email, action, user_id, detail) VALUES (?, ?, ?, ?, ?)").bind(
    new Date().toISOString(), admin, action, userId, JSON.stringify(detail),
  );
}

/** null/undefined/"" → null; otherwise an integer in [min, max]. */
function optInt(v: unknown, name: string, min: number, max: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw invalid(`Invalid ${name}`);
  return v;
}
function reqInt(v: unknown, name: string, min: number, max: number): number {
  const n = optInt(v, name, min, max);
  if (n === null) throw invalid(`${name} is required`);
  return n;
}
function planName(v: unknown): string {
  if (typeof v !== "string" || v.trim().length < 1 || v.trim().length > 40) throw invalid("Invalid name");
  return v.trim();
}

async function userRow(env: Env, id: string) {
  const u = await env.DB.prepare("SELECT id, email, plan, suspended_at FROM users WHERE id = ?")
    .bind(id)
    .first<{ id: string; email: string; plan: string; suspended_at: string | null }>();
  if (!u) throw notFound("Account not found");
  return u;
}

async function activePlan(env: Env, id: unknown) {
  if (typeof id !== "string" || !PLAN_ID_RE.test(id)) throw invalid("Invalid plan");
  const p = await env.DB.prepare("SELECT id, archived, is_default FROM plans WHERE id = ?").bind(id).first<{ id: string; archived: number; is_default: number }>();
  if (!p) throw notFound("Plan not found");
  return p;
}

async function accountAction(req: Request, env: Env, admin: string, id: string, action: string): Promise<Response> {
  const u = await userRow(env, id);
  const b = await bodyOrEmpty(req);
  const now = new Date().toISOString();
  switch (action) {
    case "plan": {
      const p = await activePlan(env, b.plan);
      if (p.archived) throw invalid("That plan is archived");
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET plan = ? WHERE id = ?").bind(p.id, id),
        audit(env, admin, "change_plan", id, { from: u.plan, to: p.id }),
      ]);
      break;
    }
    case "limits": {
      const bytes = optInt(b.bytes, "storage", 1, MAX_BYTES);
      const items = optInt(b.items, "items", 1, MAX_ITEMS);
      const devices = optInt(b.devices, "devices", 1, MAX_DEVICES);
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET bytes_limit = ?, items_limit = ?, devices_limit = ? WHERE id = ?").bind(bytes, items, devices, id),
        audit(env, admin, "custom_limits", id, { bytes, items, devices }),
      ]);
      break;
    }
    case "sign-out": {
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?").bind(id).first<{ n: number }>();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM devices WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM login_challenges WHERE user_id = ?").bind(id),
        audit(env, admin, "sign_out_all", id, { devices: n?.n ?? 0 }),
      ]);
      break;
    }
    case "reset-two-step": {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM totp WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM backup_codes WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM login_challenges WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM two_step_failures WHERE user_id = ?").bind(id),
        audit(env, admin, "reset_two_step", id),
      ]);
      break;
    }
    case "suspend": {
      if (u.suspended_at) break;
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ? AND suspended_at IS NULL").bind(now, id),
        audit(env, admin, "suspend", id),
      ]);
      break;
    }
    case "unsuspend": {
      if (!u.suspended_at) break;
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET suspended_at = NULL WHERE id = ?").bind(id),
        audit(env, admin, "unsuspend", id),
      ]);
      break;
    }
    default:
      throw notFound();
  }
  return json({ ok: true, account: await accountDetail(env, id) });
}

async function deleteAccount(req: Request, env: Env, admin: string, id: string): Promise<Response> {
  const u = await userRow(env, id);
  const b = await bodyOrEmpty(req);
  if (typeof b.confirm_email !== "string" || b.confirm_email.trim().toLowerCase() !== u.email) {
    throw invalid("Type the account's email to confirm");
  }
  // Audit first in the same batch: the row keeps the email because the account it points at is gone.
  await env.DB.batch([audit(env, admin, "delete_account", id, { email: u.email }), ...deleteUserStatements(env, id)]);
  return json({ ok: true });
}

async function createPlan(req: Request, env: Env, admin: string): Promise<Response> {
  const b = await bodyOrEmpty(req);
  if (typeof b.id !== "string" || !PLAN_ID_RE.test(b.id)) throw invalid("Plan id: 2-31 lowercase letters, digits or dashes");
  const name = planName(b.name);
  const bytes = reqInt(b.bytes, "storage", 1, MAX_BYTES);
  const items = reqInt(b.items, "items", 1, MAX_ITEMS);
  const devices = optInt(b.devices, "devices", 1, MAX_DEVICES);
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO plans (id, name, bytes_limit, items_limit, devices_limit, is_default, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)",
      ).bind(b.id, name, bytes, items, devices, now, now),
      audit(env, admin, "create_plan", null, { plan: b.id, name, bytes, items, devices }),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError("conflict", 409, "A plan with that id exists");
    throw e;
  }
  return json({ ok: true, plans: await listPlans(env) }, 201);
}

async function planAction(req: Request, env: Env, admin: string, id: string, action: string | undefined): Promise<Response> {
  const p = await activePlan(env, id);
  const b = await bodyOrEmpty(req);
  const now = new Date().toISOString();
  if (action === undefined && req.method === "PUT") {
    const name = planName(b.name);
    const bytes = reqInt(b.bytes, "storage", 1, MAX_BYTES);
    const items = reqInt(b.items, "items", 1, MAX_ITEMS);
    const devices = optInt(b.devices, "devices", 1, MAX_DEVICES);
    await env.DB.batch([
      env.DB.prepare("UPDATE plans SET name = ?, bytes_limit = ?, items_limit = ?, devices_limit = ?, updated_at = ? WHERE id = ?").bind(
        name, bytes, items, devices, now, id,
      ),
      audit(env, admin, "edit_plan", null, { plan: id, name, bytes, items, devices }),
    ]);
  } else if (action === "default" && req.method === "POST") {
    if (p.archived) throw invalid("An archived plan can't be the default");
    if (!p.is_default) {
      await env.DB.batch([
        env.DB.prepare("UPDATE plans SET is_default = 0, updated_at = ? WHERE is_default = 1").bind(now),
        env.DB.prepare("UPDATE plans SET is_default = 1, updated_at = ? WHERE id = ?").bind(now, id),
        audit(env, admin, "default_plan", null, { plan: id }),
      ]);
    }
  } else if (action === "archive" && req.method === "POST") {
    if (p.is_default) throw invalid("Make another plan the default first");
    if (p.archived) return json({ ok: true, plans: await listPlans(env) });
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE plan = ?").bind(id).first<{ n: number }>())?.n ?? 0;
    const stmts: Statement[] = [];
    let moveTo: string | null = null;
    if (n > 0) {
      if (b.move_to === undefined || b.move_to === null || b.move_to === "") {
        throw new HttpError("plan_in_use", 409, `${n} account${n === 1 ? " uses" : "s use"} this plan`, { accounts: n });
      }
      const t = await activePlan(env, b.move_to);
      if (t.id === id || t.archived) throw invalid("Move accounts to another active plan");
      moveTo = t.id;
      stmts.push(env.DB.prepare("UPDATE users SET plan = ? WHERE plan = ?").bind(moveTo, id));
    }
    stmts.push(
      env.DB.prepare("UPDATE plans SET archived = 1, updated_at = ? WHERE id = ?").bind(now, id),
      audit(env, admin, "archive_plan", null, { plan: id, moved: n, to: moveTo }),
    );
    await env.DB.batch(stmts);
  } else {
    throw notFound();
  }
  return json({ ok: true, plans: await listPlans(env) });
}

/** Admin writes may have no body (sign out, suspend…). Otherwise a JSON object, at most 1 MiB. */
async function bodyOrEmpty(req: Request): Promise<Record<string, unknown>> {
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return {};
  if (buf.byteLength > MAX_BODY_BYTES) throw invalid("Request body too large");
  try {
    return obj(JSON.parse(new TextDecoder().decode(buf)), "body");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw invalid("Invalid JSON");
  }
}

async function addInvite(req: Request, env: Env, admin: string): Promise<Response> {
  const b = await bodyOrEmpty(req);
  const email = normaliseEmail(b.email);
  const r = await env.DB.prepare("SELECT 1 FROM invites WHERE email = ?").bind(email).first();
  if (!r) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO invites (email, created_at, created_by) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING").bind(
        email, new Date().toISOString(), admin,
      ),
      audit(env, admin, "add_invite", null, { email }),
    ]);
  }
  return json({ ok: true, invites: await listInvites(env) }, r ? 200 : 201);
}

async function removeInvite(req: Request, env: Env, admin: string): Promise<Response> {
  const b = await bodyOrEmpty(req);
  const email = normaliseEmail(b.email);
  const r = await env.DB.prepare("SELECT 1 FROM invites WHERE email = ?").bind(email).first();
  if (!r) throw notFound("Invite not found");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM invites WHERE email = ?").bind(email),
    audit(env, admin, "remove_invite", null, { email }),
  ]);
  return json({ ok: true, invites: await listInvites(env) });
}

// ---------- routing ----------

/** Cross-site writes are refused: JSON + a custom header (forces a preflight we never answer) + same Origin. */
function checkWrite(req: Request): void {
  if (req.headers.get("x-tessh-admin") !== "1") throw new HttpError("forbidden", 403, "Forbidden");
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== new URL(req.url).origin) throw new HttpError("forbidden", 403, "Forbidden");
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") throw new HttpError("forbidden", 403, "Forbidden");
  const type = req.headers.get("content-type") ?? "";
  if (req.headers.get("content-length") !== "0" && type && !type.startsWith("application/json")) {
    throw new HttpError("invalid_request", 400, "JSON only");
  }
}

async function apiRoute(req: Request, env: Env, admin: string, path: string, url: URL): Promise<Response> {
  const m = req.method;
  if (m === "GET") {
    if (path === "/api/overview") return json(await overview(env));
    if (path === "/api/accounts") return json({ accounts: await listAccounts(env, url.searchParams.get("q") ?? "", parseFilter(url.searchParams.get("filter"))) });
    const am = /^\/api\/accounts\/([0-9a-f-]{36})$/.exec(path);
    if (am) return json(await accountDetail(env, am[1]));
    if (path === "/api/plans") return json({ plans: await listPlans(env) });
    if (path === "/api/audit") return json({ audit: await listAudit(env, url.searchParams.get("user")) });
    if (path === "/api/invites") return json({ signups: env.SIGNUPS, invites: await listInvites(env) });
    throw notFound();
  }
  checkWrite(req);
  if (path === "/api/invites" && m === "POST") return addInvite(req, env, admin);
  if (path === "/api/invites" && m === "DELETE") return removeInvite(req, env, admin);
  const aa = /^\/api\/accounts\/([0-9a-f-]{36})(?:\/([a-z-]+))?$/.exec(path);
  if (aa) {
    if (aa[2] === undefined && m === "DELETE") return deleteAccount(req, env, admin, aa[1]);
    if (aa[2] !== undefined && m === "POST") return accountAction(req, env, admin, aa[1], aa[2]);
    throw notFound();
  }
  if (path === "/api/plans" && m === "POST") return createPlan(req, env, admin);
  const pm = /^\/api\/plans\/([a-z0-9-]+)(?:\/([a-z]+))?$/.exec(path);
  if (pm) return planAction(req, env, admin, pm[1], pm[2]);
  throw notFound();
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

async function pageRoute(req: Request, env: Env, admin: string, path: string, url: URL): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError("not_found", 404, "Not found");
  if (path === "/admin.css") return new Response(ADMIN_CSS, { headers: { "content-type": "text/css; charset=utf-8" } });
  if (path === "/admin.js") return new Response(ADMIN_JS, { headers: { "content-type": "text/javascript; charset=utf-8" } });
  const ctx = { admin, host: new URL(env.PUBLIC_URL).host, signups: env.SIGNUPS, counts: await navCounts(env) };
  if (path === "/") {
    return html(renderOverview(ctx, await overview(env), await listAccounts(env, "", "all", 5)));
  }
  if (path === "/accounts") {
    const q = url.searchParams.get("q") ?? "";
    const filter = parseFilter(url.searchParams.get("filter"));
    return html(renderAccounts(ctx, await listAccounts(env, q, filter), q, filter, await listPlans(env)));
  }
  const am = /^\/accounts\/([0-9a-f-]{36})$/.exec(path);
  if (am) {
    const detail = await accountDetail(env, am[1]);
    return html(renderAccount(ctx, detail, await listPlans(env), await listAudit(env, am[1], 20)));
  }
  if (path === "/plans") return html(renderPlans(ctx, await listPlans(env)));
  if (path === "/invites") return html(renderInvites(ctx, await listInvites(env)));
  if (path === "/audit") {
    const user = url.searchParams.get("user");
    const uid = user && /^[0-9a-f-]{36}$/.test(user) ? user : null;
    return html(renderAudit(ctx, await listAudit(env, uid), uid));
  }
  throw new HttpError("not_found", 404, "Not found");
}

async function navCounts(env: Env) {
  const r = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM users) AS accounts, (SELECT COUNT(*) FROM plans WHERE archived = 0) AS plans, (SELECT COUNT(*) FROM invites) AS invites",
  ).first<{ accounts: number; plans: number; invites: number }>();
  return { accounts: r?.accounts ?? 0, plans: r?.plans ?? 0, invites: r?.invites ?? 0 };
}

function secure(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export async function handleAdmin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "/";
  const isApi = path === "/api" || path.startsWith("/api/");
  try {
    const admin = verifyAdmin(req, env);
    return secure(isApi ? await apiRoute(req, env, admin, path, url) : await pageRoute(req, env, admin, path, url));
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    if (!isApi && e.status === 404 && e.code === "not_found") return secure(html(renderNotFound(), 404));
    if (isApi || e.status === 401) return secure(errorFrom(e));
    return secure(new Response(`${e.message}\n`, { status: e.status, headers: { "content-type": "text/plain; charset=utf-8" } }));
  }
}
