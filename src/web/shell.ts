// The HTML document every web page (setup and panel) is wrapped in. CSP-compatible: styles and scripts
// come from /_/ files only, so a page may carry no inline <script>, <style> or style="" attribute.
// Each /_/ URL carries a hash of the file's content, so a browser fetches it fresh whenever it changes.
import { assetURL } from "./assets.ts";
import { icons } from "./icons.ts";
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape a value for HTML text and attributes. */
export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Adding the authenticator, in setup and in the panel: a QR code first, the key to type in folded away
 * underneath. The page's script fills `data-qr`, `data-secret`, `data-uri` and the copy button from the
 * enrol response; the 6-digit code entry follows.
 */
export const totpEnrol = (): string => `<p class="cap">Scan this with your authenticator app, then type the code it shows.</p>
<div class="qr" data-qr></div>
<details class="where manual"><summary>${icons.info}<span>Can't scan? Enter the key instead</span></summary>
<div class="where-box"><div class="cmd"><code class="key" data-secret>…</code><button type="button" class="btn ghost sm" data-copy="" data-copy-secret>${icons.copy}<span>Copy</span></button></div>
<p><a class="uri" data-uri href="#">Open in your authenticator app</a></p></div>
</details>`;

/** The Tessh Server wordmark at the top of a setup or sign-in card. */
export const MARK = `<div class="mark"><span class="gly" aria-hidden="true"><span class="t">t</span><span class="c">›</span><span class="b"></span></span> Tessh Server</div>`;

export interface PageOptions {
  title: string;
  body: string;
  /** The behaviour file to load from /_/ (deferred). */
  script?: "setup" | "panel";
}

/**
 * Every page is dark. Only the panel (script "panel") loads theme.js, blocking in <head> so its saved
 * appearance (dark, light or match system) is on <html> before the first paint.
 */
export function page({ title, body, script }: PageOptions): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>${script === "panel" ? `<script src="${assetURL("theme.js")}"></script>` : ""}<link rel="stylesheet" href="${assetURL("tessh.css")}"><script src="${assetURL("field.js")}" defer></script>${script ? `<script src="${assetURL("one-time-code.js")}" defer></script><script src="${assetURL(`${script}.js`)}" defer></script>` : ""}
</head><body>
${body}
</body></html>
`;
}
