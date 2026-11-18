import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assetURL } from "../src/web/assets.ts";
import { icons } from "../src/web/icons.ts";
import { esc, page } from "../src/web/shell.ts";
import { readFileSync } from "node:fs";
import { renderMissing, renderPage } from "../src/page.ts";
import { SELF } from "./harness.ts";

describe("web assets", () => {
  const cases: [string, string][] = [
    ["/_/tessh.css", "text/css"],
    ["/_/field.js", "text/javascript"],
    ["/_/one-time-code.js", "text/javascript"],
    ["/_/setup.js", "text/javascript"],
    ["/_/panel.js", "text/javascript"],
    ["/_/theme.js", "text/javascript"],
    ["/_/AlloRound.woff2", "font/woff2"],
  ];
  for (const [path, type] of cases) {
    it(`serves ${path}`, async () => {
      const res = await SELF.fetch(`https://keys.test${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(type);
      expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
    });
  }

  it("names each file by a hash of its content", async () => {
    const url = assetURL("tessh.css");
    expect(url).toMatch(/^\/_\/tessh\.css\?h=[0-9a-f]{10}$/);
    const body = new Uint8Array(await (await SELF.fetch(`https://keys.test${url}`)).arrayBuffer());
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 10);
    expect(url).toBe(`/_/tessh.css?h=${hash}`);
    expect(() => assetURL("missing.js")).toThrow();
  });

  it("has no way out of the whitelist", async () => {
    for (const p of ["/_/../package.json", "/_/%2e%2e/package.json", "/_/missing.css", "/_/"]) {
      expect((await SELF.fetch(`https://keys.test${p}`)).status).toBe(404);
    }
  });
});

describe("page shell", () => {
  it("is CSP-compatible", () => {
    const html = page({ title: "A <b>", body: '<p class="x">hi</p>', script: "setup" });
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    expect(html).toContain(`<script src="${assetURL("one-time-code.js")}" defer></script><script src="${assetURL("setup.js")}" defer></script>`);
    expect(html).toContain("A &lt;b&gt;");
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\sstyle=/);
  });

  it("escapes", () => expect(esc(`<&"'>`)).toBe("&lt;&amp;&quot;&#39;&gt;"));

  it("has every icon as an svg", () => {
    expect(Object.keys(icons).sort()).toEqual(
      "apple chevron chevronDown cloud copy globe gear grid info lock list mail people plus server signout".split(" ").sort(),
    );
    for (const svg of Object.values(icons)) expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 16 16"/);
  });
});

describe("theme", () => {
  const css = readFileSync(new URL("../assets/web/tessh.css", import.meta.url), "utf8");
  const themeTag = `<script src="${assetURL("theme.js")}"></script>`;

  it("is dark unless the panel's <html data-theme> asks for light", () => {
    expect(css).toMatch(/^:root\{color-scheme:dark;/m);
    // every light rule hangs off data-theme: light, or system inside the light media query
    for (const m of css.matchAll(/@media \(prefers-color-scheme:light\)\{([^{]+)\{/g)) expect(m[1]).toMatch(/^:root\[data-theme=system\]/);
    expect(css).toContain(":root[data-theme=light]{color-scheme:light;--canvas:#f1f3f5;");
    expect(css).toContain("@media (prefers-color-scheme:light){:root[data-theme=system]{--canvas:#f1f3f5;");
  });

  it("setup, join and other non-panel pages never load the panel theme", () => {
    for (const html of [page({ title: "Set up", body: "", script: "setup" }), page({ title: "Join", body: "" })]) {
      expect(html).toContain('<meta name="color-scheme" content="dark">');
      expect(html).not.toContain("theme.js");
      expect(html).not.toContain("data-theme");
    }
  });

  it("key pages are dark only", () => {
    const key = { name: "k", type: "ssh-ed25519", fingerprint: "SHA256:k", kind: "synced" as const, addedAt: "2026-11-16T10:00:00Z", line: "ssh-ed25519 AAAA k" };
    const keyPage = renderPage({ username: "bob", host: "s.example.com", origin: "https://s.example.com/bob", install: "x", revokedCount: 0, updated: "2026-11-16T10:00:00Z", keys: [key] });
    for (const html of [keyPage, renderMissing("nobody")]) {
      expect(html).toContain('<meta name="color-scheme" content="dark">');
      expect(html).not.toContain("prefers-color-scheme");
      expect(html).not.toContain("theme.js");
    }
  });

  it("the panel applies its theme in <head>, blocking, before the stylesheet", () => {
    const html = page({ title: "Overview", body: "", script: "panel" });
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain(`${themeTag}<link rel="stylesheet" href="${assetURL("tessh.css")}">`);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).not.toMatch(/\sstyle=/);
  });
});
