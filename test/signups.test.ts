import { describe, expect, it } from "vitest";
import { basic, makeEnv } from "./harness.ts";
import { handle, type Env } from "../src/index.ts";
import { handleAdmin } from "../src/admin.ts";
import { registerBody } from "./helpers.ts";
import { cancelInvite, createInvite, listInvites } from "../src/invites.ts";
import type { Signups } from "../src/config.ts";

function server(signups: Signups) {
  const env = makeEnv({ SIGNUPS: signups });
  const register = (email: string, invite?: string) =>
    handle(
      new Request("https://keys.test/v1/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registerBody(email, invite === undefined ? {} : { invite })),
      }),
      env,
    );
  const admin = (method: string, path: string, body?: unknown) =>
    handleAdmin(
      new Request(`https://admin.test${path}`, {
        method,
        headers: { authorization: basic(), "x-tessh-admin": "1", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
  return { env, register, admin };
}

const err = async (r: Response) => ((await r.json()) as { error: string }).error;

describe("sign-ups", () => {
  it("open: anyone can register", async () => {
    const s = server("open");
    expect((await s.register("anyone@example.com")).status).toBe(201);
  });

  const NOW = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  function seed(s: ReturnType<typeof server>, code: string, kind: "member" | "owner", over: { expires?: string; cancelled?: string; used?: string } = {}) {
    s.env.DB.prepare("INSERT INTO invites (code, label, kind, created_at, expires_at, cancelled_at, used_at) VALUES (?, 'Alice', ?, ?, ?, ?, ?)")
      .bind(code, kind, iso(NOW - 1000), over.expires ?? null, over.cancelled ?? null, over.used ?? null)
      .execSync();
  }
  const count = (s: ReturnType<typeof server>) => (s.env.DB.prepare("SELECT COUNT(*) AS n FROM users").execSync<{ n: number }>().results[0].n);

  type Case = { code: string | null; status: number; error?: string };
  const matrix: Record<Signups, Record<string, Case>> = {
    open: {
      none: { code: null, status: 201 },
      member: { code: "member", status: 201 },
      owner: { code: "owner", status: 201 },
      used: { code: "used", status: 403, error: "invite_invalid" },
      expired: { code: "expired", status: 403, error: "invite_invalid" },
      cancelled: { code: "cancelled", status: 403, error: "invite_invalid" },
    },
    invite: {
      none: { code: null, status: 403, error: "invite_required" },
      member: { code: "member", status: 201 },
      owner: { code: "owner", status: 201 },
      used: { code: "used", status: 403, error: "invite_invalid" },
      expired: { code: "expired", status: 403, error: "invite_invalid" },
      cancelled: { code: "cancelled", status: 403, error: "invite_invalid" },
    },
    closed: {
      none: { code: null, status: 403, error: "signups_closed" },
      member: { code: "member", status: 403, error: "signups_closed" },
      owner: { code: "owner", status: 201 },
      used: { code: "used", status: 403, error: "signups_closed" },
      expired: { code: "expired", status: 403, error: "signups_closed" },
      cancelled: { code: "cancelled", status: 403, error: "signups_closed" },
    },
  };

  for (const mode of ["open", "invite", "closed"] as const) {
    for (const [name, c] of Object.entries(matrix[mode])) {
      it(`${mode} with ${name} code: ${c.status}${c.error ? ` ${c.error}` : ""}`, async () => {
        const s = server(mode);
        seed(s, "member", "member");
        seed(s, "owner", "owner");
        seed(s, "used", "member", { used: iso(NOW - 500) });
        seed(s, "expired", "member", { expires: iso(NOW - 500) });
        seed(s, "cancelled", "member", { cancelled: iso(NOW - 500) });
        const r = await s.register("new@example.com", c.code ?? undefined);
        expect(r.status).toBe(c.status);
        if (c.error) expect(await err(r)).toBe(c.error);
        expect(count(s)).toBe(c.status === 201 ? 1 : 0);
        if (c.status === 201 && c.code) {
          const row = s.env.DB.prepare("SELECT used_at, used_by FROM invites WHERE code = ?").bind(c.code).execSync<{ used_at: string; used_by: string }>().results[0];
          expect(row.used_at).toBeTruthy();
          expect(row.used_by).toBeTruthy();
        }
      });
    }
  }

  it("a used code cannot be used twice", async () => {
    const s = server("invite");
    seed(s, "abc", "member");
    expect((await s.register("a@example.com", "abc")).status).toBe(201);
    const second = await s.register("b@example.com", "abc");
    expect(second.status).toBe(403);
    expect(await err(second)).toBe("invite_invalid");
    expect(count(s)).toBe(1);
  });

  it("two parallel sign-ups with one code: exactly one succeeds", async () => {
    const s = server("invite");
    seed(s, "abc", "member");
    const rs = await Promise.all([s.register("a@example.com", "abc"), s.register("b@example.com", "abc")]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 403]);
    expect(count(s)).toBe(1);
  });

  it("the owner code sets owner_user_id, in the database and live", async () => {
    const s = server("closed");
    seed(s, "owner", "owner");
    const r = await s.register("boss@example.com", "owner");
    expect(r.status).toBe(201);
    const id = s.env.DB.prepare("SELECT id FROM users WHERE email = 'boss@example.com'").execSync<{ id: string }>().results[0].id;
    expect(s.env.DB.prepare("SELECT value FROM settings WHERE key = 'owner_user_id'").execSync<{ value: string }>().results[0].value).toBe(id);
    expect(s.env.SETTINGS.ownerUserId).toBe(id);
  });

  it("a member code does not set the owner", async () => {
    const s = server("invite");
    seed(s, "abc", "member");
    await s.register("a@example.com", "abc");
    expect(s.env.DB.prepare("SELECT 1 FROM settings WHERE key = 'owner_user_id'").execSync().results).toEqual([]);
  });

  it("a rejected sign-up (email taken) leaves the code unused", async () => {
    const s = server("invite");
    seed(s, "a", "member");
    seed(s, "b", "member");
    expect((await s.register("a@example.com", "a")).status).toBe(201);
    const r = await s.register("a@example.com", "b");
    expect(r.status).toBe(409);
    expect(s.env.DB.prepare("SELECT used_at FROM invites WHERE code = 'b'").execSync<{ used_at: string | null }>().results[0].used_at).toBeNull();
  });

  it("createInvite makes a code from the alphabet with a join link and expiry", () => {
    const s = server("invite");
    const a = createInvite(s.env, { label: "Bob", days: 7, origin: "https://keys.test" });
    expect(a.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{6}$/);
    expect(a.url).toBe(`https://keys.test/join/${a.code}`);
    const row = s.env.DB.prepare("SELECT kind, expires_at FROM invites WHERE code = ?").bind(a.code).execSync<{ kind: string; expires_at: string }>().results[0];
    expect(row.kind).toBe("member");
    expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const b = createInvite(s.env, { label: "Never", days: null, kind: "owner", origin: "https://keys.test" });
    expect(s.env.DB.prepare("SELECT kind, expires_at FROM invites WHERE code = ?").bind(b.code).execSync().results[0]).toEqual({ kind: "owner", expires_at: null });
  });

  it("listInvites: waiting, used with who joined; cancelled and expired are hidden", async () => {
    const s = server("invite");
    seed(s, "wait", "member");
    seed(s, "gone", "member", { cancelled: iso(NOW) });
    seed(s, "old", "member", { expires: iso(NOW - 500) });
    seed(s, "join", "member");
    await s.register("joined@example.com", "join");
    const l = listInvites(s.env);
    expect(l.waiting.map((i) => i.code)).toEqual(["wait"]);
    expect(l.used.map((i) => [i.code, i.email])).toEqual([["join", "joined@example.com"]]);
  });

  it("cancelInvite stops a code working; used or unknown codes are 404", async () => {
    const s = server("invite");
    seed(s, "abc", "member");
    cancelInvite(s.env, "abc");
    expect(await err(await s.register("a@example.com", "abc"))).toBe("invite_invalid");
    expect(() => cancelInvite(s.env, "abc")).toThrow();
    expect(() => cancelInvite(s.env, "nope")).toThrow();
  });

  it("new reserved names are refused", async () => {
    const s = server("open");
    for (const n of ["setup", "join", "owner", "team", "docs", "activity", "status", "invite"]) {
      const r = await handle(new Request(`https://keys.test/v1/username/${n}`), s.env);
      expect(await r.json()).toEqual({ available: false, reason: "reserved" });
    }
  });

  it("a malformed body is still a 400 before the sign-up check", async () => {
    const s = server("closed");
    const r = await handle(
      new Request("https://keys.test/v1/register", { method: "POST", body: JSON.stringify({ email: "x@example.com" }) }),
      s.env,
    );
    expect(r.status).toBe(400);
  });

  it("/v1/server reports the mode", async () => {
    for (const mode of ["open", "invite", "closed"] as const) {
      const s = server(mode);
      const r = await handle(new Request("https://keys.test/v1/server"), s.env);
      expect(((await r.json()) as Env & { signups: string }).signups).toBe(mode);
    }
  });
});
