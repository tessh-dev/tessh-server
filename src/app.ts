// Wires config, secrets, the database and both HTTP servers together. src/main.ts runs it.
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleAdmin } from "./admin.ts";
import { loadConfig, loadSecrets, type Config } from "./config.ts";
import { Database } from "./db.ts";
import { handle, type Env } from "./index.ts";
import { migrate, readMigrations } from "./migrate.ts";
import { serve } from "./server.ts";

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
  admin: Server | null;
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

  const env: Env = {
    DB: db,
    PRELOGIN_SECRET: secrets.preloginSecret,
    TOTP_KEY: secrets.totpKey,
    PUBLIC_URL: config.publicURL,
    SERVER_NAME: config.serverName,
    SIGNUPS: config.signups,
    VERSION: version(),
    ADMIN_PASSWORD: config.adminPassword,
  };

  const api = serve((req) => handle(req, env));
  await listen(api, config.port, config.bind);
  log(`Tessh server ${env.VERSION} listening on ${config.bind}:${config.port} (public URL ${config.publicURL}, sign-ups: ${config.signups})`);

  let admin: Server | null = null;
  if (config.adminPassword) {
    admin = serve((req) => handleAdmin(req, env));
    await listen(admin, config.adminPort, config.adminBind);
    log(`Admin panel listening on ${config.adminBind}:${config.adminPort}`);
  } else {
    log("Admin panel off: set ADMIN_PASSWORD to turn it on.");
  }

  return {
    config,
    env,
    api,
    admin,
    async close() {
      await Promise.all([closeServer(api), admin ? closeServer(admin) : Promise.resolve()]);
      db.close();
    },
  };
}
