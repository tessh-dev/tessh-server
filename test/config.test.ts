import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadSecrets, normalisePublicURL, parseSignups } from "../src/config.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "tessh-config-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("config", () => {
  it("defaults", () => {
    const c = loadConfig({ PUBLIC_URL: "https://sync.example.com/" });
    expect(c).toMatchObject({
      publicURL: "https://sync.example.com",
      port: 8080,
      dataDir: "/data",
      dbPath: "/data/tessh.db",
    });
  });

  it("PUBLIC_URL is optional, and must be an origin when given", () => {
    expect(loadConfig({}).publicURL).toBeNull();
    expect(() => loadConfig({ PUBLIC_URL: "nope" })).toThrow(ConfigError);
    expect(() => normalisePublicURL("sync.example.com")).toThrow(ConfigError);
    expect(() => normalisePublicURL("ftp://sync.example.com")).toThrow(ConfigError);
    expect(() => normalisePublicURL("https://example.com/tessh")).toThrow(ConfigError);
    expect(normalisePublicURL("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  it("SIGNUPS and ports are validated", () => {
    expect(parseSignups("OPEN")).toBe("open");
    expect(parseSignups(undefined)).toBe("invite");
    expect(() => parseSignups("maybe")).toThrow(ConfigError);
    expect(() => loadConfig({ PUBLIC_URL: "https://a.example", PORT: "http" })).toThrow(ConfigError);
  });
});

describe("secrets", () => {
  it("are created once into secrets.json (0600) and reused", () => {
    const dir = tmp();
    const a = loadSecrets(dir, {});
    expect(a.created).toBe(true);
    expect(Buffer.from(a.secrets.totpKey, "base64")).toHaveLength(32);
    expect(a.secrets.preloginSecret.length).toBeGreaterThan(20);
    expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
    const b = loadSecrets(dir, {});
    expect(b.created).toBe(false);
    expect(b.secrets).toEqual(a.secrets);
  });

  it("environment values win and are not written to disk", () => {
    const dir = tmp();
    const totp = Buffer.alloc(32, 7).toString("base64");
    const s = loadSecrets(dir, { TOTP_KEY: totp, PRELOGIN_SECRET: "from-env" });
    expect(s.secrets).toEqual({ totpKey: totp, preloginSecret: "from-env" });
    expect(s.created).toBe(false);
    expect(() => readFileSync(join(dir, "secrets.json"))).toThrow();
  });

  it("refuses a malformed TOTP key", () => {
    const dir = tmp();
    expect(() => loadSecrets(dir, { TOTP_KEY: "short" })).toThrow(ConfigError);
    writeFileSync(join(dir, "secrets.json"), "{not json");
    expect(() => loadSecrets(dir, {})).toThrow(ConfigError);
  });
});
