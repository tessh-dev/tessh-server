// Update check: asks GitHub for the newest release once a day and remembers it if it is newer than this server.
// A failure is silent: the panel then says nothing about updates being available.
import type { Env } from "./index.ts";
import { version as currentVersion } from "./version.ts";

const URL_LATEST = "https://api.github.com/repos/BobzTH/tessh-server/releases/latest";
const FIRST_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const parts = (v: string): number[] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** True when `a` is a newer version than `b`. Anything that isn't `x.y.z` is never newer. */
export function isNewer(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The newest release GitHub reports (`newer` says whether it beats `version`), or null when the check failed. */
export async function checkForUpdate(fetchFn: Fetch = fetch, version: string = currentVersion()): Promise<{ latest: string; newer: boolean } | null> {
  try {
    const res = await fetchFn(URL_LATEST, {
      headers: { "user-agent": `tessh-server/${version}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const tag = (await res.json()) as { tag_name?: unknown };
    if (typeof tag.tag_name !== "string") return null;
    const latest = tag.tag_name.trim().replace(/^v/, "");
    return { latest, newer: isNewer(latest, version) };
  } catch {
    return null;
  }
}

/** Checks 60 seconds after boot, then every 24 hours, keeping the result on `env`. Returns a function that stops it. */
export function scheduleUpdateChecks(env: Env, fetchFn?: Fetch): () => void {
  const run = async () => {
    const r = await checkForUpdate(fetchFn, env.VERSION);
    // A failed check changes nothing; a good one replaces what was known.
    if (r) env.UPDATE_LATEST = r.newer ? r.latest : null;
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
