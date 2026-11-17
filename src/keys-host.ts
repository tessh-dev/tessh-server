// Public key pages: /<username> and its files. Serves only what a device signed and uploaded.
import { decodeBase64, encodeBase64 } from "./auth.ts";
import type { Env } from "./index.ts";
import { renderInstall } from "./install.ts";
import { NAMESPACE, bodyLines, identityDomain, type KeyEntry, type KeyKind } from "./keypage.ts";
import { renderHome, renderMissing, renderPage, type PublicKey } from "./page.ts";

const TEXT = "text/plain; charset=utf-8";
const CACHE = "public, max-age=60";
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

interface Page {
  username: string;
  signer: string;
  authorizedKeys: string;
  authorizedKeysSig: string;
  revoked: string;
  revokedSig: string;
  keys: KeyEntry[];
  updated: string;
}

async function loadPage(env: Env, username: string): Promise<Page | null> {
  const r = await env.DB.prepare(
    `SELECT u.signer_public_key, k.authorized_keys, k.authorized_keys_sig, k.revoked, k.revoked_sig, k.keys_json, k.updated_at
     FROM users u JOIN keypages k ON k.user_id = u.id WHERE u.username = ?`,
  )
    .bind(username)
    .first<{
      signer_public_key: string;
      authorized_keys: string;
      authorized_keys_sig: string;
      revoked: string;
      revoked_sig: string;
      keys_json: string;
      updated_at: string;
    }>();
  if (!r) return null;
  return {
    username,
    signer: r.signer_public_key,
    authorizedKeys: r.authorized_keys,
    authorizedKeysSig: r.authorized_keys_sig,
    revoked: r.revoked,
    revokedSig: r.revoked_sig,
    keys: JSON.parse(r.keys_json) as KeyEntry[],
    updated: r.updated_at,
  };
}

const lineParts = (line: string) => {
  const [type, b64, name] = line.split(" ");
  return { type, b64, name };
};

async function fingerprint(b64: string): Promise<string> {
  const blob = decodeBase64(b64) ?? new Uint8Array();
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", blob));
  return "SHA256:" + encodeBase64(d).replace(/=+$/, "");
}

/** The public name of a key: `tessh-` and the first 8 characters of its fingerprint (`+/` as `-_`), as the apps
 *  write it. Pages signed by older apps name keys after their labels; those names are never shown. */
export function publicName(fp: string): string {
  const short = fp.replace(/^SHA256:/, "").slice(0, 8).replace(/\+/g, "-").replace(/\//g, "_").replace(/[^A-Za-z0-9_-]/g, "");
  return short ? `tessh-${short}` : "tessh";
}

/** A signed line with its comment swapped for the neutral public name. */
const publicLine = (line: string, fp: string) => {
  const { type, b64 } = lineParts(line);
  return `${type} ${b64} ${publicName(fp)}`;
};

/** `kind` isn't signed, so it only picks between Synced and Standard: a Device key is always a P-256 key, and a
 *  P-256 key from Tessh is always a Device key. Pages from older apps have no kind: their standard keys synced. */
const publicKind = (type: string, kind: KeyKind | undefined): KeyKind =>
  type === "ecdsa-sha2-nistp256" ? "device" : kind === "standard" ? "standard" : "synced";

/** Serve-time: keep only entries with a signed line of the same name, take the type and fingerprint from that line,
 *  and keep only public fields (no label or device, even from a page an older app signed). */
async function verifiedKeys(p: Page): Promise<PublicKey[]> {
  const lines = new Map(bodyLines(p.authorizedKeys).map((l) => [lineParts(l).name, l]));
  const out: PublicKey[] = [];
  for (const k of p.keys) {
    const line = lines.get(k.name);
    if (!line) continue;
    const { type, b64 } = lineParts(line);
    const fp = await fingerprint(b64);
    out.push({
      name: publicName(fp),
      type,
      fingerprint: fp,
      kind: publicKind(type, k.kind),
      addedAt: k.addedAt,
      line: publicLine(line, fp),
    });
  }
  return out;
}

async function keysJson(p: Page, keys: PublicKey[], origin: string) {
  return {
    username: p.username,
    updated: p.updated,
    keys: keys.map((k) => ({
      name: k.name,
      type: k.type,
      kind: k.kind,
      fingerprint: k.fingerprint,
      addedAt: k.addedAt,
      url: `${origin}/${k.name}`,
    })),
    revoked: await Promise.all(
      bodyLines(p.revoked).map(async (line) => {
        const { type, b64 } = lineParts(line);
        const fp = await fingerprint(b64);
        return { name: publicName(fp), type, fingerprint: fp, key: publicLine(line, fp) };
      }),
    ),
    signature: {
      format: "ssh-keygen -Y sign",
      namespace: NAMESPACE,
      signer: p.signer,
      authorized_keys: `${origin}/authorized_keys.sig`,
      revoked: `${origin}/revoked.sig`,
      allowed_signers: `${origin}/allowed_signers`,
    },
    install: `curl -fsSL ${origin}/install.sh | sh`,
  };
}

const HTML_HEADERS = {
  vary: "Accept",
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const wantsHTML = (req: Request) => (req.headers.get("accept") ?? "").includes("text/html");

/** Plain text for scripts; a designed page for browsers. Always 404. */
function notFound(req: Request, env: Env, username: string | null = null): Response {
  if (wantsHTML(req)) {
    return new Response(req.method === "HEAD" ? null : renderMissing(username, identityDomain(env.PUBLIC_URL)), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", ...HTML_HEADERS },
    });
  }
  return new Response("Not found\n", { status: 404, headers: { "content-type": TEXT, vary: "Accept" } });
}

/** The key pages are public, so any origin may read them (e.g. keys.json from another site). No credentials. */
export async function keysHost(req: Request, env: Env): Promise<Response> {
  const res = await keysRoute(req, env);
  const out = new Response(res.body, res);
  out.headers.set("access-control-allow-origin", "*");
  return out;
}

async function keysRoute(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET, HEAD", "access-control-max-age": "600" } });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed\n", { status: 405, headers: { "content-type": TEXT, allow: "GET, HEAD" } });
  }
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (path === "") {
    const host = identityDomain(env.PUBLIC_URL);
    if (!wantsHTML(req)) {
      return new Response(req.method === "HEAD" ? null : `${env.SERVER_NAME}: Tessh sync server. Key pages: ${env.PUBLIC_URL}/<username>\n`, {
        headers: { "content-type": TEXT, vary: "Accept" },
      });
    }
    return new Response(req.method === "HEAD" ? null : renderHome(env.SERVER_NAME, host), {
      headers: { "content-type": "text/html; charset=utf-8", ...HTML_HEADERS },
    });
  }
  const m = /^\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (!m || !USERNAME_RE.test(m[1])) return notFound(req, env);
  const p = await loadPage(env, m[1]);
  if (!p) return notFound(req, env, m[2] === undefined ? m[1] : null);
  const keys = await verifiedKeys(p);

  const host = identityDomain(env.PUBLIC_URL);
  const origin = `${env.PUBLIC_URL}/${p.username}`;
  const ok = (body: string, type = TEXT, extra: Record<string, string> = {}) =>
    new Response(req.method === "HEAD" ? null : body, { headers: { "content-type": type, "cache-control": CACHE, ...extra } });
  const file = m[2];

  switch (file) {
    case undefined: {
      if (!wantsHTML(req)) return ok(p.authorizedKeys, TEXT, { vary: "Accept" });
      const html = renderPage({
        username: p.username,
        host,
        origin,
        install: `curl -fsSL ${origin}/install.sh | sh`,
        keys,
        revokedCount: bodyLines(p.revoked).length,
        updated: p.updated,
      });
      return ok(html, "text/html; charset=utf-8", HTML_HEADERS);
    }
    case "authorized_keys":
      return ok(p.authorizedKeys);
    case "authorized_keys.sig":
      return ok(p.authorizedKeysSig);
    case "revoked":
      return ok(p.revoked);
    case "revoked.sig":
      return ok(p.revokedSig);
    case "allowed_signers":
      return ok(`${p.username}@${host} namespaces="${NAMESPACE}" ${p.signer}\n`);
    case "keys.json":
      return ok(JSON.stringify(await keysJson(p, keys, origin), null, 2) + "\n", "application/json; charset=utf-8");
    case "install.sh":
      return ok(renderInstall({ username: p.username, signer: p.signer }, env.PUBLIC_URL), "text/x-shellscript; charset=utf-8");
  }

  // /<u>/<name> or /<u>/<name>.pub → that one key from the signed authorized_keys body, with its neutral name as the
  // comment. Found by its public name, or by the name an older app signed (so old links keep working). Exact first.
  const lines = await Promise.all(
    bodyLines(p.authorizedKeys).map(async (l) => ({ l, fp: await fingerprint(lineParts(l).b64) })),
  );
  const find = (name: string) =>
    lines.find(({ fp }) => publicName(fp) === name) ?? lines.find(({ l }) => lineParts(l).name === name);
  const one = find(file) ?? (file.endsWith(".pub") ? find(file.slice(0, -4)) : undefined);
  return one ? ok(publicLine(one.l, one.fp) + "\n") : notFound(req, env);
}
