// The real thing: start() with node:http on free ports, a temp DATA_DIR, then plain fetch().
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start, type App } from "../src/app.ts";
import { clientAddress, serve } from "../src/server.ts";
import { clientIP } from "../src/http.ts";
import { saveSetting } from "../src/settings.ts";
import { createInvite } from "../src/invites.ts";

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

  it("server info says whether the owner still has to make a Tessh account", async () => {
    const info = async () => (await (await fetch(`${api}/v1/server`)).json()) as { ownerPending: boolean };
    expect((await info()).ownerPending).toBe(true);
    const { code } = createInvite(app.env, { label: "Owner", days: null, kind: "owner", origin: "https://sync.example.com" });
    const authKey = Buffer.alloc(32, 1).toString("base64");
    const r = await fetch(`${api}/v1/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "owner@example.com",
        authKey,
        salt: Buffer.alloc(16, 2).toString("base64"),
        kdf: { alg: "argon2id", opslimit: 3, memlimit: 67108864 },
        wrappedVaultKey: Buffer.alloc(60, 3).toString("base64"),
        encryptedSigningKey: Buffer.alloc(60, 4).toString("base64"),
        signerPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGFrZQ",
        recoveryAuthKey: Buffer.alloc(32, 11).toString("base64"),
        wrappedVaultKeyRecovery: Buffer.alloc(60, 12).toString("base64"),
        invite: code,
        device: { name: "Mac", platform: "macos" },
      }),
    });
    expect(r.status, await r.clone().text()).toBeLessThan(300);
    expect((await info()).ownerPending).toBe(false);
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

describe("client address", () => {
  it("ignores an x-tessh-client-ip header from the client", async () => {
    const s = serve(async (req) => new Response(clientIP(req)));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
      // The socket is loopback, so the proxy's view (last X-Forwarded-For entry) is used; the spoofed header never is.
      const res = await fetch(url, { headers: { "x-tessh-client-ip": "6.6.6.6", "x-forwarded-for": "7.7.7.7, 203.0.113.9" } });
      expect(await res.text()).toBe("203.0.113.9");
      expect(await (await fetch(url, { headers: { "x-tessh-client-ip": "6.6.6.6" } })).text()).toBe("127.0.0.1");
    } finally {
      s.close();
      s.closeAllConnections();
    }
  });

  it("uses the last forwarded entry only when the socket is local or private", () => {
    expect(clientAddress("127.0.0.1", "1.1.1.1, 2.2.2.2")).toBe("2.2.2.2");
    expect(clientAddress("::1", "2.2.2.2")).toBe("2.2.2.2");
    expect(clientAddress("::ffff:10.1.2.3", "2.2.2.2")).toBe("2.2.2.2");
    expect(clientAddress("172.20.0.5", "2.2.2.2")).toBe("2.2.2.2");
    expect(clientAddress("192.168.1.9", "2.2.2.2")).toBe("2.2.2.2");
    expect(clientAddress("fd12::1", "2.2.2.2")).toBe("2.2.2.2");
    expect(clientAddress("127.0.0.1", undefined)).toBe("127.0.0.1");
    expect(clientAddress("203.0.113.5", "2.2.2.2")).toBe("203.0.113.5");
    expect(clientAddress("172.32.0.1", "2.2.2.2")).toBe("172.32.0.1");
    expect(clientAddress(undefined, "2.2.2.2")).toBe("unknown");
  });
});
