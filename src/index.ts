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
import { serveAsset } from "./web/assets.ts";
import { twoStepRoutes } from "./two-step.ts";
import { HttpError, error, errorFrom, json } from "./http.ts";
import { originFor, type Settings } from "./settings.ts";

export interface Env {
  DB: Database;
  /** HMAC key for the stable fake salts /v1/prelogin returns for unknown emails. */
  PRELOGIN_SECRET: string;
  /** base64 of 32 random bytes: AES-256-GCM key for TOTP secrets at rest. */
  TOTP_KEY: string;
  /** The server's public origin, e.g. `https://sync.example.com`. Null: the origin of each request is used (see originFor). */
  PUBLIC_URL: string | null;
  SERVER_NAME: string;
  SIGNUPS: Signups;
  VERSION: string;
  /** The settings as loaded; saveSetting keeps it and the fields above in step. */
  SETTINGS: Settings;
  /** Random per boot (16 hex). The setup page uses it to tell a restart from a change of server. */
  INSTANCE_ID: string;
  /** HTTP Basic password for the admin panel. Unset: the admin panel refuses every request. */
  ADMIN_PASSWORD?: string | null;
  /** The live setup code (hash only) while the server is not set up. Memory only. */
  SETUP?: { hash: string; expiresAt: number; scope: "full" | "owner" } | null;
  /** An authenticator being enrolled for the owner, until confirmed or expired. Memory only. */
  OWNER_TOTP_PENDING?: { secret: Uint8Array; expiresAt: number } | null;
}

/** For the apps' "Custom server" check. */
export function serverInfo(req: Request, env: Env) {
  return {
    name: env.SERVER_NAME,
    version: env.VERSION,
    signups: env.SIGNUPS,
    keysURL: originFor(req, env),
    setUp: env.SETTINGS.setupDone,
    instance: env.INSTANCE_ID,
  };
}

async function api(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  const read = req.method === "GET" || req.method === "HEAD";
  if (read && pathname === "/v1/health") return json({ ok: true });
  if (read && pathname === "/v1/server") return json(serverInfo(req, env));
  const res =
    (await twoStepRoutes(req, env)) ??
    (await accountRoutes(req, env)) ??
    (await recoveryRoutes(req, env)) ??
    (await syncRoutes(req, env)) ??
    (await keypageRoutes(req, env));
  if (res) return res;
  return error("not_found", 404, "Not found");
}

/** While the server is not set up only the setup flow, its assets and the two public probes are served. */
function notSetUp(req: Request, pathname: string): Response | null {
  if (pathname === "/setup" || pathname.startsWith("/setup/") || pathname.startsWith("/_/")) return null;
  if (pathname === "/v1/health" || pathname === "/v1/server") return null;
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return error("not_set_up", 503, "This server isn't set up yet");
  const wantsHTML = (req.method === "GET" || req.method === "HEAD") && (req.headers.get("accept") ?? "").includes("text/html");
  if (wantsHTML) return new Response(null, { status: 302, headers: { location: "/setup" } });
  return new Response("This server isn't set up yet\n", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  try {
    if (!env.SETTINGS.setupDone) {
      const blocked = notSetUp(req, pathname);
      if (blocked) return blocked;
    }
    if (pathname.startsWith("/_/")) return serveAsset(req) ?? error("not_found", 404, "Not found");
    if (pathname === "/v1" || pathname.startsWith("/v1/")) return await api(req, env);
    return await keysHost(req, env);
  } catch (e) {
    if (e instanceof HttpError) return errorFrom(e);
    throw e;
  }
}

export default { fetch: handle };
