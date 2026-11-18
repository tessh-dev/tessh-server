// Backups: one SQLite file made with VACUUM INTO, a consistent copy that is safe while the server runs.
// A nightly one goes into the data volume (newest 7 kept); the owner can also download a fresh one.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "./index.ts";

const KEEP = 7;
const NIGHTLY = /^tessh-\d{4}-\d{2}-\d{2}\.db$/;
const HOUR = 3;

const pad = (n: number) => String(n).padStart(2, "0");
/** The server-local calendar date, `YYYY-MM-DD`. */
export const dateStamp = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function vacuumInto(env: Env, file: string): void {
  env.DB.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}

/** Writes `<dir>/backups/tessh-YYYY-MM-DD.db`, replacing one from the same day, and keeps the newest 7. Returns its path. */
export function runBackup(env: Env, dir: string, now = new Date()): string {
  const backups = join(dir, "backups");
  mkdirSync(backups, { recursive: true });
  const file = join(backups, `tessh-${dateStamp(now)}.db`);
  rmSync(file, { force: true });
  vacuumInto(env, file);
  const old = readdirSync(backups).filter((f) => NIGHTLY.test(f)).sort().reverse().slice(KEEP);
  for (const f of old) rmSync(join(backups, f), { force: true });
  return file;
}

/** When the newest nightly backup in `<dir>/backups` was written, or null when there is none. */
export function lastBackupAt(dir: string): Date | null {
  let names: string[];
  try {
    names = readdirSync(join(dir, "backups")).filter((f) => NIGHTLY.test(f));
  } catch {
    return null;
  }
  let newest: Date | null = null;
  for (const f of names) {
    try {
      const t = statSync(join(dir, "backups", f)).mtime;
      if (!newest || t > newest) newest = t;
    } catch {}
  }
  return newest;
}

/** A fresh backup in memory for the owner to download. The temporary file is gone before this returns. */
export function backupBytes(env: Env): Uint8Array {
  const tmp = mkdtempSync(join(tmpdir(), "tessh-backup-"));
  try {
    const file = join(tmp, "backup.db");
    vacuumInto(env, file);
    return readFileSync(file);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Milliseconds from `now` to the next 03:00 server-local time. */
export function msUntilNightly(now = new Date()): number {
  const next = new Date(now);
  next.setHours(HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Runs runBackup every night at 03:00 local time. Returns a function that stops it. A failure is logged, never thrown. */
export function scheduleBackups(env: Env, dir: string, log: (m: string) => void = console.error): () => void {
  let timer: NodeJS.Timeout;
  const arm = () => {
    timer = setTimeout(() => {
      try {
        runBackup(env, dir);
      } catch (e) {
        log(`Nightly backup failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      arm();
    }, msUntilNightly());
    timer.unref();
  };
  arm();
  return () => clearTimeout(timer);
}
