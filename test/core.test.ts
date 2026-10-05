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

describe("multi-region", () => {
  const srv = { id: "11111111-2222-3333-4444-555555555555", name: "web", status: "ACTIVE", flavor: { id: "f1" }, addresses: {}, metadata: {} };
  const handler = (c: { url: string }) => {
    if (c.url.includes("/flavors/")) return { body: { flavor: { id: "f1", name: "SL1", vcpus: 1, ram: 1024 } } };
    if (c.url.includes("/servers/detail")) {
      return { body: { servers: c.url.startsWith("https://compute.ru-1.") ? [srv] : [] } };
    }
    if (c.url.includes("/os-volume_attachments") || c.url.includes("/os-interface")) return { body: {} };
    return undefined;
  };

  it("without SELECTEL_REGION, server_get finds the server in any region", async () => {
    const { call } = await connect(testConfig({ defaultRegion: undefined }), fakeFetch(handler).impl);
    const r = await call("server_get", { server: "web" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("ru-1");
  });

  it("without SELECTEL_REGION, servers_list scans all regions", async () => {
    const f = fakeFetch(handler);
    const { call } = await connect(testConfig({ defaultRegion: undefined }), f.impl);
    const r = await call("servers_list");
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("web");
    expect(f.calls.some((c) => c.url.startsWith("https://compute.ru-9."))).toBe(true);
  });
});

describe("auth by user id", () => {
  it("UID in SELECTEL_USERNAME is sent as user.id", async () => {
    const uid = "a".repeat(32);
    let authBody: any;
    const base = fakeFetch(() => ({ body: { projects: [] } }));
    const spy = (async (input: any, init?: RequestInit) => {
      if (String(input).endsWith("/auth/tokens")) authBody = JSON.parse(String(init?.body));
      return base.impl(input, init);
    }) as typeof fetch;
    const { call } = await connect(testConfig({}, { SELECTEL_USERNAME: uid }), spy);
    await call("projects_list");
    expect(authBody.auth.identity.password.user).toEqual({ id: uid, password: "secret-password" });
  });
});

describe("status", () => {
  it("reports the connected client and confirmation method", async () => {
    const { call } = await connect(testConfig({ confirm: "auto" }), fakeFetch(() => undefined).impl);
    const r = await call("selectel_status");
    expect(r.text).toContain('"name": "test"');
    expect(r.text).toContain("chat (plan + confirm_token)");
  });
});
