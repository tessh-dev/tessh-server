import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { start, type App } from "../src/app.ts";
import { RESET_OWNER_MESSAGE, runCli } from "../src/cli.ts";
import { handle } from "../src/index.ts";
import { createOwner } from "../src/owner.ts";
import { Database } from "../src/db.ts";

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const dataDir = () => {
  const d = mkdtempSync(join(tmpdir(), "tessh-reset-"));
  dirs.push(d);
  return d;
};
const penv = (dir: string): NodeJS.ProcessEnv => ({ DATA_DIR: dir, PORT: "0", BIND: "127.0.0.1", UPDATE_CHECK: "false" });
const flag = (dir: string) => {
  const db = new Database(join(dir, "tessh.db"));
  try {
    return db.prepare("SELECT value FROM settings WHERE key = 'reset_owner_requested'").execSync<{ value: string }>().results[0]?.value ?? null;
  } finally {
    db.close();
  }
};

describe("reset-owner", () => {
  it("sets the flag, prints the instruction and starts no server", () => {
    const dir = dataDir();
    const lines: string[] = [];
    expect(runCli(["reset-owner"], penv(dir), (m) => lines.push(m))).toBe(0);
    expect(lines).toEqual([RESET_OWNER_MESSAGE]);
    expect(flag(dir)).toBe("1");
  });

  it("is not a command when there are no arguments, and rejects unknown ones", () => {
    expect(runCli([])).toBeNull();
    expect(runCli(["bogus"])).toBe(2);
  });

  it("on the next start issues an owner-scope code, clears the flag and keeps members syncing", async () => {
    const dir = dataDir();
    const logs: string[] = [];
    const first = await start(penv(dir), () => {});
    first.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('setup_done', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").bind().execSync();
    await createOwner(first.env, "old@example.com", "a long enough password");
    await first.close();

    runCli(["reset-owner"], penv(dir), () => {});
    expect(flag(dir)).toBe("1");

    const app = await start(penv(dir), (m) => logs.push(m));
    apps.push(app);
    expect(app.env.SETUP?.scope).toBe("owner");
    expect(app.env.SETTINGS.setupDone).toBe(true);
    expect(app.env.SETTINGS.resetOwnerRequested).toBe(false);
    expect(flag(dir)).toBe("0");
    expect(logs.join("\n")).toMatch(/Owner login reset[\s\S]*Setup code {2}[A-Z0-9]{4}-[A-Z0-9]{4}/);

    // Members keep syncing; only /setup serves the owner flow.
    const account = await handle(new Request("http://x.test/v1/account"), app.env);
    expect(account.status).toBe(401);
    const setup = await handle(new Request("http://x.test/setup", { headers: { accept: "text/html" } }), app.env);
    expect(setup.status).toBe(200);
    expect(await setup.text()).not.toContain("Your server");
  });

  it("an unfinished setup keeps its normal code and just drops the flag", async () => {
    const dir = dataDir();
    runCli(["reset-owner"], penv(dir), () => {});
    const app = await start(penv(dir), () => {});
    apps.push(app);
    expect(app.env.SETUP?.scope).toBe("full");
    expect(flag(dir)).toBe("0");
  });
});
