// Update check: asks GitHub for the newest release once a day and remembers it if it is newer than this server.
// Nothing here updates anything: the owner runs the update themselves. The panel shows what was found, or that
// the last check failed. The release notes come from GitHub and are untrusted: releaseNotes() reduces them to
// a few plain lines and the panel escapes them like any other text.
import type { Env } from "./index.ts";
import { version as currentVersion } from "./version.ts";

const REPO = "tessh-dev/tessh-server";
const URL_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const FIRST_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const NOTE_LINES = 5;
const NOTE_CHARS = 160;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A release newer than this server, as the panel shows it. Every field is plain text. */
export interface Release {
  version: string;
  /** The release page on github.com (anything else is replaced by the releases list). */
  url: string;
  /** ISO time, or null when GitHub gave none. */
  publishedAt: string | null;
  /** Up to five plain lines from the release notes. */
  notes: string[];
}

// ---- Versions ----

interface SemVer {
  core: [number, number, number];
  pre: string[];
}

function parse(v: string): SemVer | null {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] } : null;
}

/** Semver precedence: negative when a < b, 0 when equal (build metadata ignored), positive when a > b; null when either isn't semver. */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  // A pre-release sorts before its release.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

/** True when `a` is a newer version than `b`. Anything that isn't semver is never newer. */
export function isNewer(a: string, b: string): boolean {
  return (compareVersions(a, b) ?? 0) > 0;
}

// ---- Release notes ----

/**
 * The first few non-empty lines of a release's markdown as plain text: headings, bullets, quotes and emphasis
 * markers stripped, links and images reduced to their text, HTML comments and link definitions dropped. The
 * result is still untrusted text: callers escape it. Nothing here produces HTML.
 */
export function releaseNotes(body: unknown, max = NOTE_LINES): string[] {
  if (typeof body !== "string") return [];
  const text = body.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/\r\n?/g, "\n");
  const out: string[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (out.length >= max) break;
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    let s = raw.trim();
    if (!s || /^([-*_]\s*){3,}$/.test(s) || /^\[[^\]]+\]:\s*\S/.test(s) || /^\|?[\s:-]+\|[\s|:-]*$/.test(s)) continue;
    if (!fenced) {
      s = s
        .replace(/^(>\s*)+/, "")
        .replace(/^#{1,6}\s+/, "")
        .replace(/\s+#+$/, "")
        .replace(/^([-*+]|\d+[.)])\s+/, "")
        .replace(/^\[[ xX]\]\s+/, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
        .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
        .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
        .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=$|[\s).,:;!?])/g, "$1$2")
        .replace(/`([^`]*)`/g, "$1");
    }
    // Control characters (and stray bidi overrides) never reach the page.
    s = s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
    if (!s) continue;
    out.push(s.length > NOTE_CHARS ? `${s.slice(0, NOTE_CHARS - 1).trimEnd()}…` : s);
  }
  return out;
}

/** GitHub's release page when it is one, otherwise the releases list. */
function releaseURL(u: unknown): string {
  if (typeof u !== "string") return RELEASES_PAGE;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith(`/${REPO}/releases/`) ? url.href : RELEASES_PAGE;
  } catch {
    return RELEASES_PAGE;
  }
}

// ---- The check ----

/** The newest release GitHub reports (`newer` says whether it beats `version`), or null when the check failed. */
export async function checkForUpdate(
  fetchFn: Fetch = fetch,
  version: string = currentVersion(),
): Promise<{ latest: string; newer: boolean; release: Release } | null> {
  try {
    const res = await fetchFn(URL_LATEST, {
      headers: { "user-agent": `tessh-server/${version}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const r = (await res.json()) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown; body?: unknown };
    if (typeof r.tag_name !== "string") return null;
    const latest = r.tag_name.trim().replace(/^v/, "");
    if (!parse(latest)) return null;
    const published = typeof r.published_at === "string" && Number.isFinite(Date.parse(r.published_at)) ? new Date(r.published_at).toISOString() : null;
    return {
      latest,
      newer: isNewer(latest, version),
      release: { version: latest, url: releaseURL(r.html_url), publishedAt: published, notes: releaseNotes(r.body) },
    };
  } catch {
    return null;
  }
}

/**
 * Records a check's outcome on `env`. A successful check (`found` is the newest release, or null for "none newer")
 * replaces what was known; a failed one (`found` undefined) keeps the known release but marks the failure, so the
 * panel never shows an old "up to date" as if it were confirmed. Tests set the latest release through this too.
 */
export function recordCheck(env: Env, found: Release | null | undefined, now = Date.now()): void {
  if (found === undefined) {
    env.UPDATE_FAILED_AT = now;
    return;
  }
  const newer = found && isNewer(found.version, env.VERSION) ? found : null;
  env.UPDATE_RELEASE = newer;
  env.UPDATE_LATEST = newer?.version ?? null;
  env.UPDATE_CHECKED_AT = now;
  env.UPDATE_FAILED_AT = null;
}

/** Checks 60 seconds after boot, then every 24 hours, keeping the result on `env`. Returns a function that stops it. */
export function scheduleUpdateChecks(env: Env, fetchFn?: Fetch): () => void {
  const run = async () => {
    const r = await checkForUpdate(fetchFn, env.VERSION);
    recordCheck(env, r ? r.release : undefined);
  };
  const first = setTimeout(() => void run(), FIRST_MS);
  const daily = setInterval(() => void run(), DAY_MS);
  first.unref();
  daily.unref();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}

/** Check now waits this long after the last attempt, so repeated presses don't spend GitHub's rate limit. */
const CHECK_NOW_GAP_MS = 15_000;

/** The panel's Check now: checks at once (unless one ran in the last 15 seconds) and records the answer. Off stays off. */
export async function checkNow(env: Env, now = Date.now()): Promise<void> {
  if (!env.UPDATE_CHECK) return;
  const last = Math.max(env.UPDATE_CHECKED_AT ?? 0, env.UPDATE_FAILED_AT ?? 0);
  if (now - last < CHECK_NOW_GAP_MS) return;
  const r = await checkForUpdate(env.UPDATE_FETCH, env.VERSION);
  recordCheck(env, r ? r.release : undefined, now);
}

/** What the panel says about updates. */
export type UpdateStatus =
  | { kind: "off" }
  | { kind: "update"; release: Release }
  | { kind: "current"; checkedAt: number }
  | { kind: "failed"; at: number }
  | { kind: "pending" };

export function updateStatus(env: Env): UpdateStatus {
  if (!env.UPDATE_CHECK) return { kind: "off" };
  const latest = env.UPDATE_RELEASE?.version ?? env.UPDATE_LATEST;
  if (latest && isNewer(latest, env.VERSION)) {
    const release = env.UPDATE_RELEASE?.version === latest ? env.UPDATE_RELEASE : { version: latest, url: RELEASES_PAGE, publishedAt: null, notes: [] };
    return { kind: "update", release };
  }
  if (env.UPDATE_FAILED_AT) return { kind: "failed", at: env.UPDATE_FAILED_AT };
  if (env.UPDATE_CHECKED_AT) return { kind: "current", checkedAt: env.UPDATE_CHECKED_AT };
  return { kind: "pending" };
}
