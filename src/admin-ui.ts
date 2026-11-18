// Admin panel pages (desktop and 360 px phone). Strict CSP: no inline script or style,
// so widths/heights come from classes (w0…w20, h0…h20) and behaviour from /admin.js via data attributes.
import type { AccountDetail, AccountSummary, AuditRow, Filter } from "./admin.ts";
import type { Signups } from "./config.ts";
import { esc } from "./web/shell.ts";

export interface Ctx {
  admin: string;
  host: string;
  signups: Signups;
  counts: { accounts: number };
}

export { esc };

const MiB = 1024 * 1024;
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n >= Number.MAX_SAFE_INTEGER) return "No limit";
  if (n < 1024) return `${n} B`;
  if (n < MiB) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * MiB) return `${(n / MiB).toFixed(n < 10 * MiB ? 1 : 0)} MB`;
  return `${(n / 1024 / MiB).toFixed(1)} GB`;
}
const fmtInt = (n: number) => n.toLocaleString("en-GB");
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
export function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const fmtDateTime = (iso: string) => `${fmtDate(iso)} ${iso.slice(11, 16)} UTC`;
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86_400) return "yesterday";
  if (s < 30 * 86_400) return `${Math.round(s / 86_400)} days ago`;
  return fmtDate(iso);
}
/** a•••@example.com: lists mask the local part (shoulder-surfing); the account page shows it in full. */
export function maskEmail(e: string): string {
  const at = e.lastIndexOf("@");
  return at <= 0 ? "•••" : `${e[0]}•••${e.slice(at)}`;
}
const pct = (used: number, limit: number) => (limit > 0 ? Math.min(100, (used / limit) * 100) : 0);
const step = (p: number) => Math.max(0, Math.min(20, Math.round(p / 5)));
function meter(used: number, limit: number): string {
  const p = pct(used, limit);
  // Any use at all shows a sliver, so 1% never reads as empty.
  return `<span class="meter"><i class="w${used > 0 ? Math.max(1, step(p)) : 0}${p >= 80 ? " warn" : ""}"></i></span>`;
}
type Section = "overview" | "accounts" | "audit";

const SIGNUPS_LABEL: Record<Signups, string> = { open: "Sign-ups open", invite: "Invite only", closed: "Sign-ups closed" };

function layout(ctx: Ctx, section: Section, title: string, body: string): string {
  const nav = (id: Section, href: string, label: string, count?: number) =>
    `<a class="nv${id === section ? " on" : ""}" href="${href}"${id === section ? ' aria-current="page"' : ""}>${label}${count === undefined ? "" : ` <b>${fmtInt(count)}</b>`}</a>`;
  const who = ctx.admin.split("@")[0];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} · Tessh admin</title><link rel="stylesheet" href="/admin.css"><script src="/admin.js" defer></script></head>
<body><div class="m">
<nav class="sd" aria-label="Admin">
 <div class="lg"><a class="brand" href="/"><i>t›</i>Tessh <small>admin</small></a><span class="av" title="${esc(ctx.admin)}">${esc(who[0]?.toUpperCase() ?? "?")}</span></div>
 <div class="nav">${nav("overview", "/", "Overview")}${nav("accounts", "/accounts", "Accounts", ctx.counts.accounts)}${nav("audit", "/audit", "Audit log")}</div>
 <div class="who">${esc(ctx.host)}<br>${esc(SIGNUPS_LABEL[ctx.signups])} · ${esc(who)}</div>
</nav>
<main class="mn">${body}
<p class="zk"><b>Zero-knowledge:</b> admin sees counts and sizes only, never hosts, keys or passwords. Every action is logged.</p>
</main></div></body></html>`;
}

function accountRow(a: AccountSummary, now: number): string {
  const devices = `${a.devices} device${a.devices === 1 ? "" : "s"}`;
  return `<a class="acc" href="/accounts/${esc(a.id)}"><span class="em">${esc(maskEmail(a.email))}</span><span class="seen">${esc(ago(a.lastSeenAt, now))}</span>
<span class="meta">${a.username ? `<span class="mono">/${esc(a.username)}</span>` : ""}<span>${devices}</span><span>${meter(a.usage.bytes, a.limits.bytes)}${fmtBytes(a.usage.bytes)}</span>${a.twoStep ? '<span class="pill on">2FA</span>' : ""}${a.suspended ? '<span class="pill bad">Suspended</span>' : ""}</span></a>`;
}

function accountList(rows: AccountSummary[], empty: string): string {
  const now = Date.now();
  return rows.length ? rows.map((a) => accountRow(a, now)).join("\n") : `<p class="empty">${esc(empty)}</p>`;
}

export function renderOverview(
  ctx: Ctx,
  o: Awaited<ReturnType<typeof import("./admin.ts").overview>>,
  recent: AccountSummary[],
): string {
  const max = Math.max(1, ...o.signups30d.map((d) => d.count));
  const bars = o.signups30d
    .map((d) => `<i class="h${step((d.count / max) * 100)}" title="${esc(d.day)}: ${d.count}"></i>`)
    .join("");
  const total30 = o.signups30d.reduce((s, d) => s + d.count, 0);
  const activePct = o.accounts ? Math.round((o.active7d / o.accounts) * 100) : 0;
  const twoPct = o.accounts ? Math.round((o.twoStep / o.accounts) * 100) : 0;
  const warn = (n: number) => (n > 0 ? " w" : "");
  return layout(
    ctx,
    "overview",
    "Overview",
    `<div class="hd"><h1>Overview</h1><span>Updated ${esc(o.updatedAt.slice(11, 16))} UTC</span></div>
<div class="st">
 <div class="c"><small>Accounts</small><div class="v">${fmtInt(o.accounts)}</div><div class="d">+${fmtInt(o.newThisWeek)} this week</div></div>
 <div class="c"><small>Active 7 days</small><div class="v">${fmtInt(o.active7d)}</div><div class="d">${activePct}%</div></div>
 <div class="c"><small>Storage</small><div class="v">${fmtBytes(o.storage.bytes)}</div><div class="d mut">of ${fmtBytes(o.storage.capacity)}</div></div>
 <div class="c"><small>Two-step on</small><div class="v">${twoPct}%</div><div class="d">${fmtInt(o.twoStep)} account${o.twoStep === 1 ? "" : "s"}</div></div>
</div>
<div class="row2">
 <div class="c"><small>Sign-ups · 30 days · ${fmtInt(total30)}</small><div class="bars" role="img" aria-label="${total30} sign-ups in 30 days">${bars}</div></div>
 <div class="c"><small>Health</small><div class="hl">
  <div><span><span class="dot${warn(o.health.failedLogins1h)}"></span>Failed logins 1 h</span><b>${fmtInt(o.health.failedLogins1h)}</b></div>
  <div><span><span class="dot${warn(o.health.failedCodes1h)}"></span>Failed two-step 1 h</span><b>${fmtInt(o.health.failedCodes1h)}</b></div>
  <div><span><span class="dot${warn(o.suspended)}"></span>Suspended</span><b>${fmtInt(o.suspended)}</b></div>
  <div><span><span class="dot"></span>Devices</span><b>${fmtInt(o.devices)}</b></div>
 </div></div>
</div>
<div class="list"><div class="tools"><div class="lt"><b>Recently active</b><a href="/accounts">All accounts</a></div></div>
${accountList(recent, "No accounts yet.")}</div>`,
  );
}

const FILTERS: [Filter, string][] = [["all", "All"], ["two_step", "Two-step"], ["near", "Near limit"], ["suspended", "Suspended"]];

export function renderAccounts(ctx: Ctx, rows: AccountSummary[], q: string, filter: Filter): string {
  const href = (f: Filter) => `/accounts?${new URLSearchParams({ ...(q ? { q } : {}), ...(f === "all" ? {} : { filter: f }) })}`;
  const chips = FILTERS
    .map(([f, label]) => `<a class="chip${f === filter ? " on" : ""}" href="${esc(href(f))}">${esc(label)}</a>`)
    .join("");
  return layout(
    ctx,
    "accounts",
    "Accounts",
    `<div class="hd"><h1>Accounts</h1><span>${rows.length === 200 ? "First 200" : `${fmtInt(rows.length)} shown`}</span></div>
<div class="list"><div class="tools">
 <form class="srchf" method="get" action="/accounts" role="search">${filter === "all" ? "" : `<input type="hidden" name="filter" value="${esc(filter)}">`}
  <input class="srch" type="search" name="q" value="${esc(q)}" placeholder="Search email or username…" aria-label="Search email or username" autocomplete="off"></form>
 <div class="chips">${chips}</div></div>
${accountList(rows, q || filter !== "all" ? "No accounts match." : "No accounts yet.")}</div>`,
  );
}

function dialog(id: string, title: string, inner: string, opts: { api: string; method: string; done: string; submit: string; bad?: boolean }): string {
  return `<dialog id="${id}" aria-labelledby="${id}-t"><form class="dlg" data-api="${esc(opts.api)}" data-method="${opts.method}" data-done="${esc(opts.done)}">
<h2 id="${id}-t">${esc(title)}</h2>${inner}<p class="err" role="alert" hidden></p>
<div class="dact"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn ${opts.bad ? "bad" : "pri"}">${esc(opts.submit)}</button></div></form></dialog>`;
}

const numField = (name: string, label: string, value: number | null, placeholder: string, scale?: number, required = false) =>
  `<label>${esc(label)}<input name="${name}" inputmode="numeric" data-type="int"${scale ? ` data-scale="${scale}"` : ""} value="${value === null ? "" : esc(scale ? +(value / scale).toFixed(2) : value)}" placeholder="${esc(placeholder)}"${required ? " required" : ""} autocomplete="off"></label>`;

export function renderAccount(ctx: Ctx, a: AccountDetail, audit: AuditRow[]): string {
  const now = Date.now();
  const base = `/api/accounts/${a.id}`;
  const devices = a.deviceList.length
    ? a.deviceList
        .map((d) => `<li><span>${esc(d.name)} <span class="soft">${esc(d.platform)}</span></span><span class="soft">last sync ${esc(ago(d.lastSeenAt, now))}</span></li>`)
        .join("")
    : `<li class="soft">No signed-in devices</li>`;
  const facts: [string, string][] = [
    ["Created", fmtDate(a.createdAt)],
    ["Last seen", ago(a.lastSeenAt, now)],
    ["Two-step", a.twoStep ? `On · ${a.backupCodesLeft} backup code${a.backupCodesLeft === 1 ? "" : "s"} left` : "Off"],
    ["Recovery code", a.recovery ? "Set" : "Not set"],
    ["Key page", a.keyPage ? `<span class="mono">/${esc(a.keyPage.username)}</span>${a.keyPage.seq ? ` · v${a.keyPage.seq}` : " · not published"}` : "None"],
    ["Status", a.suspended ? `<span class="bad-t">Suspended ${esc(fmtDate(a.suspendedAt))}</span>` : "Active"],
  ];
  const custom = a.overrides.bytes !== null;
  const usage = `<div class="use">
 <div><span>Storage</span><span>${fmtBytes(a.usage.bytes)} of ${fmtBytes(a.limits.bytes)}</span></div>${meter(a.usage.bytes, a.limits.bytes).replace('class="meter"', 'class="meter wide"')}
 <div><span>Items</span><span>${fmtInt(a.usage.items)} of ${fmtInt(a.limits.items)}</span></div>${meter(a.usage.items, a.limits.items).replace('class="meter"', 'class="meter wide"')}
 <div><span>Devices</span><span>${a.devices} of ${a.limits.devices}</span></div>
 ${custom ? '<p class="soft">Custom storage limit set for this account.</p>' : ""}</div>`;

  const dialogs = [
    dialog(
      "d-limits",
      "Storage limit",
      `<p class="soft">Blank uses the server default.</p>
${numField("bytes", "Storage (MB)", a.overrides.bytes, "server default", MiB)}`,
      { api: `${base}/limits`, method: "POST", done: "reload", submit: "Save limits" },
    ),
    dialog("d-signout", "Sign out all devices", `<p>Ends every session on ${a.devices} device${a.devices === 1 ? "" : "s"}. The apps will ask for the password again.</p>`, {
      api: `${base}/sign-out`, method: "POST", done: "reload", submit: "Sign out all", bad: true,
    }),
    dialog("d-2fa", "Reset two-step", `<p>Turns two-step off and deletes the backup codes. Only do this after checking who is asking.</p>`, {
      api: `${base}/reset-two-step`, method: "POST", done: "reload", submit: "Reset two-step", bad: true,
    }),
    a.suspended
      ? dialog("d-suspend", "Unsuspend", `<p>Sign-in and sync work again. Existing sessions come back.</p>`, {
          api: `${base}/unsuspend`, method: "POST", done: "reload", submit: "Unsuspend",
        })
      : dialog("d-suspend", "Suspend", `<p>Blocks sign-in and sync. Sessions are kept, so unsuspending restores them.</p>`, {
          api: `${base}/suspend`, method: "POST", done: "reload", submit: "Suspend", bad: true,
        }),
    dialog(
      "d-delete",
      "Delete account",
      `<p>Deletes the account, its devices, synced items and key page. This can't be undone.</p>
<label>Type <b>${esc(a.email)}</b> to confirm<input name="confirm_email" data-match="${esc(a.email)}" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>`,
      { api: base, method: "DELETE", done: "/accounts", submit: "Delete account", bad: true },
    ),
  ].join("\n");

  return layout(
    ctx,
    "accounts",
    a.email,
    `<div class="hd"><h1><a class="back" href="/accounts" aria-label="Back to accounts">‹</a> Account</h1><span>${esc(a.id)}</span></div>
<div class="c drw"><h3>${esc(a.email)}</h3><small>Created ${esc(fmtDate(a.createdAt))} · ${fmtInt(a.usage.items)} encrypted item${a.usage.items === 1 ? "" : "s"}</small>
 <div class="acts">
  <button class="btn" data-open="d-limits">Storage limit</button>
  <button class="btn" data-open="d-signout">Sign out devices</button><button class="btn" data-open="d-2fa"${a.twoStep ? "" : " disabled"}>Reset two-step</button>
  <button class="btn" data-open="d-suspend">${a.suspended ? "Unsuspend" : "Suspend"}</button><a class="btn" href="/audit?user=${esc(a.id)}">Audit log</a>
  <button class="btn bad wide" data-open="d-delete">Delete account</button>
 </div></div>
<div class="grid2">
 <div class="c"><small>Facts</small><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>
 <div class="c"><small>Usage${custom ? " · custom limit" : ""}</small>${usage}</div>
</div>
<div class="c sec"><small>Devices</small><ul class="devs">${devices}</ul></div>
<div class="c sec"><small>Recent admin actions</small>${auditList(audit, false)}</div>
${dialogs}`,
  );
}

const ACTIONS: Record<string, string> = {
  custom_limits: "Set storage limit",
  sign_out_all: "Signed out all devices",
  reset_two_step: "Reset two-step",
  suspend: "Suspended",
  unsuspend: "Unsuspended",
  delete_account: "Deleted account",
};

function detailText(a: AuditRow): string {
  const d = a.detail;
  switch (a.action) {
    case "custom_limits":
      return `storage ${d.bytes === null || d.bytes === undefined ? "server default" : fmtBytes(Number(d.bytes))}`;
    case "sign_out_all":
      return `${d.devices} device${d.devices === 1 ? "" : "s"}`;
    default:
      return "";
  }
}

function auditList(rows: AuditRow[], withAccount = true): string {
  if (!rows.length) return `<p class="empty">Nothing yet.</p>`;
  return `<ul class="audit">${rows
    .map((a) => {
      const who = withAccount && a.email ? (a.userId ? `<a href="/audit?user=${esc(a.userId)}">${esc(a.email)}</a>` : esc(a.email)) : "";
      return `<li><div><b>${esc(ACTIONS[a.action] ?? a.action)}</b>${who ? ` · ${who}` : ""}<span class="soft">${esc(detailText(a))}</span></div><small>${esc(fmtDateTime(a.at))} · ${esc(a.admin)}</small></li>`;
    })
    .join("")}</ul>`;
}

export function renderAudit(ctx: Ctx, rows: AuditRow[], userId: string | null): string {
  const email = userId ? rows.find((r) => r.email)?.email ?? userId : null;
  return layout(
    ctx,
    "audit",
    "Audit log",
    `<div class="hd"><h1>Audit log</h1><span>${userId ? `${esc(email)} · <a href="/audit">All accounts</a>` : "Newest first"}</span></div>
<div class="c">${auditList(rows, !userId)}</div>`,
  );
}

export function renderNotFound(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found · Tessh admin</title><link rel="stylesheet" href="/admin.css"></head><body><main class="nf"><h1>Not found</h1><p><a href="/">Back to the overview</a></p></main></body></html>`;
}

const steps = (prefix: string, prop: string) =>
  Array.from({ length: 21 }, (_, i) => `.${prefix}${i}{${prop}:${i * 5}%}`).join("");

export const ADMIN_CSS = `:root{--bg:#0b0c0e;--side:#0e0f12;--panel:#131418;--line:#22242a;--ink:#ececef;--mut:#9a9ca3;--soft:#6b6e76;--blue:#3b82f6;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;color-scheme:dark}
*{box-sizing:border-box}
html{height:100%;background:var(--bg)}
body{margin:0;min-height:100%;background:var(--bg);color:var(--ink);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Inter",sans-serif;-webkit-text-size-adjust:100%}
a{color:inherit;text-decoration:none}
a:hover{color:#93c5fd}
.m{display:grid;grid-template-columns:180px minmax(0,1fr);min-height:100vh}
.sd{min-width:0;background:var(--side);border-right:1px solid var(--line);padding:14px 10px;display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh}
.lg{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 6px 14px;font-weight:500}
.brand{display:flex;gap:8px;align-items:center}
.lg i{width:22px;height:22px;border-radius:6px;background:#fff;color:#000;font:600 11px ui-monospace,monospace;display:grid;place-items:center;font-style:normal}
.lg small{color:var(--mut);font-weight:400}
.av{width:26px;height:26px;border-radius:50%;background:var(--blue);display:none;place-items:center;font-size:11px}
.nav{display:flex;flex-direction:column;gap:2px}
.nv{padding:7px 10px;border-radius:8px;color:var(--mut);display:flex;justify-content:space-between;gap:8px;white-space:nowrap}
.nv:hover{background:#ffffff0a;color:var(--ink)}
.nv.on{background:#ffffff12;color:var(--ink)}
.nv b{font-weight:400;color:var(--soft)}
.who{margin-top:auto;font-size:11px;color:var(--soft);padding:8px;border-top:1px solid var(--line);overflow-wrap:anywhere}
.mn{padding:18px 20px;min-width:0;max-width:1100px}
.hd{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:14px}
.hd h1{font-size:20px;font-weight:400;margin:0}
.hd>span{color:var(--mut);font-size:12px;overflow-wrap:anywhere}
.hd>span a{color:#93c5fd}
.back{color:var(--mut);padding-right:4px}
.st{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:10px}
.c{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0}
.c small{color:var(--mut);font-size:11px}
.c .v{font-size:22px;margin-top:2px}
.c .d{font-size:11px;color:var(--ok)}
.c .d.mut{color:var(--mut)}
.row2,.grid2{display:grid;grid-template-columns:1.4fr 1fr;gap:10px;margin-bottom:10px}
.grid2{grid-template-columns:1fr 1fr;margin-top:10px}
.bars{display:flex;align-items:end;gap:3px;height:64px;margin-top:10px}
.bars i{flex:1;background:linear-gradient(var(--blue),#1d4ed8);border-radius:3px 3px 0 0;opacity:.85;min-height:2px}
${steps("h", "height")}
.hl{display:flex;flex-direction:column;gap:7px;margin-top:8px}
.hl div{display:flex;justify-content:space-between;gap:8px;color:var(--mut)}
.hl b{font-weight:400;color:var(--ink);text-align:right}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ok);margin-right:6px}
.dot.w{background:var(--warn)}
.list{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.tools{padding:10px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.lt{display:flex;justify-content:space-between;gap:8px}
.lt b{font-weight:500}
.lt a{color:#93c5fd;font-size:12px}
.srchf{margin:0}
.srch{width:100%;background:#0b0c0e;border:1px solid var(--line);border-radius:9px;padding:8px 10px;color:var(--ink);font:inherit}
.srch::placeholder{color:var(--soft)}
input:focus-visible,select:focus-visible,.btn:focus-visible,a:focus-visible{outline:2px solid #3b82f6aa;outline-offset:1px}
.chips{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{padding:5px 10px;border-radius:99px;background:#ffffff0d;color:var(--mut);font-size:12px;white-space:nowrap}
.chip.on{background:#3b82f622;color:#93c5fd}
.acc{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:11px 12px;border-bottom:1px solid var(--line)}
.acc:last-child{border-bottom:0}
.acc:hover{background:#3b82f614;color:inherit}
.acc .em{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acc .meta{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px 12px;color:var(--mut);font-size:12px;align-items:center}
.acc .seen{color:var(--soft);font-size:12px}
.empty{padding:14px 12px;color:var(--soft);margin:0}
.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}
.soft{color:var(--soft)}
.bad-t{color:var(--bad)}
.pill{font-size:10.5px;padding:2px 7px;border-radius:6px;background:#ffffff10;color:var(--mut);white-space:nowrap}
.pill.on{background:#4ade8020;color:var(--ok)}
.pill.bad{background:#f8717118;color:var(--bad)}
.meter{width:46px;height:5px;border-radius:3px;background:#ffffff12;display:inline-block;vertical-align:middle;margin-right:5px;overflow:hidden}
.meter.wide{display:block;width:100%;margin:4px 0 8px}
.meter i{display:block;height:100%;border-radius:3px;background:var(--blue)}
.meter i.warn{background:var(--warn)}
${steps("w", "width")}
.drw h3{margin:0 0 2px;font-size:14px;font-weight:500;overflow-wrap:anywhere}
.acts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:10px}
.btn{padding:9px 10px;border-radius:9px;background:#ffffff10;font:inherit;font-size:12.5px;text-align:center;color:var(--ink);border:0;cursor:pointer}
.btn:hover:not([disabled]){background:#ffffff1f;color:var(--ink)}
.btn[disabled]{opacity:.4;cursor:default}
.btn.pri{background:var(--blue);color:#fff}
.btn.pri:hover{background:#2563eb}
.btn.bad{background:#f8717118;color:var(--bad)}
.btn.bad:hover:not([disabled]){background:#f8717130;color:var(--bad)}
.btn.wide{grid-column:1/-1}
.facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 14px;margin:8px 0 0}
.facts dt{color:var(--mut)}
.facts dd{margin:0;overflow-wrap:anywhere}
.use{margin-top:8px}
.use>div{display:flex;justify-content:space-between;gap:8px;color:var(--mut)}
.use>div span:last-child{color:var(--ink)}
.use p{margin:8px 0 0;font-size:12px}
.sec{margin-top:10px}
.devs,.audit{list-style:none;margin:8px 0 0;padding:0}
.devs li{display:flex;justify-content:space-between;flex-wrap:wrap;gap:2px 10px;padding:7px 0;border-top:1px solid var(--line)}
.devs li:first-child{border-top:0}
.audit li{padding:9px 0;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:2px}
.audit li:first-child{border-top:0}
.audit li div{overflow-wrap:anywhere}
.audit li div b{font-weight:500}
.audit li div .soft{margin-left:8px}
.audit a{color:#93c5fd}
.audit small{color:var(--soft)}
.zk{margin-top:14px;font-size:11.5px;color:var(--soft)}
.zk b{color:#93c5fd;font-weight:500}
dialog{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:14px;padding:0;width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 32px)}
dialog::backdrop{background:#000a}
dialog[open]{animation:pop .22s cubic-bezier(.2,.9,.3,1.2)}
@keyframes pop{from{opacity:0;transform:scale(.96) translateY(6px)}}
@media (prefers-reduced-motion:reduce){dialog[open]{animation:none}}
.dlg{padding:16px;display:flex;flex-direction:column;gap:10px;margin:0}
.dlg h2{margin:0;font-size:16px;font-weight:500}
.dlg p{margin:0;color:var(--mut)}
.dlg label{display:flex;flex-direction:column;gap:4px;color:var(--mut);font-size:12px}
.dlg label b{color:var(--ink);font-weight:500;overflow-wrap:anywhere}
.dlg input,.dlg select{background:#0b0c0e;border:1px solid var(--line);border-radius:9px;padding:9px 10px;color:var(--ink);font:inherit;font-size:13px;width:100%}
.dlg input::placeholder{color:var(--soft)}
.err{color:var(--bad)!important}
.dact{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px}
.nf{padding:40px 20px}
.note{margin:0 0 10px;color:var(--mut)}
.note.w{color:var(--warn)}
.btn.mini{padding:5px 10px;font-size:12px}
.nf a{color:#93c5fd}
@media (max-width:560px){
 .m{grid-template-columns:minmax(0,1fr)}
 .sd{border-right:0;border-bottom:1px solid var(--line);padding:12px 12px 8px;position:static;height:auto}
 .lg{padding:0 2px 10px}
 .av{display:grid}
 .nav{flex-direction:row;overflow-x:auto;scrollbar-width:none;gap:4px;margin:0 -12px;padding:0 12px}
 .nav::-webkit-scrollbar{display:none}
 .nv{padding:6px 11px;border-radius:99px;background:#ffffff08}
 .who{display:none}
 .mn{padding:14px 12px}
 .hd{flex-direction:column;gap:2px}
 .st{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
 .c .v{font-size:20px}
 .row2,.grid2{grid-template-columns:minmax(0,1fr);gap:8px}
 .bars{height:52px}
}
`;

// Plain ES2020, no framework. Dialog forms send JSON with the x-tessh-admin header (the server refuses writes without it).
export const ADMIN_JS = `"use strict";
(() => {
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  for (const b of $$("[data-open]")) {
    b.addEventListener("click", () => {
      const d = document.getElementById(b.dataset.open);
      if (!d) return;
      const f = d.querySelector("form");
      if (f) { f.reset(); const e = f.querySelector(".err"); if (e) e.hidden = true; syncMatch(f); }
      d.showModal();
    });
  }
  for (const b of $$("[data-close]")) b.addEventListener("click", () => b.closest("dialog").close());
  function syncMatch(f) {
    const m = f.querySelector("[data-match]");
    if (!m) return;
    const ok = m.value.trim().toLowerCase() === m.dataset.match.toLowerCase();
    f.querySelector("button[type=submit]").disabled = !ok;
  }
  for (const f of $$("form[data-api]")) {
    f.addEventListener("input", () => syncMatch(f));
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const err = f.querySelector(".err");
      const submit = f.querySelector("button[type=submit]");
      const body = {};
      try {
        for (const el of $$("input[name],select[name]", f)) {
          const v = el.value.trim();
          if (el.dataset.type === "int") {
            if (v === "") { body[el.name] = null; continue; }
            const n = Number(v.replace(/[ ,_]/g, ""));
            if (!Number.isFinite(n) || n <= 0) throw new Error("Enter a positive number or leave it blank.");
            body[el.name] = Math.round(n * Number(el.dataset.scale || 1));
          } else body[el.name] = v;
        }
      } catch (e) { err.textContent = e.message; err.hidden = false; return; }
      submit.disabled = true;
      try {
        const res = await fetch(f.dataset.api, {
          method: f.dataset.method,
          headers: { "content-type": "application/json", "x-tessh-admin": "1" },
          body: JSON.stringify(body),
          credentials: "same-origin",
        });
        if (!res.ok) {
          let msg = "Something went wrong (" + res.status + ").";
          try { const j = await res.json(); if (j && j.message) msg = j.message; } catch (_) {}
          throw new Error(msg);
        }
        const done = f.dataset.done;
        if (done === "reload") location.reload(); else location.assign(done);
      } catch (e) {
        err.textContent = e.message; err.hidden = false; submit.disabled = false;
      }
    });
  }
})();
`;
