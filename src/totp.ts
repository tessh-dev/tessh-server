/** RFC 6238 TOTP (HMAC-SHA-1), RFC 4648 base32, AES-256-GCM sealing and backup codes. Pure WebCrypto. */

export const STEP_SECONDS = 30;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Crockford-style: no i, l, o, u. */
export const BACKUP_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const enc = new TextEncoder();

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export const stepAt = (ms: number): number => Math.floor(ms / 1000 / STEP_SECONDS);

/** HOTP value for `step`, truncated to `digits` (RFC 4226 dynamic truncation). */
export async function totpAt(secret: Uint8Array, step: number, digits = 6): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Constant-time for equal-length strings; unequal lengths return false. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Returns the step (within ±1 of `nowMs`) whose code matches and is newer than `lastStep`, else null.
 * All three candidates are always computed and compared, so timing does not reveal which one matched.
 */
export async function matchStep(secret: Uint8Array, code: string, nowMs: number, lastStep: number | null): Promise<number | null> {
  const now = stepAt(nowMs);
  let found: number | null = null;
  for (const s of [now - 1, now, now + 1]) {
    const ok = timingSafeEqual(await totpAt(secret, s), code);
    if (ok && (lastStep === null || s > lastStep) && found === null) found = s;
  }
  return found;
}

function decodeKey(b64: string | undefined): Uint8Array {
  if (!b64) throw new Error("TOTP_KEY is not set");
  const bin = atob(b64);
  if (bin.length !== 32) throw new Error("TOTP_KEY must be 32 bytes");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const aesKey = (b64: string | undefined) =>
  crypto.subtle.importKey("raw", decodeKey(b64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

/** AES-256-GCM, AAD = user id. Output: iv (12) || ciphertext+tag. */
export async function seal(keyB64: string | undefined, userId: string, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(userId) }, await aesKey(keyB64), plain),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function open(keyB64: string | undefined, userId: string, sealed: Uint8Array): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: enc.encode(userId) },
    await aesKey(keyB64),
    sealed.slice(12),
  );
  return new Uint8Array(pt);
}

/**
 * Backup code hash: HMAC-SHA-256 over (user id || canonical code), keyed by HKDF-SHA-256(TOTP_KEY, info
 * "tessh/v1/backup-code"). 40-bit codes are cheap to brute-force from a plain hash; this keeps a database leak alone
 * from revealing them. Hex output.
 */
export async function backupCodeHash(keyB64: string | undefined, userId: string, canonical: string): Promise<string> {
  const ikm = await crypto.subtle.importKey("raw", decodeKey(keyB64), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("tessh/v1/backup-code") },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(userId + canonical)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `xxxx-xxxx`, 40 bits. 256 is a multiple of 32, so `byte & 31` is unbiased. */
export function newBackupCode(): string {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const s = [...r].map((b) => BACKUP_ALPHABET[b & 31]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Canonical `xxxx-xxxx`, or null if it can't be one. Ignores case, spaces and dashes; o→0, i/l→1. */
export function normaliseBackupCode(v: string): string | null {
  const s = v.toLowerCase().replace(/[\s-]/g, "").replace(/o/g, "0").replace(/[il]/g, "1");
  if (s.length !== 8 || [...s].some((c) => !BACKUP_ALPHABET.includes(c))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
