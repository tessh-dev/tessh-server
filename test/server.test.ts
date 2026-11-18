// The real thing: start() with node:http on free ports, a temp DATA_DIR, then plain fetch().
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start, type App } from "../src/app.ts";

let app: App;
let dir: string;
let api: string;
let admin: string;
const PASSWORD = "s3cret-admin-password";
const auth = (p = PASSWORD) => `Basic ${Buffer.from(`ops:${p}`).toString("base64")}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tessh-server-"));
  app = await start(
    { PUBLIC_URL: "https://sync.example.com", PORT: "0", ADMIN_PORT: "0", BIND: "127.0.0.1", ADMIN_BIND: "127.0.0.1", ADMIN_PASSWORD: PASSWORD, DATA_DIR: dir, SIGNUPS: "closed" },
    () => {},
  );
  api = `http://127.0.0.1:${(app.api.address() as AddressInfo).port}`;
  admin = `http://127.0.0.1:${(app.admin!.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("node:http server", () => {
  it("serves health and server info", async () => {
    const h = await fetch(`${api}/v1/health`);
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true });
    const s = (await (await fetch(`${api}/v1/server`)).json()) as Record<string, string>;
    expect(s).toMatchObject({ name: "Tessh", signups: "closed", keysURL: "https://sync.example.com" });
    expect(s.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("HEAD has headers and no body", async () => {
    const r = await fetch(`${api}/v1/health`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });

  it("refuses sign-ups when closed, over the wire", async () => {
    const r = await fetch(`${api}/v1/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(400);
  });

  it("a body over the cap is 413 without reading it all", async () => {
    const r = await fetch(`${api}/v1/sync`, { method: "POST", body: "x".repeat(3 * 1024 * 1024) });
    expect(r.status).toBe(413);
  });

  it("unknown key page is 404", async () => {
    expect((await fetch(`${api}/nobody`)).status).toBe(404);
  });

  it("admin is on its own port and needs the password", async () => {
    expect((await fetch(`${admin}/`)).status).toBe(401);
    expect((await fetch(`${admin}/`, { headers: { authorization: auth("nope") } })).status).toBe(401);
    const ok = await fetch(`${admin}/`, { headers: { authorization: auth() } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Overview");
    // And not on the public port.
    expect((await fetch(`${api}/accounts`, { headers: { authorization: auth() } })).status).toBe(404);
  });

  it("admin writes check the origin the browser used, as a reverse proxy forwards it", async () => {
    const send = (origin: string, extra: Record<string, string> = {}) =>
      fetch(`${admin}/api/accounts/6f1c1e0a-0000-4000-8000-000000000000/suspend`, {
        method: "POST",
        headers: { authorization: auth(), "x-tessh-admin": "1", "content-type": "application/json", origin, ...extra },
        body: "{}",
      });
    expect((await send("https://evil.example")).status).toBe(403);
    expect((await send("https://admin.example.com", { "x-forwarded-proto": "https", "x-forwarded-host": "admin.example.com" })).status).toBe(404);
  });

  it("writes the database and secrets to DATA_DIR", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "tessh.db"))).toBe(true);
    expect(existsSync(join(dir, "secrets.json"))).toBe(true);
  });
});

describe("without ADMIN_PASSWORD", () => {
  it("the API runs and the admin port is not opened", async () => {
    const d = mkdtempSync(join(tmpdir(), "tessh-server-"));
    const a = await start({ PUBLIC_URL: "http://127.0.0.1", PORT: "0", BIND: "127.0.0.1", DATA_DIR: d }, () => {});
    try {
      expect(a.admin).toBeNull();
      const port = (a.api.address() as AddressInfo).port;
      expect((await fetch(`http://127.0.0.1:${port}/v1/health`)).status).toBe(200);
    } finally {
      await a.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
