// Runs install.sh for real (sh, curl over file://, ssh-keygen) in plain Node, against the signed fixture
// pages: seq 5 is the current page, seq 4 an older pair with Old-Mac still live, seq 6 a newer one.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderInstall } from "../src/install.ts";
import { NAMESPACE } from "../src/keypage.ts";
import fx from "./fixtures/keypage.json" with { type: "json" };

const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const runnable = has("curl") && has("ssh-keygen") && process.platform !== "win32";

interface Pair {
  authorizedKeys: string;
  authorizedKeysSig: string;
  revoked: string;
  revokedSig: string;
}

function rig() {
  const root = mkdtempSync(join(tmpdir(), "tessh-install-"));
  const home = join(root, "home");
  const pages = join(root, "pages", "alice");
  mkdirSync(home, { recursive: true });
  mkdirSync(pages, { recursive: true });
  const serve = (p: Pair) => {
    writeFileSync(join(pages, "authorized_keys"), p.authorizedKeys);
    writeFileSync(join(pages, "authorized_keys.sig"), p.authorizedKeysSig);
    writeFileSync(join(pages, "revoked"), p.revoked);
    writeFileSync(join(pages, "revoked.sig"), p.revokedSig);
  };
  const script = (signer = fx.signerPublicKey) =>
    renderInstall({ username: "alice", signer }, "https://keys.test").replace(
      "ORIGIN='https://keys.test/alice'",
      `ORIGIN='file://${pages}'`,
    );
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home };
  /** `curl … | sh -s -- args`: the script arrives on stdin. */
  const pipe = (args: string[] = [], signer?: string) =>
    spawnSync("sh", ["-s", "--", ...args], { input: script(signer), env, encoding: "utf8" });
  const updater = join(home, ".ssh", "tessh-update-alice.sh");
  const runUpdater = (args: string[] = []) => spawnSync("sh", [updater, ...args], { env, encoding: "utf8" });
  const ak = join(home, ".ssh", "authorized_keys");
  const keys = () => (existsSync(ak) ? readFileSync(ak, "utf8") : "");
  /** Like pipe, but `before(pid)` runs once sh has started and before it reads the script. */
  const pipeWithPid = (args: string[], before: (pid: number) => void) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn("sh", ["-s", "--", ...args], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => done({ status, stdout, stderr }));
      before(child.pid!);
      child.stdin.end(script());
    });
  return { root, home, serve, pipe, pipeWithPid, runUpdater, updater, ak, keys };
}

const base: Pair = fx;

describe.skipIf(!runnable)("install.sh", () => {
  it("first run installs the signed keys, pins the signer, records the seq and writes the updater", () => {
    const r = rig();
    r.serve(base);
    const out = r.pipe();
    expect(out.status, out.stderr).toBe(0);
    const k = r.keys();
    expect(k).toContain(" MacBook-Air\n");
    expect(k).toContain(" iPhone\n");
    expect(k).not.toContain("Old-Mac");
    expect(k).not.toContain("#"); // the version header is never copied
    expect(statSync(r.ak).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(r.home, ".ssh", "tessh-signer-alice"), "utf8")).toBe(fx.signerPublicKey + "\n");
    expect(readFileSync(join(r.home, ".ssh", "tessh-seq-alice"), "utf8")).toBe("5\n");
    expect(out.stdout).toContain(`sh ${r.updater}`);
    expect(out.stdout).toContain("crontab");
    const upd = readFileSync(r.updater, "utf8");
    expect(upd).toContain(`BAKED_SIGNER='${fx.signerPublicKey}'`);
    expect(statSync(r.updater).mode & 0o700).toBe(0o700);

    // Run again: up to date, nothing rewritten.
    const again = r.pipe();
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("Up to date: all 2 keys");
  });

  it("refuses an older signed list (a replay that would un-revoke Old-Mac)", () => {
    const r = rig();
    r.serve(base);
    expect(r.pipe().status).toBe(0);
    const before = r.keys();
    r.serve(fx.older);
    for (const res of [r.pipe(), r.runUpdater()]) {
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("older than the ones last installed here (version 5)");
    }
    expect(r.keys()).toBe(before);
    expect(r.keys()).not.toContain("Old-Mac");
  });

  it("the updater keeps the pinned signer and applies newer lists", () => {
    const r = rig();
    r.serve(base);
    expect(r.pipe().status).toBe(0);
    r.serve(fx.newer);
    const res = r.runUpdater();
    expect(res.status, res.stderr).toBe(0);
    expect(r.keys()).toContain(" MacBook-Air\n");
    expect(r.keys()).not.toContain("iPhone");
    expect(readFileSync(join(r.home, ".ssh", "tessh-seq-alice"), "utf8")).toBe("6\n");

    // A download serving another signer is refused against the pin; the updater never looks at it.
    const swapped = r.pipe([], fx.otherSignerPublicKey);
    expect(swapped.status).toBe(1);
    expect(swapped.stderr).toContain("changed since it was pinned");
    expect(r.runUpdater().status).toBe(0);
  });

  it("replaces the file atomically, keeps other lines and a backup", () => {
    const r = rig();
    r.serve(base);
    mkdirSync(join(r.home, ".ssh"), { recursive: true, mode: 0o700 });
    writeFileSync(r.ak, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther other@box\n", { mode: 0o644 });
    const res = r.pipe();
    expect(res.status, res.stderr).toBe(0);
    expect(r.keys().startsWith("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther other@box\n")).toBe(true);
    expect(statSync(r.ak).mode & 0o777).toBe(0o600);
    const files = readdirSync(join(r.home, ".ssh"));
    expect(files.some((f) => f.startsWith("authorized_keys.bak."))).toBe(true);
    expect(files.some((f) => f.startsWith(".tessh-authorized_keys."))).toBe(false);
    expect(res.stdout).toContain("Backup:");
  });

  it("dry run changes nothing", () => {
    const r = rig();
    r.serve(base);
    const res = r.pipe(["--dry-run"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("Dry run: would add 2 and remove 0");
    expect(existsSync(join(r.home, ".ssh"))).toBe(false);
  });

  it("refuses lists without a matching version header", () => {
    const r = rig();
    r.serve({ ...base, revoked: fx.newer.revoked, revokedSig: fx.newer.revokedSig });
    const res = r.pipe();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no matching version header");
  });

  it("at the installed version, accepts only the same lists (a second pair signed with one seq can't un-revoke)", () => {
    const r = rig();
    // A throwaway signer, so the test can sign two different pairs that carry the same seq.
    const dir = mkdtempSync(join(tmpdir(), "tessh-signer-"));
    const key = join(dir, "id");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", key]);
    const signer = readFileSync(`${key}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
    let n = 0;
    const sign = (text: string) => {
      const f = join(dir, `msg${n++}`);
      writeFileSync(f, text);
      execFileSync("ssh-keygen", ["-q", "-Y", "sign", "-f", key, "-n", NAMESPACE, f]);
      return readFileSync(`${f}.sig`, "utf8");
    };
    const [mac, phone, old] = fx.authorizedKeys.split("\n").slice(1, 3).concat(fx.revoked.split("\n")[1]);
    const pair = (seq: number, live: string[], revoked: string[]): Pair => {
      const head = `# tessh-keys seq=${seq} updated=2025-11-15T09:4${seq}:40.000Z\n`;
      const authorizedKeys = head + live.map((l) => l + "\n").join("");
      const revokedText = head + revoked.map((l) => l + "\n").join("");
      return { authorizedKeys, authorizedKeysSig: sign(authorizedKeys), revoked: revokedText, revokedSig: sign(revokedText) };
    };
    r.serve(pair(6, [mac, phone, old], []));
    const first = r.pipe([], signer);
    expect(first.status, first.stderr).toBe(0);
    const a = pair(7, [mac, phone], [old]);
    r.serve(a);
    expect(r.runUpdater().status).toBe(0);
    expect(r.keys()).not.toContain("Old-Mac");
    const seqf = join(r.home, ".ssh", "tessh-seq-alice");
    expect(readFileSync(seqf, "utf8")).toBe("7\n");

    // Pair B: also seq 7, signed by the same key, but with Old-Mac live again.
    r.serve(pair(7, [mac, phone, old], []));
    const b = r.runUpdater();
    expect(b.status).toBe(1);
    expect(b.stderr).toContain("differ from the version 7 lists installed here");
    expect(r.keys()).not.toContain("Old-Mac");

    // The very same pair A again is fine.
    r.serve(a);
    const again = r.runUpdater();
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("Up to date");

    // A damaged seq file stops the update instead of reading as 0.
    writeFileSync(seqf, "garbage\n");
    const damaged = r.runUpdater();
    expect(damaged.status).toBe(1);
    expect(damaged.stderr).toContain("is damaged");
  });

  it("--file into a directory someone else controls: never writes through planted links", async () => {
    const r = rig();
    r.serve(base);
    const dir = join(r.root, "deploy-ssh");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "authorized_keys");
    writeFileSync(target, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther other@box\n");
    const victims: string[] = [];
    const plant = (at: string) => {
      const v = join(r.root, `victim${victims.length}`);
      writeFileSync(v, "untouched\n");
      symlinkSync(v, at);
      victims.push(v);
    };
    // The old backup name (one per second around now) and the old temp name (the shell's pid).
    const stamp = (d: Date) =>
      [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
    for (let i = 0; i < 5; i++) plant(`${target}.bak.${stamp(new Date(Date.now() + i * 1000))}`);
    const res = await r.pipeWithPid(["--file", target], (pid) => plant(join(dir, `.tessh-authorized_keys.${pid}`)));
    expect(res.status, res.stderr).toBe(0);
    for (const v of victims) expect(readFileSync(v, "utf8")).toBe("untouched\n");
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toContain(" MacBook-Air\n");

    // A target that is a link, or sits in a linked directory, is refused before anything is written.
    const linked = join(r.root, "linked-ak");
    plant(linked);
    const refused = r.pipe(["--file", linked]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("is a symbolic link");
    const linkedDir = join(r.root, "linked-dir");
    symlinkSync(dir, linkedDir);
    const refusedDir = r.pipe(["--file", join(linkedDir, "authorized_keys")]);
    expect(refusedDir.status).toBe(1);
    expect(refusedDir.stderr).toContain("is a symbolic link");
    for (const v of victims) expect(readFileSync(v, "utf8")).toBe("untouched\n");
  });

  it("the script parses under sh -n", () => {
    const sh = renderInstall({ username: "alice", signer: fx.signerPublicKey }, "https://keys.test");
    expect(() => execFileSync("sh", ["-n"], { input: sh })).not.toThrow();
  });
});
