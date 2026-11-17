// The request handler: `/v1/*` is the sync API, everything else is the public key pages
// (`/<username>`, `/<username>/install.sh`, ...). The admin panel is a separate handler (src/admin.ts)
// served on its own port.
import { accountRoutes } from "./accounts.ts";
import type { Signups } from "./config.ts";
import type { Database } from "./db.ts";
import { keypageRoutes } from "./keypage.ts";
import { keysHost } from "./keys-host.ts";
import { recoveryRoutes } from "./recovery.ts";
import { syncRoutes } from "./sync.ts";
import { twoStepRoutes } from "./two-step.ts";
import { HttpError, error, errorFrom, json } from "./http.ts";

export interface Env {
  DB: Database;
  /** HMAC key for the stable fake salts /v1/prelogin returns for unknown emails. */
  PRELOGIN_SECRET: string;
  /** base64 of 32 random bytes: AES-256-GCM key for TOTP secrets at rest. */
  TOTP_KEY: string;
  /** The server's public origin, e.g. `https://sync.example.com`. Key page links and install lines use it. */
  PUBLIC_URL: string;
  SERVER_NAME: string;
  SIGNUPS: Signups;
  VERSION: string;
  /** HTTP Basic password for the admin panel. Unset: the admin panel refuses every request. */
  ADMIN_PASSWORD?: string | null;
}

/** For the apps' "Custom server" check. */
export function serverInfo(env: Env) {
  return { name: env.SERVER_NAME, version: env.VERSION, signups: env.SIGNUPS, keysURL: env.PUBLIC_URL };
}

async function api(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  const read = req.method === "GET" || req.method === "HEAD";
  if (read && pathname === "/v1/health") return json({ ok: true });
  if (read && pathname === "/v1/server") return json(serverInfo(env));
  const res =
    (await twoStepRoutes(req, env)) ??
    (await accountRoutes(req, env)) ??
    (await recoveryRoutes(req, env)) ??
    (await syncRoutes(req, env)) ??
    (await keypageRoutes(req, env));
  if (res) return res;
  return error("not_found", 404, "Not found");
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  try {
    if (pathname === "/v1" || pathname.startsWith("/v1/")) return await api(req, env);
    return await keysHost(req, env);
  } catch (e) {
    if (e instanceof HttpError) return errorFrom(e);
    throw e;
  }
}

export default { fetch: handle };
