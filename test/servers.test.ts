import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeAll, describe, expect, it } from "vitest";
import { SelectelClient } from "../src/core/client.js";
import type { Config } from "../src/core/config.js";
import { Context } from "../src/core/context.js";
import { registerTools } from "../src/core/tool.js";
import { computeCatalogTools } from "../src/tools/compute-catalog.js";
import { serverTools, timing } from "../src/tools/servers.js";
import { fakeFetch, testConfig, type Call, type Handler } from "./helpers.js";

beforeAll(() => {
  timing.intervalMs = 1;
});

async function setup(config: Config, handler: Handler) {
  const f = fakeFetch(handler);
  const ctx = new Context(config, new SelectelClient(config, f.impl));
  const server = new McpServer({ name: "t", version: "0" });
  const tools = registerTools(server, ctx, [...serverTools, ...computeCatalogTools]);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join("\n"), isError: Boolean(res.isError) };
  };
  const callConfirmed = async (name: string, args: Record<string, unknown> = {}) => {
    const plan = await call(name, args);
    const m = plan.text.match(/confirm_token="([^"]+)"/);
    if (!m) return plan;
    return call(name, { ...args, confirm_token: m[1] });
  };
  return { f, tools, call, callConfirmed };
}

const SID = "11111111-1111-1111-1111-111111111111";
const FLAVOR = { id: "f1", name: "SL1.2-4096", vcpus: 2, ram: 4096, disk: 0, "os-flavor-access:is_public": true };

function server(over: Record<string, unknown> = {}) {
  return {
    id: SID,
    name: "web-1",
    status: "ACTIVE",
    created: "2026-01-01T00:00:00Z",
    flavor: { id: "f1" },
    metadata: {},
    addresses: {
      net: [
        { addr: "192.168.0.5", version: 4, "OS-EXT-IPS:type": "fixed" },
        { addr: "203.0.113.7", version: 4, "OS-EXT-IPS:type": "floating" },
      ],
    },
    "OS-EXT-AZ:availability_zone": "ru-9a",
    key_name: "k",
    security_groups: [{ name: "default" }],
    "os-extended-volumes:volumes_attached": [{ id: "vol1", delete_on_termination: true }],
    ...over,
  };
}

const json = (body: unknown, status = 200) => ({ status, body });
const path = (c: Call) => new URL(c.url).pathname.replace(/^\/v1/, "");

describe("servers", () => {
  it("lists servers and classifies IPs", async () => {
    const { call } = await setup(testConfig({ mode: "full" }), (c) => {
      if (path(c) === "/servers/detail") return json({ servers: [server()] });
      if (path(c) === "/flavors/f1") return json({ flavor: FLAVOR });
    });
    const r = await call("servers_list");
    const out = JSON.parse(r.text);
    expect(out.servers[0]).toMatchObject({
      name: "web-1",
      region: "ru-9",
      public_ips: ["203.0.113.7"],
      private_ips: ["192.168.0.5"],
      floating_ips: ["203.0.113.7"],
      flavor: { name: "SL1.2-4096", vcpus: 2, ram_mb: 4096 },
    });
  });

  it("gets a server by name with volumes", async () => {
    const { call } = await setup(testConfig({ mode: "full" }), (c) => {
      if (path(c) === "/servers/detail") return json({ servers: [server()] });
      if (path(c) === "/flavors/f1") return json({ flavor: FLAVOR });
      if (path(c) === "/volumes/vol1")
        return json({ volume: { id: "vol1", name: "boot", size: 20, volume_type: "fast.ru-9a", bootable: "true", status: "in-use", attachments: [{ server_id: SID, device: "/dev/vda" }] } });
    });
    const out = JSON.parse((await call("server_get", { server: "web-1" })).text);
    expect(out.id).toBe(SID);
    expect(out.volumes[0]).toMatchObject({ size_gb: 20, type: "fast.ru-9a", device: "/dev/vda" });
    expect(out.availability_zone).toBe("ru-9a");
  });

  it("reports ambiguous names", async () => {
    const { call } = await setup(testConfig({ mode: "full" }), (c) => {
      if (path(c) === "/servers/detail") return json({ servers: [server(), server({ id: "22222222-2222-2222-2222-222222222222" })] });
    });
    const r = await call("server_get", { server: "web-1" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ambiguous");
    expect(r.text).toContain("22222222");
  });

  it("create: plan then confirm sends boot-from-volume body with base64 user_data", async () => {
    const created: Call[] = [];
    const { call, callConfirmed } = await setup(testConfig({ mode: "full" }), (c) => {
      const p = path(c);
      if (p === "/flavors/detail") return json({ flavors: [FLAVOR] });
      if (p === "/v2/images") return json({ images: [{ id: "img1", name: "Ubuntu 24.04", min_disk: 5 }] });
      if (p === "/v2.0/networks") return json({ networks: [{ id: "net1", name: "private" }, { id: "ext", name: "external-network", "router:external": true }] });
      if (p === "/os-availability-zone") return json({ availabilityZoneInfo: [{ zoneName: "ru-9a", zoneState: { available: true } }] });
      if (p === "/types") return json({ volume_types: [{ name: "fast.ru-9a" }, { name: "universal.ru-9a" }] });
      if (p === "/servers" && c.method === "POST") {
        created.push(c);
        return json({ server: { id: SID } }, 202);
      }
      if (p === `/servers/${SID}`) return json({ server: server({ addresses: { net: [{ addr: "10.0.0.4", version: 4 }] } }) });
    });
    const args = { name: "web-1", vcpus: 2, ram_mb: 4096, image: "Ubuntu 24.04", size_gb: 20, user_data: "#cloud-config\n", key_name: "k" };
    const plan = await call("server_create", args);
    expect(plan.text).toContain("PLAN ONLY");
    expect(plan.text).toContain("universal.ru-9a");
    expect(created).toHaveLength(0);

    const r = await callConfirmed("server_create", args);
    expect(r.isError).toBe(false);
    expect(created).toHaveLength(1);
    const body = (created[0]!.body as { server: Record<string, unknown> }).server;
    expect(body.flavorRef).toBe("f1");
    expect(body.availability_zone).toBe("ru-9a");
    expect(body.user_data).toBe(Buffer.from("#cloud-config\n").toString("base64"));
    expect(body.networks).toEqual([{ uuid: "net1" }]);
    expect(body.block_device_mapping_v2).toEqual([
      { boot_index: 0, uuid: "img1", source_type: "image", destination_type: "volume", volume_size: 20, volume_type: "universal.ru-9a", delete_on_termination: true },
    ]);
    expect(JSON.parse(r.text).servers[0]).toMatchObject({ id: SID, status: "ACTIVE", private_ips: ["10.0.0.4"] });
  });

  it("create refuses count above the limit", async () => {
    const { call } = await setup(testConfig({ mode: "full", maxServersPerCall: 2 }), () => undefined);
    const r = await call("server_create", { name: "x", flavor: "f1", image: "i", size_gb: 10, count: 3 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("SELECTEL_MAX_SERVERS_PER_CALL");
  });

  it("resize: resize -> VERIFY_RESIZE -> confirmResize", async () => {
    const actions: unknown[] = [];
    let status = "ACTIVE";
    const big = { id: "f2", name: "SL1.4-8192", vcpus: 4, ram: 8192, disk: 0, "os-flavor-access:is_public": true };
    const { callConfirmed } = await setup(testConfig({ mode: "full" }), (c) => {
      const p = path(c);
      if (p === "/flavors/detail") return json({ flavors: [FLAVOR, big] });
      if (p === "/flavors/f1") return json({ flavor: FLAVOR });
      if (p === "/servers/detail") return json({ servers: [server({ status })] });
      if (p === `/servers/${SID}/action`) {
        actions.push(c.body);
        const b = c.body as Record<string, unknown>;
        if ("resize" in b) status = "VERIFY_RESIZE";
        if ("confirmResize" in b) status = "ACTIVE";
        return { status: 202 };
      }
      if (p === `/servers/${SID}`) return json({ server: server({ status }) });
    });
    const r = await callConfirmed("server_resize", { server: "web-1", flavor: "SL1.4-8192" });
    expect(r.isError).toBe(false);
    expect(actions).toEqual([{ resize: { flavorRef: "f2" } }, { confirmResize: null }]);
    expect(JSON.parse(r.text)).toMatchObject({ status: "ACTIVE", vcpus: 4, ram_mb: 8192 });
  });

  it("delete is refused on protected servers (plan stage)", async () => {
    const calls: string[] = [];
    const { call } = await setup(testConfig({ mode: "full" }), (c) => {
      calls.push(`${c.method} ${path(c)}`);
      if (path(c) === "/servers/detail") return json({ servers: [server({ metadata: { protected: "true" } })] });
    });
    const r = await call("server_delete", { server: "web-1" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("protected");
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("delete plan lists floating IPs and release deletes them", async () => {
    const calls: string[] = [];
    const { call, callConfirmed } = await setup(testConfig({ mode: "full" }), (c) => {
      calls.push(`${c.method} ${path(c)}`);
      const p = path(c);
      if (p === "/servers/detail") return json({ servers: [server()] });
      if (p === "/volumes/vol1") return json({ volume: { id: "vol1", size: 10, attachments: [] } });
      if (p === "/v2.0/ports") return json({ ports: [{ id: "port1" }] });
      if (p === "/v2.0/floatingips" ) return json({ floatingips: [{ id: "fip1", floating_ip_address: "203.0.113.7" }] });
      if (p === `/servers/${SID}` && c.method === "DELETE") return { status: 200 };
      if (p === "/v2.0/floatingips/fip1") return { status: 200 };
    });
    const plan = await call("server_delete", { server: "web-1", release_floating_ips: false });
    expect(plan.text).toContain("remain allocated");
    await callConfirmed("server_delete", { server: "web-1", release_floating_ips: true });
    expect(calls).toContain(`DELETE /servers/${SID}`);
    expect(calls).toContain("DELETE /v2.0/floatingips/fip1");
  });

  it("readonly mode hides write tools", async () => {
    const { tools } = await setup(testConfig({ mode: "readonly" }), () => undefined);
    expect(tools).toContain("servers_list");
    expect(tools).toContain("flavors_list");
    expect(tools).not.toContain("server_create");
    expect(tools).not.toContain("keypair_import");
    expect(tools).not.toContain("server_delete");
  });

  it("safe mode hides destructive tools", async () => {
    const { tools } = await setup(testConfig({ mode: "safe" }), () => undefined);
    expect(tools).toContain("server_create");
    expect(tools).toContain("server_protect");
    expect(tools).not.toContain("server_delete");
    expect(tools).not.toContain("server_unprotect");
  });

  it("keypair_import rejects private keys", async () => {
    const { call } = await setup(testConfig({ mode: "full" }), () => undefined);
    const r = await call("keypair_import", { name: "k", public_key: "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "a".repeat(60) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("private key");
  });
});
