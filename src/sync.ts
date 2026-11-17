import { BASE64_BLOB_RE, authenticate } from "./auth.ts";
import { LIMIT_SQL, assertNotSuspended, type EffectiveLimits } from "./limits.ts";
import { HttpError, json, readJSON } from "./http.ts";
import type { Env } from "./index.ts";

const PAGE = 500;
const MAX_BLOB = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (msg: string) => new HttpError("invalid_request", 400, msg);

interface NewItem {
  id: string;
  deleted: boolean;
  blob: string | null;
  size: number;
}

function parseItems(body: unknown): NewItem[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("Invalid body");
  const raw = (body as Record<string, unknown>).items;
  if (!Array.isArray(raw)) throw invalid("items must be an array");
  if (raw.length > PAGE) throw invalid(`At most ${PAGE} items per push`);
  const seen = new Set<string>();
  return raw.map((v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalid("Invalid item");
    const { id, deleted, blob } = v as Record<string, unknown>;
    if (typeof id !== "string" || !UUID.test(id)) throw invalid("Item id must be a UUID");
    const key = id.toLowerCase();
    if (seen.has(key)) throw invalid("Duplicate item id");
    seen.add(key);
    if (typeof deleted !== "boolean") throw invalid("deleted must be a boolean");
    // A tombstone carries its sealed model (so deletes take part in last-write-wins) or, from older
    // clients and for key secrets, a null blob. A live item always has a blob.
    if (deleted && blob === null) return { id: key, deleted, blob: null, size: 0 };
    if (typeof blob !== "string" || blob.length === 0) throw invalid("blob must be a non-empty string");
    if (!BASE64_BLOB_RE.test(blob)) throw invalid("blob must be base64");
    if (blob.length > MAX_BLOB) throw invalid(`blob over ${MAX_BLOB} characters`);
    return { id: key, deleted, blob, size: blob.length };
  });
}

async function pull(req: Request, env: Env): Promise<Response> {
  const a = await authenticate(req, env);
  await assertNotSuspended(env, a.userId);
  const raw = new URL(req.url).searchParams.get("since") ?? "0";
  if (!/^\d{1,15}$/.test(raw)) throw invalid("since must be a non-negative integer");
  const since = Number(raw);
  const { results } = await env.DB.prepare(
    "SELECT id, version, deleted, blob FROM items WHERE user_id = ? AND version > ? ORDER BY version LIMIT ?",
  )
    .bind(a.userId, since, PAGE + 1)
    .all<{ id: string; version: number; deleted: number; blob: string | null }>();
  const hasMore = results.length > PAGE;
  const items = results.slice(0, PAGE).map((r) => ({ id: r.id, version: r.version, deleted: r.deleted === 1, blob: r.blob }));
  return json({ items, cursor: items.length ? items[items.length - 1].version : since, hasMore });
}

const quotaExceeded = () => new HttpError("quota_exceeded", 413, "Sync storage is full");

/** Pre-check for the normal 413 path. The authoritative guard is the last statement of the batch. */
async function checkQuota(env: Env, userId: string, items: NewItem[], limits: EffectiveLimits): Promise<void> {
  const ids = JSON.stringify(items.map((i) => i.id));
  const cur = await env.DB.prepare(
    `SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS items,
            COALESCE(SUM(CASE WHEN id IN (SELECT value FROM json_each(?1)) THEN size END), 0) AS rbytes,
            COALESCE(SUM(CASE WHEN id IN (SELECT value FROM json_each(?1)) THEN 1 END), 0) AS ritems
     FROM items WHERE user_id = ?2`,
  )
    .bind(ids, userId)
    .first<{ bytes: number; items: number; rbytes: number; ritems: number }>();
  const newBytes = items.reduce((s, i) => s + i.size, 0);
  if ((cur?.bytes ?? 0) - (cur?.rbytes ?? 0) + newBytes > limits.bytes) throw quotaExceeded();
  if ((cur?.items ?? 0) - (cur?.ritems ?? 0) + items.length > limits.items) throw quotaExceeded();
}

/**
 * One batch (a single transaction): bump the cursor, write every item with a version derived from the
 * bumped cursor, then a guard row that violates a CHECK (rolling everything back) if the account is over quota.
 */
export async function writeItems(env: Env, userId: string, items: NewItem[]) {
  const n = items.length;
  const stmts = [
    env.DB.prepare("UPDATE users SET cursor = cursor + ? WHERE id = ? RETURNING cursor").bind(n, userId),
    ...items.map((it, i) =>
      env.DB.prepare(
        `INSERT INTO items (user_id, id, version, deleted, blob, size)
         VALUES (?1, ?2, (SELECT cursor FROM users WHERE id = ?1) - ?3, ?4, ?5, ?6)
         ON CONFLICT (user_id, id) DO UPDATE SET version = excluded.version, deleted = excluded.deleted,
           blob = excluded.blob, size = excluded.size`,
      ).bind(userId, it.id, n - 1 - i, it.deleted ? 1 : 0, it.blob, it.size),
    ),
    env.DB.prepare(
      // Effective limits resolved in SQL (override ?? plan ?? default), read inside this transaction.
      `INSERT INTO quota_guard (ok) SELECT 0 FROM ${LIMIT_SQL.from}
       WHERE u.id = ?1
         AND ((SELECT COALESCE(SUM(size), 0) FROM items WHERE user_id = ?1) > ${LIMIT_SQL.bytes}
           OR (SELECT COUNT(*) FROM items WHERE user_id = ?1) > ${LIMIT_SQL.items})`,
    ).bind(userId),
  ];
  let out;
  try {
    out = await env.DB.batch(stmts);
  } catch (e) {
    const m = String(e);
    if (m.includes("quota_guard") || m.includes("CHECK constraint")) throw quotaExceeded();
    if (m.includes("NOT NULL") || m.includes("FOREIGN KEY")) throw new HttpError("unauthorized", 401, "Missing or invalid token");
    throw e;
  }
  const cursor = (out[0].results[0] as { cursor: number } | undefined)?.cursor;
  if (cursor === undefined) throw new HttpError("unauthorized", 401, "Missing or invalid token");
  const versions: Record<string, number> = {};
  items.forEach((it, i) => (versions[it.id] = cursor - (n - 1 - i)));
  return { versions, cursor };
}

async function push(req: Request, env: Env): Promise<Response> {
  const a = await authenticate(req, env);
  const limits = await assertNotSuspended(env, a.userId);
  const items = parseItems(await readJSON(req));
  if (items.length === 0) {
    const u = await env.DB.prepare("SELECT cursor FROM users WHERE id = ?").bind(a.userId).first<{ cursor: number }>();
    if (!u) throw new HttpError("unauthorized", 401, "Missing or invalid token");
    return json({ versions: {}, cursor: u.cursor });
  }
  await checkQuota(env, a.userId, items, limits);
  return json(await writeItems(env, a.userId, items));
}

export async function syncRoutes(req: Request, env: Env): Promise<Response | null> {
  if (new URL(req.url).pathname !== "/v1/sync") return null;
  if (req.method === "GET") return pull(req, env);
  if (req.method === "POST") return push(req, env);
  return null;
}
