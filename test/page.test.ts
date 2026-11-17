import { describe, expect, it } from "vitest";
import type { KeyKind } from "../src/keypage.ts";
import { renderMissing, renderPage, type PublicKey } from "../src/page.ts";

const key = (name: string, type: string, kind: KeyKind): PublicKey => ({
  name,
  type,
  fingerprint: `SHA256:${name}`,
  kind,
  addedAt: "2026-11-16T10:00:00Z",
  line: `${type} AAAA ${name}`,
});
const base = {
  username: "bob",
  host: "sync.example.com",
  origin: "https://sync.example.com/bob",
  install: "curl -fsSL https://sync.example.com/bob/install.sh | sh",
  revokedCount: 0,
  updated: "2026-11-16T10:00:00Z",
};

describe("key page HTML", () => {
  it("labels Device, Synced and Standard keys with their algorithm and counts them", () => {
    const keys = [
      key("tessh-mac", "ecdsa-sha2-nistp256", "device"),
      key("tessh-phone", "ecdsa-sha2-nistp256", "device"),
      key("tessh-rsa", "ssh-rsa", "synced"),
      key("tessh-ed", "ssh-ed25519", "standard"),
    ];
    const html = renderPage({ ...base, keys });
    expect(html).toContain('<span class="kname">Device key</span><span class="kind hw">ECDSA P-256</span>');
    expect(html).toContain('<span class="kname">Synced key</span><span class="kind">RSA</span>');
    expect(html).toContain('<span class="kname">Standard key</span><span class="kind">Ed25519</span>');
    expect(html).toContain("2 Device</span>");
    expect(html).toContain("1 Synced</span>");
    expect(html).toContain("1 Standard</span>");
    expect(html).toContain('data-copy="ecdsa-sha2-nistp256 AAAA tessh-mac"');
    expect(html).toContain("Added 16 Nov 2026");
    expect(html).not.toMatch(/Touch ID|Face ID/);
    expect(html).not.toContain('<div class="revoked">');
  });

  it("empty state has no install card but keeps the FAQ", () => {
    const html = renderPage({ ...base, keys: [], revokedCount: 2 });
    expect(html).toContain("No keys yet");
    expect(html).toContain("hasn't published any keys yet");
    expect(html).not.toContain("Install script");
    expect(html).toContain("2 revoked keys.");
    expect(html).toContain("What does the install command do?");
    expect(html).toContain("What is a Device key?");
  });

  it("escapes what it shows", () => {
    const k = { ...key("x", "<img src=x>", "synced"), fingerprint: "<b>" };
    const html = renderPage({ ...base, keys: [k] });
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<b>&lt;");
    expect(html).toContain("&#60;img src=x&#62;");
  });

  it("404 page", () => {
    expect(renderMissing("alice")).toContain("No key page for <b>@alice</b>");
    expect(renderMissing(null)).toContain("Nothing here");
  });
});
