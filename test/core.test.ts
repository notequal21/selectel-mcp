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

describe("toolsets & prompts", () => {
  it("SELECTEL_TOOLSETS limits tools; account + overview always present", async () => {
    const { tools } = await connect(testConfig({ mode: "full", toolsets: ["dns"] }), fakeFetch(() => undefined).impl);
    expect(tools).toContain("dns_zones_list");
    expect(tools).toContain("infra_overview");
    expect(tools).not.toContain("servers_list");
  });
  it("registers prompts", async () => {
    const { client } = await connect(testConfig(), fakeFetch(() => undefined).impl);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(["new_server", "cost_audit", "dns_migrate"]));
  });
  it("every mutating tool is hidden in readonly mode", async () => {
    const { client } = await connect(testConfig({ mode: "readonly" }), fakeFetch(() => undefined).impl);
    const { tools } = await client.listTools();
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
  });
});
