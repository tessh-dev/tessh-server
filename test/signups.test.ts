import { describe, expect, it } from "vitest";
import { ADMIN, basic, makeEnv } from "./harness.ts";
import { handle, type Env } from "../src/index.ts";
import { handleAdmin } from "../src/admin.ts";
import { registerBody } from "./helpers.ts";
import type { Signups } from "../src/config.ts";

function server(signups: Signups) {
  const env = makeEnv({ SIGNUPS: signups });
  const register = (email: string) =>
    handle(
      new Request("https://keys.test/v1/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registerBody(email)),
      }),
      env,
    );
  const admin = (method: string, path: string, body?: unknown) =>
    handleAdmin(
      new Request(`https://admin.test${path}`, {
        method,
        headers: { authorization: basic(), "x-tessh-admin": "1", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
  return { env, register, admin };
}

const err = async (r: Response) => ((await r.json()) as { error: string }).error;

describe("sign-ups", () => {
  it("open: anyone can register", async () => {
    const s = server("open");
    expect((await s.register("anyone@example.com")).status).toBe(201);
  });

  it("closed: every new account is refused, invited or not", async () => {
    const s = server("closed");
    await s.admin("POST", "/api/invites", { email: "alice@example.com" });
    for (const email of ["alice@example.com", "bob@example.com"]) {
      const r = await s.register(email);
      expect(r.status).toBe(403);
      expect(await err(r)).toBe("signups_closed");
    }
    expect(await s.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).toEqual({ n: 0 });
  });

  it("invite: only invited emails, matched case-insensitively", async () => {
    const s = server("invite");
    const refused = await s.register("bob@example.com");
    expect(refused.status).toBe(403);
    expect(await err(refused)).toBe("invite_required");

    const add = await s.admin("POST", "/api/invites", { email: " Alice@Example.com " });
    expect(add.status).toBe(201);
    expect((await s.register("ALICE@example.com")).status).toBe(201);
    expect((await s.register("bob@example.com")).status).toBe(403);
  });

  it("a malformed body is still a 400 before the sign-up check", async () => {
    const s = server("closed");
    const r = await handle(
      new Request("https://keys.test/v1/register", { method: "POST", body: JSON.stringify({ email: "x@example.com" }) }),
      s.env,
    );
    expect(r.status).toBe(400);
  });

  it("/v1/server reports the mode", async () => {
    for (const mode of ["open", "invite", "closed"] as const) {
      const s = server(mode);
      const r = await handle(new Request("https://keys.test/v1/server"), s.env);
      expect(((await r.json()) as Env & { signups: string }).signups).toBe(mode);
    }
  });
});

describe("invites admin", () => {
  it("add, list, show who joined, remove; every write is audited", async () => {
    const s = server("invite");
    expect((await s.admin("POST", "/api/invites", { email: "carol@example.com" })).status).toBe(201);
    expect((await s.admin("POST", "/api/invites", { email: "carol@example.com" })).status).toBe(200);
    expect((await s.admin("POST", "/api/invites", { email: "dave@example.com" })).status).toBe(201);
    expect((await s.admin("POST", "/api/invites", { email: "not an email" })).status).toBe(400);
    await s.register("carol@example.com");

    const list = (await (await s.admin("GET", "/api/invites")).json()) as { signups: string; invites: any[] };
    expect(list.signups).toBe("invite");
    const byEmail = Object.fromEntries(list.invites.map((i) => [i.email, i]));
    expect(byEmail["carol@example.com"].userId).toBeTruthy();
    expect(byEmail["dave@example.com"].userId).toBeNull();
    expect(byEmail["dave@example.com"].createdBy).toBe("ops");

    const page = await (await s.admin("GET", "/invites")).text();
    expect(page).toContain("carol@example.com");
    expect(page).toContain("Not joined yet");

    expect((await s.admin("DELETE", "/api/invites", { email: "dave@example.com" })).status).toBe(200);
    expect((await s.admin("DELETE", "/api/invites", { email: "dave@example.com" })).status).toBe(404);
    expect((await s.register("dave@example.com")).status).toBe(403);

    const { results } = await s.env.DB.prepare("SELECT action, admin_email, detail FROM admin_audit ORDER BY id").all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual(["add_invite", "add_invite", "remove_invite"]);
  });

  it("invite writes need the admin password", async () => {
    const r = await ADMIN.fetch("https://admin.test/api/invites", {
      method: "POST",
      headers: { "x-tessh-admin": "1", "content-type": "application/json" },
      body: JSON.stringify({ email: "eve@example.com" }),
    });
    expect(r.status).toBe(401);
  });
});
