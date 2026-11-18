// The panel's pages as HTML. Plain server rendering: assets/web/panel.js only adds the writes, copy buttons,
// dialogs and segmented controls. No inline scripts, styles or style attributes (the CSP forbids them).
import type { Signups } from "../config.ts";
import type { Env } from "../index.ts";
import type { InviteRow } from "../invites.ts";
import { NO_LIMIT } from "../limits.ts";
import type { OwnerSessionInfo } from "../owner.ts";
import { icons } from "./icons.ts";
import { updateState, type ActivityEvent, type Overview, type Person } from "./panel.ts";
import { MARK, esc, page } from "./shell.ts";

export interface PanelContext {
  env: Env;
  origin: string;
  host: string;
  counts: { people: number; waiting: number };
  now: number;
}

type Section = "overview" | "team" | "invites" | "activity" | "settings";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STORAGE: [number, string][] = [
  [524_288_000, "500 MB"],
  [1_073_741_824, "1 GB"],
  [5_368_709_120, "5 GB"],
  [NO_LIMIT, "No limit"],
];
const PRIVACY = "The panel never shows anyone's hosts, snippets or keys. It can't: they're encrypted on their devices.";

// ---- Small pieces ----

/** Sizes as the panel shows them: binary units, written MB and GB as the apps do. */
export function formatBytes(n: number): string {
  if (n < 0) return "No limit";
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  if (n === 0) return "0 MB";
  if (n < MB) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < GB) return `${Math.round(n / MB)} MB`;
  return `${Number((n / GB).toFixed(n < 10 * GB ? 1 : 0))} GB`;
}

export const isApple = (platform: string) => /^(macos|ios|ipados|visionos)$/i.test(platform);


const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "just now", "5 min ago", "2 h ago", "Yesterday", "3 days ago", then a date. */
export function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = Math.max(0, now - t);
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 2 * DAY) return "Yesterday";
  if (d < 30 * DAY) return `${Math.floor(d / DAY)} days ago`;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "ends in 7 days", "ends in under a day", or never for a code without an end. */
function ends(iso: string | null, now: number): string {
  if (!iso) return "never runs out";
  const d = Date.parse(iso) - now;
  if (d >= DAY) return `ends in ${Math.ceil(d / DAY)} days`;
  return "ends in under a day";
}

/** One of six avatar colours, fixed for a given id. */
function colour(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `c${h % 6}`;
}

const avatar = (id: string, name: string) => `<span class="who ${colour(id)}" aria-hidden="true">${esc((name.trim()[0] ?? "?").toUpperCase())}</span>`;

const PLATFORMS: Record<string, string> = { macos: "macOS", ios: "iOS", ipados: "iPadOS", visionos: "visionOS", android: "Android", windows: "Windows", linux: "Linux" };
const platformName = (p: string) => PLATFORMS[p.toLowerCase()] ?? (p ? p[0].toUpperCase() + p.slice(1) : "Unknown");
const osTile = (platform: string) => (isApple(platform) ? `<span class="os">${icons.apple}</span>` : `<span class="os gen">${icons.server}</span>`);

function eventIcon(e: ActivityEvent): string {
  if (e.icon === "apple") return `<span class="os">${icons.apple}</span>`;
  if (e.icon === "device") return `<span class="os gen">${icons.server}</span>`;
  return `<span class="ri">${icons[e.icon]}</span>`;
}

function eventRows(events: ActivityEvent[], now: number, empty: string): string {
  if (events.length === 0) return `<div class="rows"><div class="row"><span class="empty">${esc(empty)}</span></div></div>`;
  return `<div class="rows">${events
    .map((e) => `<div class="row">${eventIcon(e)}<div class="t"><b>${esc(e.text)}</b></div><span class="r">${esc(ago(e.at, now))}</span></div>`)
    .join("")}</div>`;
}

const copyButton = (value: string, label = "Copy") =>
  `<button type="button" class="btn ghost sm" data-copy="${esc(value)}">${icons.copy}<span>${esc(label)}</span></button>`;

/** A button that calls the API; with `confirm`, only after the person agrees in a dialog. */
function action(
  label: string,
  opts: { method: string; path: string; body?: unknown; tone?: "danger" | "warn"; confirm?: { title: string; text: string; ok: string }; then?: string },
): string {
  const attrs = [
    `class="btn ghost sm${opts.tone ? ` ${opts.tone}` : ""}"`,
    `data-act`,
    `data-method="${esc(opts.method)}"`,
    `data-path="${esc(opts.path)}"`,
    opts.body === undefined ? "" : `data-body="${esc(JSON.stringify(opts.body))}"`,
    opts.confirm ? `data-confirm="${esc(opts.confirm.title)}" data-confirm-text="${esc(opts.confirm.text)}" data-confirm-ok="${esc(opts.confirm.ok)}"` : "",
    opts.then ? `data-then="${esc(opts.then)}"` : "",
  ].filter(Boolean);
  return `<button type="button" ${attrs.join(" ")}>${esc(label)}</button>`;
}

const CONFIRM_DIALOG = `<dialog class="dlg" data-dialog="confirm" aria-labelledby="confirm-title"><form method="dialog">
<h4 id="confirm-title" data-c-title></h4><p class="cap" data-c-text></p>
<div class="acts"><button class="btn ghost" value="no">Cancel</button><button class="btn primary grow" value="yes" data-c-ok>OK</button></div>
</form></dialog>`;

// ---- Layout ----

function layout(ctx: PanelContext, section: Section, title: string, inner: string, dialogs = ""): string {
  const s = ctx.env.SETTINGS;
  const nav = (key: Section, href: string, icon: string, label: string, count?: number) =>
    `<a class="nav${key === section ? " on" : ""}" href="${href}"${key === section ? ` aria-current="page"` : ""}>${icon}<span>${label}</span>${
      count ? `<span class="ct">${count}</span>` : ""
    }</a>`;
  const body = `<div class="body app-body">
<nav class="side" aria-label="Panel">
<div class="vault"><span class="av"><span class="gly" aria-hidden="true"><span class="t">t</span><span class="c">›</span><span class="b"></span></span></span><div><b>${esc(s.name)}</b><small>${esc(ctx.host)}</small></div></div>
${nav("overview", "/admin", icons.grid, "Overview")}
${nav("team", "/admin/team", icons.people, "Team", ctx.counts.people)}
${nav("invites", "/admin/invites", icons.mail, "Invites", ctx.counts.waiting)}
${nav("activity", "/admin/activity", icons.list, "Activity")}
${nav("settings", "/admin/settings", icons.gear, "Settings")}
<div class="foot"><div class="sync"><i></i>Running · ${esc(ctx.env.VERSION)}</div><button type="button" class="nav" data-act data-method="POST" data-path="/admin/api/signout" data-then="/admin/login">${icons.signout}<span>Sign out</span></button></div>
</nav>
<main class="main"><canvas data-field="top" aria-hidden="true"></canvas><div class="inner">
${inner}
</div></main>
</div>
<p class="toast" role="status" aria-live="polite" data-toast hidden></p>
${CONFIRM_DIALOG}${dialogs}`;
  return page({ title: `${title} · ${s.name}`, body, script: "panel", version: ctx.env.VERSION });
}

const header = (title: string, sub: string, extra = "") =>
  `<div class="ph"><div><h3>${esc(title)}</h3><p>${sub}</p></div>${extra ? `<span class="sp"></span>${extra}` : ""}</div>`;

const signupsLine = (s: Signups) => (s === "invite" ? "invite only" : s === "open" ? "open to anyone with the address" : "just you");

// ---- Pages ----

const updateText = (u: string | null | undefined) => (u ? `Update available: ${u}` : "Up to date");

function updateNote(u: string | null | undefined): string {
  if (u === undefined) return "";
  return `<span class="${u ? "up" : "ok"}">${esc(updateText(u))}</span>`;
}

export function renderOverview(ctx: PanelContext, o: Overview): string {
  const pct = o.storage.capacity ? Math.min(100, Math.round((o.storage.bytes / o.storage.capacity) * 100)) : null;
  const bar = pct === null ? "" : `<div class="mt" role="img" aria-label="${pct}% of everyone's storage"><i data-pct="${pct}"></i></div>`;
  const inner = `${header("Overview", `${esc(ctx.env.SETTINGS.name)} · ${esc(signupsLine(ctx.env.SETTINGS.signups))}`)}
<div class="stats">
<div class="stat"><small>People</small><b>${o.people}</b></div>
<div class="stat"><small>Devices</small><b>${o.devices}</b></div>
<div class="stat"><small>Storage</small><b>${esc(formatBytes(o.storage.bytes))}</b>${bar}</div>
<div class="stat"><small>Version</small><b>${esc(o.version)}</b>${updateNote(o.update)}</div>
</div>
<div class="h">Recent activity<a class="r" href="/admin/activity">All activity</a></div>
${eventRows(o.recent, ctx.now, "Nothing has happened yet")}`;
  return layout(ctx, "overview", "Overview", inner);
}

function personRow(ctx: PanelContext, p: Person, open: boolean): string {
  const chips = `${p.role === "owner" ? ` <span class="chipn ink">Owner</span>` : ""}${p.suspended ? ` <span class="chipn">Suspended</span>` : ""}`;
  const key = p.keyPage
    ? `<span class="kp hide-s">${esc(p.keyPage)}<button type="button" class="kpc" data-copy="${esc(`${ctx.origin}/${p.username}`)}" aria-label="Copy key page link">${icons.copy}</button></span>`
    : `<span class="hide-s soft">No key page yet</span>`;
  const head = `<div class="row person${open ? " open" : ""}">${avatar(p.id, p.name)}<div class="t"><a class="open-link" href="${
    open ? "/admin/team" : `/admin/team/${esc(p.id)}`
  }" aria-expanded="${open}"><b>${esc(p.name)}${chips}</b></a><small>${esc(p.email)}</small></div><span class="r">${key}<span class="hide-s">${esc(
    plural(p.devices.length, "device", "devices"),
  )}</span>${open ? icons.chevronDown : icons.chevron}</span></div>`;
  if (!open) return head;

  const devices = p.devices.length
    ? p.devices
        .map((d) => {
          const live = ctx.now - Date.parse(d.lastSeenAt) < 10 * MIN ? `<span class="livedot" aria-label="Active now"></span>` : "";
          return `<div class="row">${osTile(d.platform)}<div class="t"><b>${esc(d.name)}</b><small>${esc(platformName(d.platform))} · active ${esc(
            ago(d.lastSeenAt, ctx.now),
          )}</small></div><span class="r">${live}${action("Sign out", {
            method: "POST",
            path: `/admin/api/team/${p.id}/devices/${d.id}/sign-out`,
            tone: "danger",
            confirm: { title: `Sign ${p.name} out on ${d.name}?`, text: "The app on that device stops syncing. They can sign in again.", ok: "Sign out" },
          })}</span></div>`;
        })
        .join("")
    : `<div class="row"><span class="empty">No devices signed in</span></div>`;
  const used = `${formatBytes(p.usage.bytes)} of ${p.limit.bytes === NO_LIMIT ? "no limit" : formatBytes(p.limit.bytes)}`;
  const limitButton = `<button type="button" class="btn ghost sm" data-limit="/admin/api/team/${esc(p.id)}/limit" data-limit-name="${esc(p.name)}" data-limit-current="${
    p.limit.custom ? p.limit.bytes : ""
  }">Storage limit</button>`;
  const manage =
    p.role === "owner"
      ? `<span class="soft">Your own account. Remove it from the app.</span>`
      : `${
          p.suspended
            ? action("Unsuspend", { method: "POST", path: `/admin/api/team/${p.id}/suspend`, body: { suspended: false } })
            : action("Suspend", {
                method: "POST",
                path: `/admin/api/team/${p.id}/suspend`,
                body: { suspended: true },
                tone: "warn",
                confirm: { title: `Suspend ${p.name}?`, text: "They can't sign in or sync until you unsuspend them. Nothing is deleted.", ok: "Suspend" },
              })
        }${action("Remove", {
          method: "DELETE",
          path: `/admin/api/team/${p.id}`,
          tone: "danger",
          then: "/admin/team",
          confirm: { title: `Remove ${p.name}?`, text: "Their account, devices and synced data are deleted from this server. This can't be undone.", ok: "Remove" },
        })}`;
  return `${head}<div class="sub2">${devices}<div class="row tools"><small>${esc(used)}${p.limit.custom ? "" : " (server default)"}</small><span class="r">${limitButton}${manage}</span></div>
<div class="row tools"><a class="soft" href="/admin/activity?user=${esc(p.id)}">Activity for ${esc(p.name)}</a></div></div>`;
}

function limitDialog(ctx: PanelContext): string {
  const def = ctx.env.SETTINGS.defaultBytes;
  const options: [string, string][] = [["", `Default (${formatBytes(def)})`], ...STORAGE.map(([b, l]): [string, string] => [String(b), l])];
  return `<dialog class="dlg" data-dialog="limit" aria-labelledby="limit-title"><form method="dialog">
<h4 id="limit-title">Storage limit</h4><p class="cap" data-limit-for></p>
<div class="sg wrap" role="radiogroup" aria-labelledby="limit-title">${options
    .map(([v, l]) => `<button type="button" role="radio" aria-checked="false" data-limit-value="${v}">${esc(l)}</button>`)
    .join("")}</div>
<p class="err" role="alert" hidden></p>
<div class="acts"><button class="btn ghost" value="cancel">Cancel</button><button type="button" class="btn primary grow" data-limit-save>Save</button></div>
</form></dialog>`;
}

export function renderTeam(ctx: PanelContext, list: Person[], openId: string | null): string {
  const sub = `${plural(list.length, "person", "people")} · ${plural(ctx.counts.waiting, "invite", "invites")} waiting`;
  const rows = list.length ? list.map((p) => personRow(ctx, p, p.id === openId)).join("") : `<div class="row"><span class="empty">No one has joined yet</span></div>`;
  const inner = `${header("Team", esc(sub), `<a class="btn primary sm" href="/admin/invites">${icons.plus}New invite</a>`)}
<div class="rows">${rows}</div>
<p class="cap note">${esc(PRIVACY)}</p>`;
  return layout(ctx, "team", "Team", inner, limitDialog(ctx));
}

export function renderInvites(ctx: PanelContext, inv: { waiting: InviteRow[]; used: InviteRow[] }): string {
  const s = ctx.env.SETTINGS.signups;
  const sub = s === "invite" ? "Sign-ups are invite only" : s === "open" ? "Anyone with the address can join, invited or not" : "Sign-ups are closed: only your own code works";
  const waiting = inv.waiting.length
    ? inv.waiting
        .map((i) => {
          const url = `${ctx.origin}/join/${i.code}`;
          const what = i.kind === "owner" ? `your code ${i.code} · ${ends(i.expiresAt, ctx.now)}` : `${ctx.host}/join/${i.code} · ${ends(i.expiresAt, ctx.now)}`;
          return `<div class="row"><span class="ri">${icons.mail}</span><div class="t"><b>${esc(i.label)}</b><small>${esc(what)}</small></div><span class="r">${copyButton(url)}${action("Cancel", {
            method: "DELETE",
            path: `/admin/api/invites/${i.code}`,
            confirm: { title: `Cancel the invite for ${i.label}?`, text: "The link stops working.", ok: "Cancel invite" },
          })}</span></div>`;
        })
        .join("")
    : `<div class="row"><span class="empty">No invites waiting</span></div>`;
  const used = inv.used.length
    ? inv.used
        .map((i) => {
          const name = i.name ?? (i.email ? i.email.split("@")[0] : `${i.label} (removed)`);
          return `<div class="row">${avatar(i.code, name)}<div class="t"><b>${esc(name)}</b><small>joined ${esc(ago(i.usedAt ?? "", ctx.now))}${
            i.label && i.label !== name ? ` · invite for ${esc(i.label)}` : ""
          }</small></div></div>`;
        })
        .join("")
    : `<div class="row"><span class="empty">No one has used an invite yet</span></div>`;
  const inner = `${header("Invites", esc(sub))}
<form class="fg invbar" data-invite novalidate>
<input class="invl" name="label" maxlength="64" autocomplete="off" placeholder="Who's it for? A name, just for you" aria-label="Who's it for? A name, just for you">
<div class="sg" role="radiogroup" aria-label="Runs out after"><button type="button" role="radio" aria-checked="true" class="on" data-days="7">7 days</button><button type="button" role="radio" aria-checked="false" data-days="30">30 days</button></div>
<button class="btn primary sm" type="submit">${icons.plus}New invite</button>
</form>
<p class="err" role="alert" data-invite-err hidden></p>
<p class="cap">Each link works once.</p>
<div class="h">Waiting <span>${inv.waiting.length}</span></div>
<div class="rows">${waiting}</div>
<div class="h">Used <span>${inv.used.length}</span></div>
<div class="rows">${used}</div>`;
  return layout(ctx, "invites", "Invites", inner);
}

export function renderActivity(ctx: PanelContext, events: ActivityEvent[], who: Person | null): string {
  const sub = who ? `For ${esc(who.name)} · <a href="/admin/activity">All activity</a>` : "Sign-ups, sign-ins and your changes, newest first";
  return layout(ctx, "activity", "Activity", `${header("Activity", sub)}\n${eventRows(events, ctx.now, "Nothing has happened yet")}`);
}

/** "Safari on Mac" from a user agent, as near as can be told. */
function browserName(agent: string): string {
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "A browser";
  const os = /iPhone|iPad/.test(agent) ? "iPhone or iPad" : /Mac OS X|Macintosh/.test(agent) ? "Mac" : /Android/.test(agent) ? "Android" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function renderSettings(ctx: PanelContext, owner: { email: string; totp: boolean }, sessions: OwnerSessionInfo[]): string {
  const s = ctx.env.SETTINGS;
  const lockedNote = `<small>Set by the server's environment</small>`;
  const name = s.locked.name
    ? `<div class="fieldi">${esc(s.name)}</div>`
    : `<input class="fieldi" data-setting="name" value="${esc(s.name)}" maxlength="64" autocomplete="off" aria-label="Name">`;
  const address = s.publicURL ?? ctx.origin;
  const https = address.startsWith("https:")
    ? `<span class="okt"><i></i>HTTPS</span>`
    : `<span class="okt warn"><i></i>Not HTTPS yet</span>`;
  const addr = s.locked.public_url
    ? `<div class="fieldi m">${esc(address)}${https}</div>`
    : `<div class="fieldi m inp"><input data-setting="address" value="${esc(s.publicURL ?? "")}" placeholder="${esc(ctx.origin)}" autocomplete="off" spellcheck="false" aria-label="Address">${https}</div>`;
  const seg = (key: string, label: string, options: [string, string][], current: string, locked: boolean) =>
    `<div class="sg" role="radiogroup" aria-label="${esc(label)}">${options
      .map(
        ([v, l]) =>
          `<button type="button" role="radio" aria-checked="${v === current}"${v === current ? ` class="on"` : ""} data-setting="${key}" data-value="${esc(v)}"${
            locked ? " disabled" : ""
          }>${esc(l)}</button>`,
      )
      .join("")}</div>`;
  const signups = seg(
    "signups",
    "Who can join",
    [
      ["invite", "Invite only"],
      ["open", "Anyone"],
      ["closed", "Just me"],
    ],
    s.signups,
    !!s.locked.signups,
  );
  const storage = seg(
    "defaultBytes",
    "Storage per person",
    STORAGE.map(([b, l]) => [String(b), l]),
    String(s.defaultBytes),
    false,
  );
  const sessionRows = sessions
    .map(
      (x) =>
        `<div class="srow"><div><b>${x.current ? "This browser" : esc(browserName(x.agent))}</b><small>${esc(x.current ? browserName(x.agent) : `Signed in ${ago(x.created_at, ctx.now)}`)}</small></div><div class="mono muted">${esc(
          x.ip,
        )} · active ${esc(ago(x.last_seen_at, ctx.now))}</div></div>`,
    )
    .join("");
  const totp = owner.totp
    ? `<span class="okt"><i></i>Authenticator on</span><button type="button" class="btn ghost sm" data-open="totp-off">Turn off</button>`
    : `<span class="okt warn"><i></i>Authenticator off</span><button type="button" class="btn ghost sm" data-open="totp-on">Turn on</button>`;
  const update = updateState(ctx.env);
  const inner = `${header("Settings", "Changes save as you go")}
<div class="h">Server</div>
<div class="rows">
<div class="srow"><div><b>Name</b>${s.locked.name ? lockedNote : "<small>Shown in the apps</small>"}</div>${name}</div>
<div class="srow"><div><b>Address</b>${s.locked.public_url ? lockedNote : "<small>For apps and key pages</small>"}</div>${addr}</div>
<div class="srow"><div><b>Who can join</b>${s.locked.signups ? lockedNote : ""}</div><div>${signups}</div></div>
<div class="srow"><div><b>Storage per person</b><small>Change one person in Team</small></div><div>${storage}</div></div>
</div>
<div class="h">You</div>
<div class="rows">
<div class="srow"><div><b>Owner login</b><small>${esc(owner.email)}</small></div><div class="btns">${totp}<button type="button" class="btn ghost sm" data-open="password">Change password</button>${
    sessions.length > 1 ? action("Sign out other sessions", { method: "POST", path: "/admin/api/owner/sessions/end-others" }) : ""
  }</div></div>
${sessionRows}
</div>
<div class="h">Maintenance</div>
<div class="rows">
<div class="srow"><div><b>Backups</b><small>One SQLite file</small></div><div class="btns"><a class="btn ghost sm" href="/admin/api/backup" download>Download a backup</a><span class="note">Nightly at 03:00 into the data volume</span></div></div>
<div class="srow"><div><b>Updates</b><small>${esc(ctx.env.VERSION)}${update === undefined ? "" : ` · ${esc(update ? updateText(update) : "up to date")}`}</small></div><div class="mono muted">docker compose pull &amp;&amp; docker compose up -d</div></div>
</div>`;
  const pw = (id: string, label: string, auto: string, extra = "") =>
    `<div class="fr"><label for="${id}">${label}</label><input id="${id}" type="password" required autocomplete="${auto}"${extra}></div>`;
  const dialogs = `
<dialog class="dlg" data-dialog="password" aria-labelledby="pw-title"><form method="dialog" data-api="/admin/api/owner/password" novalidate>
<h4 id="pw-title">Change password</h4><p class="cap">Your other sessions are signed out.</p>
<div class="fg">${pw("pw-current", "Current", "current-password", ' name="current"')}${pw("pw-next", "New", "new-password", ' name="next" minlength="12" placeholder="At least 12 characters"')}</div>
<p class="err" role="alert" hidden></p>
<div class="acts"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button type="submit" class="btn primary grow">Change password</button></div>
</form></dialog>
<dialog class="dlg" data-dialog="totp-on" aria-labelledby="totp-on-title"><form method="dialog" data-api="/admin/api/owner/totp/confirm" data-totp-start novalidate>
<h4 id="totp-on-title">Turn on the authenticator</h4><p class="cap">Add this key to your authenticator app, then type the code it shows.</p>
<p class="secret" data-secret>…</p><a class="mono uri" data-uri href="#">Open in your authenticator app</a>
<div class="fg"><div class="fr"><label for="totp-code">Code</label><input class="m" id="totp-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456"></div></div>
<p class="err" role="alert" hidden></p>
<div class="acts"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button type="submit" class="btn primary grow">Turn on</button></div>
</form></dialog>
<dialog class="dlg" data-dialog="totp-off" aria-labelledby="totp-off-title"><form method="dialog" data-api="/admin/api/owner/totp/disable" novalidate>
<h4 id="totp-off-title">Turn off the authenticator</h4><p class="cap">Signing in will need only your password.</p>
<div class="fg">${pw("totp-off-pw", "Password", "current-password", ' name="password"')}</div>
<p class="err" role="alert" hidden></p>
<div class="acts"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button type="submit" class="btn primary danger grow">Turn off</button></div>
</form></dialog>`;
  return layout(ctx, "settings", "Settings", inner, dialogs);
}

export function renderLogin(env: Env): string {
  const body = `<main class="moment"><canvas data-field="moment" aria-hidden="true"></canvas>
<form class="ocard" data-api="/admin/login" data-then="/admin" data-login novalidate>${MARK}
<h3>Sign in</h3>
<p class="sub">The panel for ${esc(env.SETTINGS.name)}.</p>
<div class="fg">
<div class="fr"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="username" spellcheck="false" autofocus></div>
<div class="fr"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password"></div>
<div class="fr" data-code-row hidden><label for="code">Code</label><input class="m" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456"></div>
</div>
<p class="err" role="alert" hidden></p>
<div class="acts"><button class="btn primary grow" type="submit">Sign in</button></div>
</form></main>`;
  return page({ title: `Sign in · ${env.SETTINGS.name}`, body, script: "panel", version: env.VERSION });
}

export function renderNotFound(env: Env): string {
  const body = `<main class="moment"><canvas data-field="moment" aria-hidden="true"></canvas><section class="ocard">${MARK}
<h3>Not found</h3><p class="sub">There's nothing at this address.</p>
<div class="acts"><a class="btn primary grow" href="/admin">Back to the panel</a></div></section></main>`;
  return page({ title: `Not found · ${env.SETTINGS.name}`, body, script: "panel", version: env.VERSION });
}
