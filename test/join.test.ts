import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/index.ts";
import { createInvite, resetInviteAttempts } from "../src/invites.ts";
import { loadSettings } from "../src/settings.ts";
import { makeEnv, freshDB } from "./harness.ts";
import { registerBody } from "./helpers.ts";

const get = (env: ReturnType<typeof makeEnv>, path: string, method = "GET") => handle(new Request(`https://keys.test${path}`, { method, headers: { accept: "text/html" } }), env);

describe("invite page", () => {
  beforeEach(() => resetInviteAttempts());

  it("welcomes a valid code and links into the app", async () => {
    const env = makeEnv({ SERVER_NAME: "Holmes Lab", SETTINGS: { ...loadSettings(freshDB(), {}), setupDone: true, name: "Holmes Lab" } });
    const { code } = createInvite(env, { label: "Sam", days: 7, origin: "https://keys.test" });
    const res = await get(env, `/join/${code}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await res.text();
    expect(html).toContain("You're invited to Holmes Lab");
    expect(html).toContain("The owner invited you to keep your SSH hosts and keys on this server, encrypted on your devices.");
    expect(html).toContain(`href="tessh://join?server=https%3A%2F%2Fkeys.test&amp;code=${code}"`);
    expect(html).toContain(">Open in Tessh<");
    expect(html).toContain(`href="https://tessh.dev/download"`);
    expect(html).toContain(`Or in the app: Self-hosted › <span class="mono">keys.test</span> · code <span class="mono">${code}</span>`);
    expect(html).not.toMatch(/<style|style="|<script>/);
  });

  it("names the owner when they have a username", async () => {
    const env = makeEnv();
    env.DB.prepare("INSERT INTO users (id, email, auth_hash, salt, kdf, wrapped_vault_key, encrypted_signing_key, signer_public_key, username, created_at) VALUES ('u1', 'o@x.test', 'h', 's', '{}', 'w', 'e', 'k', 'alice', '2026-01-01')")
      .bind()
      .execSync();
    env.SETTINGS.ownerUserId = "u1";
    const { code } = createInvite(env, { label: "Sam", days: null, origin: "https://keys.test" });
    expect(await (await get(env, `/join/${code}`)).text()).toContain("alice invited you");
  });

  it("says the same thing for used, cancelled, expired and unknown codes, without echoing the code", async () => {
    const env = makeEnv();
    const used = createInvite(env, { label: "a", days: 7, origin: "x" }).code;
    env.DB.prepare("UPDATE invites SET used_at = ? WHERE code = ?").bind(new Date().toISOString(), used).execSync();
    const old = createInvite(env, { label: "b", days: 7, origin: "x" }).code;
    env.DB.prepare("UPDATE invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE code = ?").bind(old).execSync();
    const gone = createInvite(env, { label: "c", days: 7, origin: "x" }).code;
    env.DB.prepare("UPDATE invites SET cancelled_at = ? WHERE code = ?").bind(new Date().toISOString(), gone).execSync();
    for (const code of [used, old, gone, "nope12", "bad%20code"]) {
      const res = await get(env, `/join/${code}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("This invite has been used or has run out. Ask for a new one.");
      expect(html).not.toContain(code);
      expect(html).not.toContain("tessh://");
    }
  });

  it("is always dark: no panel theme", async () => {
    const html = await (await get(makeEnv(), "/join/abc123")).text();
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    expect(html).not.toContain("theme.js");
  });

  it("only answers GET and HEAD, and only once set up", async () => {
    const env = makeEnv();
    expect((await get(env, "/join/abc123", "POST")).status).toBe(405);
    expect((await get(env, "/join/abc123", "HEAD")).status).toBe(200);
    const unset = makeEnv({ SETTINGS: { ...loadSettings(freshDB(), {}), setupDone: false } });
    const res = await handle(new Request("https://keys.test/join/abc123", { headers: { accept: "text/html" } }), unset);
    expect([res.status, res.headers.get("location")]).toEqual([302, "/setup"]);
  });

  it("wrong codes count against the sign-up limit: 10 per address, then 429 even for a live code", async () => {
    const env = makeEnv({ SIGNUPS: "invite" });
    const { code } = createInvite(env, { label: "Sam", days: 7, origin: "https://keys.test" });
    const from = (ip: string, path: string) =>
      handle(new Request(`https://keys.test${path}`, { headers: { accept: "text/html", "x-tessh-client-ip": ip } }), env);
    for (let i = 0; i < 10; i++) expect((await from("4.4.4.4", `/join/nope${i}0`)).status).toBe(200);
    const limited = await from("4.4.4.4", `/join/${code}`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limited.headers.get("content-type")).toContain("text/html");
    const html = await limited.text();
    expect(html).toContain("Too many wrong invite codes");
    expect(html).not.toContain(code);
    // The same counter guards sign-up.
    const reg = await handle(
      new Request("https://keys.test/v1/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tessh-client-ip": "4.4.4.4" },
        body: JSON.stringify(registerBody("late@example.com", { invite: code })),
      }),
      env,
    );
    expect(reg.status).toBe(429);
    // Another address still sees the invite, and a right code is never counted.
    for (let i = 0; i < 12; i++) expect(await (await from("5.5.5.5", `/join/${code}`)).text()).toContain("You're invited");
  });

  it("wrong sign-up codes count against the invite page too", async () => {
    const env = makeEnv({ SIGNUPS: "invite" });
    const { code } = createInvite(env, { label: "Sam", days: 7, origin: "https://keys.test" });
    for (let i = 0; i < 10; i++) {
      await handle(
        new Request("https://keys.test/v1/register", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tessh-client-ip": "6.6.6.6" },
          body: JSON.stringify(registerBody(`x${i}@example.com`, { invite: `bad${i}0` })),
        }),
        env,
      );
    }
    const res = await handle(new Request(`https://keys.test/join/${code}`, { headers: { "x-tessh-client-ip": "6.6.6.6" } }), env);
    expect(res.status).toBe(429);
  });
});
