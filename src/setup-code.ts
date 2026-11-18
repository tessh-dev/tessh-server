// The one-time setup code printed in the server log while the server is not set up. It proves the person
// finishing setup in the browser has access to the machine. Only a hash is kept, in memory, never stored.
import { createHash, randomInt } from "node:crypto";
import { HttpError } from "./http.ts";
import type { Env } from "./index.ts";
import { timingSafeEqual } from "./totp.ts";

export const SETUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const LIFETIME_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_WRONG = 5;
const MAX_WRONG_ALL = 50;
const MAX_TRACKED = 10_000;

const attempts = new Map<string, { count: number; since: number }>();
let global = { count: 0, since: 0 };

const normalise = (s: string) => s.toUpperCase().replace(/[-\s]/g, "");
const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");

/** Forgets every IP's failed tries. */
export function resetSetupAttempts(): void {
  attempts.clear();
  global = { count: 0, since: 0 };
}

function prune(now: number): void {
  for (const [ip, a] of attempts) if (now - a.since > WINDOW_MS) attempts.delete(ip);
  // Map keeps insertion order: the first keys are the oldest.
  while (attempts.size >= MAX_TRACKED) attempts.delete(attempts.keys().next().value as string);
  if (now - global.since > WINDOW_MS) global = { count: 0, since: now };
}

/** How many IPs are being tracked. For tests. */
export const trackedAttempts = (): number => attempts.size;

/** Makes a fresh code, keeps its hash on `env` and returns it as `XXXX-XXXX`. Any earlier code stops working. */
export function issueSetupCode(env: Env, now = Date.now(), scope: "full" | "owner" = "full"): string {
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) raw += SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)];
  env.SETUP = { hash: hashOf(raw), expiresAt: now + LIFETIME_MS, scope };
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Throws unless `input` is the live setup code. Five wrong tries from one IP lock it out for 15 minutes. */
export function checkSetupCode(env: Env, input: string, ip: string, now = Date.now()): void {
  prune(now);
  const a = attempts.get(ip);
  if (global.count >= MAX_WRONG_ALL || (a && a.count >= MAX_WRONG)) throw new HttpError("too_many_attempts", 429, "Too many wrong codes. Try again in 15 minutes.");

  const setup = env.SETUP;
  if (setup && now > setup.expiresAt) throw new HttpError("setup_code_wrong", 401, "That code has expired. Restart the server for a new one.");
  if (setup && timingSafeEqual(hashOf(normalise(input)), setup.hash)) {
    attempts.delete(ip);
    return;
  }
  global.count++;
  attempts.set(ip, a ? { count: a.count + 1, since: a.since } : { count: 1, since: now });
  throw new HttpError("setup_code_wrong", 401, "That code isn't right.");
}

export function setupLogLines(code: string, scope: "full" | "owner" = "full"): string[] {
  return [
    scope === "owner"
      ? "Owner login reset. Open this to set a new one (works for 24 hours):"
      : "Not set up yet. Open this to finish setup (works for 24 hours):",
    "  http://<this machine>:8080/setup    or https://your.domain/setup",
    `  Setup code  ${code}`,
  ];
}
