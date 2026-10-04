import { describe, expect, it } from "vitest";
import { connect, fakeFetch, PROJECT_ID, testConfig } from "./helpers.js";

describe("core", () => {
  it("readonly mode exposes only read tools", async () => {
    const { tools } = await connect(testConfig({ mode: "readonly" }), fakeFetch(() => undefined).impl);
    expect(tools).toContain("selectel_status");
  });

  it("lists projects via resell API and hides disallowed ones", async () => {
    const f = fakeFetch((c) =>
      c.url.endsWith("/v2/projects")
        ? { body: { projects: [{ id: PROJECT_ID, name: "main" }, { id: "f".repeat(32), name: "other" }] } }
        : undefined,
    );
    const { call } = await connect(testConfig({ allowedProjects: ["main"] }), f.impl);
    const r = await call("projects_list");
    expect(r.text).toContain("main");
    expect(r.text).not.toContain("other");
    expect(f.calls[0]!.headers["X-Auth-Token"]).toBe("tok");
  });

  it("does not leak the password in status output", async () => {
    const { call } = await connect(testConfig(), fakeFetch(() => undefined).impl);
    const r = await call("selectel_status");
    expect(r.text).not.toContain("secret-password");
  });

  it("rejects disallowed regions", async () => {
    const { ctx } = await connect(testConfig({ allowedRegions: ["ru-9"] }), fakeFetch(() => undefined).impl);
    expect(() => ctx.resolveRegion("ru-1")).toThrow(/not in SELECTEL_ALLOWED_REGIONS/);
  });
});
