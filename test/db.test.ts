import { describe, expect, it } from "vitest";
import { Database } from "../src/db.ts";

function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, n INTEGER NOT NULL DEFAULT 0, data BLOB);
          CREATE TABLE guard (ok INTEGER NOT NULL CHECK (ok = 1));`);
  return d;
}

describe("Database", () => {
  it("first() returns the first row or null", async () => {
    const d = db();
    await d.prepare("INSERT INTO t (name) VALUES (?), (?)").bind("a", "b").run();
    expect(await d.prepare("SELECT name FROM t ORDER BY name").first()).toEqual({ name: "a" });
    expect(await d.prepare("SELECT name FROM t WHERE name = ?").bind("zzz").first()).toBeNull();
  });

  it("all() returns results; numbered parameters work", async () => {
    const d = db();
    await d.prepare("INSERT INTO t (name, n) VALUES (?1, ?2), (?3, ?2)").bind("a", 5, "b").run();
    const { results } = await d.prepare("SELECT name, n FROM t WHERE n = ?1 ORDER BY name").bind(5).all<{ name: string; n: number }>();
    expect(results).toEqual([
      { name: "a", n: 5 },
      { name: "b", n: 5 },
    ]);
  });

  it("run() reports changes and the last row id", async () => {
    const d = db();
    const ins = await d.prepare("INSERT INTO t (name) VALUES (?)").bind("a").run();
    expect(ins.meta.changes).toBe(1);
    expect(ins.meta.last_row_id).toBe(1);
    await d.prepare("INSERT INTO t (name) VALUES (?)").bind("b").run();
    const upd = await d.prepare("UPDATE t SET n = n + 1").run();
    expect(upd.meta.changes).toBe(2);
    const none = await d.prepare("UPDATE t SET n = 0 WHERE name = ?").bind("zzz").run();
    expect(none.meta.changes).toBe(0);
  });

  it("RETURNING rows come back in results", async () => {
    const d = db();
    await d.prepare("INSERT INTO t (name) VALUES ('a')").run();
    const r = await d.prepare("UPDATE t SET n = n + ? WHERE name = 'a' RETURNING n").bind(3).run();
    expect(r.results).toEqual([{ n: 3 }]);
    expect(r.meta.changes).toBe(1);
  });

  it("binds booleans as 0/1, blobs as bytes, and refuses undefined", async () => {
    const d = db();
    await d.prepare("INSERT INTO t (name, n, data) VALUES (?, ?, ?)").bind("a", true, new Uint8Array([1, 2, 3])).run();
    const row = await d.prepare("SELECT n, data FROM t").first<{ n: number; data: Uint8Array }>();
    expect(row!.n).toBe(1);
    expect([...row!.data]).toEqual([1, 2, 3]);
    expect(() => d.prepare("SELECT ?").bind(undefined as never).firstSync()).toThrow(/undefined/);
  });

  it("batch() commits every statement and returns one result each", async () => {
    const d = db();
    const out = await d.batch([
      d.prepare("INSERT INTO t (name) VALUES (?)").bind("a"),
      d.prepare("INSERT INTO t (name) VALUES (?)").bind("b"),
      d.prepare("SELECT COUNT(*) AS c FROM t"),
    ]);
    expect(out).toHaveLength(3);
    expect(out[2].results).toEqual([{ c: 2 }]);
  });

  it("batch() rolls everything back when one statement fails", async () => {
    const d = db();
    await d.prepare("INSERT INTO t (name) VALUES ('keep')").run();
    await expect(
      d.batch([
        d.prepare("INSERT INTO t (name) VALUES ('x')"),
        d.prepare("UPDATE t SET n = 9 WHERE name = 'keep'"),
        d.prepare("INSERT INTO guard (ok) VALUES (0)"),
      ]),
    ).rejects.toThrow(/CHECK constraint/);
    const { results } = await d.prepare("SELECT name, n FROM t").all();
    expect(results).toEqual([{ name: "keep", n: 0 }]);
    // A UNIQUE failure is reported with its usual text, which the routes look for.
    await expect(d.batch([d.prepare("INSERT INTO t (name) VALUES ('keep')")])).rejects.toThrow(/UNIQUE/);
    // And the connection is usable afterwards (no transaction left open).
    await d.batch([d.prepare("INSERT INTO t (name) VALUES ('after')")]);
    expect((await d.prepare("SELECT COUNT(*) AS c FROM t").first<{ c: number }>())!.c).toBe(2);
  });

  it("enforces foreign keys", async () => {
    const d = new Database(":memory:");
    d.exec("CREATE TABLE p (id TEXT PRIMARY KEY); CREATE TABLE c (pid TEXT NOT NULL REFERENCES p(id) ON DELETE CASCADE)");
    await expect(d.prepare("INSERT INTO c (pid) VALUES ('nope')").run()).rejects.toThrow(/FOREIGN KEY/);
    await d.batch([d.prepare("INSERT INTO p VALUES ('a')"), d.prepare("INSERT INTO c VALUES ('a')")]);
    await d.prepare("DELETE FROM p").run();
    expect(await d.prepare("SELECT * FROM c").first()).toBeNull();
  });
});
