// HTTP Basic for the admin panel. Any user name is accepted and recorded in the audit log as the admin's name;
// the password must equal ADMIN_PASSWORD (compared in constant time). No password configured: nobody gets in.
import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.ts";
import type { Env } from "./index.ts";

const CHALLENGE = { "www-authenticate": 'Basic realm="Tessh admin", charset="UTF-8"' };

const unauthorized = () => new HttpError("unauthorized", 401, "Admin password required", undefined, CHALLENGE);

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time for any lengths: both sides are hashed to 32 bytes first. */
export function passwordMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** Returns the admin's name (the Basic user name, or "admin" when blank). Throws 401 otherwise. */
export function verifyAdmin(req: Request, env: Env): string {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) throw new HttpError("forbidden", 403, "The admin panel is off: set ADMIN_PASSWORD");
  const m = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) throw unauthorized();
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) throw unauthorized();
  const user = decoded.slice(0, colon).trim();
  const ok = passwordMatches(decoded.slice(colon + 1), expected);
  if (!ok) throw unauthorized();
  const name = user.replace(/[^\p{L}\p{N}@._ -]/gu, "").slice(0, 64);
  return name || "admin";
}
