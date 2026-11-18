import { env } from "./harness.ts";
import { describe, expect, it } from "vitest";
import { writeItems } from "../src/sync.ts";
import { call, registerUser, uuid } from "./helpers.ts";

const item = (blob = "QUJD", id = uuid()) => ({ id, deleted: false, blob });
const push = (token: string, items: unknown[]) => call("POST", "/v1/sync", { items }, token);
const pull = async (token: string, since?: number) =>
  (await (await call("GET", `/v1/sync${since === undefined ? "" : `?since=${since}`}`, undefined, token)).json()) as any;

describe("sync", () => {
  it("push then pull returns items in version order with a cursor", async () => {
    const { token } = await registerUser("s1@x.com");
    const a = item("QUE="), b = item("QkI=");
    const res = await push(token, [a, b]);
    expect(res.status).toBe(200);
    const r = (await res.json()) as any;
    expect(r.versions).toEqual({ [a.id]: 1, [b.id]: 2 });
    expect(r.cursor).toBe(2);
    const p = await pull(token);
    expect(p.items).toEqual([
      { id: a.id, version: 1, deleted: false, blob: "QUE=" },
      { id: b.id, version: 2, deleted: false, blob: "QkI=" },
    ]);
    expect(p.cursor).toBe(2);
    expect(p.hasMore).toBe(false);
  });

  it("pull since cursor returns only newer items", async () => {
    const { token } = await registerUser("s2@x.com");
    await push(token, [item(), item()]);
    const c = item();
    await push(token, [c]);
    const p = await pull(token, 2);
    expect(p.items.map((i: any) => i.id)).toEqual([c.id]);
    const empty = await pull(token, 3);
    expect(empty.items).toEqual([]);
    expect(empty.cursor).toBe(3);
  });

  it("since must be a non-negative integer", async () => {
    const { token } = await registerUser("s3@x.com");
    for (const s of ["-1", "abc", "1.5", ""]) {
      expect((await call("GET", `/v1/sync?since=${s}`, undefined, token)).status).toBe(400);
    }
  });

  it("requires auth", async () => {
    expect((await call("GET", "/v1/sync")).status).toBe(401);
    expect((await call("POST", "/v1/sync", { items: [] })).status).toBe(401);
  });

  it("re-pushing an id replaces it with a higher version", async () => {
    const { token } = await registerUser("s4@x.com");
    const a = item("QQ==");
    await push(token, [a]);
    const r = (await (await push(token, [{ ...a, blob: "Qg==" }])).json()) as any;
    expect(r.versions[a.id]).toBe(2);
    const p = await pull(token);
    expect(p.items).toEqual([{ id: a.id, version: 2, deleted: false, blob: "Qg==" }]);
  });

  it("pushing a tombstone stores deleted with null blob", async () => {
    const { token, userId } = await registerUser("s5@x.com");
    const a = item();
    await push(token, [a]);
    const res = await push(token, [{ id: a.id, deleted: true, blob: null }]);
    expect(res.status).toBe(200);
    const p = await pull(token);
    expect(p.items).toEqual([{ id: a.id, version: 2, deleted: true, blob: null }]);
    const row = await env.DB.prepare("SELECT size FROM items WHERE user_id = ?").bind(userId).first<{ size: number }>();
    expect(row!.size).toBe(0);
  });

  it("a tombstone may carry a sealed blob, which counts toward the quota", async () => {
    const { token, userId } = await registerUser("s5b@x.com");
    const a = item();
    await push(token, [a]);
    const res = await push(token, [{ id: a.id, deleted: true, blob: "QUJDRA==" }]);
    expect(res.status).toBe(200);
    const p = await pull(token);
    expect(p.items).toEqual([{ id: a.id, version: 2, deleted: true, blob: "QUJDRA==" }]);
    const row = await env.DB.prepare("SELECT size FROM items WHERE user_id = ?").bind(userId).first<{ size: number }>();
    expect(row!.size).toBe(8);
  });

  it("deleted and blob must agree", async () => {
    const { token } = await registerUser("s6@x.com");
    for (const bad of [
      { id: uuid(), deleted: true, blob: "" },
      { id: uuid(), deleted: true, blob: "not base64!" },
      { id: uuid(), deleted: true, blob: 5 },
      { id: uuid(), deleted: true },
      { id: uuid(), deleted: true, blob: "A".repeat(65_540) },
      { id: uuid(), deleted: false, blob: null },
      { id: uuid(), deleted: false, blob: "" },
      { id: uuid(), deleted: false },
      { id: uuid(), blob: "QQ==" },
      { id: uuid(), deleted: "no", blob: "QQ==" },
      { id: uuid(), deleted: false, blob: 5 },
    ]) {
      expect((await push(token, [bad])).status).toBe(400);
    }
  });

  it("pull pages at 500 with hasMore", async () => {
    const { token } = await registerUser("s7@x.com");
    expect((await push(token, Array.from({ length: 500 }, () => item("QQ==")))).status).toBe(200);
    expect((await push(token, [item("QQ==")])).status).toBe(200);
    const p1 = await pull(token);
    expect(p1.items.length).toBe(500);
    expect(p1.hasMore).toBe(true);
    expect(p1.cursor).toBe(500);
    const p2 = await pull(token, p1.cursor);
    expect(p2.items.length).toBe(1);
    expect(p2.hasMore).toBe(false);
    expect(p2.cursor).toBe(501);
  });

  it("push over quota is rejected whole", async () => {
    const { token, userId } = await registerUser("s8@x.com");
    await env.DB.prepare("INSERT INTO items (user_id, id, version, deleted, blob, size) VALUES (?, ?, 1, 0, 'x', 1073741800)")
      .bind(userId, uuid()).run();
    await env.DB.prepare("UPDATE users SET cursor = 1 WHERE id = ?").bind(userId).run();
    const a = item("A".repeat(100)), b = item("B".repeat(100));
    const res = await push(token, [a, b]);
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error).toBe("quota_exceeded");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = ?").bind(userId).first<{ n: number }>();
    expect(n!.n).toBe(1);
    const u = await env.DB.prepare("SELECT cursor FROM users WHERE id = ?").bind(userId).first<{ cursor: number }>();
    expect(u!.cursor).toBe(1);
  });

  it("replacing an item credits its old size against the quota", async () => {
    const { token, userId } = await registerUser("s9@x.com");
    const id = uuid();
    await env.DB.prepare("INSERT INTO items (user_id, id, version, deleted, blob, size) VALUES (?, ?, 1, 0, 'x', 1073741800)")
      .bind(userId, id).run();
    await env.DB.prepare("UPDATE users SET cursor = 1 WHERE id = ?").bind(userId).run();
    expect((await push(token, [{ id, deleted: false, blob: "A".repeat(1000) }])).status).toBe(200);
  });

  it("item count limit counts tombstones", async () => {
    const { token, userId } = await registerUser("s10@x.com");
    await env.DB.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 100000) INSERT INTO items (user_id, id, version, deleted, blob, size) SELECT ?, 'id' || i, i, 1, NULL, 0 FROM n",
    ).bind(userId).run();
    await env.DB.prepare("UPDATE users SET cursor = 100000 WHERE id = ?").bind(userId).run();
    const res = await push(token, [item()]);
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error).toBe("quota_exceeded");
  });

  it("blob over 65,536 chars is 400", async () => {
    const { token } = await registerUser("s11@x.com");
    expect((await push(token, [item("A".repeat(65_537))])).status).toBe(400);
    expect((await push(token, [item("A".repeat(65_536))])).status).toBe(200);
  });

  it("more than 500 items per push is 400", async () => {
    const { token } = await registerUser("s12@x.com");
    expect((await push(token, Array.from({ length: 501 }, () => item()))).status).toBe(400);
  });

  it("users cannot read each other's items", async () => {
    const a = await registerUser("s13a@x.com");
    const b = await registerUser("s13b@x.com");
    const shared = uuid();
    await push(a.token, [item("QQ==", shared)]);
    expect((await pull(b.token)).items).toEqual([]);
    await push(b.token, [item("Qg==", shared)]);
    expect((await pull(a.token)).items[0].blob).toBe("QQ==");
  });

  it("ids must be UUIDs", async () => {
    const { token } = await registerUser("s14@x.com");
    for (const id of ["abc", "", 5, "../x", uuid() + "x"]) {
      expect((await push(token, [{ id, deleted: false, blob: "QQ==" }])).status).toBe(400);
    }
  });

  it("duplicate ids within a push are 400", async () => {
    const { token } = await registerUser("s15@x.com");
    const a = item();
    expect((await push(token, [a, a])).status).toBe(400);
  });

  it("malformed bodies are 400", async () => {
    const { token } = await registerUser("s16@x.com");
    expect((await call("POST", "/v1/sync", {}, token)).status).toBe(400);
    expect((await call("POST", "/v1/sync", { items: "x" }, token)).status).toBe(400);
    expect((await push(token, [null])).status).toBe(400);
  });

  it("empty push returns the current cursor", async () => {
    const { token } = await registerUser("s17@x.com");
    await push(token, [item()]);
    const r = (await (await push(token, [])).json()) as any;
    expect(r).toEqual({ versions: {}, cursor: 1 });
  });

  it("concurrent pushes never share versions", async () => {
    const { token } = await registerUser("s18@x.com");
    const mk = () => Array.from({ length: 20 }, () => item());
    const results = await Promise.all([push(token, mk()), push(token, mk()), push(token, mk())]);
    const all: number[] = [];
    for (const r of results) {
      expect(r.status).toBe(200);
      all.push(...Object.values(((await r.json()) as any).versions as Record<string, number>));
    }
    expect(new Set(all).size).toBe(60);
    expect(Math.max(...all)).toBe(60);
    expect((await pull(token)).cursor).toBe(60);
  });

  it("blobs must be standard base64", async () => {
    const { token } = await registerUser("s19@x.com");
    for (const b of ["not base64!", "ab-_", "QQ==Q", "===", "QQ=== ", "QQ\n=="]) {
      expect((await push(token, [item(b)])).status).toBe(400);
    }
    expect((await push(token, [item("a+/9QQ==")])).status).toBe(200);
  });

  it("the in-batch guard rejects an over-quota write even when the pre-check is bypassed", async () => {
    const { userId } = await registerUser("s20@x.com");
    await env.DB.prepare("INSERT INTO items (user_id, id, version, deleted, blob, size) VALUES (?, ?, 1, 0, 'x', 1073741800)")
      .bind(userId, uuid()).run();
    await env.DB.prepare("UPDATE users SET cursor = 1 WHERE id = ?").bind(userId).run();
    const items = [{ id: uuid(), deleted: false, blob: "A".repeat(100), size: 100 }];
    await expect(writeItems(env as any, userId, items)).rejects.toMatchObject({ code: "quota_exceeded", status: 413 });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = ?").bind(userId).first<{ n: number }>();
    expect(n!.n).toBe(1);
    const u = await env.DB.prepare("SELECT cursor FROM users WHERE id = ?").bind(userId).first<{ cursor: number }>();
    expect(u!.cursor).toBe(1);
  });

  it("the in-batch guard enforces the item count limit", async () => {
    const { userId } = await registerUser("s21@x.com");
    await env.DB.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 100000) INSERT INTO items (user_id, id, version, deleted, blob, size) SELECT ?, 'id' || i, i, 1, NULL, 0 FROM n",
    ).bind(userId).run();
    await expect(
      writeItems(env as any, userId, [{ id: uuid(), deleted: true, blob: null, size: 0 }]),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  it("a missing user row is 401, not 500", async () => {
    await expect(
      writeItems(env as any, uuid(), [{ id: uuid(), deleted: false, blob: "QQ==", size: 4 }]),
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });
});
