// The HTML document every web page (setup and panel) is wrapped in. CSP-compatible: styles and scripts
// come from /_/ files only, so a page may carry no inline <script>, <style> or style="" attribute.
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape a value for HTML text and attributes. */
export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export interface PageOptions {
  title: string;
  body: string;
  /** The behaviour file to load from /_/ (deferred). */
  script?: "setup" | "panel";
}

export function page({ title, body, script }: PageOptions): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><link rel="stylesheet" href="/_/tessh.css"><script src="/_/field.js" defer></script>${script ? `<script src="/_/${script}.js" defer></script>` : ""}
</head><body>
${body}
</body></html>
`;
}
