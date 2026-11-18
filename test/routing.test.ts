import { describe, expect, it } from "vitest";
import { SELF } from "./harness.ts";

describe("routing on one public URL", () => {
  it("serves health", async () => {
    const res = await SELF.fetch("https://keys.test/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves the server info for the apps' custom server check", async () => {
    const res = await SELF.fetch("https://keys.test/v1/server");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Test server", version: "0.0.0-test", signups: "open", keysURL: "https://keys.test", setUp: true, ownerPending: true, instance: "0123456789abcdef" });
  });

  it("routes by path, whatever the Host", async () => {
    for (const host of ["keys.test", "other.test", "127.0.0.1:8080"]) {
      expect((await SELF.fetch(`http://${host}/v1/health`)).status).toBe(200);
    }
  });

  it("unknown API paths are JSON 404s", async () => {
    for (const path of ["/v1", "/v1/nope", "/v1/health/extra"]) {
      const res = await SELF.fetch(`https://keys.test${path}`);
      expect(res.status, path).toBe(404);
      expect(((await res.json()) as any).error).toBe("not_found");
    }
  });

  it("the home page names the server", async () => {
    const html = await SELF.fetch("https://keys.test/", { headers: { accept: "text/html" } });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("Test server");
    const text = await SELF.fetch("https://keys.test/");
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(await text.text()).toContain("https://keys.test/<username>");
  });

  it("a key page for an unknown user is 404, as text or HTML", async () => {
    for (const path of ["/nobody", "/nobody/install.sh", "/nobody/keys.json"]) {
      expect((await SELF.fetch(`https://keys.test${path}`)).status, path).toBe(404);
    }
    const res = await SELF.fetch("https://keys.test/nobody", { headers: { accept: "text/html" } });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("No key page for <b>@nobody</b>");
  });
});
