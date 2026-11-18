// Wires config, secrets, the database and the HTTP server together. src/main.ts runs it.
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig, loadSecrets, type Config } from "./config.ts";
import { Database } from "./db.ts";
import { handle, type Env } from "./index.ts";
import { migrate, readMigrations } from "./migrate.ts";
import { serve } from "./server.ts";
import { loadSettings, saveSetting } from "./settings.ts";
import { issueSetupCode, setupLogLines } from "./setup-code.ts";
import { scheduleBackups } from "./backup.ts";
import { scheduleUpdateChecks } from "./updates.ts";
import { ROOT, version } from "./version.ts";

export { version };

export interface App {
  config: Config;
  env: Env;
  api: Server;
  close(): Promise<void>;
}

const listen = (s: Server, port: number, host: string) =>
  new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, host, () => {
      s.off("error", reject);
      resolve();
    });
  });

const closeServer = (s: Server) =>
  new Promise<void>((resolve) => {
    s.close(() => resolve());
    s.closeIdleConnections();
  });

export async function start(processEnv: NodeJS.ProcessEnv = process.env, log: (m: string) => void = console.log): Promise<App> {
  const config = loadConfig(processEnv);
  mkdirSync(config.dataDir, { recursive: true });
  const { secrets, created } = loadSecrets(config.dataDir, processEnv);
  if (created) log(`Created server secrets in ${join(config.dataDir, "secrets.json")}. Back this file up with the database.`);

  const db = new Database(config.dbPath);
  const applied = migrate(db, readMigrations(join(ROOT, "migrations")));
  if (applied.length) log(`Applied migrations: ${applied.join(", ")}`);

  const settings = loadSettings(db, processEnv);
  const env: Env = {
    DB: db,
    PRELOGIN_SECRET: secrets.preloginSecret,
    TOTP_KEY: secrets.totpKey,
    PUBLIC_URL: settings.publicURL,
    SERVER_NAME: settings.name,
    SIGNUPS: settings.signups,
    VERSION: version(),
    SETTINGS: settings,
    INSTANCE_ID: randomBytes(8).toString("hex"),
    UPDATE_CHECK: processEnv.UPDATE_CHECK?.trim().toLowerCase() !== "false",
  };

  const api = serve((req) => handle(req, env));
  await listen(api, config.port, config.bind);
  log(
    `Tessh server ${env.VERSION} listening on ${config.bind}:${config.port} (${settings.publicURL ? `public URL ${settings.publicURL}` : "public URL from each request"}, sign-ups: ${settings.signups})`,
  );
  if (!settings.setupDone) {
    for (const line of setupLogLines(issueSetupCode(env))) log(line);
    // Setup is not finished, so there is no owner login to reset yet.
    if (settings.resetOwnerRequested) saveSetting(env, "reset_owner_requested", "0");
  } else if (settings.resetOwnerRequested) {
    for (const line of setupLogLines(issueSetupCode(env, Date.now(), "owner"), "owner")) log(line);
    saveSetting(env, "reset_owner_requested", "0");
  }

  const stopBackups = scheduleBackups(env, config.dataDir, log);
  const stopUpdates = env.UPDATE_CHECK ? scheduleUpdateChecks(env) : () => {};

  return {
    config,
    env,
    api,
    async close() {
      stopBackups();
      stopUpdates();
      await closeServer(api);
      db.close();
    },
  };
}
