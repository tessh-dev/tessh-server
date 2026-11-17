// Configuration from environment variables, plus the two server secrets, which are created on first boot
// into DATA_DIR/secrets.json (mode 0600) unless they are given in the environment.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Signups = "open" | "invite" | "closed";

export interface Config {
  publicURL: string;
  port: number;
  bind: string;
  adminPort: number;
  adminBind: string;
  adminPassword: string | null;
  signups: Signups;
  serverName: string;
  dataDir: string;
  dbPath: string;
}

export interface Secrets {
  preloginSecret: string;
  totpKey: string;
}

export class ConfigError extends Error {}

function port(v: string | undefined, name: string, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new ConfigError(`${name} must be a port number (0-65535)`);
  return n;
}

/** `https://sync.example.com` (no trailing slash). A path, query or credentials are refused. */
export function normalisePublicURL(v: string | undefined): string {
  if (!v) throw new ConfigError("PUBLIC_URL is required, e.g. PUBLIC_URL=https://sync.example.com");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(`PUBLIC_URL is not a URL: ${v}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConfigError("PUBLIC_URL must start with https:// or http://");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) {
    throw new ConfigError("PUBLIC_URL must be an origin only (no path), e.g. https://sync.example.com");
  }
  return u.origin;
}

export function parseSignups(v: string | undefined): Signups {
  const s = (v ?? "").trim().toLowerCase() || "invite";
  if (s !== "open" && s !== "invite" && s !== "closed") throw new ConfigError("SIGNUPS must be open, invite or closed");
  return s;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const dataDir = env.DATA_DIR || "/data";
  return {
    publicURL: normalisePublicURL(env.PUBLIC_URL),
    port: port(env.PORT, "PORT", 8080),
    bind: env.BIND || "0.0.0.0",
    adminPort: port(env.ADMIN_PORT, "ADMIN_PORT", 8081),
    adminBind: env.ADMIN_BIND || "0.0.0.0",
    adminPassword: env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD : null,
    signups: parseSignups(env.SIGNUPS),
    serverName: (env.SERVER_NAME || "Tessh").trim().slice(0, 64) || "Tessh",
    dataDir,
    dbPath: join(dataDir, "tessh.db"),
  };
}

const isKey32 = (b64: string) => {
  try {
    return Buffer.from(b64, "base64").length === 32 && /^[A-Za-z0-9+/]{43}=$/.test(b64);
  } catch {
    return false;
  }
};

/**
 * Environment wins over the file. Missing values are created and written to DATA_DIR/secrets.json.
 * Changing or losing TOTP_KEY breaks every enrolled authenticator and backup code.
 */
export function loadSecrets(dataDir: string, env: NodeJS.ProcessEnv): { secrets: Secrets; created: boolean } {
  const file = join(dataDir, "secrets.json");
  let stored: Partial<Secrets> = {};
  if (existsSync(file)) {
    try {
      stored = JSON.parse(readFileSync(file, "utf8")) as Partial<Secrets>;
    } catch {
      throw new ConfigError(`${file} is not valid JSON. Restore it from your backup.`);
    }
  }
  const fromEnv = { preloginSecret: env.PRELOGIN_SECRET || undefined, totpKey: env.TOTP_KEY || undefined };
  if (fromEnv.totpKey && !isKey32(fromEnv.totpKey)) throw new ConfigError("TOTP_KEY must be base64 of 32 bytes (openssl rand -base64 32)");
  let created = false;
  const fileSecrets: Secrets = {
    preloginSecret: stored.preloginSecret ?? "",
    totpKey: stored.totpKey ?? "",
  };
  if (!fileSecrets.preloginSecret && !fromEnv.preloginSecret) {
    fileSecrets.preloginSecret = randomBytes(32).toString("base64");
    created = true;
  }
  if (!fileSecrets.totpKey && !fromEnv.totpKey) {
    fileSecrets.totpKey = randomBytes(32).toString("base64");
    created = true;
  }
  if (fileSecrets.totpKey && !isKey32(fileSecrets.totpKey)) throw new ConfigError(`totpKey in ${file} must be base64 of 32 bytes`);
  if (created) {
    mkdirSync(dataDir, { recursive: true });
    const out: Partial<Secrets> = {};
    if (fileSecrets.preloginSecret) out.preloginSecret = fileSecrets.preloginSecret;
    if (fileSecrets.totpKey) out.totpKey = fileSecrets.totpKey;
    writeFileSync(file, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return {
    secrets: {
      preloginSecret: fromEnv.preloginSecret ?? fileSecrets.preloginSecret,
      totpKey: fromEnv.totpKey ?? fileSecrets.totpKey,
    },
    created,
  };
}
