// Test harness: an in-memory database with every migration applied, an Env, and fetch-style entry points for the
// public handler (SELF) and the admin handler (ADMIN). Each test file gets its own database.
import { join } from "node:path";
import { handleAdmin } from "../src/admin.ts";
import { Database } from "../src/db.ts";
import { handle, type Env } from "../src/index.ts";
import { loadSettings } from "../src/settings.ts";
import { migrate, readMigrations } from "../src/migrate.ts";

export const MIGRATIONS = readMigrations(join(import.meta.dirname, "..", "migrations"));
export const ADMIN_PASSWORD = "correct horse battery staple";

export function freshDB(): Database {
  const db = new Database(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

export function makeEnv(over: Partial<Env> = {}): Env {
  const db = over.DB ?? freshDB();
  return {
    DB: db,
    PRELOGIN_SECRET: "test-prelogin-secret",
    // Test-only AES key (32 bytes of 0x2a).
    TOTP_KEY: "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=",
    PUBLIC_URL: "https://keys.test",
    SERVER_NAME: "Test server",
    SIGNUPS: "open",
    VERSION: "0.0.0-test",
    ADMIN_PASSWORD,
    SETTINGS: { ...loadSettings(db, {}), setupDone: true },
    INSTANCE_ID: "0123456789abcdef",
    ...over,
  };
}

export const env: Env = makeEnv();

type FetchInput = string | URL | Request;

export const SELF = {
  fetch: (input: FetchInput, init?: RequestInit) => handle(new Request(input, init), env),
};

export const ADMIN = {
  fetch: (input: FetchInput, init?: RequestInit) => handleAdmin(new Request(input, init), env),
};

export const basic = (password = ADMIN_PASSWORD, user = "ops") => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
