// Command-line commands that run instead of the server. They open the database, change it and exit: the server
// process owns the HTTP ports, so none of these start it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Database } from "./db.ts";
import { migrate, readMigrations } from "./migrate.ts";
import { ROOT } from "./version.ts";

export const RESET_OWNER_MESSAGE = "Restart the server (docker compose restart tessh-server), then open /setup with the code it prints.";

/** `tessh-server reset-owner`: asks the next start to issue an owner-reset setup code. */
export function resetOwner(processEnv: NodeJS.ProcessEnv = process.env, log: (m: string) => void = console.log): void {
  const config = loadConfig(processEnv);
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(config.dbPath);
  try {
    migrate(db, readMigrations(join(ROOT, "migrations")));
    db.prepare("INSERT INTO settings (key, value) VALUES ('reset_owner_requested', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind().execSync();
  } finally {
    db.close();
  }
  log(RESET_OWNER_MESSAGE);
}

/** Runs the command named in `args` and returns its exit code, or null when `args` isn't a command (start the server). */
export function runCli(args: string[], processEnv: NodeJS.ProcessEnv = process.env, log: (m: string) => void = console.log): number | null {
  if (args.length === 0) return null;
  if (args[0] === "reset-owner") {
    resetOwner(processEnv, log);
    return 0;
  }
  console.error(`Unknown command: ${args[0]}\nUsage: tessh-server [reset-owner]`);
  return 2;
}
