// The request handler: `/v1/*` is the sync API, `/setup` the browser setup, `/admin` the owner's panel, everything
// else is the public key pages (`/<username>`, `/<username>/install.sh`, ...). `/join/<code>` is the invite page.
import { accountRoutes } from "./accounts.ts";
import type { Signups } from "./config.ts";
import type { Database } from "./db.ts";
import { keypageRoutes } from "./keypage.ts";
import { joinRoutes } from "./web/join.ts";
import { keysHost } from "./keys-host.ts";
import { recoveryRoutes } from "./recovery.ts";
import { syncRoutes } from "./sync.ts";
import { serveAsset } from "./web/assets.ts";
import { panelRoutes } from "./web/panel.ts";
import { setupRoutes } from "./web/setup.ts";
import { twoStepRoutes } from "./two-step.ts";
import type { Release } from "./updates.ts";
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
  /** The live setup code (hash only) while the server is not set up. Memory only. */
  SETUP?: { hash: string; expiresAt: number; scope: "full" | "owner" } | null;
  /** The browser that typed the setup code: a hash of its token, bound to that code. Memory only. */
  SETUP_SESSION?: { hash: string; codeHash: string; expiresAt: number; totp: { secret: Uint8Array; expiresAt: number } | null } | null;
  /** An authenticator being enrolled for the owner, until confirmed or expired. Memory only. */
  OWNER_TOTP_PENDING?: { secret: Uint8Array; expiresAt: number } | null;
  /** The daily update check: whether it runs (UPDATE_CHECK=false turns it off) and the newer release it found, if any. Memory only. */
  UPDATE_CHECK?: boolean;
  UPDATE_LATEST?: string | null;
  /** That newer release's page, date and plain-text notes (see updates.ts recordCheck). Memory only. */
  UPDATE_RELEASE?: Release | null;
  /** When the last check succeeded, and when the latest attempt failed (null once one succeeds). Epoch ms. */
  UPDATE_CHECKED_AT?: number | null;
  UPDATE_FAILED_AT?: number | null;
  /** The data volume, where nightly backups go (the panel reads the newest one's time). Unset in tests. */
  DATA_DIR?: string;
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
  // Public, and read cross-origin by the setup page to check an address reaches this server.
  if (read && pathname === "/v1/server") return json(serverInfo(req, env), 200, { "access-control-allow-origin": "*" });
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
    if (pathname === "/setup" || pathname.startsWith("/setup/")) return await setupRoutes(req, env);
    if (pathname === "/admin" || pathname.startsWith("/admin/")) return await panelRoutes(req, env);
    if (pathname.startsWith("/join/")) return await joinRoutes(req, env);
    return await keysHost(req, env);
  } catch (e) {
    if (e instanceof HttpError) return errorFrom(e);
    throw e;
  }
}

export default { fetch: handle };
