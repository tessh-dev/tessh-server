// The page an invite link opens: `/join/<code>`. It tells the person who invited them and hands the server
// and code to the app. A code that is used, cancelled, expired or unknown gets one plain message that never
// repeats the code.
import { HttpError, clientIP, error, limitKey } from "../http.ts";
import type { Env } from "../index.ts";
import { checkInviteLimit, countInviteFailure, findUsableInvite } from "../invites.ts";
import { originFor } from "../settings.ts";
import { MARK, esc, page } from "./shell.ts";

const CODE_RE = /^[A-Za-z0-9]{1,32}$/;
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; " +
  "form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
const HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** The owner's Tessh username when they have one, else "The owner". */
function ownerName(env: Env): string {
  const id = env.SETTINGS.ownerUserId;
  if (!id) return "The owner";
  const u = env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(id).execSync<{ username: string | null }>().results[0];
  return u?.username || "The owner";
}

function render(env: Env, body: string): string {
  return page({
    title: `Join ${env.SETTINGS.name}`,
    body: `<main class="moment"><canvas data-field="moment" aria-hidden="true"></canvas>${body}</main>`,
  });
}

function valid(req: Request, env: Env, code: string): string {
  const origin = originFor(req, env);
  const host = new URL(origin).host;
  const link = `tessh://join?server=${encodeURIComponent(origin)}&code=${encodeURIComponent(code)}`;
  return render(
    env,
    `<section class="ocard invite">
<div class="tile" aria-hidden="true"><span class="gly"><span class="t">t</span><span class="c">›</span><span class="b"></span></span></div>
<h3>You're invited to ${esc(env.SETTINGS.name)}</h3>
<p class="sub">${esc(ownerName(env))} invited you to keep your SSH hosts and keys on this server, encrypted on your devices.</p>
<div class="stack"><a class="btn primary" href="${esc(link)}">Open in Tessh</a><a class="btn ghost" href="https://tessh.dev/download">Get Tessh for Mac or iPhone</a></div>
<p class="cap">Or in the app: Self-hosted › <span class="mono">${esc(host)}</span> · code <span class="mono">${esc(code)}</span></p>
</section>`,
  );
}

function used(env: Env): string {
  return render(env, `<section class="ocard invite">${MARK}<h3>This invite has ended</h3>\n<p class="sub">This invite has been used or has run out. Ask for a new one.</p></section>`);
}

function limited(env: Env): string {
  return render(env, `<section class="ocard invite">${MARK}<h3>Too many tries</h3>\n<p class="sub">Too many wrong invite codes. Try again in 15 minutes.</p></section>`);
}

/** `/join/<code>`. Wrong codes count with wrong codes at sign-up: 10 per address, 200 in all per 15 minutes. */
export async function joinRoutes(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return error("invalid_request", 405, "Method not allowed", undefined, { allow: "GET, HEAD" });
  const code = new URL(req.url).pathname.slice("/join/".length);
  const key = limitKey(clientIP(req));
  const now = Date.now();
  try {
    checkInviteLimit(key, now);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return new Response(req.method === "HEAD" ? null : limited(env), { status: 429, headers: { ...HEADERS, ...e.headers } });
  }
  const usable = CODE_RE.test(code) && findUsableInvite(env, code) !== null;
  if (!usable) countInviteFailure(key, now);
  const html = usable ? valid(req, env, code) : used(env);
  return new Response(req.method === "HEAD" ? null : html, { headers: HEADERS });
}
