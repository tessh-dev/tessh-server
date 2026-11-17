// Applies migrations/*.sql in name order, once each. Applied names are recorded in `schema_migrations`,
// and each file runs in its own transaction with its record, so a failed file leaves nothing behind.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "./db.ts";

export interface Migration {
  name: string;
  sql: string;
}

export function readMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** Returns the names it applied (empty when the schema is already current). */
export function migrate(db: Database, migrations: Migration[]): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(
    db.sqlite
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((r) => String((r as { name: string }).name)),
  );
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.sqlite.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(m.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      if (db.sqlite.isTransaction) db.exec("ROLLBACK");
      throw new Error(`Migration ${m.name} failed: ${(e as Error).message}`);
    }
    applied.push(m.name);
  }
  return applied;
}
