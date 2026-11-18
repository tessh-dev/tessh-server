// Server settings. The database holds them; a value given in the environment wins and locks that setting.
import { normalisePublicURL, parseSignups, type Signups } from "./config.ts";
import type { Database } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Env } from "./index.ts";
import { DEFAULT_LIMITS } from "./limits.ts";

export type SettingKey = "name" | "public_url" | "signups" | "default_bytes" | "owner_user_id" | "setup_done";

type LockableKey = "name" | "public_url" | "signups";

export interface Settings {
  name: string;
  publicURL: string | null;
  signups: Signups;
  /** Storage per person in bytes; -1 is no limit. */
  defaultBytes: number;
  ownerUserId: string | null;
  setupDone: boolean;
  /** Settings the server's environment fixes; the panel shows them read-only. */
  locked: Partial<Record<LockableKey, true>>;
}

const DEFAULT_NAME = "Tessh";

export function loadSettings(db: Database, processEnv: NodeJS.ProcessEnv): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").execSync<{ key: string; value: string }>().results;
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const locked: Settings["locked"] = {};

  let name = stored.get("name")?.trim() || DEFAULT_NAME;
  const envName = processEnv.SERVER_NAME?.trim();
  if (envName) {
    name = envName.slice(0, 64);
    locked.name = true;
  }

  let publicURL: string | null = null;
  const storedURL = stored.get("public_url");
  if (storedURL) {
    try {
      publicURL = normalisePublicURL(storedURL);
    } catch {
      publicURL = null;
    }
  }
  if (processEnv.PUBLIC_URL) {
    publicURL = normalisePublicURL(processEnv.PUBLIC_URL);
    locked.public_url = true;
  }

  let signups: Signups = "invite";
  const storedSignups = stored.get("signups");
  if (storedSignups) {
    try {
      signups = parseSignups(storedSignups);
    } catch {
      signups = "invite";
    }
  }
  if (processEnv.SIGNUPS?.trim()) {
    signups = parseSignups(processEnv.SIGNUPS);
    locked.signups = true;
  }

  const bytes = Number(stored.get("default_bytes"));
  return {
    name,
    publicURL,
    signups,
    defaultBytes: stored.has("default_bytes") && Number.isInteger(bytes) ? bytes : DEFAULT_LIMITS.bytes,
    ownerUserId: stored.get("owner_user_id") ?? null,
    setupDone: stored.get("setup_done") === "1",
    locked,
  };
}

const invalid = (msg: string) => new HttpError("invalid_request", 400, msg);

/** The value to store for `key`, or a 400 when it is not acceptable. */
function normalise(key: SettingKey, value: string): string {
  switch (key) {
    case "name": {
      const v = value.trim();
      if (v.length < 1 || v.length > 64) throw invalid("The name must be 1 to 64 characters");
      return v;
    }
    case "public_url":
      try {
        return normalisePublicURL(value.trim());
      } catch (e) {
        throw invalid(e instanceof Error ? e.message : "Not a valid address");
      }
    case "signups":
      try {
        return parseSignups(value);
      } catch {
        throw invalid("Sign-ups must be open, invite or closed");
      }
    case "default_bytes": {
      const n = Number(value);
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n) || (n !== -1 && n <= 0)) throw invalid("Storage must be -1 (no limit) or a positive number of bytes");
      return String(n);
    }
    case "setup_done":
      if (value !== "0" && value !== "1") throw invalid("setup_done must be 0 or 1");
      return value;
    case "owner_user_id":
      if (!value) throw invalid("owner_user_id is required");
      return value;
  }
}

/** Writes one setting to the database and the live `env`. A setting the environment fixes is refused; a bad value is a 400. */
export function saveSetting(env: Env, key: SettingKey, value: string): void {
  if (env.SETTINGS.locked[key as LockableKey]) throw new HttpError("locked_by_env", 409, "Set by the server's environment");
  const v = normalise(key, value);
  env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, v)
    .execSync();
  const s = env.SETTINGS;
  switch (key) {
    case "name":
      s.name = env.SERVER_NAME = v;
      break;
    case "public_url":
      s.publicURL = env.PUBLIC_URL = v;
      break;
    case "signups":
      s.signups = env.SIGNUPS = parseSignups(v);
      break;
    case "default_bytes":
      s.defaultBytes = Number(v);
      break;
    case "owner_user_id":
      s.ownerUserId = v;
      break;
    case "setup_done":
      s.setupDone = v === "1";
      break;
  }
}

/** The server's public origin: PUBLIC_URL when set, else the one this request came in on. */
export function originFor(req: Request, env: Env): string {
  return env.PUBLIC_URL ?? new URL(req.url).origin;
}
