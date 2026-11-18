import { describe, expect, it, vi } from "vitest";
import { checkForUpdate, isNewer, scheduleUpdateChecks } from "../src/updates.ts";
import { makeEnv } from "./harness.ts";

const release = (tag: string) => async () => new Response(JSON.stringify({ tag_name: tag }));

describe("update check", () => {
  it("compares versions numerically", () => {
    expect(isNewer("1.10.0", "1.9.9")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("0.9.0", "1.0.0")).toBe(false);
    expect(isNewer("nightly", "1.0.0")).toBe(false);
  });

  it("reports a newer release, ignoring the v", async () => {
    expect(await checkForUpdate(release("v1.2.0"), "1.1.0")).toEqual({ latest: "1.2.0", newer: true });
  });

  it("reports nothing for the same or an older release", async () => {
    expect(await checkForUpdate(release("v1.1.0"), "1.1.0")).toEqual({ latest: "1.1.0", newer: false });
    expect(await checkForUpdate(release("1.0.0"), "1.1.0")).toEqual({ latest: "1.0.0", newer: false });
  });

  it("is silent on failures", async () => {
    expect(await checkForUpdate(async () => { throw new Error("offline"); }, "1.0.0")).toBeNull();
    expect(await checkForUpdate(async () => new Response("no", { status: 500 }), "1.0.0")).toBeNull();
    expect(await checkForUpdate(async () => new Response("not json"), "1.0.0")).toBeNull();
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
      const env = makeEnv({ VERSION: "1.0.0" });
      const fetchFn = vi.fn((_url: string, _init?: RequestInit) => release("v2.0.0")());
      const stop = scheduleUpdateChecks(env, fetchFn);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(fetchFn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(env.UPDATE_LATEST).toBe("2.0.0");
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      // A failed check keeps what was known; a good one that finds nothing newer clears it.
      fetchFn.mockImplementationOnce(async () => { throw new Error("offline"); });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(env.UPDATE_LATEST).toBe("2.0.0");
      env.VERSION = "2.0.0";
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(env.UPDATE_LATEST).toBeNull();
      stop();
      await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000);
      expect(fetchFn).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
