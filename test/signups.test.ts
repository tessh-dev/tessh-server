import { describe, expect, it } from "vitest";
import { basic, makeEnv } from "./harness.ts";
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

  it("closed: every new account is refused, even with a live invite code", async () => {
    const s = server("closed");
    await s.env.DB.prepare("INSERT INTO invites (code, label, kind, created_at) VALUES ('abc', 'Alice', 'member', ?)").bind(new Date().toISOString()).run();
    for (const email of ["alice@example.com", "bob@example.com"]) {
      const r = await s.register(email);
      expect(r.status).toBe(403);
      expect(await err(r)).toBe("signups_closed");
    }
    expect(await s.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).toEqual({ n: 0 });
  });

  it("invite: a new account without an invite code is refused", async () => {
    const s = server("invite");
    const refused = await s.register("bob@example.com");
    expect(refused.status).toBe(403);
    expect(await err(refused)).toBe("invite_required");
    expect(await s.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).toEqual({ n: 0 });
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
