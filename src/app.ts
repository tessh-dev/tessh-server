// Wires config, secrets, the database and the HTTP server together. src/main.ts runs it.
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { loadConfig, loadSecrets, type Config } from "./config.ts";
import { Database } from "./db.ts";
import { handle, type Env } from "./index.ts";
import { migrate, readMigrations } from "./migrate.ts";
import { serve } from "./server.ts";
import { loadSettings } from "./settings.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function version(): string {
  try {
    return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

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
    ADMIN_PASSWORD: processEnv.ADMIN_PASSWORD || null,
  };

  const api = serve((req) => handle(req, env));
  await listen(api, config.port, config.bind);
  log(
    `Tessh server ${env.VERSION} listening on ${config.bind}:${config.port} (${settings.publicURL ? `public URL ${settings.publicURL}` : "public URL from each request"}, sign-ups: ${settings.signups})`,
  );

  return {
    config,
    env,
    api,
    async close() {
      await closeServer(api);
      db.close();
    },
  };
}
