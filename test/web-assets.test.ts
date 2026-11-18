import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assetURL } from "../src/web/assets.ts";
import { icons } from "../src/web/icons.ts";
import { esc, page } from "../src/web/shell.ts";
import { SELF } from "./harness.ts";

describe("web assets", () => {
  const cases: [string, string][] = [
    ["/_/tessh.css", "text/css"],
    ["/_/field.js", "text/javascript"],
    ["/_/one-time-code.js", "text/javascript"],
    ["/_/setup.js", "text/javascript"],
    ["/_/panel.js", "text/javascript"],
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
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain(`<script src="${assetURL("one-time-code.js")}" defer></script><script src="${assetURL("setup.js")}" defer></script>`);
    expect(html).toContain("A &lt;b&gt;");
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\sstyle=/);
  });

  it("escapes", () => expect(esc(`<&"'>`)).toBe("&lt;&amp;&quot;&#39;&gt;"));

  it("has every icon as an svg", () => {
    expect(Object.keys(icons).sort()).toEqual(
      "apple chevron chevronDown cloud copy globe gear grid lock list mail people plus server signout".split(" ").sort(),
    );
    for (const svg of Object.values(icons)) expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 16 16"/);
  });
});
