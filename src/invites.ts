// Invite codes: a short code a person types or follows as a link to create an account.
import { randomInt } from "node:crypto";
import type { Statement } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Env } from "./index.ts";

// Letters and digits without the look-alikes 0 O 1 l I.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const CODE_LENGTH = 6;
const DAY_MS = 86_400_000;

export type InviteKind = "member" | "owner";

export interface InviteRow {
  code: string;
  label: string;
  kind: InviteKind;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  /** Set on used rows: the account that joined with the code, if it still exists. */
  name: string | null;
  email: string | null;
}

export const invalidInvite = () => new HttpError("invite_invalid", 403, "That invite code has been used, cancelled or has run out.");

function newCode(): string {
  let c = "";
  for (let i = 0; i < CODE_LENGTH; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return c;
}

export function createInvite(
  env: Env,
  opts: { label: string; days: 7 | 30 | null; kind?: InviteKind; origin: string },
): { code: string; url: string } {
  const now = Date.now();
  const expires = opts.days === null ? null : new Date(now + opts.days * DAY_MS).toISOString();
  for (;;) {
    const code = newCode();
    try {
      env.DB.prepare("INSERT INTO invites (code, label, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(code, opts.label, opts.kind ?? "member", new Date(now).toISOString(), expires)
        .execSync();
      return { code, url: `${opts.origin}/join/${code}` };
    } catch (e) {
      // A clash with an existing code is vanishingly rare: pick another.
      if (!String(e).includes("UNIQUE")) throw e;
    }
  }
}

/** The link that opens the Tessh app on the owner sign-up page with the server, code and the admin email filled in. */
export function ownerJoinLink(env: Env, origin: string, code: string): string {
  const row = env.DB.prepare("SELECT email FROM owner WHERE id = 1").firstSync<{ email: string }>();
  const email = row?.email ? `&email=${encodeURIComponent(row.email)}` : "";
  return `tessh://join?server=${encodeURIComponent(origin)}&code=${encodeURIComponent(code)}${email}`;
}

/** Cancels a code that is still waiting; a used, cancelled or unknown code is a 404. */
export function cancelInvite(env: Env, code: string): void {
  const r = env.DB.prepare("UPDATE invites SET cancelled_at = ? WHERE code = ? AND used_at IS NULL AND cancelled_at IS NULL")
    .bind(new Date().toISOString(), code)
    .execSync();
  if (r.meta.changes === 0) throw new HttpError("not_found", 404, "Invite not found");
}

interface Row {
  code: string;
  label: string;
  kind: InviteKind;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
  username: string | null;
  email: string | null;
}

const view = (r: Row): InviteRow => ({
  code: r.code,
  label: r.label,
  kind: r.kind,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
  name: r.username,
  email: r.email,
});

const COLUMNS = "i.code, i.label, i.kind, i.created_at, i.expires_at, i.used_at, u.username, u.email";

/** Waiting: not used, cancelled or expired. Used: kept with who joined. Cancelled and expired codes are not listed. */
export function listInvites(env: Env): { waiting: InviteRow[]; used: InviteRow[] } {
  const now = new Date().toISOString();
  const waiting = env.DB.prepare(
    `SELECT ${COLUMNS} FROM invites i LEFT JOIN users u ON u.id = i.used_by
     WHERE i.used_at IS NULL AND i.cancelled_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > ?)
     ORDER BY i.created_at DESC, i.code`,
  )
    .bind(now)
    .execSync<Row>().results;
  const used = env.DB.prepare(
    `SELECT ${COLUMNS} FROM invites i LEFT JOIN users u ON u.id = i.used_by
     WHERE i.used_at IS NOT NULL ORDER BY i.used_at DESC, i.code`,
  ).execSync<Row>().results;
  return { waiting: waiting.map(view), used: used.map(view) };
}

// ---- Wrong invite codes ----
// One counter for every place that tells a caller whether a code works: sign-up and the invite page.

const WINDOW_MS = 15 * 60_000;

const INVITE_MAX_WRONG = 10;
const INVITE_MAX_WRONG_ALL = 200;
const INVITE_MAX_TRACKED = 10_000;
const inviteFailures = new Map<string, { count: number; since: number }>();
let inviteGlobal = { count: 0, since: 0 };

/** Forgets every address's wrong invite codes. */
export function resetInviteAttempts(): void {
  inviteFailures.clear();
  inviteGlobal = { count: 0, since: 0 };
}

const tooManyCodes = (since: number, now: number) =>
  new HttpError("too_many_attempts", 429, "Too many wrong invite codes. Try again in 15 minutes.", undefined, {
    "retry-after": String(Math.max(1, Math.ceil((WINDOW_MS - (now - since)) / 1000))),
  });

/** 429 once an address (IPv6 by /64) has 10 wrong codes in 15 minutes, or every address once there are 200. */
export function checkInviteLimit(key: string, now: number): void {
  for (const [k, a] of inviteFailures) if (now - a.since > WINDOW_MS) inviteFailures.delete(k);
  if (now - inviteGlobal.since > WINDOW_MS) inviteGlobal = { count: 0, since: now };
  const a = inviteFailures.get(key);
  if (a && a.count >= INVITE_MAX_WRONG) throw tooManyCodes(a.since, now);
  if (inviteGlobal.count >= INVITE_MAX_WRONG_ALL) throw tooManyCodes(inviteGlobal.since, now);
}

export function countInviteFailure(key: string, now: number): void {
  inviteGlobal.count++;
  const a = inviteFailures.get(key);
  if (a) a.count++;
  else {
    while (inviteFailures.size >= INVITE_MAX_TRACKED) inviteFailures.delete(inviteFailures.keys().next().value as string);
    inviteFailures.set(key, { count: 1, since: now });
  }
}

/** The invite if it is still usable now, else null. */
export function findUsableInvite(env: Env, code: string): { kind: InviteKind } | null {
  return env.DB.prepare(
    `SELECT kind FROM invites WHERE code = ? AND used_at IS NULL AND cancelled_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(code, new Date().toISOString())
    .execSync<{ kind: InviteKind }>().results[0] ?? null;
}

/**
 * Batch statements that consume `code` for `userId`: a guard that fails the whole batch when the code is
 * no longer usable (so a racing second sign-up creates no account), then the update. Put them after the
 * user insert; a failure rolls the batch back.
 */
export function consumeInviteStatements(env: Env, code: string, userId: string, nowIso: string): Statement[] {
  const usable = "code = ? AND used_at IS NULL AND cancelled_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
  return [
    env.DB.prepare(`INSERT INTO quota_guard (ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM invites WHERE ${usable})`).bind(code, nowIso),
    env.DB.prepare(`UPDATE invites SET used_at = ?, used_by = ? WHERE ${usable}`).bind(nowIso, userId, code, nowIso),
  ];
}
