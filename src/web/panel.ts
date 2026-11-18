// The owner's panel at /admin: Overview, Devices (just me) or Team and Invites, Activity, Settings and
// Maintenance, plus its JSON API under
// /admin/api/. Every page and call needs an owner session (src/owner.ts); writes also need the panel header and
// a same-origin request, and every change is written to the audit log under the owner's email.
// Zero-knowledge: only names, emails, usernames, device names, counts, sizes and dates leave here. The panel never
// shows vault data, keys, hashes, salts or auth data. The one exception is the owner's full backup download, which
// is the whole database and so needs the owner's password (and authenticator code) again.
import { deleteUserStatements } from "../accounts.ts";
import { backupBytes, dateStamp, lastBackupAt } from "../backup.ts";
import { normalisePublicURL, type Signups } from "../config.ts";
import { HttpError, MAX_BODY_BYTES, errorFrom, json } from "../http.ts";
import type { Env } from "../index.ts";
import { cancelInvite, createInvite, listInvites } from "../invites.ts";
import { LIMIT_SQL, NO_LIMIT } from "../limits.ts";
import {
  changeOwnerPassword,
  checkWrite,
  confirmOwner,
  confirmTotp,
  disableTotp,
  endOtherSessions,
  listOwnerSessions,
  ownerInfo,
  requireOwner,
  signIn,
  signOut,
  startTotp,
} from "../owner.ts";
import { ADDRESS_HINT, originFor, saveSetting, type SettingKey } from "../settings.ts";
import {
  formatBytes,
  isApple,
  renderActivity,
  renderDevices,
  renderInvites,
  renderMaintenance,
  renderLogin,
  renderNotFound,
  renderOverview,
  renderSettings,
  renderTeam,
  type Health,
  type PanelContext,
} from "./panel-views.ts";

const DAY = 86_400_000;
const SESSION_IDLE_MS = 30 * DAY;
const SESSION_MAX_MS = 90 * DAY;
const MAX_LABEL = 64;
const ID_RE = /^[0-9a-f-]{36}$/;
const CODE_RE = /^[A-Za-z0-9]{1,32}$/;

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const SECURITY: Record<string, string> = {
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const invalid = (msg: string) => new HttpError("invalid_request", 400, msg);
const notFound = (what = "Not found") => new HttpError("not_found", 404, what);
const ownAccount = () => new HttpError("cannot_remove_owner", 409, "That's your own account. Remove it from the app instead.");

// ---- Data ----

/** A person's display name: their username, else the part of their email before the @. */
export const displayName = (u: { username: string | null; email: string }): string => u.username ?? u.email.split("@")[0];

export interface Device {
  id: string;
  name: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface Person {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: "owner" | "member";
  /** `<host>/<username>`, or null until they pick a username. */
  keyPage: string | null;
  suspended: boolean;
  createdAt: string;
  devices: Device[];
  usage: { bytes: number; items: number };
  /** bytes: the limit in force, -1 for no limit. custom: their own limit rather than the server default. */
  limit: { bytes: number; custom: boolean };
}

interface PersonRow {
  id: string;
  email: string;
  username: string | null;
  created_at: string;
  suspended_at: string | null;
  bytes_limit: number | null;
  bytes: number;
  items: number;
  lim_bytes: number;
}

async function people(env: Env, host: string, onlyId?: string): Promise<Person[]> {
  const where = onlyId ? " WHERE u.id = ?" : "";
  const rows = (
    await env.DB.prepare(
      `SELECT u.id, u.email, u.username, u.created_at, u.suspended_at, u.bytes_limit,
         (SELECT COALESCE(SUM(size), 0) FROM items WHERE user_id = u.id) AS bytes,
         (SELECT COUNT(*) FROM items WHERE user_id = u.id AND deleted = 0) AS items,
         ${LIMIT_SQL.bytes} AS lim_bytes
       FROM ${LIMIT_SQL.from}${where} ORDER BY u.created_at, u.id`,
    )
      .bind(...(onlyId ? [onlyId] : []))
      .all<PersonRow>()
  ).results;
  const devices = (
    await env.DB.prepare(
      `SELECT id, user_id, name, platform, created_at, last_seen_at FROM devices${onlyId ? " WHERE user_id = ?" : ""} ORDER BY last_seen_at DESC, id`,
    )
      .bind(...(onlyId ? [onlyId] : []))
      .all<{ id: string; user_id: string; name: string; platform: string; created_at: string; last_seen_at: string }>()
  ).results;
  const byUser = new Map<string, Device[]>();
  for (const d of devices) {
    const list = byUser.get(d.user_id) ?? [];
    list.push({ id: d.id, name: d.name, platform: d.platform, createdAt: d.created_at, lastSeenAt: d.last_seen_at });
    byUser.set(d.user_id, list);
  }
  const owner = env.SETTINGS.ownerUserId;
  const list = rows.map(
    (r): Person => ({
      id: r.id,
      name: displayName(r),
      email: r.email,
      username: r.username,
      role: r.id === owner ? "owner" : "member",
      keyPage: r.username ? `${host}/${r.username}` : null,
      suspended: r.suspended_at !== null,
      createdAt: r.created_at,
      devices: byUser.get(r.id) ?? [],
      usage: { bytes: r.bytes, items: r.items },
      limit: { bytes: r.lim_bytes >= Number.MAX_SAFE_INTEGER ? NO_LIMIT : r.lim_bytes, custom: r.bytes_limit !== null },
    }),
  );
  // The owner first, then everyone else in the order they joined.
  return list.sort((a, b) => (a.role === b.role ? 0 : a.role === "owner" ? -1 : 1));
}

/** The newer version when there is one, null when up to date, undefined when the update check is off. */
export const updateState = (env: Env): string | null | undefined => (env.UPDATE_CHECK ? (env.UPDATE_LATEST ?? null) : undefined);

export interface Overview {
  people: number;
  devices: number;
  /** capacity: the sum of everyone's limits, or null when anyone has no limit. */
  storage: { bytes: number; capacity: number | null };
  version: string;
  /** The update check's answer: the newer version, null when up to date, undefined when the check is off. */
  update: string | null | undefined;
  recent: ActivityEvent[];
}

async function overview(env: Env, host: string, everyone?: Person[]): Promise<Overview> {
  const list = everyone ?? (await people(env, host));
  const unlimited = list.some((p) => p.limit.bytes === NO_LIMIT);
  return {
    people: list.length,
    devices: list.reduce((n, p) => n + p.devices.length, 0),
    storage: {
      bytes: list.reduce((n, p) => n + p.usage.bytes, 0),
      capacity: unlimited || list.length === 0 ? null : list.reduce((n, p) => n + p.limit.bytes, 0),
    },
    version: env.VERSION,
    update: updateState(env),
    recent: await activity(env, null, 5),
  };
}

// ---- Activity ----

export interface ActivityEvent {
  at: string;
  kind: "audit" | "signup" | "device";
  /** What happened, in a sentence. */
  text: string;
  /** Which icon the row shows: a line icon name, or "apple"/"device" for a device tile. */
  icon: "plus" | "mail" | "gear" | "people" | "lock" | "signout" | "apple" | "device";
  userId: string | null;
}

const SIGNUPS_WORDS: Record<Signups, string> = { invite: "invite only", open: "anyone with the address", closed: "just you" };

function auditText(action: string, d: Record<string, unknown>): { text: string; icon: ActivityEvent["icon"] } {
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
  const name = s("name") || "someone";
  switch (action) {
    case "device_sign_out":
      return { text: `You signed ${name} out on ${s("device") || "a device"}`, icon: "signout" };
    case "storage_limit": {
      const b = d.bytes;
      const to = b === null || b === undefined ? "the server default" : typeof b === "number" && b < 0 ? "no limit" : formatBytes(Number(b));
      return { text: `You set ${name}'s storage to ${to}`, icon: "people" };
    }
    case "suspend":
      return { text: `You suspended ${name}`, icon: "people" };
    case "unsuspend":
      return { text: `You lifted ${name}'s suspension`, icon: "people" };
    case "remove":
      return { text: `You removed ${name}`, icon: "people" };
    case "invite_create":
      return { text: `You made an invite for ${s("label")}`, icon: "mail" };
    case "invite_cancel":
      return { text: `You cancelled the invite for ${s("label")}`, icon: "mail" };
    case "setting": {
      const v = d.value;
      switch (s("key")) {
        case "name":
          return { text: `Name changed to ${String(v)}`, icon: "gear" };
        case "public_url":
          return { text: `Address changed to ${String(v)}`, icon: "gear" };
        case "signups":
          return { text: `Sign-ups changed to ${SIGNUPS_WORDS[v as Signups] ?? String(v)}`, icon: "gear" };
        case "default_bytes":
          return { text: `Storage per person changed to ${formatBytes(Number(v))}`, icon: "gear" };
      }
      return { text: "Settings changed", icon: "gear" };
    }
    case "owner_password":
      return { text: "You changed the owner password", icon: "lock" };
    case "totp_on":
      return { text: "You turned on the authenticator", icon: "lock" };
    case "totp_off":
      return { text: "You turned off the authenticator", icon: "lock" };
    case "backup.download":
      return { text: "You downloaded a backup", icon: "gear" };
    case "sessions_end_others":
      return { text: "You signed out your other sessions", icon: "lock" };
  }
  return { text: action.replace(/_/g, " "), icon: "gear" };
}

/** Panel changes, sign-ups and new devices, newest first. `userId` keeps one person's. */
export async function activity(env: Env, userId: string | null, limit = 200): Promise<ActivityEvent[]> {
  const audit = (
    await env.DB.prepare(`SELECT at, action, user_id, detail FROM admin_audit${userId ? " WHERE user_id = ?" : ""} ORDER BY id DESC LIMIT ?`)
      .bind(...(userId ? [userId, limit] : [limit]))
      .all<{ at: string; action: string; user_id: string | null; detail: string }>()
  ).results.map((a): ActivityEvent => {
    let detail: Record<string, unknown> = {};
    try {
      detail = JSON.parse(a.detail);
    } catch {}
    return { at: a.at, kind: "audit", userId: a.user_id, ...auditText(a.action, detail) };
  });
  const joins = (
    await env.DB.prepare(
      `SELECT u.id, u.email, u.username, u.created_at, (SELECT kind FROM invites WHERE used_by = u.id LIMIT 1) AS invite
       FROM users u${userId ? " WHERE u.id = ?" : ""} ORDER BY u.created_at DESC, u.rowid DESC LIMIT ?`,
    )
      .bind(...(userId ? [userId, limit] : [limit]))
      .all<{ id: string; email: string; username: string | null; created_at: string; invite: "member" | "owner" | null }>()
  ).results.map(
    (u): ActivityEvent => ({
      at: u.created_at,
      kind: "signup",
      userId: u.id,
      icon: "plus",
      text: `${displayName(u)} joined${u.invite === "owner" ? " with the owner code" : u.invite === "member" ? " with an invite" : ""}`,
    }),
  );
  // Every device except the one an account was made on (that is the sign-up).
  const devices = (
    await env.DB.prepare(
      `SELECT d.name, d.platform, d.created_at, u.id, u.email, u.username FROM devices d JOIN users u ON u.id = d.user_id
       WHERE NOT (d.created_at = u.created_at AND d.rowid = (SELECT MIN(rowid) FROM devices WHERE user_id = d.user_id))
       ${userId ? "AND u.id = ?" : ""} ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
    )
      .bind(...(userId ? [userId, limit] : [limit]))
      .all<{ name: string; platform: string; created_at: string; id: string; email: string; username: string | null }>()
  ).results.map(
    (d): ActivityEvent => ({
      at: d.created_at,
      kind: "device",
      userId: d.id,
      icon: isApple(d.platform) ? "apple" : "device",
      text: `${displayName(d)} signed in on ${d.name}`,
    }),
  );
  // Within the same instant a panel change comes after a sign-in, and a sign-in after the sign-up.
  const rank = { audit: 0, device: 1, signup: 2 };
  return [...audit, ...devices, ...joins]
    .sort((a, b) => (a.at === b.at ? rank[a.kind] - rank[b.kind] : a.at < b.at ? 1 : -1))
    .slice(0, limit);
}

// ---- Writes ----

function audit(env: Env, actor: string, action: string, userId: string | null, detail: Record<string, unknown> = {}) {
  return env.DB.prepare("INSERT INTO admin_audit (at, actor, action, user_id, detail) VALUES (?, ?, ?, ?, ?)").bind(
    new Date().toISOString(),
    actor,
    action,
    userId,
    JSON.stringify(detail),
  );
}

async function personRow(env: Env, id: string) {
  const u = await env.DB.prepare("SELECT id, email, username, suspended_at FROM users WHERE id = ?")
    .bind(id)
    .first<{ id: string; email: string; username: string | null; suspended_at: string | null }>();
  if (!u) throw notFound("Person not found");
  return u;
}

/** A write's JSON body, at most 1 MiB; an empty body is an empty object. */
async function body(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) throw invalid("Request body too large");
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return {};
  if (buf.byteLength > MAX_BODY_BYTES) throw invalid("Request body too large");
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw invalid("Invalid JSON");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw invalid("Expected a JSON object");
  return v as Record<string, unknown>;
}

async function signOutDevice(env: Env, actor: string, userId: string, deviceId: string): Promise<Response> {
  const u = await personRow(env, userId);
  const d = await env.DB.prepare("SELECT name FROM devices WHERE id = ? AND user_id = ?").bind(deviceId, userId).first<{ name: string }>();
  if (!d) throw notFound("Device not found");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE device_id = ? AND user_id = ?").bind(deviceId, userId),
    env.DB.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?").bind(deviceId, userId),
    audit(env, actor, "device_sign_out", userId, { name: displayName(u), device: d.name }),
  ]);
  return json({ ok: true });
}

async function setLimit(env: Env, actor: string, userId: string, b: Record<string, unknown>): Promise<Response> {
  const u = await personRow(env, userId);
  const v = b.bytes;
  if (!(v === null || v === NO_LIMIT || (typeof v === "number" && Number.isSafeInteger(v) && v > 0))) {
    throw invalid("Storage must be a size in bytes, -1 for no limit, or null for the server default");
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET bytes_limit = ? WHERE id = ?").bind(v, userId),
    audit(env, actor, "storage_limit", userId, { name: displayName(u), bytes: v }),
  ]);
  return json({ ok: true });
}

async function setSuspended(env: Env, actor: string, userId: string, b: Record<string, unknown>): Promise<Response> {
  const u = await personRow(env, userId);
  if (typeof b.suspended !== "boolean") throw invalid("suspended must be true or false");
  if (b.suspended && userId === env.SETTINGS.ownerUserId) throw ownAccount();
  if (b.suspended === (u.suspended_at !== null)) return json({ ok: true });
  await env.DB.batch([
    b.suspended
      ? env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ? AND suspended_at IS NULL").bind(new Date().toISOString(), userId)
      : env.DB.prepare("UPDATE users SET suspended_at = NULL WHERE id = ?").bind(userId),
    audit(env, actor, b.suspended ? "suspend" : "unsuspend", userId, { name: displayName(u) }),
  ]);
  return json({ ok: true });
}

async function removePerson(env: Env, actor: string, userId: string): Promise<Response> {
  const u = await personRow(env, userId);
  if (userId === env.SETTINGS.ownerUserId) throw ownAccount();
  // The audit row keeps the name and email: the account it points at is gone.
  await env.DB.batch([audit(env, actor, "remove", userId, { name: displayName(u), email: u.email }), ...deleteUserStatements(env, userId)]);
  return json({ ok: true });
}

async function newInvite(req: Request, env: Env, actor: string, b: Record<string, unknown>): Promise<Response> {
  const label = typeof b.label === "string" ? b.label.trim() : "";
  if (label.length < 1 || label.length > MAX_LABEL) throw invalid(`Give the invite a name, up to ${MAX_LABEL} characters`);
  if (b.days !== 7 && b.days !== 30) throw invalid("An invite runs for 7 or 30 days");
  const invite = createInvite(env, { label, days: b.days, kind: "member", origin: originFor(req, env) });
  await audit(env, actor, "invite_create", null, { label, days: b.days }).run();
  return json(invite);
}

async function removeInvite(env: Env, actor: string, code: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT label FROM invites WHERE code = ?").bind(code).first<{ label: string }>();
  cancelInvite(env, code);
  await audit(env, actor, "invite_cancel", null, { label: row?.label ?? "" }).run();
  return json({ ok: true });
}

/** The whole database, after the owner confirms with their password (and code). It holds every account's hashes and wrapped keys. */
async function downloadBackup(req: Request, env: Env, actor: string, b: Record<string, unknown>): Promise<Response> {
  await confirmOwner(env, req, { password: b.password, code: b.code });
  const file = backupBytes(env);
  await audit(env, actor, "backup.download", null).run();
  return new Response(file, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="tessh-backup-${dateStamp(new Date())}.db"`,
    },
  });
}

async function saveSettings(env: Env, actor: string, b: Record<string, unknown>): Promise<Response> {
  const fields: [string, SettingKey][] = [
    ["name", "name"],
    ["address", "public_url"],
    ["signups", "signups"],
    ["defaultBytes", "default_bytes"],
  ];
  const given = fields.filter(([k]) => b[k] !== undefined);
  if (given.length === 0) throw invalid("Nothing to change");
  for (const [, key] of given) {
    if (env.SETTINGS.locked[key as keyof typeof env.SETTINGS.locked]) throw new HttpError("locked_by_env", 409, "Set by the server's environment");
  }
  // Check every value before saving any.
  const values = new Map<SettingKey, string>();
  for (const [k, key] of given) {
    const v = b[k];
    switch (key) {
      case "name": {
        const name = typeof v === "string" ? v.trim() : "";
        if (name.length < 1 || name.length > 64) throw invalid("The name must be 1 to 64 characters");
        values.set(key, name);
        break;
      }
      case "public_url":
        try {
          values.set(key, normalisePublicURL(typeof v === "string" ? v.trim() : ""));
        } catch {
          throw invalid(ADDRESS_HINT);
        }
        break;
      case "signups":
        if (v !== "open" && v !== "invite" && v !== "closed") throw invalid("Choose who can join");
        values.set(key, v);
        break;
      case "default_bytes":
        if (!(typeof v === "number" && Number.isSafeInteger(v) && (v === NO_LIMIT || v > 0))) throw invalid("Choose the storage per person");
        values.set(key, String(v));
        break;
    }
  }
  // What the server serves now; an unchanged value is neither saved nor logged.
  const current: Partial<Record<SettingKey, string>> = {
    name: env.SERVER_NAME,
    public_url: env.PUBLIC_URL ?? "",
    signups: env.SIGNUPS,
    default_bytes: String(env.SETTINGS.defaultBytes),
  };
  for (const [key, value] of values) {
    if (current[key] === value) continue;
    saveSetting(env, key, value);
    await audit(env, actor, "setting", null, { key, value: key === "default_bytes" ? Number(value) : value }).run();
  }
  return json({ ok: true });
}

// ---- Routing ----

const str = (v: unknown) => (typeof v === "string" ? v : "");

async function api(req: Request, env: Env, path: string, url: URL): Promise<Response> {
  const { tokenHash } = await requireOwner(env, req);
  const host = new URL(originFor(req, env)).host;
  const m = req.method;
  if (m === "GET" || m === "HEAD") {
    if (path === "overview") return json(await overview(env, host));
    if (path === "team") return json({ people: await people(env, host) });
    if (path === "activity") return json({ events: await activity(env, await activityUser(env, url)) });
    throw notFound();
  }
  const actor = (await ownerInfo(env))?.email ?? "owner";
  const b = await body(req);
  let r: RegExpExecArray | null;
  if ((r = /^team\/([^/]+)\/devices\/([^/]+)\/sign-out$/.exec(path)) && m === "POST") {
    if (!ID_RE.test(r[1]) || !ID_RE.test(r[2])) throw notFound();
    return signOutDevice(env, actor, r[1], r[2]);
  }
  if ((r = /^team\/([^/]+)(?:\/(limit|suspend))?$/.exec(path))) {
    if (!ID_RE.test(r[1])) throw notFound();
    if (r[2] === "limit" && m === "POST") return setLimit(env, actor, r[1], b);
    if (r[2] === "suspend" && m === "POST") return setSuspended(env, actor, r[1], b);
    if (r[2] === undefined && m === "DELETE") return removePerson(env, actor, r[1]);
    throw notFound();
  }
  if (path === "invites" && m === "POST") return newInvite(req, env, actor, b);
  if ((r = /^invites\/([^/]+)$/.exec(path)) && m === "DELETE") {
    if (!CODE_RE.test(r[1])) throw notFound("Invite not found");
    return removeInvite(env, actor, r[1]);
  }
  if (m !== "POST") throw notFound();
  switch (path) {
    case "settings":
      return saveSettings(env, actor, b);
    case "backup":
      return downloadBackup(req, env, actor, b);
    case "owner/password":
      await changeOwnerPassword(env, req, tokenHash, str(b.current), str(b.next));
      await audit(env, actor, "owner_password", null).run();
      return json({ ok: true });
    case "owner/totp/start":
      return json(await startTotp(env));
    case "owner/totp/confirm":
      await confirmTotp(env, str(b.code), req);
      await audit(env, actor, "totp_on", null).run();
      return json({ ok: true });
    case "owner/totp/disable":
      await disableTotp(env, req, str(b.password));
      await audit(env, actor, "totp_off", null).run();
      return json({ ok: true });
    case "owner/sessions/end-others": {
      const count = await endOtherSessions(env, tokenHash);
      await audit(env, actor, "sessions_end_others", null, { count }).run();
      return json({ ok: true, count });
    }
    case "signout":
      return json({ ok: true }, 200, { "set-cookie": await signOut(env, req) });
  }
  throw notFound();
}

/** The `?user=` an Activity view is for: null for everyone, a 404 for a malformed or unknown id. */
async function activityUser(env: Env, url: URL): Promise<string | null> {
  const user = url.searchParams.get("user");
  if (user === null) return null;
  if (!ID_RE.test(user) || !(await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(user).first())) throw notFound("Person not found");
  return user;
}

/** Sidebar counts. Waiting invites are member invites only: the owner's own code is not an invite. */
async function sidebarCounts(env: Env): Promise<{ people: number; waiting: number }> {
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users) AS people,
       (SELECT COUNT(*) FROM invites WHERE kind = 'member' AND used_at IS NULL AND cancelled_at IS NULL AND (expires_at IS NULL OR expires_at > ?)) AS waiting`,
  )
    .bind(new Date().toISOString())
    .first<{ people: number; waiting: number }>();
  return { people: r?.people ?? 0, waiting: r?.waiting ?? 0 };
}

/** The owner's own Tessh account (the one that signed up with the owner code), or null until there is one. */
async function ownerAccount(env: Env, host: string): Promise<Person | null> {
  const id = env.SETTINGS.ownerUserId;
  return id ? ((await people(env, host, id))[0] ?? null) : null;
}

/** The owner code setup made, while it is still waiting to be used. */
async function ownerCode(env: Env): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT code FROM invites WHERE kind = 'owner' AND used_at IS NULL AND cancelled_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(new Date().toISOString())
    .first<{ code: string }>();
  return r?.code ?? null;
}

function health(env: Env, origin: string): Health {
  const last = env.DATA_DIR ? lastBackupAt(env.DATA_DIR) : null;
  return {
    uptimeMs: Math.round(process.uptime() * 1000),
    lastBackup: last ? last.toISOString() : null,
    https: (env.SETTINGS.publicURL ?? origin).startsWith("https:"),
  };
}

async function pages(req: Request, env: Env, path: string, url: URL): Promise<string> {
  const { tokenHash } = await requireOwner(env, req);
  const origin = originFor(req, env);
  const host = new URL(origin).host;
  const owner = (await ownerInfo(env)) ?? { email: "", totp: false };
  const ctx: PanelContext = { env, origin, host, counts: await sidebarCounts(env), now: Date.now(), ownerEmail: owner.email };
  if (path === "") {
    const list = await people(env, host);
    const mine = list.find((p) => p.role === "owner") ?? null;
    return renderOverview(ctx, await overview(env, host, list), {
      people: list,
      owner: mine,
      ownerCode: mine ? null : await ownerCode(env),
      health: health(env, origin),
    });
  }
  if (path === "devices") {
    const mine = await ownerAccount(env, host);
    return renderDevices(ctx, mine, mine ? null : await ownerCode(env));
  }
  if (path === "team") return renderTeam(ctx, await people(env, host), null);
  const t = /^team\/([^/]+)$/.exec(path);
  if (t) {
    const list = await people(env, host);
    if (!ID_RE.test(t[1]) || !list.some((p) => p.id === t[1])) throw notFound();
    return renderTeam(ctx, list, t[1]);
  }
  if (path === "invites") return renderInvites(ctx, listInvites(env));
  if (path === "activity") {
    const user = await activityUser(env, url);
    const who = user ? (await people(env, host, user))[0] : null;
    return renderActivity(ctx, await activity(env, user), who);
  }
  if (path === "settings") {
    const now = Date.now();
    const sessions = (await listOwnerSessions(env, tokenHash)).filter(
      (s) => now - Date.parse(s.last_seen_at) < SESSION_IDLE_MS && now - Date.parse(s.created_at) < SESSION_MAX_MS,
    );
    return renderSettings(ctx, owner, sessions);
  }
  if (path === "maintenance") return renderMaintenance(ctx, owner, health(env, origin));
  throw notFound();
}

async function login(req: Request, env: Env): Promise<Response> {
  if (req.method === "POST") {
    checkWrite(req, [new URL(originFor(req, env)).origin]);
    const b = await body(req);
    const { cookie } = await signIn(env, req, { email: b.email, password: b.password, code: b.code });
    return json({ ok: true }, 200, { "set-cookie": cookie });
  }
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError("invalid_request", 405, "Method not allowed", undefined, { allow: "GET, HEAD, POST" });
  try {
    await requireOwner(env, req);
    return new Response(null, { status: 302, headers: { location: "/admin" } });
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
  }
  return html(req, renderLogin(env));
}

const html = (req: Request, page: string, status = 200) =>
  new Response(req.method === "HEAD" ? null : page, { status, headers: { "content-type": "text/html; charset=utf-8" } });

function secure(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
  return out;
}

/** `/admin`, `/admin/*` and `/admin/api/*`. */
export async function panelRoutes(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "").slice("/admin".length).replace(/^\//, "");
  const isApi = path === "api" || path.startsWith("api/");
  try {
    if (path === "login") return secure(await login(req, env));
    if (isApi) return secure(await api(req, env, path.slice(4), url));
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError("invalid_request", 405, "Method not allowed", undefined, { allow: "GET, HEAD" });
    return secure(html(req, await pages(req, env, path, url)));
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    if (!isApi && path !== "login") {
      if (e.status === 401) return secure(new Response(null, { status: 302, headers: { location: "/admin/login" } }));
      if (e.status === 404) return secure(html(req, renderNotFound(env), 404));
    }
    return secure(errorFrom(e));
  }
}
