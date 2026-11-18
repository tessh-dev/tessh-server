import { beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/http.ts";
import { handle } from "../src/index.ts";
import { checkSetupCode, issueSetupCode, resetSetupAttempts, setupLogLines, trackedAttempts } from "../src/setup-code.ts";
import { makeEnv } from "./harness.ts";

const DAY = 24 * 60 * 60 * 1000;
const unsetEnv = () => makeEnv({ SETTINGS: { ...makeEnv().SETTINGS, setupDone: false } });
const failure = (fn: () => void): HttpError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected an HttpError");
};

describe("setup code", () => {
  beforeEach(() => resetSetupAttempts());

  it("is shown as XXXX-XXXX from the safe alphabet", () => {
    expect(issueSetupCode(unsetEnv())).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it("accepts lowercase, spaces and no dash", () => {
    const env = unsetEnv();
    const code = issueSetupCode(env);
    expect(() => checkSetupCode(env, code, "1.1.1.1")).not.toThrow();
    expect(() => checkSetupCode(env, code.toLowerCase().replace("-", ""), "1.1.1.1")).not.toThrow();
    expect(() => checkSetupCode(env, ` ${code.toLowerCase().replace("-", " ")} `, "1.1.1.1")).not.toThrow();
  });

  it("stores only a hash", () => {
    const env = unsetEnv();
    const code = issueSetupCode(env);
    expect(JSON.stringify(env.SETUP)).not.toContain(code.replace("-", ""));
  });

  it("rejects a wrong code with setup_code_wrong", () => {
    const env = unsetEnv();
    issueSetupCode(env);
    const e = failure(() => checkSetupCode(env, "AAAA-AAAA", "1.1.1.1"));
    expect([e.status, e.code]).toEqual([401, "setup_code_wrong"]);
  });

  it("locks an IP out after 5 wrong tries, not other IPs", () => {
    const env = unsetEnv();
    const code = issueSetupCode(env);
    for (let i = 0; i < 5; i++) expect(failure(() => checkSetupCode(env, "AAAA-AAAA", "1.1.1.1")).status).toBe(401);
    const e = failure(() => checkSetupCode(env, "AAAA-AAAA", "1.1.1.1"));
    expect([e.status, e.code]).toEqual([429, "too_many_attempts"]);
    expect(failure(() => checkSetupCode(env, code, "1.1.1.1")).status).toBe(429);
    expect(failure(() => checkSetupCode(env, "AAAA-AAAA", "2.2.2.2")).status).toBe(401);
    expect(() => checkSetupCode(env, code, "2.2.2.2")).not.toThrow();
  });

  it("locks everyone out after 50 wrong tries across IPs", () => {
    const env = unsetEnv();
    const code = issueSetupCode(env, 0);
    for (let i = 0; i < 50; i++) expect(failure(() => checkSetupCode(env, "AAAA-AAAA", `10.0.${i}.1`, 1000)).status).toBe(401);
    const e = failure(() => checkSetupCode(env, "AAAA-AAAA", "9.9.9.9", 1000));
    expect([e.status, e.code]).toEqual([429, "too_many_attempts"]);
    expect(failure(() => checkSetupCode(env, code, "8.8.8.8", 1000)).status).toBe(429);
    expect(() => checkSetupCode(env, code, "8.8.8.8", 1000 + 15 * 60 * 1000 + 1)).not.toThrow();
  });

  it("prunes expired entries and stays bounded", () => {
    const env = unsetEnv();
    issueSetupCode(env, 0);
    for (let i = 0; i < 4; i++) failure(() => checkSetupCode(env, "AAAA-AAAA", `ip-${i}`, 0));
    expect(trackedAttempts()).toBe(4);
    failure(() => checkSetupCode(env, "AAAA-AAAA", "later", 15 * 60 * 1000 + 1));
    expect(trackedAttempts()).toBe(1);
  });

  it("lets an IP try again after 15 minutes", () => {
    const env = unsetEnv();
    const code = issueSetupCode(env, 0);
    for (let i = 0; i < 5; i++) failure(() => checkSetupCode(env, "AAAA-AAAA", "1.1.1.1", 1000));
    expect(failure(() => checkSetupCode(env, code, "1.1.1.1", 2000)).status).toBe(429);
    expect(() => checkSetupCode(env, code, "1.1.1.1", 1000 + 15 * 60 * 1000 + 1)).not.toThrow();
  });

  it("expires after 24 hours", () => {
    const env = unsetEnv();
    const code = issueSetupCode(env, 0);
    expect(() => checkSetupCode(env, code, "1.1.1.1", DAY - 1)).not.toThrow();
    const e = failure(() => checkSetupCode(env, code, "1.1.1.1", DAY + 1));
    expect([e.status, e.code]).toEqual([401, "setup_code_wrong"]);
    expect(e.message).toBe("That code has expired. Restart the server for a new one.");
  });

  it("refuses when no code was issued", () => {
    expect(failure(() => checkSetupCode(unsetEnv(), "AAAA-AAAA", "1.1.1.1")).code).toBe("setup_code_wrong");
  });

  it("logs the lines the owner needs", () => {
    expect(setupLogLines("ABCD-2345")).toEqual([
      "Not set up yet. Open this to finish setup (works for 24 hours):",
      "  http://<this machine>:8080/setup    or https://your.domain/setup",
      "  Setup code  ABCD-2345",
    ]);
  });
});

describe("not-set-up gate", () => {
  const get = (env: ReturnType<typeof unsetEnv>, path: string, headers: Record<string, string> = {}) =>
    handle(new Request(`https://keys.test${path}`, { headers }), env);

  it("answers /v1/sync with 503 not_set_up", async () => {
    const res = await get(unsetEnv(), "/v1/sync");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "not_set_up", message: "This server isn't set up yet" });
  });

  it("redirects HTML pages to /setup", async () => {
    const res = await get(unsetEnv(), "/bobby", { accept: "text/html" });
    expect([res.status, res.headers.get("location")]).toEqual([302, "/setup"]);
  });

  it("answers anything else with 503 text", async () => {
    const res = await get(unsetEnv(), "/bobby/install.sh", { accept: "*/*" });
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("lets health, server info, /setup and /_/ through", async () => {
    const env = unsetEnv();
    expect((await get(env, "/v1/health")).status).toBe(200);
    const info = await get(env, "/v1/server");
    expect(info.status).toBe(200);
    expect((await info.json()) as { setUp: boolean }).toMatchObject({ setUp: false });
    for (const p of ["/setup", "/setup/code", "/_/app.css"]) expect((await get(env, p, { accept: "text/html" })).status).not.toBe(503);
    expect((await get(env, "/setup", { accept: "text/html" })).headers.get("location")).toBeNull();
  });

  it("is inactive once set up", async () => {
    const res = await get(makeEnv(), "/v1/sync");
    expect(res.status).not.toBe(503);
  });
});
