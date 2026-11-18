import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http.ts";
import { handle } from "../src/index.ts";
import { ConfigError } from "../src/config.ts";
import { loadSettings, originFor, saveSetting } from "../src/settings.ts";
import { freshDB, makeEnv } from "./harness.ts";

describe("settings", () => {
  it("defaults", () => {
    expect(loadSettings(freshDB(), {})).toEqual({
      name: "Tessh",
      publicURL: null,
      signups: "invite",
      defaultBytes: 1073741824,
      ownerUserId: null,
      setupDone: false,
      resetOwnerRequested: false,
      locked: {},
    });
  });

  it("environment values win and lock the setting", () => {
    const db = freshDB();
    db.prepare("INSERT INTO settings (key, value) VALUES ('name', 'Stored')").execSync();
    const s = loadSettings(db, { SERVER_NAME: "Lab", SIGNUPS: "open", PUBLIC_URL: "https://sync.example.com/" });
    expect(s).toMatchObject({ name: "Lab", signups: "open", publicURL: "https://sync.example.com" });
    expect(s.locked).toEqual({ name: true, signups: true, public_url: true });
  });

  it("reads stored values", () => {
    const db = freshDB();
    for (const [k, v] of [["name", "Mine"], ["signups", "closed"], ["default_bytes", "-1"], ["owner_user_id", "u1"], ["setup_done", "1"], ["public_url", "https://a.example"]]) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind(k, v).execSync();
    }
    expect(loadSettings(db, {})).toEqual({
      name: "Mine", publicURL: "https://a.example", signups: "closed", defaultBytes: -1, ownerUserId: "u1", setupDone: true, resetOwnerRequested: false, locked: {},
    });
  });

  it("saving a locked key is refused", () => {
    const db = freshDB();
    const env = makeEnv({ DB: db, SETTINGS: loadSettings(db, { SERVER_NAME: "Lab" }) });
    try {
      saveSetting(env, "name", "Other");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect(e).toMatchObject({ code: "locked_by_env", status: 409 });
    }
  });

  it("saving a locked public_url or signups is refused", () => {
    const db = freshDB();
    const env = makeEnv({ DB: db, SETTINGS: loadSettings(db, { PUBLIC_URL: "https://a.example", SIGNUPS: "open" }) });
    for (const [k, v] of [["public_url", "https://b.example"], ["signups", "closed"]] as const) {
      expect(() => saveSetting(env, k, v)).toThrow(expect.objectContaining({ code: "locked_by_env", status: 409 }));
    }
  });

  it("a bad value is a 400 and changes neither the database nor the env", () => {
    const db = freshDB();
    const env = makeEnv({ DB: db, SETTINGS: loadSettings(db, {}), PUBLIC_URL: "https://keys.test", SIGNUPS: "open", SERVER_NAME: "Test server" });
    const bad: [Parameters<typeof saveSetting>[1], string][] = [
      ["signups", "maybe"], ["public_url", "not a url"], ["public_url", "https://a.example/path"],
      ["default_bytes", "0"], ["default_bytes", "-5"], ["default_bytes", "1.5"], ["default_bytes", "abc"],
      ["name", "   "], ["name", "x".repeat(65)], ["setup_done", "yes"], ["owner_user_id", ""],
    ];
    for (const [k, v] of bad) {
      expect(() => saveSetting(env, k, v), `${k}=${v}`).toThrow(expect.objectContaining({ code: "invalid_request", status: 400 }));
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings").firstSync<{ n: number }>()?.n).toBe(0);
    expect([env.PUBLIC_URL, env.SIGNUPS, env.SERVER_NAME]).toEqual(["https://keys.test", "open", "Test server"]);
    expect(env.SETTINGS).toEqual(loadSettings(db, {}));
  });

  it("stores the normalised value", () => {
    const db = freshDB();
    const env = makeEnv({ DB: db, SETTINGS: loadSettings(db, {}) });
    saveSetting(env, "public_url", "https://sync.example.com/");
    saveSetting(env, "name", "  Home  ");
    expect(env.PUBLIC_URL).toBe("https://sync.example.com");
    expect(env.SERVER_NAME).toBe("Home");
    expect(loadSettings(db, {})).toMatchObject({ publicURL: "https://sync.example.com", name: "Home" });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'public_url'").firstSync<{ value: string }>()?.value).toBe("https://sync.example.com");
  });

  it("loadSettings refuses a bad environment value", () => {
    expect(() => loadSettings(freshDB(), { SIGNUPS: "bogus" })).toThrow(ConfigError);
    expect(() => loadSettings(freshDB(), { PUBLIC_URL: "nope" })).toThrow(ConfigError);
  });

  it("saving updates the database and the live env", () => {
    const db = freshDB();
    const env = makeEnv({ DB: db, SETTINGS: loadSettings(db, {}) });
    saveSetting(env, "name", "Home");
    saveSetting(env, "signups", "closed");
    saveSetting(env, "public_url", "https://sync.example.com");
    saveSetting(env, "default_bytes", "-1");
    saveSetting(env, "setup_done", "1");
    expect(env.SERVER_NAME).toBe("Home");
    expect(env.SIGNUPS).toBe("closed");
    expect(env.PUBLIC_URL).toBe("https://sync.example.com");
    expect(env.SETTINGS).toMatchObject({ name: "Home", signups: "closed", defaultBytes: -1, setupDone: true });
    expect(loadSettings(db, {})).toMatchObject({ name: "Home", signups: "closed", defaultBytes: -1, setupDone: true });
    saveSetting(env, "name", "Again");
    expect(db.prepare("SELECT value FROM settings WHERE key = 'name'").firstSync<{ value: string }>()?.value).toBe("Again");
  });

  it("originFor uses PUBLIC_URL, else the request", () => {
    expect(originFor(new Request("http://x.test/a"), makeEnv({ PUBLIC_URL: "https://keys.test" }))).toBe("https://keys.test");
    expect(originFor(new Request("https://sync.test:8443/a"), makeEnv({ PUBLIC_URL: null }))).toBe("https://sync.test:8443");
  });

  it("/v1/server reports setUp and a per-boot instance", async () => {
    const db = freshDB();
    const env = makeEnv({ DB: db, SETTINGS: loadSettings(db, {}) });
    const body = (await (await handle(new Request("https://x.test/v1/server"), env)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ setUp: false, name: "Test server" });
    expect(body.instance).toMatch(/^[0-9a-f]{16}$/);
    expect(body.keysURL).toBe("https://keys.test");
  });
});

describe("reset_owner_requested", () => {
  it("accepts 0 and 1 only and updates the live settings", () => {
    const env = makeEnv();
    saveSetting(env, "reset_owner_requested", "1");
    expect(env.SETTINGS.resetOwnerRequested).toBe(true);
    expect(loadSettings(env.DB, {}).resetOwnerRequested).toBe(true);
    saveSetting(env, "reset_owner_requested", "0");
    expect(env.SETTINGS.resetOwnerRequested).toBe(false);
    expect(() => saveSetting(env, "reset_owner_requested", "yes")).toThrow();
  });
});
