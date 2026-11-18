# Web setup and admin panel

Status: Built in 1.1.0.

## Why

Running your own Tessh server should feel as finished as using Tessh Cloud. Today it takes a cloned repo,
an edited compose file, a password in `.env` and a panel on a second, local-only port. The goal is: install,
open a web address, finish setup in the browser, then run a small team from a web panel.

People choose between Tessh Cloud and a self-hosted server in the apps. A self-hosted server gives the
same sync and key pages as the cloud, plus a panel for the person who runs it.

## Goals

- Install with two commands and no file editing.
- First visit opens a guided setup in the browser.
- A web panel for the owner: overview, team, invites, activity, settings.
- Invite people with links. A link opens a small page that hands off to the apps.
- Each person gets their public key page on this server (`https://<server>/<username>`), shown in the panel.
- The look matches the Tessh apps (see "Look").

## Non-goals (this version)

- Web login for team members. Every account feature already exists in the Mac and iPhone apps.
  Leave room for these pages later; don't build them now.
- Shared vaults (shared servers and credentials across a team). Planned separately.
- Sending email. Invites are links the owner shares however they like.
- Multiple owners or admin roles.

## Anti-goals

- The server must never be able to read anyone's vault. The panel shows names, emails, usernames,
  device names, counts, sizes and dates only. Never blobs, keys or auth material.
- Nobody who reaches the address before the owner may claim the server.

## Approaches considered

1. **Owner web app only (chosen).** Setup and panel in the server. Members use the apps for their account.
   Smallest, safest; the only gap is reaching your account with no device of your own to hand, which the
   owner covers by signing out a member's device from the panel.
2. **Owner web app plus member web login.** Matches the cloud website fully, but needs the apps'
   encryption work in the browser. About twice the work. Can follow later on the same pages.
3. **Reuse the tessh.dev website inside the image.** Ties this repo to the website's build and licences.
   Rejected.

## The flow

### 1. Install

```sh
curl -fsSL https://tessh.dev/self-host/compose.yml -o compose.yml
docker compose up -d
docker compose logs tessh-server
```

No edits needed. On boot without an owner, the log prints:

```
Not set up yet. Open this to finish setup (works for 24 hours):
  http://<this machine>:8080/setup    or https://your.domain/setup
  Setup code  K7PQ-4M2X
```

Until setup is finished, every route except `/setup`, its assets and `/v1/health` answers
"not set up yet" (the API returns a clear error the apps can show).

### 2. Setup (browser, four steps)

1. **Unlock**: the 8-character setup code from the logs.
2. **Name and address**: server name (shown in the apps) and public address, prefilled from how the page
   was opened. Checked live: HTTPS, and that the address reaches this same server.
3. **Owner login**: email, password (strength shown), optional authenticator code (recommended, on by default).
   This login is for the panel only. The owner's Tessh account is made in the app like anyone else's.
4. **Your team**: who can join (Invite only, recommended / Anyone with the address / Just me), names for
   first invites (optional), storage per person (500 MB / 1 GB / 5 GB / No limit).

Then **Ready**: the invite links to copy, how to connect your own apps (choose Self-hosted, enter the address,
the owner needs no invite), and **Open the panel**.

### 3. Invite page

`/join/<code>` shows "You're invited to <server name>", who invited them, **Open in Tessh** (a link the apps
handle, carrying the server address and invite code) and **Get Tessh for Mac or iPhone**, plus the manual
route (Self-hosted, address, code).

### 4. Panel (`/admin`)

Sidebar: server name and address, Overview, Team, Invites, Activity, Settings; footer shows "Running · <version>"
and Sign out.

- **Overview**: people, devices, storage used, version (with "up to date" or "update available"),
  recent activity.
- **Team**: one row per person: name, email, role (Owner / Member), key page link (copy), device count.
  Opening a row shows their devices (OS tile, name, platform, last active, **Sign out**), storage used of
  their limit, and **Storage limit**, **Suspend**, **Remove**.
- **Invites**: make an invite (a name for the owner's reference, expiry 7 or 30 days); waiting invites with
  copy and cancel; used invites with who joined and when. Each link works once.
- **Activity**: the audit log.
- **Settings**: name, address, who can join, storage per person; owner login (change password, authenticator,
  sign out other sessions); backups (download now; nightly copy at 03:00 into the data volume); updates
  (current version, the update command).

## Look

The apps' look, not a generic admin template:

- Tessh tokens, light and dark following the system (canvas, sidebar, card, line, ink, muted, soft, pill,
  accent, ok; light/dark values as in the apps).
- Headings, page titles and big numbers in Allo Round (bundled woff2, OFL notice shipped with it);
  body in the system sans; addresses, emails and links in mono.
- The Tessh ASCII field: full-screen behind setup and invite pages with a darkened veil behind the content;
  a ~230 px strip fading out at the top of each panel page. Respect reduced motion.
- Sidebar: monochrome line icons, selected item a neutral pill, counts in the soft colour.
- Blue only for the main action, toggles, focus and selection rings. Selection elsewhere is neutral.
- Device rows use brand OS tiles. Rows and grouped cards like the apps' Settings.
- The setup "Ready" screen uses the apps' empty-state tile (dark terminal tile, field rising inside).

## Decisions

- **One port.** Setup, panel, invite pages, key pages and the API share port 8080. The separate admin port
  and `ADMIN_PASSWORD` go away (1.0.0 was never published, so there is nothing to migrate).
- **Setup code**: random, 8 characters from an unambiguous alphabet, held for 24 hours, a new one on each
  boot until setup is done. Wrong attempts are rate limited.
- **Owner auth**: password hashed with scrypt; optional TOTP (reuse the existing TOTP code); session cookie
  (`HttpOnly`, `Secure` when HTTPS, `SameSite=Strict`), CSRF-safe writes, sessions listed and revocable.
- **Settings live in the database**, written by setup and the panel. Environment variables (`PUBLIC_URL`,
  `SERVER_NAME`, `SIGNUPS`) still work and, when set, lock that setting in the panel ("set by the server's
  environment").
- **Invites become codes.** A signup on an invite-only server needs a valid, unused, unexpired invite code.
  Email-matched invites are dropped.
- **Storage per person**: one default plus per-person overrides, replacing the plans screen.
- **Backups**: SQLite `VACUUM INTO` a dated file in the data volume nightly, keeping the last 7; the panel
  streams a fresh copy on demand.
- **Update check**: once a day against this repo's GitHub Releases; off with `UPDATE_CHECK=false`. No other
  outbound calls.
- **The owner's Tessh account**: setup makes one extra single-use code, the owner code, shown on Ready as
  "Your code". The account that signs up with it gets the Owner role in Team. It works whatever "who can join"
  says. (Ready's wording becomes "use your code", not "no invite needed".)
- **Who can join** maps to `SIGNUPS`: Invite only = `invite`, Anyone with the address = `open`,
  Just me = `closed` (only the owner code). Changing it never affects existing accounts.
- **HTTPS**: setup and the panel work over plain HTTP so a fresh install can be reached, but show a warning
  until the address is HTTPS; the session cookie is `Secure` whenever the request is HTTPS. The apps keep
  requiring HTTPS except for `localhost`. The compose file publishes 8080 on all interfaces; the guide puts a
  reverse proxy in front.
- **Owner locked out**: `docker compose exec tessh-server tessh-server reset-owner` prints a fresh setup code
  that reopens only the owner-login step. No other recovery route.
- **Data model**: 1.0.0 was never published, so migrations may be rewritten. Plans go; each account keeps a
  storage limit (default from settings, per-person override). Item and device limits stay as fixed,
  generous defaults, not shown in the panel.
- **Reserved usernames**: add every first path segment the server uses or may use (`setup`, `join`, `admin`,
  `api`, `v1`, `assets`, `login`, `signup`, `account`, `invite`, `settings`, `static`, `health`, `docs`,
  `.well-known` and similar) so key pages can't collide now or later.

## App changes (in the Tessh apps, not this repo)

- Sign-up and sign-in start with **Where should your vault live?**: Tessh Cloud or Self-hosted. Self-hosted
  takes the address, shows the server's name and "who can join", and asks for an invite code when needed.
- Signup sends the code as `invite` in the existing signup request. `/v1/server` adds `setUp: true|false`;
  a server that isn't set up answers API calls with error `not_set_up`.
- Invite links: `/join/<code>` offers `tessh://join?server=<address>&code=<code>`; the apps open sign-up with
  both filled in.
- Signed in, the account screen shows the server's name and address and the person's key page link there.

## Left to the builder

- Page structure, routing and how pages are rendered and bundled.
- How the address check proves "this same server" (for example, a per-boot instance id fetched from the
  typed address).
- Rate limits, session lifetimes, exact copy beyond what is written here.
- Test approach (existing tests use Vitest).
