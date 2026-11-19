// Static files for the web pages, served under /_/. A fixed whitelist: the request path is only ever a key
// into this map, never joined onto a directory.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILES: Record<string, { file: string; type: string }> = {
  "tessh.css": { file: "assets/web/tessh.css", type: "text/css; charset=utf-8" },
  "field.js": { file: "assets/web/field.js", type: "text/javascript; charset=utf-8" },
  "one-time-code.js": { file: "assets/web/one-time-code.js", type: "text/javascript; charset=utf-8" },
  "setup.js": { file: "assets/web/setup.js", type: "text/javascript; charset=utf-8" },
  "panel.js": { file: "assets/web/panel.js", type: "text/javascript; charset=utf-8" },
  "theme.js": { file: "assets/web/theme.js", type: "text/javascript; charset=utf-8" },
  "favicon.svg": { file: "assets/web/favicon.svg", type: "image/svg+xml" },
  "favicon.ico": { file: "assets/web/favicon.ico", type: "image/x-icon" },
  "apple-touch-icon.png": { file: "assets/web/apple-touch-icon.png", type: "image/png" },
  "AlloRound.woff2": { file: "assets/fonts/AlloRound.woff2", type: "font/woff2" },
};

const loaded = new Map<string, Uint8Array>();
const read = (name: string, file: string): Uint8Array => {
  let bytes = loaded.get(name);
  if (!bytes) {
    bytes = readFileSync(join(ROOT, file));
    loaded.set(name, bytes);
  }
  return bytes;
};

// A short hash of each file's content, worked out once at startup, so a URL changes exactly when its file does.
const HASHES = new Map(Object.entries(FILES).map(([name, { file }]) => [name, createHash("sha256").update(read(name, file)).digest("hex").slice(0, 10)]));

/** The URL of a known asset, with its content hash: `/_/tessh.css?h=0123456789`. */
export function assetURL(name: string): string {
  const hash = HASHES.get(name);
  if (!hash) throw new Error(`Unknown asset ${name}`);
  return `/_/${name}?h=${hash}`;
}

/** Browsers ask for these at the root whatever the page says; they get our icons, never a 404 (or another app's cached icon). */
const ROOT_ICONS: Record<string, string> = { "/favicon.ico": "favicon.ico", "/apple-touch-icon.png": "apple-touch-icon.png", "/apple-touch-icon-precomposed.png": "apple-touch-icon.png" };

export function serveRootIcon(req: Request): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const name = ROOT_ICONS[new URL(req.url).pathname];
  if (!name) return null;
  return new Response(req.method === "HEAD" ? null : read(name, FILES[name].file), {
    headers: { "content-type": FILES[name].type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" },
  });
}

/** The icon links every page carries. */
export function iconLinks(): string {
  return `<link rel="icon" href="${assetURL("favicon.svg")}" type="image/svg+xml"><link rel="icon" href="${assetURL("favicon.ico")}" sizes="16x16 32x32 48x48"><link rel="apple-touch-icon" href="${assetURL("apple-touch-icon.png")}">`;
}

/** `/_/<name>` for a known asset, else null (the caller answers 404). */
export function serveAsset(req: Request): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith("/_/")) return null;
  const entry = Object.hasOwn(FILES, pathname.slice(3)) ? FILES[pathname.slice(3)] : undefined;
  if (!entry) return null;
  return new Response(req.method === "HEAD" ? null : read(pathname.slice(3), entry.file), {
    headers: { "content-type": entry.type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" },
  });
}
