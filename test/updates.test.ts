import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOwner, resetOwnerAttempts } from "../src/owner.ts";
import { RELEASES_PAGE, checkForUpdate, compareVersions, isNewer, recordCheck, releaseNotes, scheduleUpdateChecks, type Release } from "../src/updates.ts";
import { SELF, env, makeEnv } from "./harness.ts";

const release = (tag: string, extra: Record<string, unknown> = {}) => async () => new Response(JSON.stringify({ tag_name: tag, ...extra }));

describe("semver ordering", () => {
  it("compares numerically, not as text", () => {
    expect(isNewer("1.10.0", "1.9.9")).toBe(true);
    expect(isNewer("2.0.0", "1.99.99")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("0.9.0", "1.0.0")).toBe(false);
    expect(isNewer("v1.2.0", "1.1.0")).toBe(true);
  });

  it("sorts pre-releases before their release, by identifier", () => {
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0-rc.1", "0.9.0")).toBe(true);
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 1; i < order.length; i++) expect(compareVersions(order[i], order[i - 1])).toBeGreaterThan(0);
    expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
  });

  it("never calls anything that isn't semver newer", () => {
    expect(isNewer("nightly", "1.0.0")).toBe(false);
    expect(isNewer("1.2", "1.0.0")).toBe(false);
    expect(isNewer("1.2.0", "dev")).toBe(false);
    expect(compareVersions("01.0.0", "1.0.0")).toBeNull();
  });
});

describe("release notes", () => {
  it("keeps the first five non-empty lines as plain text", () => {
    const body = "## What's new\n\n- **Faster** sync\n* Fixed `install.sh` on Alpine\n\n1. One\n2. Two\n3. Three";
    expect(releaseNotes(body)).toEqual(["What's new", "Faster sync", "Fixed install.sh on Alpine", "One", "Two"]);
  });

  it("reduces links and images to their text and drops comments and link definitions", () => {
    const body = "<!-- template -->\nSee [the guide](https://evil.example/x) and ![logo](https://x/y.png)\n> quoted <https://github.com/a>\n[ref]: https://x\n---\nDone [here][ref]";
    expect(releaseNotes(body)).toEqual(["See the guide and logo", "quoted https://github.com/a", "Done here"]);
  });

  it("returns HTML as text for the page to escape, never as markup", () => {
    const notes = releaseNotes('<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n‮evil\u0007');
    expect(notes).toEqual(["<script>alert(1)</script>", '<img src=x onerror="alert(2)">', "evil"]);
  });

  it("copes with no body or a long one", () => {
    expect(releaseNotes(undefined)).toEqual([]);
    expect(releaseNotes(42)).toEqual([]);
    const [line] = releaseNotes("x".repeat(500));
    expect(line.length).toBe(160);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("update check", () => {
  it("reports a newer release with its page, date and notes", async () => {
    const r = await checkForUpdate(
      release("v1.2.0", { html_url: "https://github.com/BobzTH/tessh-server/releases/tag/v1.2.0", published_at: "2026-11-12T10:00:00Z", body: "- One\n- Two" }),
      "1.1.0",
    );
    expect(r).toEqual({
      latest: "1.2.0",
      newer: true,
      release: { version: "1.2.0", url: "https://github.com/BobzTH/tessh-server/releases/tag/v1.2.0", publishedAt: "2026-11-12T10:00:00.000Z", notes: ["One", "Two"] },
    });
  });

  it("never links anywhere but the repo's releases", async () => {
    for (const html_url of ["javascript:alert(1)", "https://evil.example/BobzTH/tessh-server/releases/x", "http://github.com/BobzTH/tessh-server/releases/x", 7]) {
      expect((await checkForUpdate(release("v1.2.0", { html_url }), "1.1.0"))!.release.url).toBe(RELEASES_PAGE);
    }
    expect((await checkForUpdate(release("v1.2.0", { published_at: "soon" }), "1.1.0"))!.release.publishedAt).toBeNull();
  });

  it("reports nothing newer for the same or an older release", async () => {
    expect((await checkForUpdate(release("v1.1.0"), "1.1.0"))!.newer).toBe(false);
    expect((await checkForUpdate(release("1.0.0"), "1.1.0"))!.newer).toBe(false);
  });

  it("returns null on failures", async () => {
    expect(await checkForUpdate(async () => { throw new Error("offline"); }, "1.0.0")).toBeNull();
    expect(await checkForUpdate(async () => new Response("no", { status: 404 }), "1.0.0")).toBeNull();
    expect(await checkForUpdate(async () => new Response("no", { status: 500 }), "1.0.0")).toBeNull();
    expect(await checkForUpdate(async () => new Response("not json"), "1.0.0")).toBeNull();
    expect(await checkForUpdate(release("nightly"), "1.0.0")).toBeNull();
  });

  it("sends the right URL, user agent and a timeout", async () => {
    const fetchFn = vi.fn((_url: string, _init?: RequestInit) => release("1.0.0")());
    await checkForUpdate(fetchFn, "1.0.0");
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/BobzTH/tessh-server/releases/latest");
    expect((init!.headers as Record<string, string>)["user-agent"]).toBe("tessh-server/1.0.0");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("checks 60 seconds after boot and then daily, until stopped", async () => {
    vi.useFakeTimers();
    try {
      const e = makeEnv({ VERSION: "1.0.0" });
      const fetchFn = vi.fn((_url: string, _init?: RequestInit) => release("v2.0.0", { body: "Big one" })());
      const stop = scheduleUpdateChecks(e, fetchFn);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(fetchFn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(e.UPDATE_LATEST).toBe("2.0.0");
      expect(e.UPDATE_RELEASE?.notes).toEqual(["Big one"]);
      expect(e.UPDATE_CHECKED_AT).toBeTypeOf("number");
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      // A failed check keeps the known release and marks the failure; a good one that finds nothing newer clears both.
      fetchFn.mockImplementationOnce(async () => { throw new Error("offline"); });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(e.UPDATE_LATEST).toBe("2.0.0");
      expect(e.UPDATE_FAILED_AT).toBeTypeOf("number");
      e.VERSION = "2.0.0";
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(e.UPDATE_LATEST).toBeNull();
      expect(e.UPDATE_RELEASE).toBeNull();
      expect(e.UPDATE_FAILED_AT).toBeNull();
      stop();
      await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000);
      expect(fetchFn).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("update notice in the panel", () => {
  const BASE = "https://keys.test";
  const PW = "a long enough password";
  const CMD = "docker compose pull &amp;&amp; docker compose up -d";
  let cookie = "";
  const page = async (path: string) => (await SELF.fetch(`${BASE}${path}`, { headers: { cookie } })).text();
  const NEW: Release = {
    version: "9.9.9",
    url: "https://github.com/BobzTH/tessh-server/releases/tag/v9.9.9",
    publishedAt: "2026-11-12T10:00:00.000Z",
    notes: releaseNotes("## Highlights\n- <script>alert(1)</script> fixed\n- See [docs](https://evil.example)"),
  };

  beforeAll(async () => {
    await createOwner(env, "owner@example.com", PW);
    resetOwnerAttempts();
    const login = await SELF.fetch(`${BASE}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tessh-owner": "1", origin: BASE, "x-tessh-client-ip": "10.0.0.7" },
      body: JSON.stringify({ email: "owner@example.com", password: PW }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  });
  beforeEach(() => {
    env.UPDATE_CHECK = true;
    env.UPDATE_LATEST = env.UPDATE_RELEASE = env.UPDATE_CHECKED_AT = env.UPDATE_FAILED_AT = null;
  });

  it("Overview shows the card above the health tile when there's an update", async () => {
    recordCheck(env, NEW);
    const html = await page("/admin");
    const card = html.indexOf('<section class="upcard"');
    expect(card).toBeGreaterThan(-1);
    expect(card).toBeLessThan(html.indexOf('<section class="hero"'));
    expect(html).toContain("Tessh Server 9.9.9 is available");
    expect(html).toContain(`You&#39;re on ${env.VERSION} · released 12 Nov 2026`);
    expect(html).toContain("<li>Highlights</li><li>&lt;script&gt;alert(1)&lt;/script&gt; fixed</li><li>See docs</li>");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("evil.example");
    expect(html).toContain(`<a class="upl" href="https://github.com/BobzTH/tessh-server/releases/tag/v9.9.9" target="_blank" rel="noopener">What's new</a>`);
    expect(html).toContain(`<code>${CMD}</code>`);
    expect(html).toContain("Run it where your compose file is. Your data stays in the data volume.");
    expect(html).not.toMatch(/\sstyle=/);
  });

  it("Overview has no card when up to date, off, failed or not checked", async () => {
    expect(await page("/admin")).not.toContain("upcard");
    recordCheck(env, { ...NEW, version: env.VERSION });
    const current = await page("/admin");
    expect(current).not.toContain("upcard");
    expect(current).toContain(`${env.VERSION} up to date`);
    recordCheck(env, undefined);
    const failed = await page("/admin");
    expect(failed).not.toContain("upcard");
    expect(failed).not.toContain("up to date");
    env.UPDATE_CHECK = false;
    expect(await page("/admin")).not.toContain("upcard");
  });

  it("the sidebar status links to Maintenance when there's an update", async () => {
    expect(await page("/admin")).toContain(`<small><i class="dot"></i>Running · ${env.VERSION}</small>`);
    recordCheck(env, NEW);
    const html = await page("/admin/team");
    expect(html).toContain('<a class="upd" href="/admin/maintenance"><i class="dot warn"></i>Update available · 9.9.9</a>');
    expect(html).not.toContain("Running ·");
  });

  it("Maintenance: an update shows the same card", async () => {
    recordCheck(env, NEW);
    const html = await page("/admin/maintenance");
    expect(html).toContain("Tessh Server 9.9.9 is available");
    expect(html).toContain("released 12 Nov 2026");
    expect(html).toContain("<li>See docs</li>");
    expect(html).toContain(`target="_blank" rel="noopener">What's new</a>`);
    expect(html).toContain(`<code>${CMD}</code>`);
  });

  it("Maintenance: up to date says when it was checked", async () => {
    recordCheck(env, null, Date.now() - 2 * 60 * 60 * 1000);
    const html = await page("/admin/maintenance");
    expect(html).toContain(`${env.VERSION} · <span class="okp">Up to date</span> · checked 2 h ago`);
    expect(html).not.toContain("upcard");
    expect(html).toContain(`<code>${CMD}</code>`);
  });

  it("Maintenance: off says how to turn it back on", async () => {
    env.UPDATE_CHECK = false;
    recordCheck(env, NEW); // ignored while the check is off
    const html = await page("/admin/maintenance");
    expect(html).toContain("The update check is off");
    expect(html).toContain("UPDATE_CHECK");
    expect(html).not.toContain("upcard");
    expect(html).not.toContain("Up to date");
  });

  it("Maintenance: a failed check says so, with the last attempt, not a stale up to date", async () => {
    recordCheck(env, null, Date.now() - 3 * 24 * 60 * 60 * 1000);
    recordCheck(env, undefined, Date.now() - 5 * 60 * 1000);
    const html = await page("/admin/maintenance");
    expect(html).toContain("Couldn't check for updates");
    expect(html).toContain("Last tried 5 min ago");
    expect(html).not.toContain("Up to date");
  });

  it("Maintenance: before the first check says it hasn't run yet", async () => {
    expect(await page("/admin/maintenance")).toContain("Not checked yet");
  });
});
