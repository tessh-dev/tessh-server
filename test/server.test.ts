// The real thing: start() with node:http on free ports, a temp DATA_DIR, then plain fetch().
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start, type App } from "../src/app.ts";
import { saveSetting } from "../src/settings.ts";

let app: App;
let dir: string;
let api: string;
const logged: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tessh-server-"));
  app = await start(
    { PUBLIC_URL: "https://sync.example.com", PORT: "0", BIND: "127.0.0.1", DATA_DIR: dir, SIGNUPS: "closed" },
    (m) => logged.push(m),
  );
  saveSetting(app.env, "setup_done", "1");
  api = `http://127.0.0.1:${(app.api.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("node:http server", () => {
  it("logs one setup code at boot while not set up", () => {
    expect(logged.filter((l) => l.startsWith("  Setup code  "))).toHaveLength(1);
    expect(logged.join("\n")).toMatch(/Setup code {2}[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/);
  });

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

  it("writes the database and secrets to DATA_DIR", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "tessh.db"))).toBe(true);
    expect(existsSync(join(dir, "secrets.json"))).toBe(true);
  });
});

describe("without PUBLIC_URL", () => {
  it("the API runs and key pages use the request's origin", async () => {
    const d = mkdtempSync(join(tmpdir(), "tessh-server-"));
    const a = await start({ PORT: "0", BIND: "127.0.0.1", DATA_DIR: d }, () => {});
    try {
      const port = (a.api.address() as AddressInfo).port;
      expect((await fetch(`http://127.0.0.1:${port}/v1/health`)).status).toBe(200);
      const info = (await (await fetch(`http://127.0.0.1:${port}/v1/server`)).json()) as Record<string, unknown>;
      expect(info).toMatchObject({ keysURL: `http://127.0.0.1:${port}`, setUp: false, signups: "invite" });
    } finally {
      await a.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
