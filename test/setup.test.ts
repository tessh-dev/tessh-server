import { assetURL } from "../src/web/assets.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Env } from "../src/index.ts";
import { createOwner, resetOwnerAttempts, signIn } from "../src/owner.ts";
import { issueSetupCode, resetSetupAttempts } from "../src/setup-code.ts";
import { loadSettings } from "../src/settings.ts";
import { qrSVG } from "../src/qr.ts";
import { base32Decode, stepAt, totpAt } from "../src/totp.ts";
import { freshDB, makeEnv } from "./harness.ts";

const BASE = "http://192.168.1.5:8080";
const PW = "a long enough password";

function unsetEnv(over: Partial<Env> = {}, processEnv: NodeJS.ProcessEnv = {}): Env {
  const db = over.DB ?? freshDB();
  const settings = loadSettings(db, processEnv);
  return makeEnv({ DB: db, PUBLIC_URL: settings.publicURL, SERVER_NAME: settings.name, SETTINGS: settings, ...over });
}

const cookieOf = (res: Response, name: string): string | null => {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(";")[0];
  return null;
};

class Browser {
  cookies = new Map<string, string>();
  readonly env: Env;
  readonly origin: string;
  constructor(env: Env, origin = BASE) {
    this.env = env;
    this.origin = origin;
  }

  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (v && !/Max-Age=0/.test(c)) this.cookies.set(k, v);
      else this.cookies.delete(k);
    }
    return res;
  }

  private cookie = () => [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

  async get(path = "/setup") {
    return this.keep(await handle(new Request(`${this.origin}${path}`, { headers: { accept: "text/html", cookie: this.cookie(), "x-tessh-client-ip": "1.1.1.1" } }), this.env));
  }

  async html(path = "/setup") {
    const res = await this.get(path);
    expect(res.status).toBe(200);
    return res.text();
  }

  async post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return this.keep(
      await handle(
        new Request(`${this.origin}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tessh-owner": "1",
            origin: this.origin,
            cookie: this.cookie(),
            "x-tessh-client-ip": "1.1.1.1",
            ...headers,
          },
          body: JSON.stringify(body),
        }),
        this.env,
      ),
    );
  }
}

const settingRow = (env: Env, key: string) =>
  env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).execSync<{ value: string }>().results[0]?.value ?? null;

async function unlock(b: Browser, code: string) {
  const res = await b.post("/setup/api/code", { code });
  expect(res.status).toBe(200);
  return res;
}

async function throughServer(b: Browser, code: string) {
  await unlock(b, code);
  const res = await b.post("/setup/api/server", { name: "Holmes Lab", address: "https://sync.example.com/" });
  expect(res.status).toBe(200);
}

describe("browser setup", () => {
  beforeEach(() => {
    resetSetupAttempts();
    resetOwnerAttempts();
  });

  it("goes code, server, owner, team and finishes", async () => {
    const env = unsetEnv();
    const code = issueSetupCode(env);
    const b = new Browser(env);

    const first = await b.get();
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/html");
    expect(first.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(first.headers.get("cache-control")).toBe("no-store");
    const codePage = await first.text();
    expect(codePage).toContain("Set up your server");
    // The logs command sits folded behind "Where's the code?", with a copy button.
    expect(codePage).toMatch(/<details class="where"><summary>[\s\S]*Where's the code\?/);
    expect(codePage).toContain('data-copy="docker compose logs tessh-server"');
    expect(codePage).toContain(`<script src="${assetURL("setup.js")}" defer></script>`);
    expect(assetURL("setup.js")).toMatch(/^\/_\/setup\.js\?h=[0-9a-f]{10}$/);
    expect(codePage).not.toMatch(/<script(?![^>]*\ssrc=)|<style|\sstyle=/);
    expect(codePage).toContain(`<script src="${assetURL("one-time-code.js")}" defer></script><script src="${assetURL("setup.js")}"`);
    expect(codePage).toContain('data-otp data-length="8" data-charset="code" data-groups="4,4"');

    const unlocked = await unlock(b, code.toLowerCase());
    const setCookie = unlocked.headers.getSetCookie().find((c) => c.startsWith("tessh_setup="))!;
    expect(setCookie).toMatch(/^tessh_setup=[A-Za-z0-9_-]{43}; /);
    for (const part of ["HttpOnly", "SameSite=Strict", "Path=/setup", "Max-Age=7200"]) expect(setCookie).toContain(part);
    expect(setCookie).not.toContain("Secure");
    expect(JSON.stringify(env.SETUP_SESSION)).not.toContain(b.cookies.get("tessh_setup"));

    const serverPage = await b.html();
    expect(serverPage).toContain("Your server");
    expect(serverPage).toContain('data-instance="0123456789abcdef"');
    expect(serverPage).toContain(`value="${BASE}"`);

    expect((await b.post("/setup/api/server", { name: "Holmes Lab", address: "https://sync.example.com/" })).status).toBe(200);
    expect(settingRow(env, "name")).toBe("Holmes Lab");
    expect(settingRow(env, "public_url")).toBe("https://sync.example.com");

    const ownerPage = await b.html();
    expect(ownerPage).toContain("Owner login");
    // A QR code first; the key to type in is folded behind "Can't scan?", with a copy button and the link.
    expect(ownerPage).toContain("Scan this with your authenticator app, then type the code it shows.");
    expect(ownerPage).toMatch(/<div class="qr" data-qr><\/div>\s*<details class="where manual"><summary>[\s\S]*Can't scan\? Enter the key instead[\s\S]*data-secret[\s\S]*data-copy-secret[\s\S]*data-uri[\s\S]*<\/details>\s*<div class="otp-box" id="totp"/);
    expect(ownerPage).not.toMatch(/<script(?![^>]*\ssrc=)|<style|\sstyle=/);
    const totp = await b.post("/setup/api/owner/totp", {});
    expect(totp.status).toBe(200);
    const { secret, uri, qr } = (await totp.json()) as { secret: string; uri: string; qr: string };
    expect(uri).toBe(`otpauth://totp/Tessh%20Server:Holmes%20Lab?secret=${secret}&issuer=Tessh%20Server`);
    expect(qr).toBe(qrSVG(uri));
    const totpCode = await totpAt(base32Decode(secret), stepAt(Date.now()));
    const owner = await b.post("/setup/api/owner", { email: "Owner@Example.com", password: PW, totpCode });
    expect(owner.status).toBe(200);
    const row = env.DB.prepare("SELECT email, totp_secret FROM owner").execSync<{ email: string; totp_secret: Uint8Array | null }>().results[0];
    expect(row.email).toBe("owner@example.com");
    expect(row.totp_secret).not.toBeNull();

    const team = await b.html();
    expect(team).toContain("Who's it for?");
    expect(team).toContain("You can open it up to a team later.");
    for (const s of ["Just me", "Me and my team", "How people join", "Invite link", "Anyone with the address", "500 MB", "1 GB", "5 GB", "No limit"]) expect(team).toContain(s);
    // Just me is picked first; the team options sit behind Me and my team.
    expect(team).toMatch(/<form class="ocard" data-step="team" data-who="solo"/);
    expect(team).toMatch(/class="ch on" role="radio" aria-checked="true" data-who="solo"/);
    expect(team).toMatch(/role="radio" aria-checked="false" data-who="team"/);
    expect(team).toContain('<div class="team-opts for-team" data-team-opts>');
    expect(team).toMatch(/aria-checked="true" class="on" data-signups="invite"/);
    expect(team).toMatch(/aria-checked="true" class="on" data-bytes="1073741824"/);
    expect(team).toContain("Holmes Lab is ready");

    const done = await b.post("/setup/api/team", { signups: "invite", invites: ["Sam", " Priya "], defaultBytes: 5368709120 });
    expect(done.status).toBe(200);
    const out = (await done.json()) as { invites: { label: string; url: string }[]; ownerCode: string };
    expect(out.invites.map((i) => i.label)).toEqual(["Sam", "Priya"]);
    for (const i of out.invites) expect(i.url).toMatch(/^https:\/\/sync\.example\.com\/join\/[A-Za-z0-9]{6}$/);
    expect(out.ownerCode).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(cookieOf(done, "tessh_owner")).toMatch(/^tessh_owner=/);
    expect(done.headers.getSetCookie().find((c) => c.startsWith("tessh_setup="))).toContain("Max-Age=0");

    expect(env.SETTINGS.setupDone).toBe(true);
    expect(env.SETTINGS.signups).toBe("invite");
    expect(env.SETTINGS.defaultBytes).toBe(5368709120);
    expect(env.SETUP).toBeNull();
    expect(env.SETUP_SESSION).toBeNull();
    const invites = env.DB.prepare("SELECT label, kind, expires_at FROM invites ORDER BY created_at, kind").execSync<{ label: string; kind: string; expires_at: string | null }>().results;
    expect(invites.filter((i) => i.kind === "member").map((i) => i.label).sort()).toEqual(["Priya", "Sam"]);
    for (const i of invites.filter((x) => x.kind === "member")) {
      const days = (Date.parse(i.expires_at!) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);
    }
    const ownerInvite = invites.filter((i) => i.kind === "owner");
    expect(ownerInvite).toHaveLength(1);
    expect(ownerInvite[0].expires_at).toBeNull();

    const after = await b.get();
    expect([after.status, after.headers.get("location")]).toEqual([302, "/admin"]);
    expect((await b.post("/setup/api/team", { signups: "invite", invites: [], defaultBytes: -1 })).status).toBe(404);
  });

  it("finishes for just me: closed, no storage limit, no invites", async () => {
    const env = unsetEnv();
    const b = new Browser(env);
    await throughServer(b, issueSetupCode(env));
    expect((await b.post("/setup/api/owner", { email: "owner@example.com", password: PW })).status).toBe(200);
    const page = await b.html();
    // The Ready card for just me has the owner's code and nothing about invites.
    const ready = page.slice(page.indexOf("<section class=\"ocard wide\" data-done"), page.indexOf("</section>"));
    expect(ready).toContain('data-who="solo"');
    expect(ready).toContain('<p class="sub for-solo">Your vault is ready to sync.</p>');
    expect(ready).toContain('<div class="lbl for-solo">Connect your apps</div>');
    expect(ready.replace(/<[^>]*class="[^"]*for-team[^"]*"[^>]*>[^<]*<\/[a-z]+>/g, "")).not.toMatch(/invite/i);
    expect(ready).toContain("data-owner-code");

    // Members invites make no sense when only the owner can sign up.
    expect((await b.post("/setup/api/team", { signups: "closed", invites: ["Sam"], defaultBytes: -1 })).status).toBe(400);
    const done = await b.post("/setup/api/team", { signups: "closed", invites: [], defaultBytes: -1 });
    expect(done.status).toBe(200);
    const out = (await done.json()) as { invites: unknown[]; ownerCode: string };
    expect(out.invites).toEqual([]);
    expect(out.ownerCode).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(env.SETTINGS.signups).toBe("closed");
    expect(env.SETTINGS.defaultBytes).toBe(-1);
    expect(settingRow(env, "default_bytes")).toBe("-1");
    const kinds = env.DB.prepare("SELECT kind FROM invites").execSync<{ kind: string }>().results.map((r) => r.kind);
    expect(kinds).toEqual(["owner"]);
  });

  it("saves no storage limit for just me whatever size is sent", async () => {
    const env = unsetEnv();
    const b = new Browser(env);
    await throughServer(b, issueSetupCode(env));
    expect((await b.post("/setup/api/owner", { email: "owner@example.com", password: PW })).status).toBe(200);
    expect((await b.post("/setup/api/team", { signups: "closed", invites: [], defaultBytes: 12345 })).status).toBe(400);
    expect((await b.post("/setup/api/team", { signups: "closed" })).status).toBe(200);
    expect(env.SETTINGS.defaultBytes).toBe(-1);
  });

  it.each(["invite", "open"] as const)("finishes for a team that joins by %s", async (signups) => {
    const env = unsetEnv();
    const b = new Browser(env);
    await throughServer(b, issueSetupCode(env));
    expect((await b.post("/setup/api/owner", { email: "owner@example.com", password: PW })).status).toBe(200);
    const page = await b.html();
    // The team Ready card keeps the invite links.
    expect(page).toContain('<p class="sub for-team" data-ready-sub>Send these invite links, then connect your own apps.</p>');
    expect(page).toContain('<div class="rows for-team" data-invites hidden></div>');
    const done = await b.post("/setup/api/team", { signups, invites: ["Sam"], defaultBytes: 524288000 });
    expect(done.status).toBe(200);
    const out = (await done.json()) as { invites: { label: string; url: string }[] };
    expect(out.invites.map((i) => i.label)).toEqual(["Sam"]);
    expect(env.SETTINGS.signups).toBe(signups);
    expect(env.SETTINGS.defaultBytes).toBe(524288000);
  });

  it("opens on the team choice when the environment sets signups", async () => {
    const env = unsetEnv({}, { SIGNUPS: "open" });
    const b = new Browser(env);
    await throughServer(b, issueSetupCode(env));
    expect((await b.post("/setup/api/owner", { email: "owner@example.com", password: PW })).status).toBe(200);
    const page = await b.html();
    expect(page).toMatch(/data-step="team" data-who="team"/);
    expect(page).toMatch(/role="radio" aria-checked="false" data-who="solo" disabled/);
    expect(page).toMatch(/aria-checked="true" class="on" data-signups="open" disabled/);
    expect(page).toContain("Set by the server's environment.");
  });

  it("can skip the authenticator", async () => {
    const env = unsetEnv();
    const b = new Browser(env);
    await throughServer(b, issueSetupCode(env));
    expect((await b.post("/setup/api/owner", { email: "owner@example.com", password: PW })).status).toBe(200);
    const row = env.DB.prepare("SELECT totp_secret FROM owner").execSync<{ totp_secret: unknown }>().results[0];
    expect(row.totp_secret).toBeNull();
  });

  it("does not make the owner when the authenticator code is wrong", async () => {
    const env = unsetEnv();
    const b = new Browser(env);
    await throughServer(b, issueSetupCode(env));
    expect((await b.post("/setup/api/owner", { email: "owner@example.com", password: PW, totpCode: "000000" })).status).toBe(409);
    expect((await b.post("/setup/api/owner/totp", {})).status).toBe(200);
    const res = await b.post("/setup/api/owner", { email: "owner@example.com", password: PW, totpCode: "abcdef" });
    expect(res.status).toBe(401);
    expect(env.DB.prepare("SELECT COUNT(*) AS n FROM owner").execSync<{ n: number }>().results[0].n).toBe(0);
  });

  it("refuses every later call without the setup cookie", async () => {
    const env = unsetEnv();
    const code = issueSetupCode(env);
    const b = new Browser(env);
    const calls: [string, unknown][] = [
      ["/setup/api/server", { name: "X", address: "https://x.example.com" }],
      ["/setup/api/owner/totp", {}],
      ["/setup/api/owner", { email: "owner@example.com", password: PW }],
      ["/setup/api/team", { signups: "invite", invites: [], defaultBytes: -1 }],
    ];
    for (const [path, body] of calls) expect((await b.post(path, body)).status).toBe(401);
    await unlock(b, code);
    b.cookies.set("tessh_setup", "not-the-token");
    for (const [path, body] of calls) expect((await b.post(path, body)).status).toBe(401);
    expect(await b.html()).toContain("Set up your server");
  });

  it("checks the code, the header and the origin", async () => {
    const env = unsetEnv();
    const code = issueSetupCode(env);
    const b = new Browser(env);
    expect((await b.post("/setup/api/code", { code: "AAAA-AAAA" })).status).toBe(401);
    expect((await b.post("/setup/api/code", { code }, { "x-tessh-owner": "" })).status).toBe(403);
    expect((await b.post("/setup/api/code", { code }, { origin: "https://evil.example" })).status).toBe(403);
    expect(b.cookies.has("tessh_setup")).toBe(false);
    await unlock(b, code);
  });

  it("refuses an address that isn't http or https, and a bad name", async () => {
    const env = unsetEnv();
    const b = new Browser(env);
    await unlock(b, issueSetupCode(env));
    expect((await b.post("/setup/api/server", { name: "X", address: "ftp://x" })).status).toBe(400);
    expect((await b.post("/setup/api/server", { name: "", address: "https://x.example.com" })).status).toBe(400);
    expect((await b.post("/setup/api/server", { name: "x".repeat(65), address: "https://x.example.com" })).status).toBe(400);
    expect(settingRow(env, "name")).toBeNull();
    expect(settingRow(env, "public_url")).toBeNull();
  });

  it("shows a name set by the environment read-only and ignores it in the API", async () => {
    const env = unsetEnv({}, { SERVER_NAME: "Env Lab" });
    const b = new Browser(env);
    await unlock(b, issueSetupCode(env));
    const page = await b.html();
    expect(page).toContain("Env Lab");
    expect(page).not.toMatch(/<input[^>]*name="name"/);
    expect((await b.post("/setup/api/server", { name: "Other", address: "https://sync.example.com" })).status).toBe(200);
    expect(env.SETTINGS.name).toBe("Env Lab");
    expect(settingRow(env, "name")).toBeNull();
    expect(settingRow(env, "public_url")).toBe("https://sync.example.com");
    expect(await b.html()).toContain("Owner login");
  });

  it("resumes at the owner step after a restart", async () => {
    const db = freshDB();
    const env = unsetEnv({ DB: db });
    const b = new Browser(env);
    await throughServer(b, issueSetupCode(env));

    // A restart: same database, fresh memory and a fresh code.
    const env2 = unsetEnv({ DB: db });
    const code2 = issueSetupCode(env2);
    const b2 = new Browser(env2);
    expect(await b2.html()).toContain("Set up your server");
    await unlock(b2, code2);
    const page = await b2.html();
    expect(page).toContain("Owner login");
    expect(page).not.toContain("Your server");
  });

  it("drops the setup session when a new code is issued", async () => {
    const env = unsetEnv();
    const b = new Browser(env);
    await unlock(b, issueSetupCode(env));
    issueSetupCode(env);
    expect((await b.post("/setup/api/server", { name: "X", address: "https://x.example.com" })).status).toBe(401);
  });

  it("an owner reset only asks for the code and the owner login", async () => {
    const env = makeEnv({ PUBLIC_URL: null });
    await createOwner(env, "old@example.com", PW);
    const code = issueSetupCode(env);
    env.SETUP!.scope = "owner";
    const b = new Browser(env);

    const codePage = await b.html();
    expect(codePage).toContain("Set up your server");
    expect(codePage.match(/<i(?: class="on")?><\/i>/g)).toHaveLength(2);
    await unlock(b, code);
    const page = await b.html();
    expect(page).toContain("Owner login");
    expect(page).toContain("You can sign in again");
    for (const s of ["Your server", "Your team"]) expect(page).not.toContain(s);
    expect((await b.post("/setup/api/server", { name: "X", address: "https://x.example.com" })).status).toBe(404);
    expect((await b.post("/setup/api/team", { signups: "invite", invites: [], defaultBytes: -1 })).status).toBe(404);

    expect((await b.post("/setup/api/owner", { email: "new@example.com", password: "another long password" })).status).toBe(200);
    expect(env.SETUP).toBeNull();
    await expect(signIn(env, new Request(`${BASE}/admin`), { email: "new@example.com", password: "another long password" })).resolves.toBeTruthy();
    const after = await b.get();
    expect([after.status, after.headers.get("location")]).toEqual([302, "/admin"]);
  });

  it("checks the team choices", async () => {
    const env = unsetEnv();
    const b = new Browser(env);
    await throughServer(b, issueSetupCode(env));
    const ok = { signups: "invite", invites: [], defaultBytes: 1073741824 };
    expect((await b.post("/setup/api/team", ok)).status).toBe(409);
    expect((await b.post("/setup/api/owner", { email: "owner@example.com", password: PW })).status).toBe(200);
    expect((await b.post("/setup/api/owner", { email: "owner@example.com", password: PW })).status).toBe(409);
    expect((await b.post("/setup/api/team", { ...ok, signups: "everyone" })).status).toBe(400);
    expect((await b.post("/setup/api/team", { ...ok, defaultBytes: 12345 })).status).toBe(400);
    expect((await b.post("/setup/api/team", { ...ok, invites: Array.from({ length: 21 }, (_, i) => `P${i}`) })).status).toBe(400);
    expect((await b.post("/setup/api/team", { ...ok, invites: [""] })).status).toBe(400);
    expect((await b.post("/setup/api/team", { ...ok, invites: ["x".repeat(65)] })).status).toBe(400);
    expect(env.SETTINGS.setupDone).toBe(false);
    const res = await b.post("/setup/api/team", { ...ok, signups: "closed", defaultBytes: -1 });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ invites: [] });
    expect(env.SETTINGS.signups).toBe("closed");
    expect(env.SETTINGS.defaultBytes).toBe(-1);
  });

  it("sends /setup to the panel once set up", async () => {
    const env = makeEnv();
    const b = new Browser(env);
    const res = await b.get();
    expect([res.status, res.headers.get("location")]).toEqual([302, "/admin"]);
    expect((await b.post("/setup/api/code", { code: "AAAA-AAAA" })).status).toBe(404);
    expect((await b.get("/setup/nope")).status).toBe(404);
  });

  it("lets the setup page check an address on another origin", async () => {
    const res = await handle(new Request("https://keys.test/v1/server"), makeEnv());
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("an expired owner reset", () => {
  it("drops the setup session once the code has run out", async () => {
    const env = makeEnv({ PUBLIC_URL: null });
    await createOwner(env, "old@example.com", PW);
    const code = issueSetupCode(env, Date.now(), "owner");
    const b = new Browser(env);
    await unlock(b, code);
    expect((await b.post("/setup/api/owner", { email: "new@example.com", password: "another long password" })).status).toBe(200);
    // Again, then let the code run out part-way.
    const code2 = issueSetupCode(env, Date.now(), "owner");
    const b2 = new Browser(env);
    await unlock(b2, code2);
    env.SETUP!.expiresAt = Date.now() - 1;
    expect((await b2.post("/setup/api/owner", { email: "x@example.com", password: "another long password" })).status).toBe(401);
    expect(env.SETUP_SESSION).toBeNull();
  });
});

describe("an expired setup code", () => {
  beforeEach(() => resetSetupAttempts());

  it("sends /setup to the panel once an owner reset code has run out", async () => {
    const env = makeEnv();
    await createOwner(env, "old@example.com", PW);
    issueSetupCode(env, Date.now(), "owner");
    env.SETUP!.expiresAt = Date.now() - 1;
    const res = await new Browser(env).get();
    expect([res.status, res.headers.get("location")]).toEqual([302, "/admin"]);
  });

  it("tells the owner to restart the server when the first setup code has run out", async () => {
    const env = unsetEnv({ PUBLIC_URL: null });
    issueSetupCode(env, Date.now(), "full");
    env.SETUP!.expiresAt = Date.now() - 1;
    const html = await new Browser(env).html();
    expect(html).toContain("This setup code has expired");
    expect(html).toContain("Restart the server");
    expect(html).not.toContain("data-otp");
  });
});
