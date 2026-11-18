// The browser setup an owner finishes after first start: the setup code, then name and address, the owner
// login and who can join. With an owner-reset code only the code and owner login steps are offered.
// After a correct code the browser holds a random setup token (cookie); only its hash is kept, in memory.
import { createHash, randomBytes } from "node:crypto";
import { normalisePublicURL, parseSignups } from "../config.ts";
import { HttpError, clientIP, error, json, readJSON } from "../http.ts";
import type { Env } from "../index.ts";
import { createInvite } from "../invites.ts";
import { checkWrite, confirmTotp, createOwner, createOwnerSession, totpURI } from "../owner.ts";
import { checkSetupCode } from "../setup-code.ts";
import { originFor, saveSetting } from "../settings.ts";
import { base32Encode, matchStep, timingSafeEqual } from "../totp.ts";
import { icons } from "./icons.ts";
import { MARK, esc, page } from "./shell.ts";

const COOKIE = "tessh_setup";
const SESSION_MS = 2 * 60 * 60 * 1000;
const TOTP_MS = 10 * 60 * 1000;
const MAX_INVITES = 20;
const MAX_LABEL = 64;
const STORAGE: [number, string][] = [
  [524_288_000, "500 MB"],
  [1_073_741_824, "1 GB"],
  [5_368_709_120, "5 GB"],
  [-1, "No limit"],
];
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' https: http:; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const HTML_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

type Mode = "full" | "owner";
type Step = "code" | "server" | "owner" | "team";

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const invalid = (msg: string) => new HttpError("invalid_request", 400, msg);
const notFound = () => new HttpError("not_found", 404, "Not found");

const codeExpired = (env: Env) => !!env.SETUP && Date.now() > env.SETUP.expiresAt;

/** Full setup until it is done; owner-only while an owner-reset code is there; otherwise there is nothing to set up. */
function modeOf(env: Env): Mode | null {
  if (env.SETUP?.scope === "owner") return "owner";
  return env.SETTINGS.setupDone ? null : "full";
}

// ---- The setup session ----

function tokenOf(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}

const cookieValue = (req: Request, token: string, maxAge: number) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/setup; Max-Age=${maxAge}${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`;

/** True when the request carries the live setup token, issued for the live setup code. */
function unlocked(env: Env, req: Request): boolean {
  const s = env.SETUP_SESSION;
  const token = tokenOf(req);
  if (!s || !token) return false;
  if (!env.SETUP || Date.now() > env.SETUP.expiresAt || s.codeHash !== env.SETUP.hash || Date.now() > s.expiresAt) {
    env.SETUP_SESSION = null;
    return false;
  }
  return timingSafeEqual(sha256hex(token), s.hash);
}

function requireUnlocked(env: Env, req: Request): NonNullable<Env["SETUP_SESSION"]> {
  if (!unlocked(env, req)) throw new HttpError("unauthorized", 401, "Type the setup code first");
  return env.SETUP_SESSION!;
}

// ---- Where setup is up to ----

const hasRow = (env: Env, key: string) => env.DB.prepare("SELECT 1 FROM settings WHERE key = ?").bind(key).execSync().results.length > 0;
const ownerExists = (env: Env) => env.DB.prepare("SELECT 1 FROM owner WHERE id = 1").execSync().results.length > 0;

/** The server step is done once a name or address is saved (or the environment fixes both), or the owner exists. */
function serverDone(env: Env): boolean {
  const { locked } = env.SETTINGS;
  return hasRow(env, "name") || hasRow(env, "public_url") || (!!locked.name && !!locked.public_url) || ownerExists(env);
}

function currentStep(env: Env, req: Request, mode: Mode): Step {
  if (!unlocked(env, req)) return "code";
  if (mode === "owner") return "owner";
  if (ownerExists(env)) return "team";
  return serverDone(env) ? "owner" : "server";
}

// ---- API ----

const str = (v: unknown) => (typeof v === "string" ? v : "");

async function postCode(req: Request, env: Env): Promise<Response> {
  const body = await readJSON<{ code?: unknown }>(req);
  checkSetupCode(env, str(body?.code), clientIP(req));
  const token = randomBytes(32).toString("base64url");
  env.SETUP_SESSION = { hash: sha256hex(token), codeHash: env.SETUP!.hash, expiresAt: Date.now() + SESSION_MS, totp: null };
  return json({ ok: true }, 200, { "set-cookie": cookieValue(req, token, SESSION_MS / 1000) });
}

async function postServer(req: Request, env: Env): Promise<Response> {
  requireUnlocked(env, req);
  const body = await readJSON<{ name?: unknown; address?: unknown }>(req);
  requireUnlocked(env, req);
  const { locked } = env.SETTINGS;
  // Check both before saving either.
  const name = str(body?.name).trim();
  if (!locked.name && (name.length < 1 || name.length > 64)) throw invalid("The name must be 1 to 64 characters");
  let address = "";
  if (!locked.public_url) {
    try {
      address = normalisePublicURL(str(body?.address).trim());
    } catch {
      throw invalid("Use an address that starts with https:// or http:// and has no path");
    }
  }
  if (!locked.name) saveSetting(env, "name", name);
  if (!locked.public_url) saveSetting(env, "public_url", address);
  return json({ ok: true });
}

function requireOwnerStep(env: Env, mode: Mode): void {
  if (mode !== "full") return;
  if (!serverDone(env)) throw new HttpError("conflict", 409, "Name your server first");
  if (ownerExists(env)) throw new HttpError("conflict", 409, "This server already has an owner");
}

async function postTotp(req: Request, env: Env, mode: Mode): Promise<Response> {
  const session = requireUnlocked(env, req);
  requireOwnerStep(env, mode);
  const secret = randomBytes(20);
  session.totp = { secret, expiresAt: Date.now() + TOTP_MS };
  const b32 = base32Encode(secret);
  return json({ secret: b32, uri: totpURI(env.SETTINGS.name, b32) });
}

async function postOwner(req: Request, env: Env, mode: Mode): Promise<Response> {
  requireUnlocked(env, req);
  const body = await readJSON<{ email?: unknown; password?: unknown; totpCode?: unknown }>(req);
  const session = requireUnlocked(env, req);
  requireOwnerStep(env, mode);
  const code = str(body?.totpCode).replace(/\s/g, "");
  let secret: Uint8Array | null = null;
  if (code) {
    // Checked before the owner is made, so a mistyped code leaves the step to try again.
    const pending = session.totp;
    if (!pending || Date.now() > pending.expiresAt) throw new HttpError("two_step_not_pending", 409, "The authenticator key ran out. Reload the page for a new one.");
    if ((await matchStep(pending.secret, code, Date.now(), null)) === null) throw new HttpError("invalid_code", 401, "That code isn't right. Check the authenticator app and try again.");
    secret = pending.secret;
  }
  await createOwner(env, str(body?.email), str(body?.password));
  if (secret) {
    env.OWNER_TOTP_PENDING = { secret, expiresAt: Date.now() + TOTP_MS };
    await confirmTotp(env, code);
  }
  session.totp = null;
  if (mode === "owner") {
    env.SETUP = null;
    env.SETUP_SESSION = null;
    return json({ ok: true }, 200, { "set-cookie": cookieValue(req, "", 0) });
  }
  return json({ ok: true });
}

async function postTeam(req: Request, env: Env): Promise<Response> {
  requireUnlocked(env, req);
  const body = await readJSON<{ signups?: unknown; invites?: unknown; defaultBytes?: unknown }>(req);
  const { locked } = env.SETTINGS;
  let signups = "";
  if (!locked.signups) {
    if (typeof body?.signups !== "string") throw invalid("Choose who can join");
    try {
      signups = parseSignups(body.signups);
    } catch {
      throw invalid("Choose who can join");
    }
    if (signups !== body.signups) throw invalid("Choose who can join");
  }
  const bytes = body?.defaultBytes;
  if (!STORAGE.some(([b]) => b === bytes)) throw invalid("Choose the storage per person");
  const raw = body?.invites ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_INVITES) throw invalid(`Invite up to ${MAX_INVITES} people now; you can add more later`);
  const labels = raw.map((l) => (typeof l === "string" ? l.trim() : ""));
  if (labels.some((l) => l.length < 1 || l.length > MAX_LABEL)) throw invalid(`Each name must be 1 to ${MAX_LABEL} characters`);

  // From here to finishing is synchronous, so two requests can't both finish setup.
  requireUnlocked(env, req);
  if (modeOf(env) !== "full") throw notFound();
  if (!ownerExists(env)) throw new HttpError("conflict", 409, "Make the owner login first");
  if (!locked.signups) saveSetting(env, "signups", signups);
  saveSetting(env, "default_bytes", String(bytes));
  const origin = originFor(req, env);
  const invites = labels.map((label) => ({ label, url: createInvite(env, { label, days: 7, kind: "member", origin }).url }));
  const ownerCode = createInvite(env, { label: "Owner", days: null, kind: "owner", origin }).code;
  saveSetting(env, "setup_done", "1");
  env.SETUP = null;
  env.SETUP_SESSION = null;

  const owner = await createOwnerSession(env, req);
  return json({ invites, ownerCode }, 200, [
    ["set-cookie", cookieValue(req, "", 0)],
    ["set-cookie", owner],
  ]);
}

// ---- Pages ----

function dots(mode: Mode, step: Step): string {
  const order: Step[] = mode === "owner" ? ["code", "owner"] : ["code", "server", "owner", "team"];
  return `<div class="dots" aria-hidden="true">${order.map((s) => (s === step ? `<i class="on"></i>` : "<i></i>")).join("")}</div>`;
}

const ERR = `<p class="err" role="alert" hidden></p>`;
const back = (mode: Mode) => (mode === "full" ? `<a class="btn ghost" href="/setup?step=server">Back</a>` : "");

function expiredStep(mode: Mode): string {
  return `<div class="ocard" data-step="expired">${MARK}${dots(mode, "code")}
<h3>This setup code has expired</h3>
<p class="sub">Restart the server for a new one, then find it in the logs under “Not set up yet”.</p>
<p class="cap">Run <span class="mono">docker compose restart tessh-server</span>, then <span class="mono">docker compose logs tessh-server</span>.</p>
</div>`;
}

function codeStep(mode: Mode, env: Env): string {
  if (codeExpired(env)) return expiredStep(mode);
  const box = (i: number) =>
    `<input aria-label="Character ${i + 1} of 8" maxlength="1" autocomplete="off" autocapitalize="characters" spellcheck="false"${i === 0 ? " autofocus" : ""}>`;
  const boxes = [0, 1, 2, 3].map(box).join("") + `<span class="dash" aria-hidden="true">–</span>` + [4, 5, 6, 7].map(box).join("");
  return `<form class="ocard" data-step="code" novalidate>${MARK}${dots(mode, "code")}
<h3>Set up your server</h3>
<p class="sub">Type the setup code from your server's logs. It's under “Not set up yet”.</p>
<div class="code">${boxes}</div>
<p class="cap">Lost it? Run <span class="mono">docker compose logs tessh-server</span> again.</p>
${ERR}
<div class="acts"><button class="btn primary grow" type="submit">Continue</button></div>
</form>`;
}

function serverStep(req: Request, env: Env, mode: Mode): string {
  const { locked } = env.SETTINGS;
  const address = env.PUBLIC_URL ?? new URL(req.url).origin;
  const storedName = hasRow(env, "name") ? env.SETTINGS.name : "";
  const name = locked.name
    ? `<div class="fr"><label>Name</label><span class="v">${esc(env.SETTINGS.name)}</span></div>`
    : `<div class="fr"><label for="name">Name</label><input id="name" name="name" maxlength="64" required autocomplete="off" placeholder="Home lab" value="${esc(storedName)}"></div>`;
  const addr = locked.public_url
    ? `<div class="fr"><label>Address</label><span class="v m">${esc(address)}</span><span class="okt" data-check hidden><i></i><span></span></span></div>`
    : `<div class="fr"><label for="address">Address</label><input class="m" id="address" name="address" type="url" required autocomplete="off" spellcheck="false" value="${esc(address)}"><span class="okt" data-check hidden><i></i><span></span></span></div>`;
  const lockedNote = locked.name || locked.public_url ? `<p class="cap">Values in grey are set by the server's environment.</p>` : "";
  return `<form class="ocard" data-step="server" data-instance="${esc(env.INSTANCE_ID)}" data-address="${esc(address)}" novalidate>${MARK}${dots(mode, "server")}
<h3>Your server</h3>
<p class="sub">People see its name when they sign in from the apps.</p>
<div class="fg">${name}${addr}</div>
<p class="cap warnp" data-check-warn hidden></p>
<p class="cap">The apps and key pages use this address. You can change it later.</p>${lockedNote}
${ERR}
<div class="acts"><button class="btn primary grow" type="submit">Continue</button></div>
</form>`;
}

function ownerStep(env: Env, mode: Mode): string {
  const done =
    mode === "owner"
      ? `<section class="ocard" data-done hidden>${MARK}
<h3>You can sign in again</h3>
<p class="sub">Your owner login is reset. Sign in with the new one.</p>
<div class="acts"><a class="btn primary grow" href="/admin">Open the panel</a></div>
</section>`
      : "";
  return `<form class="ocard" data-step="owner" data-mode="${mode}" novalidate>${MARK}${dots(mode, "owner")}
<h3>Owner login</h3>
<p class="sub">For running this server: people, invites and settings.</p>
<div class="fg">
<div class="fr"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="username" spellcheck="false" placeholder="you@example.com"></div>
<div class="fr"><label for="password">Password</label><input id="password" name="password" type="password" required minlength="12" autocomplete="new-password" placeholder="At least 12 characters"><span class="okt" data-strength hidden><i></i><span></span></span></div>
<div class="fr"><span class="frl" id="totp-label">Authenticator code too</span><span class="rec flat">Recommended</span><button type="button" class="tg" role="switch" aria-checked="true" aria-labelledby="totp-label" data-totp-toggle></button></div>
</div>
<div class="fg totp" data-totp>
<p class="cap">Add this key to your authenticator app, then type the code it shows.</p>
<p class="secret" data-secret>…</p>
<a class="mono uri" data-uri href="#">Open in your authenticator app</a>
<div class="fr"><label for="totp">Code</label><input class="m" id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456"></div>
</div>
${ERR}
<div class="acts">${back(mode)}<button class="btn primary grow" type="submit">Continue</button></div>
</form>${done}`;
}

function teamStep(req: Request, env: Env): string {
  const s = env.SETTINGS;
  const locked = !!s.locked.signups;
  const choice = (value: string, icon: string, title: string, note: string) => {
    const on = s.signups === value;
    return `<button type="button" class="ch${on ? " on" : ""}" role="radio" aria-checked="${on}" data-signups="${value}"${locked ? " disabled" : ""}><span class="ic">${icon}</span><span class="what"><b>${title}</b><small>${note}</small></span></button>`;
  };
  const current = STORAGE.some(([b]) => b === s.defaultBytes) ? s.defaultBytes : 1_073_741_824;
  const storage = STORAGE.map(
    ([b, label]) => `<button type="button" role="radio" aria-checked="${b === current}"${b === current ? ` class="on"` : ""} data-bytes="${b}">${label}</button>`,
  ).join("");
  const origin = originFor(req, env);
  const host = new URL(origin).host;
  return `<form class="ocard" data-step="team" novalidate>${MARK}${dots("full", "team")}
<h3>Your team</h3>
<p class="sub">All of this can change later.</p>
<div class="choices" role="radiogroup" aria-label="Who can join">
${choice("invite", icons.mail, `Invite only<span class="rec">Recommended</span>`, "People join with a link from you.")}
${choice("open", icons.globe, "Anyone with the address", "Fine on a private network like Tailscale.")}
${choice("closed", icons.lock, "Just me", "No one else can sign up.")}
</div>${locked ? `<p class="cap">Set by the server's environment.</p>` : ""}
<div class="lbl">Invite people now</div>
<div class="fg tagbox"><div class="tags" data-tags><input data-tag-input maxlength="${MAX_LABEL}" placeholder="Add a name" aria-label="Add a name, then press Return"></div></div>
<div class="lbl">Storage per person</div>
<div class="sg" role="radiogroup" aria-label="Storage per person">${storage}</div>
${ERR}
<div class="acts">${back("full")}<button class="btn primary grow" type="submit">Finish setup</button></div>
</form>
<section class="ocard wide" data-done hidden>
<div class="ill"><canvas data-tile aria-hidden="true"></canvas><div class="tx"><span class="g">✓</span> ${esc(s.name)} is running<br><span class="p">~ %</span> <span class="cur"></span></div></div>
<h3>${esc(s.name)} is ready</h3>
<p class="sub" data-ready-sub>Send these invite links, then connect your own apps.</p>
<div class="rows" data-invites hidden></div>
<div class="lbl">Your own apps</div>
<div class="rows"><div class="row"><span class="ri">${icons.server}</span><div class="t"><b>In Tessh, choose Self-hosted</b><small>${esc(host)} · your code <span data-owner-code></span></small></div></div></div>
<div class="acts"><a class="btn primary grow" href="/admin">Open the panel</a></div>
</section>
<template data-invite-row><div class="row"><span class="who"></span><div class="t"><b></b><small></small></div><span class="r"><button type="button" class="btn ghost sm" data-copy>${icons.copy}<span>Copy</span></button></span></div></template>`;
}

function render(req: Request, env: Env, mode: Mode): string {
  let step = currentStep(env, req, mode);
  // Back from the owner or team step shows the server step again.
  if (mode === "full" && step !== "code" && step !== "server" && new URL(req.url).searchParams.get("step") === "server") step = "server";
  const card =
    step === "code" ? codeStep(mode, env) : step === "server" ? serverStep(req, env, mode) : step === "owner" ? ownerStep(env, mode) : teamStep(req, env);
  return page({
    title: mode === "owner" ? "Reset the owner login · Tessh Server" : "Set up · Tessh Server",
    body: `<main class="moment"><canvas data-field="moment" aria-hidden="true"></canvas>${card}</main>`,
    script: "setup",
    version: env.VERSION,
  });
}

/** `/setup` and `/setup/api/*`. */
export async function setupRoutes(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  const mode = modeOf(env);
  if (pathname === "/setup") {
    if (req.method !== "GET" && req.method !== "HEAD") return error("invalid_request", 405, "Method not allowed", undefined, { allow: "GET, HEAD" });
    // A run-out owner reset has nothing left to show; the panel still works with the old login.
    const resetRanOut = mode === "owner" && env.SETTINGS.setupDone && codeExpired(env);
    if (!mode || resetRanOut) return new Response(null, { status: 302, headers: { location: "/admin", "cache-control": "no-store" } });
    return new Response(req.method === "HEAD" ? null : render(req, env, mode), { headers: HTML_HEADERS });
  }
  if (!mode || !pathname.startsWith("/setup/api/")) throw notFound();
  if (req.method !== "POST") return error("invalid_request", 405, "Method not allowed", undefined, { allow: "POST" });
  // The page may be open on the address the browser used, before the saved public address is reachable.
  checkWrite(req, [new URL(originFor(req, env)).origin]);
  switch (pathname) {
    case "/setup/api/code":
      return postCode(req, env);
    case "/setup/api/server":
      if (mode !== "full") throw notFound();
      return postServer(req, env);
    case "/setup/api/owner/totp":
      return postTotp(req, env, mode);
    case "/setup/api/owner":
      return postOwner(req, env, mode);
    case "/setup/api/team":
      if (mode !== "full") throw notFound();
      return postTeam(req, env);
  }
  throw notFound();
}
