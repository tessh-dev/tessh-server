// PUT /v1/keypage: a device uploads its signed key lists. The server checks both SSHSIGs against the
// account's stored signer before it stores anything, so the public page only ever serves signed bodies.
import { authenticate } from "./auth.ts";
import { HttpError, readJSON } from "./http.ts";
import type { Env } from "./index.ts";
import { verifySSHSig } from "./sshsig.ts";

export const NAMESPACE = "tessh-keys";
/** The signer identity domain in allowed_signers and install.sh: the host of the server's public URL. */
export const identityDomain = (publicURL: string): string => new URL(publicURL).host;
const MAX_BODY = 65_536;
const MAX_KEYS = 100;
const MAX_FIELD = 256;
/** `<type> <base64> <name>`, one per line. New apps send a neutral `tessh-<fingerprint start>` name; pages signed
 *  by older builds carry a sanitised key label, which is never shown on the HTML page or in keys.json. */
const LINE_RE = /^[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,2} [A-Za-z0-9._@-]+$/;
/** The first line of both signed bodies: a version that only goes up, and when it was made. */
export const HEADER_RE = /^# tessh-keys seq=([1-9][0-9]{0,14}) updated=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/;

const NAME_RE = /^[A-Za-z0-9._@-]+$/;

const invalid = (msg: string) => new HttpError("invalid_request", 400, msg);
const enc = new TextEncoder();

/** "device": made in a device's security chip. "synced": a standard key that syncs. "standard": one kept on one device. */
export type KeyKind = "device" | "synced" | "standard";
const KINDS: readonly string[] = ["device", "synced", "standard"];

/** One stored key entry. Never holds a device name or key label: older apps sent them, and they are dropped. */
export interface KeyEntry {
  name: string;
  type: string;
  fingerprint: string;
  /** Missing on pages from older apps: then it comes from the key type. */
  kind?: KeyKind;
  addedAt: string;
}

/** The key lines of a list body (the `#` header left out). The body must be empty or end with a newline. */
export function bodyLines(body: string): string[] {
  return body === "" ? [] : body.slice(0, -1).split("\n").filter((l) => !l.startsWith("#"));
}

/** A signed list body: the version header line, then zero or more key lines. Returns its seq. */
function listBody(v: unknown, name: string): { body: string; seq: number } {
  if (typeof v !== "string" || enc.encode(v).length > MAX_BODY || !v.endsWith("\n")) throw invalid(`Invalid ${name}`);
  const [header, ...lines] = v.slice(0, -1).split("\n");
  const m = HEADER_RE.exec(header);
  if (!m) throw invalid(`Invalid ${name}: the first line must be "# tessh-keys seq=<n> updated=<ISO date>"`);
  if (!lines.every((l) => LINE_RE.test(l))) throw invalid(`Invalid ${name}`);
  return { body: v, seq: Number(m[1]) };
}

function str(v: unknown, name: string, min = 1): string {
  if (typeof v !== "string" || v.length < min || v.length > MAX_FIELD) throw invalid(`Invalid keys ${name}`);
  return v;
}

function keyName(v: unknown): string {
  const n = str(v, "name");
  if (!NAME_RE.test(n)) throw invalid("Invalid keys name");
  return n;
}

function parseKeys(v: unknown): KeyEntry[] {
  if (!Array.isArray(v) || v.length > MAX_KEYS) throw invalid("Invalid keys");
  return v.map((e) => {
    if (typeof e !== "object" || e === null || Array.isArray(e)) throw invalid("Invalid keys entry");
    const k = e as Record<string, unknown>;
    if (k.kind !== undefined && (typeof k.kind !== "string" || !KINDS.includes(k.kind))) throw invalid("Invalid keys kind");
    // `label` and `device` (sent by older apps) are private: never stored.
    const out: KeyEntry = {
      name: keyName(k.name),
      type: str(k.type, "type"),
      fingerprint: str(k.fingerprint, "fingerprint"),
      addedAt: str(k.addedAt, "addedAt"),
    };
    if (k.kind !== undefined) out.kind = k.kind as KeyKind;
    return out;
  });
}

async function putKeypage(req: Request, env: Env): Promise<Response> {
  const a = await authenticate(req, env);
  const b = await readJSON<Record<string, unknown>>(req);
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw invalid("Invalid body");
  const user = await env.DB.prepare("SELECT username, signer_public_key FROM users WHERE id = ?")
    .bind(a.userId)
    .first<{ username: string | null; signer_public_key: string }>();
  if (!user) throw new HttpError("unauthorized", 401, "Missing or invalid token");
  if (!user.username) throw invalid("Set a username before publishing a key page");

  const ak = listBody(b.authorizedKeys, "authorizedKeys");
  const rv = listBody(b.revoked, "revoked");
  if (ak.seq !== rv.seq) throw invalid("authorizedKeys and revoked must carry the same seq");
  const { body: authorizedKeys, seq } = ak;
  const revoked = rv.body;
  if (typeof b.authorizedKeysSig !== "string" || typeof b.revokedSig !== "string") throw invalid("Invalid signature");
  const keys = parseKeys(b.keys);

  const ok =
    (await verifySSHSig(enc.encode(authorizedKeys), b.authorizedKeysSig, user.signer_public_key, NAMESPACE)) &&
    (await verifySSHSig(enc.encode(revoked), b.revokedSig, user.signer_public_key, NAMESPACE));
  if (!ok) throw new HttpError("bad_signature", 400, "Signature does not verify against your signing key");

  // Only a higher seq replaces the stored page, checked in the same statement so two uploads can't race past it.
  const res = await env.DB.prepare(
    `INSERT INTO keypages (user_id, authorized_keys, authorized_keys_sig, revoked, revoked_sig, keys_json, updated_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET authorized_keys = excluded.authorized_keys,
       authorized_keys_sig = excluded.authorized_keys_sig, revoked = excluded.revoked,
       revoked_sig = excluded.revoked_sig, keys_json = excluded.keys_json, updated_at = excluded.updated_at,
       seq = excluded.seq
     WHERE excluded.seq > keypages.seq`,
  )
    .bind(a.userId, authorizedKeys, b.authorizedKeysSig, revoked, b.revokedSig, JSON.stringify(keys), new Date().toISOString(), seq)
    .run();
  if (!res.meta.changes) throw new HttpError("stale_keypage", 409, "A key page with this seq or a higher one is already published");
  return new Response(null, { status: 204 });
}

/** Returns null when the route is not the key page route. */
export async function keypageRoutes(req: Request, env: Env): Promise<Response | null> {
  if (req.method === "PUT" && new URL(req.url).pathname === "/v1/keypage") return putKeypage(req, env);
  return null;
}
