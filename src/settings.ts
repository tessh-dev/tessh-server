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

/** Writes one setting to the database and the live `env`. A setting the environment fixes is refused. */
export function saveSetting(env: Env, key: SettingKey, value: string): void {
  if (env.SETTINGS.locked[key as LockableKey]) throw new HttpError("locked_by_env", 409, "Set by the server's environment");
  env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .execSync();
  const s = env.SETTINGS;
  switch (key) {
    case "name":
      s.name = env.SERVER_NAME = value;
      break;
    case "public_url":
      s.publicURL = env.PUBLIC_URL = value;
      break;
    case "signups":
      s.signups = env.SIGNUPS = parseSignups(value);
      break;
    case "default_bytes":
      s.defaultBytes = Number(value);
      break;
    case "owner_user_id":
      s.ownerUserId = value;
      break;
    case "setup_done":
      s.setupDone = value === "1";
      break;
  }
}

/** The server's public origin: PUBLIC_URL when set, else the one this request came in on. */
export function originFor(req: Request, env: Env): string {
  return env.PUBLIC_URL ?? new URL(req.url).origin;
}
