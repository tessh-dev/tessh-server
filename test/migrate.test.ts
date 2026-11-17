import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Database } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { MIGRATIONS } from "./harness.ts";

describe("migrations", () => {
  it("apply once, in order, and a second run does nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "tessh-migrate-"));
    try {
      const path = join(dir, "t.db");
      const d1 = new Database(path);
      expect(migrate(d1, MIGRATIONS)).toEqual(MIGRATIONS.map((m) => m.name));
      expect(migrate(d1, MIGRATIONS)).toEqual([]);
      d1.close();
      // Reopening the file (a restart) is idempotent too.
      const d2 = new Database(path);
      expect(migrate(d2, MIGRATIONS)).toEqual([]);
      const names = d2.sqlite.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((r) => (r as { name: string }).name);
      expect(names).toEqual(MIGRATIONS.map((m) => m.name));
      expect(d2.sqlite.prepare("SELECT COUNT(*) AS n FROM plans").get()).toEqual({ n: 2 });
      d2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies only the new ones on upgrade", () => {
    const d = new Database(":memory:");
    expect(migrate(d, MIGRATIONS.slice(0, 3))).toHaveLength(3);
    expect(migrate(d, MIGRATIONS)).toEqual(MIGRATIONS.slice(3).map((m) => m.name));
  });

  it("a failing migration leaves no trace and stops the run", () => {
    const d = new Database(":memory:");
    const bad = [
      { name: "0001_ok.sql", sql: "CREATE TABLE a (x INTEGER);" },
      { name: "0002_bad.sql", sql: "CREATE TABLE b (x INTEGER); INSERT INTO nope VALUES (1);" },
      { name: "0003_never.sql", sql: "CREATE TABLE c (x INTEGER);" },
    ];
    expect(() => migrate(d, bad)).toThrow(/0002_bad\.sql/);
    const tables = d.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => (r as { name: string }).name);
    expect(tables).toEqual(["a", "schema_migrations"]);
  });
});
