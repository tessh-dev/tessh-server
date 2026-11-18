// The panel's pages as HTML. Plain server rendering: assets/web/panel.js only adds the writes, copy buttons,
// dialogs and segmented controls. No inline scripts, styles or style attributes (the CSP forbids them).
import type { Env } from "../index.ts";
import type { InviteRow } from "../invites.ts";
import { NO_LIMIT } from "../limits.ts";
import type { OwnerSessionInfo } from "../owner.ts";
import { icons } from "./icons.ts";
import { updateStatus, type Release, type UpdateStatus } from "../updates.ts";
import type { ActivityEvent, Overview, Person } from "./panel.ts";
import { MARK, connectBlock, esc, page, totpEnrol } from "./shell.ts";

export interface PanelContext {
  env: Env;
  origin: string;
  host: string;
  counts: { people: number; waiting: number };
  now: number;
  /** The owner login's email, shown in the sidebar footer. */
  ownerEmail: string;
}

/** What the Overview's health tile and Maintenance say about the server itself. */
export interface Health {
  uptimeMs: number;
  /** When the newest nightly backup was written, or null when there is none yet. */
  lastBackup: string | null;
  /** Whether the address apps use is HTTPS. */
  https: boolean;
}

type Section = "overview" | "devices" | "team" | "invites" | "activity" | "settings" | "maintenance";

/** Just me: sign-ups are closed, so the panel is about the owner's own devices, not a team. */
const isSolo = (env: Env) => env.SETTINGS.signups === "closed";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STORAGE: [number, string][] = [
  [524_288_000, "500 MB"],
  [1_073_741_824, "1 GB"],
  [5_368_709_120, "5 GB"],
  [NO_LIMIT, "No limit"],
];
const UPDATE_COMMAND = "docker compose pull && docker compose up -d";
const UPDATE_WHERE = "Run it where your compose file is. Your data stays in the data volume.";
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

/** "12 min", "5 h", "3 days". */
function uptime(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MIN))} min`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h`;
  return plural(Math.floor(ms / DAY), "day", "days");
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** A backup's time in server-local time: "03:00" today, "yesterday 03:00", then how long ago. */
function backupTime(iso: string, now: number): string {
  const d = new Date(iso);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return hhmm(d);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday ${hhmm(d)}`;
  return ago(iso, now);
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

const QUIET = "Quiet so far. Sign-ins, new devices and your changes show up here as they happen.";

function eventRows(events: ActivityEvent[], now: number): string {
  if (events.length === 0)
    return `<div class="rows"><div class="row calm"><span class="ri">${icons.list}</span><div class="t"><b>Nothing has happened yet</b><small>${esc(QUIET)}</small></div></div></div>`;
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

/** The server tile: the t› glyph on a dark terminal tile, as on the apps' icon. */
const TILE = `<span class="lg" aria-hidden="true"><span class="gly"><span class="t">t</span><span class="c">›</span><span class="b"></span></span></span>`;

function layout(ctx: PanelContext, section: Section, head: { title: string; sub: string; extra?: string }, inner: string, dialogs = ""): string {
  const s = ctx.env.SETTINGS;
  const nav = (key: Section, href: string, icon: string, label: string, count?: number) =>
    `<a class="nav${key === section ? " on" : ""}" href="${href}"${key === section ? ` aria-current="page"` : ""}>${icon}<span>${label}</span>${
      count ? `<span class="ct">${count}</span>` : ""
    }</a>`;
  const items = isSolo(ctx.env)
    ? [nav("overview", "/admin", icons.grid, "Overview"), nav("devices", "/admin/devices", icons.laptop, "Devices"), nav("activity", "/admin/activity", icons.list, "Activity")]
    : [
        nav("overview", "/admin", icons.grid, "Overview"),
        nav("team", "/admin/team", icons.people, "Team", ctx.counts.people),
        nav("invites", "/admin/invites", icons.mail, "Invites", ctx.counts.waiting),
        nav("activity", "/admin/activity", icons.list, "Activity"),
      ];
  const update = updateStatus(ctx.env);
  const status =
    update.kind === "update"
      ? `<a class="upd" href="/admin/maintenance"><i class="dot warn"></i>Update available · ${esc(update.release.version)}</a>`
      : `<small><i class="dot"></i>Running · ${esc(ctx.env.VERSION)}</small>`;
  const email = ctx.ownerEmail || "Owner";
  const body = `<div class="body app-body">
<nav class="side" aria-label="Panel" data-side>
<div class="srv">${TILE}<div class="srv-t"><b>${esc(s.name)}</b>${status}</div><button type="button" class="menu" data-menu aria-expanded="false" aria-controls="panel-nav" aria-label="Menu">${icons.menu}${icons.close}</button></div>
<div class="navs" id="panel-nav">
${items.join("\n")}
<div class="grp">Server</div>
${nav("settings", "/admin/settings", icons.gear, "Settings")}
${nav("maintenance", "/admin/maintenance", icons.archive, "Maintenance")}
<div class="sbf"><span class="who sm ${colour(email)}" aria-hidden="true">${esc(email[0].toUpperCase())}</span><div class="sbf-t"><b>Owner</b><small>${esc(email)}</small></div><button type="button" class="iconbtn" data-act data-method="POST" data-path="/admin/api/signout" data-then="/admin/login" aria-label="Sign out" title="Sign out">${icons.signout}<span class="sr">Sign out</span></button></div>
</div>
</nav>
<main class="main"><canvas class="strip" data-field="top" aria-hidden="true"></canvas><div class="inner">
<div class="ph"><div><h1>${esc(head.title)}</h1><p>${head.sub}</p></div>${head.extra ? `<span class="sp"></span>${head.extra}` : ""}</div>
${inner}
</div></main>
</div>
<p class="toast" role="status" aria-live="polite" data-toast hidden></p>
${CONFIRM_DIALOG}${dialogs}`;
  return page({ title: `${head.title} · ${s.name}`, body, script: "panel" });
}

/** "Just you · keys.example.com" or "3 people · keys.example.com". */
function whoLine(ctx: PanelContext, people: number): string {
  const host = ctx.env.SETTINGS.publicURL ? new URL(ctx.env.SETTINGS.publicURL).host : ctx.host;
  return `${isSolo(ctx.env) ? "Just you" : esc(plural(people, "person", "people"))} · <span class="mono">${esc(host)}</span>`;
}

/** A small heading above a card, with an optional link on the right. */
const cap = (label: string, link?: [string, string]) =>
  `<div class="h">${esc(label)}${link ? `<a class="r" href="${link[0]}">${esc(link[1])}</a>` : ""}</div>`;

// ---- Pages ----

/** "12 Nov 2026". */
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The update notice: the new version, its date, a few plain lines of its notes, the release page and the command. */
function updateCard(ctx: PanelContext, r: Release): string {
  const sub = `You're on ${ctx.env.VERSION}${r.publishedAt ? ` · released ${day(r.publishedAt)}` : ""}`;
  const notes = r.notes.length ? `<ul class="upn">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
  return `<section class="upcard" aria-labelledby="upd-title"><span class="upi">${icons.upgrade}</span><div class="upt">
<h2 id="upd-title">Tessh Server ${esc(r.version)} is available</h2>
<p class="ups">${esc(sub)}</p>
${notes}<a class="upl" href="${esc(r.url)}" target="_blank" rel="noopener">What's new</a>
<div class="cmd"><code>${esc(UPDATE_COMMAND)}</code>${copyButton(UPDATE_COMMAND)}</div>
<p class="cap">${esc(UPDATE_WHERE)}</p>
</div></section>`;
}

/** Maintenance's version row when there is no update to show. */
function versionRow(ctx: PanelContext, u: Exclude<UpdateStatus, { kind: "update" }>): string {
  const v = esc(ctx.env.VERSION);
  const [right, note] =
    u.kind === "current"
      ? [`${v} · <span class="okp">Up to date</span> · checked ${esc(ago(new Date(u.checkedAt).toISOString(), ctx.now))}`, "Checked against GitHub Releases once a day"]
      : u.kind === "failed"
        ? [`${v} · <span class="warnp">Couldn't check for updates</span>`, `Last tried ${esc(ago(new Date(u.at).toISOString(), ctx.now))}. It tries again tomorrow.`]
        : u.kind === "off"
          ? [`${v} · The update check is off`, "Remove <code>UPDATE_CHECK=false</code> from the server's environment to turn it back on"]
          : [`${v} · Not checked yet`, "The first check runs a minute after the server starts"];
  return `<div class="srow"><div><b>Version</b><small>${note}</small></div><div class="mono">${right}</div></div>`;
}

/** One device of one person, with Sign out. */
function deviceRow(ctx: PanelContext, p: Person, d: Person["devices"][number], mine: boolean): string {
  const live = ctx.now - Date.parse(d.lastSeenAt) < 10 * MIN ? `<span class="livedot" aria-label="Active now"></span>` : "";
  return `<div class="row">${osTile(d.platform)}<div class="t"><b>${esc(d.name)}</b><small>${esc(platformName(d.platform))} · active ${esc(
    ago(d.lastSeenAt, ctx.now),
  )}</small></div><span class="r">${live}${action("Sign out", {
    method: "POST",
    path: `/admin/api/team/${p.id}/devices/${d.id}/sign-out`,
    tone: "danger",
    confirm: mine
      ? { title: `Sign out on ${d.name}?`, text: "The app on that device stops syncing. You can sign in again.", ok: "Sign out" }
      : { title: `Sign ${p.name} out on ${d.name}?`, text: "The app on that device stops syncing. They can sign in again.", ok: "Sign out" },
  })}</span></div>`;
}

/** Before the owner has an account: connect the apps with a link, a QR and the code in plain text. */
function connectCard(ctx: PanelContext, connect: OwnerConnect | null): string {
  const host = ctx.env.SETTINGS.publicURL ? new URL(ctx.env.SETTINGS.publicURL).host : ctx.host;
  const inner = connect
    ? connectBlock(host, connect, copyButton(connect.code))
    : `<p class="soft">Your code has been used or cancelled.</p>`;
  return `<div class="rows connect"><div class="cn">
<span class="ri">${icons.laptop}</span>
<div class="t"><b>Connect your apps</b>
${inner}</div></div></div>`;
}

/** The waiting owner code with its join link and the link's QR (an inline SVG). */
export interface OwnerConnect {
  code: string;
  link: string;
  qr: string;
}

export interface OverviewExtras {
  people: Person[];
  /** The owner's own account, or null until they sign up in an app. */
  owner: Person | null;
  /** The waiting owner code with its link and QR, when the owner has no account yet. */
  ownerConnect: OwnerConnect | null;
  health: Health;
}

function heroTile(ctx: PanelContext, o: Overview, x: OverviewExtras): string {
  const h = x.health;
  const u = updateStatus(ctx.env);
  const version =
    u.kind === "update"
      ? `${esc(o.version)} · <span class="w">update ${esc(u.release.version)} available</span>`
      : u.kind === "current"
        ? `${esc(o.version)} up to date`
        : esc(o.version);
  const backup = h.lastBackup ? `last backup ${esc(backupTime(h.lastBackup, ctx.now))}` : "no backup yet";
  const devices = isSolo(ctx.env) ? (x.owner?.devices.length ?? 0) : o.devices;
  return `<section class="hero" aria-label="Server health"><canvas data-field="tile" aria-hidden="true"></canvas>
<p class="l1"><span class="g">✓</span> ${esc(ctx.env.SETTINGS.name)} is running</p>
<p class="l2"><span class="p">~ %</span> up ${esc(uptime(h.uptimeMs))} · ${backup} · ${version}</p>
<div class="chips"><span class="chip">${esc(plural(devices, "device", "devices"))}</span><span class="chip">${esc(formatBytes(o.storage.bytes))} stored</span>${
    h.https ? `<span class="chip">HTTPS ✓</span>` : `<a class="chip warn" href="/admin/settings">Not HTTPS</a>`
  }</div></section>`;
}

export function renderOverview(ctx: PanelContext, o: Overview, x: OverviewExtras): string {
  let middle: string;
  if (isSolo(ctx.env)) {
    if (!x.owner) middle = `${cap("Your devices")}${connectCard(ctx, x.ownerConnect)}`;
    else {
      const rows = x.owner.devices.length
        ? x.owner.devices
            .slice(0, 5)
            .map(
              (d) =>
                `<div class="row">${osTile(d.platform)}<div class="t"><b>${esc(d.name)}</b><small>${esc(platformName(d.platform))} · active ${esc(
                  ago(d.lastSeenAt, ctx.now),
                )}</small></div>${ctx.now - Date.parse(d.lastSeenAt) < 10 * MIN ? `<span class="r"><span class="livedot" aria-label="Active now"></span></span>` : ""}</div>`,
            )
            .join("")
        : `<div class="row calm"><span class="ri">${icons.laptop}</span><div class="t"><b>No devices signed in</b><small>Sign in from the Tessh app with your Tessh account.</small></div></div>`;
      middle = `${cap("Your devices", ["/admin/devices", "Manage"])}<div class="rows">${rows}</div>`;
    }
  } else {
    const rows = x.people.length
      ? x.people
          .slice(0, 5)
          .map(
            (p) =>
              `<a class="row link" href="/admin/team/${esc(p.id)}">${avatar(p.id, p.name)}<div class="t"><b>${esc(p.name)}${
                p.role === "owner" ? ` <span class="chipn ink">Owner</span>` : ""
              }${p.suspended ? ` <span class="chipn">Suspended</span>` : ""}</b><small>${esc(p.email)}</small></div><span class="r">${esc(
                plural(p.devices.length, "device", "devices"),
              )}${icons.chevron}</span></a>`,
          )
          .join("")
      : `<div class="row calm"><span class="ri">${icons.people}</span><div class="t"><b>No one has joined yet</b><small>Make an invite and send them the link.</small></div><span class="r"><a class="btn ghost sm" href="/admin/invites">Invites</a></span></div>`;
    middle = `${x.owner ? "" : `${cap("Your own apps")}${connectCard(ctx, x.ownerConnect)}`}${cap("Team", ["/admin/team", "All"])}<div class="rows">${rows}</div>`;
  }
  const u = updateStatus(ctx.env);
  const inner = `${u.kind === "update" ? updateCard(ctx, u.release) : ""}${heroTile(ctx, o, x)}
${middle}
${cap("Recent activity", ["/admin/activity", "All"])}
${eventRows(o.recent, ctx.now)}`;
  return layout(ctx, "overview", { title: "Overview", sub: whoLine(ctx, o.people) }, inner);
}

export function renderDevices(ctx: PanelContext, owner: Person | null, connect: OwnerConnect | null): string {
  const people = ctx.counts.people;
  if (!owner) return layout(ctx, "devices", { title: "Devices", sub: whoLine(ctx, people) }, connectCard(ctx, connect));
  const rows = owner.devices.length
    ? owner.devices.map((d) => deviceRow(ctx, owner, d, true)).join("")
    : `<div class="row calm"><span class="ri">${icons.laptop}</span><div class="t"><b>No devices signed in</b><small>Sign in from the Tessh app with ${esc(owner.email)}.</small></div></div>`;
  const used = `${formatBytes(owner.usage.bytes)} of ${owner.limit.bytes === NO_LIMIT ? "no limit" : formatBytes(owner.limit.bytes)}`;
  const inner = `${cap(`Signed in as ${owner.email}`)}
<div class="rows">${rows}</div>
${cap("Storage")}
<div class="rows"><div class="srow"><div><b>Used</b><small>${esc(plural(owner.usage.items, "item", "items"))}, encrypted on your devices</small></div><div class="mono muted">${esc(used)}</div></div></div>
<p class="cap note">${esc("Signing a device out stops it syncing. Your data stays on the server.")}</p>`;
  return layout(ctx, "devices", { title: "Devices", sub: whoLine(ctx, people) }, inner);
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
    ? p.devices.map((d) => deviceRow(ctx, p, d, false)).join("")
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
  const inner = `<div class="rows">${rows}</div>
<p class="cap note">${esc(PRIVACY)}</p>`;
  return layout(ctx, "team", { title: "Team", sub: esc(sub), extra: `<a class="btn primary sm" href="/admin/invites">${icons.plus}New invite</a>` }, inner, limitDialog(ctx));
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
  const inner = `<form class="fg invbar" data-invite novalidate>
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
  return layout(ctx, "invites", { title: "Invites", sub: esc(sub) }, inner);
}

export function renderActivity(ctx: PanelContext, events: ActivityEvent[], who: Person | null): string {
  const sub = who ? `For ${esc(who.name)} · <a href="/admin/activity">All activity</a>` : "Sign-ups, sign-ins and your changes, newest first";
  return layout(ctx, "activity", { title: "Activity", sub }, eventRows(events, ctx.now));
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
  const seg = (key: string, label: string, options: [string, string][], current: string, locked: boolean, attr = "data-setting") =>
    `<div class="sg" role="radiogroup" aria-label="${esc(label)}">${options
      .map(
        ([v, l]) =>
          `<button type="button" role="radio" aria-checked="${v === current}"${v === current ? ` class="on"` : ""} ${attr}="${key}" data-value="${esc(v)}"${
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
  // Kept in this browser only (theme.js); the server renders Dark and panel.js marks the saved choice.
  const appearance = seg(
    "theme",
    "Appearance",
    [
      ["dark", "Dark"],
      ["light", "Light"],
      ["system", "Match system"],
    ],
    "dark",
    false,
    "data-appearance",
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
  const inner = `<div class="h">Server</div>
<div class="rows">
<div class="srow"><div><b>Name</b>${s.locked.name ? lockedNote : "<small>Shown in the apps</small>"}</div>${name}</div>
<div class="srow"><div><b>Address</b>${s.locked.public_url ? lockedNote : "<small>For apps and key pages</small>"}</div>${addr}</div>
<div class="srow"><div><b>Who can join</b>${s.locked.signups ? lockedNote : ""}</div><div>${signups}</div></div>
<div class="srow"><div><b>Storage per person</b>${isSolo(ctx.env) ? "" : "<small>Change one person in Team</small>"}</div><div>${storage}</div></div>
</div>
<div class="h">You</div>
<div class="rows">
<div class="srow"><div><b>Admin login</b><small>${esc(owner.email)}</small></div><div class="btns">${totp}<button type="button" class="btn ghost sm" data-open="password">Change password</button>${
    sessions.length > 1 ? action("Sign out other sessions", { method: "POST", path: "/admin/api/owner/sessions/end-others" }) : ""
  }</div></div>
${sessionRows}
</div>
<div class="h">This browser</div>
<div class="rows">
<div class="srow"><div><b>Appearance</b><small>Only the panel, only here</small></div><div>${appearance}</div></div>
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
<h4 id="totp-on-title">Turn on the authenticator</h4>${totpEnrol()}
<div class="otp-box" id="totp-code" data-otp data-name="code" data-label="Authenticator code"></div>
<p class="err" role="alert" hidden></p>
<div class="acts"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button type="submit" class="btn primary grow">Turn on</button></div>
</form></dialog>
<dialog class="dlg" data-dialog="totp-off" aria-labelledby="totp-off-title"><form method="dialog" data-api="/admin/api/owner/totp/disable" novalidate>
<h4 id="totp-off-title">Turn off the authenticator</h4><p class="cap">Signing in will need only your password.</p>
<div class="fg">${pw("totp-off-pw", "Password", "current-password", ' name="password"')}</div>
<p class="err" role="alert" hidden></p>
<div class="acts"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button type="submit" class="btn primary danger grow">Turn off</button></div>
</form></dialog>`;
  return layout(ctx, "settings", { title: "Settings", sub: "Changes save as you go" }, inner, dialogs);
}

export function renderMaintenance(ctx: PanelContext, owner: { totp: boolean }, h: Health): string {
  const u = updateStatus(ctx.env);
  const updates =
    u.kind === "update"
      ? updateCard(ctx, u.release)
      : `<div class="rows">
${versionRow(ctx, u)}
<div class="srow"><div><b>Update</b><small>Run this where your compose file is</small></div><div class="cmd"><code>${esc(UPDATE_COMMAND)}</code>${copyButton(UPDATE_COMMAND)}</div></div>
</div>`;
  const inner = `<div class="h">Backups</div>
<div class="rows">
<div class="srow"><div><b>Download a backup</b><small>One SQLite file with everyone's account data</small></div><div class="btns"><button type="button" class="btn ghost sm" data-open="backup">Download a backup</button></div></div>
<div class="srow"><div><b>Nightly</b><small>Nightly at 03:00 into the data volume, newest 7 kept</small></div><div class="mono muted">${
    h.lastBackup ? `Last: ${esc(backupTime(h.lastBackup, ctx.now))}` : "No backup yet"
  }</div></div>
</div>
<div class="h">Updates</div>
${updates}
<p class="cap note">Up ${esc(uptime(h.uptimeMs))}. Your data and settings stay in the data volume across updates.</p>`;
  const dialogs = `
<dialog class="dlg" data-dialog="backup" aria-labelledby="backup-title"><form method="dialog" data-download="/admin/api/backup" novalidate>
<h4 id="backup-title">Download a backup</h4><p class="cap">The file holds everyone's account data. Confirm it's you.</p>
<div class="fg"><div class="fr"><label for="backup-pw">Password</label><input id="backup-pw" type="password" required autocomplete="current-password" name="password"></div></div>${
    owner.totp ? `<div class="otp-box" id="backup-code" data-otp data-name="code" data-label="Authenticator code"></div>` : ""
  }
<p class="err" role="alert" hidden></p>
<div class="acts"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button type="submit" class="btn primary grow">Download</button></div>
</form></dialog>`;
  return layout(ctx, "maintenance", { title: "Maintenance", sub: "Backups and updates" }, inner, dialogs);
}

export function renderLogin(env: Env): string {
  const body = `<main class="moment"><canvas data-field="moment" aria-hidden="true"></canvas>
<form class="ocard" data-api="/admin/login" data-then="/admin" data-login novalidate>${MARK}
<h3>Sign in</h3>
<p class="sub">The panel for ${esc(env.SETTINGS.name)}.</p>
<p class="sub">This is your admin login. It's separate from your Tessh account in the apps.</p>
<div class="fg">
<div class="fr"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="username" spellcheck="false" autofocus></div>
<div class="fr"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password"></div>
</div>
<div class="otp-box" id="code" data-code-row data-otp data-name="code" data-label="Authenticator code" hidden></div>
<p class="err" role="alert" hidden></p>
<div class="acts"><button class="btn primary grow" type="submit">Sign in</button></div>
</form></main>`;
  return page({ title: `Sign in · ${env.SETTINGS.name}`, body, script: "panel" });
}

export function renderNotFound(env: Env): string {
  const body = `<main class="moment"><canvas data-field="moment" aria-hidden="true"></canvas><section class="ocard">${MARK}
<h3>Not found</h3><p class="sub">There's nothing at this address.</p>
<div class="acts"><a class="btn primary grow" href="/admin">Back to the panel</a></div></section></main>`;
  return page({ title: `Not found · ${env.SETTINGS.name}`, body, script: "panel" });
}
