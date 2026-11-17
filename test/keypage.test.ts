import { SELF, env } from "./harness.ts";
import { describe, expect, it } from "vitest";
import fx from "./fixtures/keypage.json" with { type: "json" };
import { publicName } from "../src/keys-host.ts";
import { call, registerBody } from "./helpers.ts";

/** The fixture is a page signed the old way: comments are key labels, entries carry label and device. */
const pub = (i: number) => publicName(fx.keys[i].fingerprint);
/** A signed line with its comment swapped for the neutral public name. */
const neutral = (line: string, fp: string) => line.split(" ").slice(0, 2).join(" ") + " " + publicName(fp);

/** The key lines of a fixture body (the version header left out). */
const keyLines = (body: string) => body.split("\n").filter((l) => l !== "" && !l.startsWith("#"));

const keysGet = (path: string, init: RequestInit = {}) => SELF.fetch(`https://keys.test${path}`, init);

const upload = (over: Record<string, unknown> = {}) => ({
  authorizedKeys: fx.authorizedKeys,
  authorizedKeysSig: fx.authorizedKeysSig,
  revoked: fx.revoked,
  revokedSig: fx.revokedSig,
  keys: fx.keys,
  ...over,
});

/** Registers with the fixture's signer and, unless `username` is null, claims that username. */
async function signerUser(email: string, username: string | null): Promise<string> {
  const res = await call("POST", "/v1/register", registerBody(email, { signerPublicKey: fx.signerPublicKey }));
  const { token } = (await res.json()) as { token: string };
  if (username) expect((await call("PUT", "/v1/account/username", { username }, token)).status).toBe(200);
  return token;
}

async function published(email: string, username: string): Promise<string> {
  const token = await signerUser(email, username);
  const res = await call("PUT", "/v1/keypage", upload(), token);
  expect(res.status).toBe(204);
  return token;
}

describe("PUT /v1/keypage", () => {
  it("upload with valid signatures is served byte-for-byte", async () => {
    await published("kp1@x.com", "alice");
    const cases: [string, string][] = [
      ["/alice/authorized_keys", fx.authorizedKeys],
      ["/alice/authorized_keys.sig", fx.authorizedKeysSig],
      ["/alice/revoked", fx.revoked],
      ["/alice/revoked.sig", fx.revokedSig],
    ];
    for (const [path, body] of cases) {
      const res = await keysGet(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
      expect(await res.text()).toBe(body);
    }
  });

  it("re-upload with a higher seq replaces the page", async () => {
    const token = await published("kp1b@x.com", "alice2");
    const res = await call("PUT", "/v1/keypage", upload({ ...fx.newer, keys: fx.keys.slice(0, 1) }), token);
    expect(res.status).toBe(204);
    expect(await (await keysGet("/alice2/authorized_keys")).text()).toBe(fx.newer.authorizedKeys);
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM keypages k JOIN users u ON u.id = k.user_id WHERE u.username = 'alice2'",
    ).first<{ n: number }>();
    expect(n!.n).toBe(1);
    const j = (await (await keysGet("/alice2/keys.json")).json()) as any;
    expect(j.keys.map((k: any) => k.name)).toEqual([pub(0)]);
  });

  it("an older or equal seq is 409 stale_keypage and changes nothing (no replay of a revoked key)", async () => {
    const token = await published("seq1@x.com", "seqy");
    for (const pair of [fx.older, { authorizedKeys: fx.authorizedKeys, authorizedKeysSig: fx.authorizedKeysSig, revoked: fx.revoked, revokedSig: fx.revokedSig }]) {
      const res = await call("PUT", "/v1/keypage", upload(pair), token);
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).error).toBe("stale_keypage");
    }
    expect(await (await keysGet("/seqy/authorized_keys")).text()).toBe(fx.authorizedKeys);
    expect(await (await keysGet("/seqy/revoked")).text()).toBe(fx.revoked);
    const acct = (await (await call("GET", "/v1/account", undefined, token)).json()) as any;
    expect(acct.keyPageSeq).toBe(fx.seq);
    expect((await call("PUT", "/v1/keypage", upload(fx.newer), token)).status).toBe(204);
    expect(((await (await call("GET", "/v1/account", undefined, token)).json()) as any).keyPageSeq).toBe(6);
  });

  it("keyPageSeq is 0 before any page", async () => {
    const token = await signerUser("seq0@x.com", "seqz");
    expect(((await (await call("GET", "/v1/account", undefined, token)).json()) as any).keyPageSeq).toBe(0);
  });

  it("both bodies need the same version header first", async () => {
    const token = await signerUser("seq2@x.com", "seqh");
    for (const over of [
      { revoked: fx.newer.revoked, revokedSig: fx.newer.revokedSig }, // seq 5 vs 6
      { authorizedKeys: keyLines(fx.authorizedKeys).join("\n") + "\n" }, // no header
      { authorizedKeys: "# tessh-keys seq=0 updated=2026-11-15T10:20:30.123Z\n" }, // seq must be > 0
      { authorizedKeys: "# tessh-keys seq=5 updated=yesterday\n" },
      { authorizedKeys: keyLines(fx.authorizedKeys)[0] + "\n" + fx.authorizedKeys }, // header not first
    ]) {
      const res = await call("PUT", "/v1/keypage", upload(over), token);
      expect(res.status, JSON.stringify(over).slice(0, 80)).toBe(400);
      expect(((await res.json()) as any).error).toBe("invalid_request");
    }
  });

  it("upload signed by another key is 400 bad_signature", async () => {
    const token = await signerUser("kp2@x.com", "bob");
    for (const over of [
      { authorizedKeysSig: fx.badAuthorizedKeysSig },
      { revokedSig: fx.authorizedKeysSig }, // right key, wrong body
      { authorizedKeys: fx.authorizedKeys + keyLines(fx.revoked)[0] + "\n" }, // body tampered after signing
      { authorizedKeysSig: "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n" },
      { authorizedKeysSig: "not a signature" },
    ]) {
      const res = await call("PUT", "/v1/keypage", upload(over), token);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toBe("bad_signature");
    }
    expect((await keysGet("/bob")).status).toBe(404);
  });

  it("a user registered with a different signer cannot publish the fixture", async () => {
    const res0 = await call(
      "POST",
      "/v1/register",
      registerBody("kp2b@x.com", { signerPublicKey: fx.otherSignerPublicKey }),
    );
    const { token } = (await res0.json()) as { token: string };
    await call("PUT", "/v1/account/username", { username: "mallory" }, token);
    const res = await call("PUT", "/v1/keypage", upload(), token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("bad_signature");
  });

  it("upload without username is 400", async () => {
    const token = await signerUser("kp3@x.com", null);
    const res = await call("PUT", "/v1/keypage", upload(), token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_request");
  });

  it("needs auth and validates the body", async () => {
    expect((await call("PUT", "/v1/keypage", upload())).status).toBe(401);
    const token = await signerUser("kp4@x.com", "carol");
    for (const over of [
      { authorizedKeys: 5 },
      { authorizedKeys: "ssh-ed25519 AAAA\n" }, // no name
      { authorizedKeys: "ssh-ed25519 AAAA name" }, // no trailing newline
      { revoked: "x".repeat(65537) },
      { keys: "nope" },
      { keys: Array.from({ length: 101 }, () => fx.keys[0]) },
      { keys: [{ ...fx.keys[0], name: 5 }] },
      { keys: [{ ...fx.keys[0], kind: "touch" }] },
      { keys: [{ ...fx.keys[0], kind: 5 }] },
    ]) {
      const res = await call("PUT", "/v1/keypage", upload(over), token);
      expect(res.status, JSON.stringify(over).slice(0, 80)).toBe(400);
      expect(((await res.json()) as any).error).toBe("invalid_request");
    }
  });
});

describe("keys host", () => {
  it("keys host: plain list for curl, HTML for browsers (Vary: Accept)", async () => {
    await published("kh1@x.com", "dave");
    const plain = await keysGet("/dave", { headers: { accept: "*/*" } });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(plain.headers.get("vary")).toBe("Accept");
    expect(await plain.text()).toBe(fx.authorizedKeys);

    const html = await keysGet("/dave/", { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("vary")).toBe("Accept");
    expect(html.headers.get("cache-control")).toBe("public, max-age=60");
    expect(html.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html.headers.get("referrer-policy")).toBe("no-referrer");
    const page = await html.text();
    expect(page).toContain("@dave");
    expect(page).toContain("curl -fsSL https://keys.test/dave/install.sh | sh");
    expect(page).toContain("trust on first use");
    expect(page).toContain("~/.ssh/tessh-update-dave.sh");
    expect(page).toContain(fx.keys[0].fingerprint);
    // An old signed page still carries labels and device names: none of them is shown.
    for (const name of ["Alice", "MacBook", ">iPhone<", "Old-Mac"]) expect(page).not.toContain(name);
    expect(page).toContain(`data-copy="${neutral(keyLines(fx.authorizedKeys)[0], fx.keys[0].fingerprint)}"`);
    expect(page).toContain('href="/dave/authorized_keys.sig"');
    expect(page).toContain('href="/dave/revoked"');
    expect(page).toContain("Tessh ASCII field");
    expect(page).toContain("curl -fsSL https://keys.test/dave &#62;&#62; ~/.ssh/authorized_keys");
    expect(page).toContain("Signed on dave's devices.");
    expect(page).toContain("The server can't add keys.");
    expect(page).toContain("How does revoking a key work?");
    expect(page).toContain("-I dave@keys.test");
    expect(page).toContain('<span class="kname">Synced key</span><span class="kind">Ed25519</span>');
    expect(page).toContain("1 revoked key.");
    expect(page).toContain('href="https://tessh.dev"');
    expect(page).not.toMatch(/(src|href)="(https?:)?\/\/(?!tessh\.dev)/);
  });

  it("404: plain text for curl, a designed page for browsers", async () => {
    await signerUser("kh404@x.com", "nopage");
    for (const p of ["/nobody", "/nopage"]) {
      const plain = await keysGet(p, { headers: { accept: "*/*" } });
      expect(plain.status, p).toBe(404);
      expect(plain.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(plain.headers.get("vary")).toBe("Accept");
      expect(await plain.text()).toBe("Not found\n");

      const html = await keysGet(p, { headers: { accept: "text/html" } });
      expect(html.status, p).toBe(404);
      expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(html.headers.get("vary")).toBe("Accept");
      expect(html.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(html.headers.get("access-control-allow-origin")).toBe("*");
      expect(await html.text()).toContain(`No key page for <b>@${p.slice(1)}</b>`);
    }
    const other = await (await keysGet("/Not_A_Name", { headers: { accept: "text/html" } })).text();
    expect(other).toContain("Nothing here");
    const file = await keysGet("/nobody/keys.json", { headers: { accept: "text/html" } });
    expect(file.status).toBe(404);
    expect(await file.text()).toContain("Nothing here");
    const head = await keysGet("/nobody", { method: "HEAD", headers: { accept: "text/html" } });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  });

  it("HEAD has headers and no body", async () => {
    await published("kh1b@x.com", "dave2");
    const res = await keysGet("/dave2/authorized_keys", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("allowed_signers line format", async () => {
    await published("kh2@x.com", "erin");
    const res = await keysGet("/erin/allowed_signers");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`erin@keys.test namespaces="tessh-keys" ${fx.signerPublicKey}\n`);
  });

  it("keys.json schema", async () => {
    await published("kh3@x.com", "frank");
    const row = await env.DB.prepare(
      "SELECT k.updated_at FROM keypages k JOIN users u ON u.id = k.user_id WHERE u.username = 'frank'",
    ).first<{ updated_at: string }>();
    const res = await keysGet("/frank/keys.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const base = "https://keys.test/frank";
    expect(await res.json()).toEqual({
      username: "frank",
      updated: row!.updated_at,
      keys: fx.keys.map((k) => ({
        name: publicName(k.fingerprint),
        type: k.type,
        kind: "synced",
        fingerprint: k.fingerprint,
        addedAt: k.addedAt,
        url: `${base}/${publicName(k.fingerprint)}`,
      })),
      revoked: [
        {
          name: expect.stringMatching(/^tessh-[A-Za-z0-9_-]{8}$/),
          type: "ssh-ed25519",
          fingerprint: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]{43}$/),
          key: expect.stringMatching(/^ssh-ed25519 [A-Za-z0-9+/=]+ tessh-[A-Za-z0-9_-]{8}$/),
        },
      ],
      signature: {
        format: "ssh-keygen -Y sign",
        namespace: "tessh-keys",
        signer: fx.signerPublicKey,
        authorized_keys: `${base}/authorized_keys.sig`,
        revoked: `${base}/revoked.sig`,
        allowed_signers: `${base}/allowed_signers`,
      },
      install: `curl -fsSL ${base}/install.sh | sh`,
    });
  });

  it("revoked fingerprint is SHA256 of the key blob", async () => {
    await published("kh3b@x.com", "frank2");
    const j = (await (await keysGet("/frank2/keys.json")).json()) as any;
    const blob = Uint8Array.from(atob(keyLines(fx.revoked)[0].split(" ")[1]), (c) => c.charCodeAt(0));
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", blob));
    expect(j.revoked[0].fingerprint).toBe("SHA256:" + btoa(String.fromCharCode(...d)).replace(/=+$/, ""));
  });

  it("per-key /<u>/<name> and unknown user 404", async () => {
    await published("kh4@x.com", "gina");
    const line = neutral(keyLines(fx.authorizedKeys)[0], fx.keys[0].fingerprint) + "\n";
    // By its public name, or by the name an old page signed; always served with the neutral comment.
    for (const p of [`/gina/${pub(0)}`, `/gina/${pub(0)}.pub`, "/gina/MacBook-Air", "/gina/MacBook-Air.pub"]) {
      const res = await keysGet(p);
      expect(res.status, p).toBe(200);
      expect(await res.text()).toBe(line);
    }
    for (const p of [
      "/gina/macbook-air",
      "/gina/Old-Mac",
      "/gina/nope",
      "/gina/a/b",
      "/nobody",
      "/nobody/authorized_keys",
      "/Gina",
    ]) {
      expect((await keysGet(p)).status, p).toBe(404);
    }
    // A username with no uploaded page is 404 everywhere.
    await signerUser("kh4b@x.com", "henry");
    for (const p of ["/henry", "/henry/authorized_keys", "/henry/allowed_signers", "/henry/keys.json", "/henry/install.sh"])
      expect((await keysGet(p)).status, p).toBe(404);
  });

  it("install.sh has the username and signer baked in", async () => {
    await published("kh5@x.com", "ivy");
    const res = await keysGet("/ivy/install.sh");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    const sh = await res.text();
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain("ORIGIN='https://keys.test/ivy'");
    expect(sh).toContain("IDENTITY='ivy@keys.test'");
    expect(sh).toContain("NAMESPACE='tessh-keys'");
    expect(sh).toContain(`'${fx.signerPublicKey}'`);
    expect(sh).toContain("tessh-signer-ivy");
    expect(sh).toContain("tessh-update-$TESSH_USER.sh");
    expect(sh).toContain("tessh-seq-$TESSH_USER");
    expect(sh).toContain("Trust on first use");
    expect(sh).toContain("TESSH_SIGNER");
    expect(sh).not.toContain("EXPECTED");
  });

  it("methods other than GET/HEAD are 405", async () => {
    await published("kh6@x.com", "jack");
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await keysGet("/jack/authorized_keys", { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
  });
});

describe("keys host hardening", () => {
  it("keys host GET responses allow any origin", async () => {
    await published("cors1@x.com", "corsy");
    for (const path of ["/corsy", "/corsy/keys.json", "/corsy/authorized_keys", "/corsy/nope", "/nobody", "/nobody/keys.json", "/"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await keysGet(path, { method, headers: { origin: "https://elsewhere.test" } });
        expect(res.headers.get("access-control-allow-origin"), `${method} ${path}`).toBe("*");
        expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      }
    }
    const post = await keysGet("/corsy", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("access-control-allow-origin")).toBe("*");
    const opt = await keysGet("/corsy/keys.json", { method: "OPTIONS" });
    expect(opt.status).toBe(204);
    expect(opt.headers.get("access-control-allow-origin")).toBe("*");
    expect(opt.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
    expect(opt.headers.get("access-control-max-age")).toBe("600");
  });

  it("keys.json fingerprints come from the signed lines", async () => {
    const token = await signerUser("fp1@x.com", "fpuser");
    const keys = [
      { ...fx.keys[0], fingerprint: "SHA256:wrong" },
      { ...fx.keys[1], name: "ghost", fingerprint: "SHA256:ghost" },
    ];
    expect((await call("PUT", "/v1/keypage", upload({ keys }), token)).status).toBe(204);
    const j = (await (await keysGet("/fpuser/keys.json")).json()) as any;
    expect(j.keys).toHaveLength(1);
    expect(j.keys[0].name).toBe(pub(0));
    expect(j.keys[0].fingerprint).toBe(fx.keys[0].fingerprint);
    const html = await (await keysGet("/fpuser", { headers: { accept: "text/html" } })).text();
    expect(html).toContain(fx.keys[0].fingerprint);
    expect(html).not.toContain("SHA256:wrong");
    expect(html).not.toContain("ghost");
  });

  it("never stores or serves device names or labels; passes kind through", async () => {
    const token = await signerUser("priv1@x.com", "privy");
    const keys = [{ ...fx.keys[0], kind: "standard" }, { ...fx.keys[1], label: "Alice's iPhone", device: "Alice's iPhone" }];
    expect((await call("PUT", "/v1/keypage", upload({ keys }), token)).status).toBe(204);
    const row = await env.DB.prepare(
      "SELECT k.keys_json FROM keypages k JOIN users u ON u.id = k.user_id WHERE u.username = 'privy'",
    ).first<{ keys_json: string }>();
    // `name` is the comment the old app signed, kept only to match entries to signed lines: never served.
    expect(row!.keys_json).not.toMatch(/label|device|Alice/);
    const text = await (await keysGet("/privy/keys.json")).text();
    expect(text).not.toMatch(/"label"|"device"|Alice|MacBook|Old-Mac/);
    const j = JSON.parse(text);
    // An Ed25519 key can't be a Device key whatever `kind` says (kind isn't signed).
    expect(j.keys.map((k: any) => k.kind)).toEqual(["standard", "synced"]);
    const html = await (await keysGet("/privy", { headers: { accept: "text/html" } })).text();
    expect(html).toContain('<span class="kname">Standard key</span>');
    expect(html).not.toMatch(/Alice|MacBook-Air/);
  });

  it("keys[].name must match [A-Za-z0-9._@-]+", async () => {
    const token = await signerUser("nm1@x.com", "nmuser");
    for (const name of ["a b", "x/y", "<b>", "é", "a\nb"]) {
      const res = await call("PUT", "/v1/keypage", upload({ keys: [{ ...fx.keys[0], name }] }), token);
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as any).error).toBe("invalid_request");
    }
  });
});
