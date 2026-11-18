import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { backupBytes, lastBackupAt, msUntilNightly, runBackup, scheduleBackups } from "../src/backup.ts";
import { createOwner, resetOwnerAttempts } from "../src/owner.ts";
import { seal, stepAt, totpAt } from "../src/totp.ts";
import { SELF, env, makeEnv } from "./harness.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "tessh-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tables = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  } finally {
    db.close();
  }
};

describe("backups", () => {
  it("writes a readable SQLite file named for the day", () => {
    const e = makeEnv();
    const dir = tmp();
    const file = runBackup(e, dir, new Date(2026, 10, 18, 3, 0));
    expect(file).toBe(join(dir, "backups", "tessh-2026-11-18.db"));
    expect(tables(file)).toContain("users");
    // The same day again replaces it.
    expect(runBackup(e, dir, new Date(2026, 10, 18, 9, 0))).toBe(file);
  });

  it("keeps the newest 7 and leaves other files alone", () => {
    const e = makeEnv();
    const dir = tmp();
    mkdirSync(join(dir, "backups"));
    writeFileSync(join(dir, "backups", "notes.txt"), "keep");
    for (let day = 1; day <= 10; day++) runBackup(e, dir, new Date(2026, 10, day, 3, 0));
    const names = readdirSync(join(dir, "backups")).sort();
    expect(names).toHaveLength(8);
    expect(names).toContain("notes.txt");
    expect(names).toContain("tessh-2026-11-10.db");
    expect(names).toContain("tessh-2026-11-04.db");
    expect(names).not.toContain("tessh-2026-11-03.db");
  });

  it("knows when the newest nightly backup was written", () => {
    const dir = tmp();
    expect(lastBackupAt(dir)).toBeNull();
    const before = Date.now() - 1000;
    runBackup(makeEnv(), dir, new Date(2026, 10, 18, 3, 0));
    expect(lastBackupAt(dir)!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("works out the wait until 03:00 local time", () => {
    expect(msUntilNightly(new Date(2026, 10, 18, 2, 0))).toBe(3_600_000);
    expect(msUntilNightly(new Date(2026, 10, 18, 3, 0))).toBe(24 * 3_600_000);
    expect(msUntilNightly(new Date(2026, 10, 18, 23, 0))).toBe(4 * 3_600_000);
  });

  it("runs nightly until stopped", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 18, 1, 0));
      const dir = tmp();
      const stop = scheduleBackups(makeEnv(), dir);
      vi.advanceTimersByTime(2 * 3_600_000 + 1000);
      expect(readdirSync(join(dir, "backups"))).toEqual(["tessh-2026-11-18.db"]);
      stop();
      vi.advanceTimersByTime(48 * 3_600_000);
      expect(readdirSync(join(dir, "backups"))).toEqual(["tessh-2026-11-18.db"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes download bytes that are a SQLite file", () => {
    const bytes = backupBytes(makeEnv());
    expect(Buffer.from(bytes).subarray(0, 15).toString()).toBe("SQLite format 3");
  });
});

describe("backup download", () => {
  const BASE = "https://keys.test";
  const PW = "a long enough password";
  let cookie = "";
  const post = (body: unknown, c: string | null = cookie, ip = "10.0.0.8") =>
    SELF.fetch(`${BASE}/admin/api/backup`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tessh-owner": "1", origin: BASE, "x-tessh-client-ip": ip, ...(c ? { cookie: c } : {}) },
      body: JSON.stringify(body),
    });
  const page = async (path: string) => (await SELF.fetch(`${BASE}${path}`, { headers: { cookie } })).text();
  const audits = () => env.DB.prepare("SELECT actor FROM admin_audit WHERE action = 'backup.download'").execSync<{ actor: string }>().results;

  beforeAll(async () => {
    await createOwner(env, "owner@example.com", PW);
    resetOwnerAttempts();
    const login = await SELF.fetch(`${BASE}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tessh-owner": "1", origin: BASE, "x-tessh-client-ip": "10.0.0.7" },
      body: JSON.stringify({ email: "owner@example.com", password: PW }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  });
  beforeEach(() => resetOwnerAttempts());

  it("is POST only and needs the owner session", async () => {
    expect((await post({ password: PW }, null)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/admin/api/backup`, { headers: { cookie } })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/admin/api/backup`, { method: "POST", headers: { cookie, "x-tessh-owner": "1" }, body: "{}" })).status).toBeGreaterThanOrEqual(400);
    expect(audits()).toEqual([]);
  });

  it("refuses a wrong or missing password without auditing, and rate limits wrong ones", async () => {
    expect((await post({ password: "nope nope nope" })).status).toBe(401);
    expect((await post({})).status).toBe(401);
    expect(audits()).toEqual([]);
    let last = 0;
    for (let i = 0; i < 12 && last !== 429; i++) last = (await post({ password: "nope nope nope" }, cookie, "10.0.0.99")).status;
    expect(last).toBe(429);
    expect(audits()).toEqual([]);
  });

  it("streams the file with safe headers once the password is right, and audits it", async () => {
    const res = await post({ password: PW });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="tessh-backup-\d{4}-\d{2}-\d{2}\.db"$/);
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 15).toString()).toBe("SQLite format 3");
    expect(audits()).toEqual([{ actor: "owner@example.com" }]);
  });

  it("asks for the authenticator code when it is on", async () => {
    const secret = new Uint8Array(20).fill(5);
    const sealed = await seal(env.TOTP_KEY, "owner", secret);
    env.DB.prepare("UPDATE owner SET totp_secret = ?, totp_last_step = NULL").bind(sealed).execSync();
    try {
      const before = audits().length;
      const need = await post({ password: PW });
      expect([need.status, ((await need.json()) as any).error]).toEqual([401, "code_required"]);
      expect((await post({ password: PW, code: "000000" })).status).toBe(401);
      expect(await page("/admin/maintenance")).toContain('id="backup-code" data-otp data-name="code"');
      const ok = await post({ password: PW, code: await totpAt(secret, stepAt(Date.now())) });
      expect(ok.status).toBe(200);
      expect(audits()).toHaveLength(before + 1);
    } finally {
      env.DB.prepare("UPDATE owner SET totp_secret = NULL, totp_last_step = NULL").bind().execSync();
    }
  });

  it("Maintenance has the Backups rows and the dialog", async () => {
    const maintenance = await page("/admin/maintenance");
    expect(maintenance).toContain('data-open="backup"');
    expect(maintenance).toContain('data-dialog="backup"');
    expect(maintenance).toContain("Download a backup");
    expect(maintenance).toContain("Nightly at 03:00 into the data volume");
    expect(maintenance).not.toContain('/admin/api/backup" download');
  });
});
