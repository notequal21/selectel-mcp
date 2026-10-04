import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { SelectelClient } from "../src/core/client.js";
import { Context } from "../src/core/context.js";
import { registerTools } from "../src/core/tool.js";
import { networkTools } from "../src/tools/network.js";
import { volumeTools } from "../src/tools/volumes.js";
import { fakeFetch, testConfig, type Handler } from "./helpers.js";

const SID = "11111111-1111-1111-1111-111111111111";
const VID = "22222222-2222-2222-2222-222222222222";
const SG = "33333333-3333-3333-3333-333333333333";

async function setup(handler: Handler, overrides = {}) {
  const f = fakeFetch(handler);
  const config = testConfig({ mode: "full", ...overrides });
  const ctx = new Context(config, new SelectelClient(config, f.impl));
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, ctx, [...networkTools, ...volumeTools]);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
  };
  const callConfirmed = async (name: string, args: Record<string, unknown> = {}) => {
    const plan = await call(name, args);
    const m = plan.text.match(/confirm_token="([^"]+)"/);
    return m ? call(name, { ...args, confirm_token: m[1] }) : plan;
  };
  return { f, call, callConfirmed };
}

describe("network", () => {
  it("lists floating IPs with attached server", async () => {
    const { call } = await setup((c) => {
      if (c.url.includes("/v2.0/floatingips"))
        return { body: { floatingips: [
          { id: "f1", floating_ip_address: "203.0.113.5", port_id: "p1", fixed_ip_address: "10.0.0.4", status: "ACTIVE" },
          { id: "f2", floating_ip_address: "203.0.113.6", port_id: null, status: "DOWN" },
        ] } };
      if (c.url.includes("/v2.0/ports")) return { body: { ports: [{ id: "p1", device_id: SID, device_owner: "compute:ru-9a" }] } };
      if (c.url.endsWith(`/servers/${SID}`)) return { body: { server: { id: SID, name: "web-1" } } };
      return undefined;
    });
    const r = await call("floating_ips_list");
    expect(r.text).toContain("web-1");
    expect(r.text).toContain("costs money while unused");
  });

  it("rule_add plan warns about 0.0.0.0/0 on port 22", async () => {
    const { call, f } = await setup((c) =>
      c.url.includes(`/security-groups/${SG}`) ? { body: { security_group: { id: SG, name: "web" } } } : undefined,
    );
    const r = await call("security_group_rule_add", { security_group: SG, protocol: "tcp", port_min: 22, remote_ip_prefix: "0.0.0.0/0" });
    expect(r.text).toContain("PLAN ONLY");
    expect(r.text).toContain("ENTIRE INTERNET");
    expect(r.text).toContain("port 22");
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    const ok = await call("security_group_rule_add", { security_group: SG, protocol: "tcp", port_min: 443 });
    expect(ok.text).not.toContain("ENTIRE INTERNET");
  });
});

describe("volumes", () => {
  const volume = (o = {}) => ({ id: VID, name: "data", size: 10, status: "available", attachments: [], bootable: "false", ...o });

  it("volume_extend sends os-extend and refuses shrink", async () => {
    const { call, callConfirmed, f } = await setup((c) => {
      if (c.method === "GET" && c.url.endsWith(`/volumes/${VID}`)) return { body: { volume: volume({ status: "in-use" }) } };
      if (c.method === "POST" && c.url.endsWith(`/volumes/${VID}/action`)) return { status: 202 };
      return undefined;
    });
    const shrink = await call("volume_extend", { volume: VID, new_size_gb: 5 });
    expect(shrink.isError).toBe(true);
    expect(shrink.text).toMatch(/cannot be shrunk/);
    const r = await callConfirmed("volume_extend", { volume: VID, new_size_gb: 20 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("resize2fs");
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ "os-extend": { new_size: 20 } });
    expect(post.headers["OpenStack-API-Version"]).toBe("volume 3.42");
  });

  it("volume_delete is refused when in-use", async () => {
    const { callConfirmed, f } = await setup((c) =>
      c.url.endsWith(`/volumes/${VID}`) && c.method === "GET"
        ? { body: { volume: volume({ status: "in-use", attachments: [{ server_id: SID }] }) } }
        : undefined,
    );
    const r = await callConfirmed("volume_delete", { volume: VID });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("in use");
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("volume_detach is refused for protected server", async () => {
    const { callConfirmed, f } = await setup(
      (c) => {
        if (c.url.endsWith(`/volumes/${VID}`)) return { body: { volume: volume({ status: "in-use", attachments: [{ server_id: SID, device: "/dev/vdb" }] }) } };
        if (c.url.endsWith(`/servers/${SID}`)) return { body: { server: { id: SID, name: "prod-db", tags: [], metadata: {} } } };
        return undefined;
      },
      { protectedServers: ["prod-db"] },
    );
    const r = await callConfirmed("volume_detach", { volume: VID });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("protected");
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
