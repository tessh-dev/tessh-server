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

const attempts = new Map<string, { count: number; since: number }>();

const normalise = (s: string) => s.toUpperCase().replace(/[-\s]/g, "");
const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");

/** Forgets every IP's failed tries. */
export function resetSetupAttempts(): void {
  attempts.clear();
}

/** Makes a fresh code, keeps its hash on `env` and returns it as `XXXX-XXXX`. Any earlier code stops working. */
export function issueSetupCode(env: Env, now = Date.now()): string {
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) raw += SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)];
  env.SETUP = { hash: hashOf(raw), expiresAt: now + LIFETIME_MS, scope: "full" };
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Throws unless `input` is the live setup code. Five wrong tries from one IP lock it out for 15 minutes. */
export function checkSetupCode(env: Env, input: string, ip: string, now = Date.now()): void {
  let a = attempts.get(ip);
  if (a && now - a.since > WINDOW_MS) {
    attempts.delete(ip);
    a = undefined;
  }
  if (a && a.count >= MAX_WRONG) throw new HttpError("too_many_attempts", 429, "Too many wrong codes. Try again in 15 minutes.");

  const setup = env.SETUP;
  if (setup && now > setup.expiresAt) throw new HttpError("setup_code_wrong", 401, "That code has expired. Restart the server for a new one.");
  if (setup && timingSafeEqual(hashOf(normalise(input)), setup.hash)) {
    attempts.delete(ip);
    return;
  }
  attempts.set(ip, a ? { count: a.count + 1, since: a.since } : { count: 1, since: now });
  throw new HttpError("setup_code_wrong", 401, "That code isn't right.");
}

export function setupLogLines(code: string): string[] {
  return [
    "Not set up yet. Open this to finish setup (works for 24 hours):",
    "  http://<this machine>:8080/setup    or https://your.domain/setup",
    `  Setup code  ${code}`,
  ];
}
