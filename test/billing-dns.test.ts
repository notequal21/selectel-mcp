import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { SelectelClient } from "../src/core/client.js";
import { Context } from "../src/core/context.js";
import { registerTools } from "../src/core/tool.js";
import { billingTools, parseBalances } from "../src/tools/billing.js";
import { computeUpserts, dnsTools, normalizeDesired, parseBindZone } from "../src/tools/dns.js";
import { fakeFetch, PROJECT_ID, testConfig, type Handler } from "./helpers.js";

async function setup(handler: Handler) {
  const f = fakeFetch(handler);
  const config = testConfig({ mode: "full" });
  const ctx = new Context(config, new SelectelClient(config, f.impl));
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, ctx, [...billingTools, ...dnsTools]);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: res.content.map((c) => c.text).join("\n"), isError: Boolean(res.isError) };
  };
  const callConfirmed = async (name: string, args: Record<string, unknown> = {}) => {
    const plan = await call(name, args);
    const m = plan.text.match(/confirm_token="([^"]+)"/);
    if (!m) return { plan, result: plan };
    return { plan, result: await call(name, { ...args, confirm_token: m[1] }) };
  };
  return { f, call, callConfirmed };
}

const ZONE = { id: "11111111-1111-1111-1111-111111111111", name: "example.com.", project_id: PROJECT_ID };
const rr = (id: string, name: string, type: string, ttl: number, contents: string[]) => ({
  id,
  name,
  type,
  ttl,
  records: contents.map((content) => ({ content, disabled: false })),
});

describe("billing", () => {
  it("converts kopecks to rubles and merges prediction", async () => {
    const { call } = await setup((c) => {
      if (c.url.startsWith("https://api.selectel.ru/v4/balances"))
        return {
          body: {
            data: {
              agreements: [
                {
                  agreement_id: 1,
                  billings: [
                    {
                      billing_type: "primary",
                      balances: [
                        { balance_type: "bonus", value: 3661464 },
                        { balance_type: "main", value: 514 },
                      ],
                      balances_values_sum: 3661978,
                      debt_sum: 0,
                      final_sum: 3661978,
                    },
                  ],
                },
              ],
              settings: { currency: "rub" },
            },
          },
        };
      if (c.url.startsWith("https://api.selectel.ru/v2/billing/prediction")) return { body: { data: { primary: 100, storage: null } } };
      return undefined;
    });
    const r = await call("billing_balance");
    expect(r.isError).toBe(false);
    const j = JSON.parse(r.text);
    expect(j.billings[0].balances).toEqual({ bonus: 36614.64, main: 5.14 });
    expect(j.total_available).toBe(36619.78);
    expect(j.balance_lasts[0].lasts).toBe("4 d 4 h");
  });

  it("falls back to the v3 shape", () => {
    const p = parseBalances({ data: { billings: [{ final_sum: 33218108, debt_sum: 0 }] } });
    expect(p.totalAvailable).toBe(332181.08);
  });

  it("explains how to fix a 403", async () => {
    const { call } = await setup(() => ({ status: 403, body: { message: "forbidden" } }));
    const r = await call("billing_balance");
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"billing" role');
  });
});

describe("dns helpers", () => {
  it("rejects bad A record IPs and CNAME at apex", () => {
    expect(() => normalizeDesired("example.com", { name: "www", type: "A", records: ["999.1.1.1"] })).toThrow(/IPv4/);
    expect(() => normalizeDesired("example.com", { name: "@", type: "CNAME", records: ["x.test"] })).toThrow(/apex/);
    expect(() => normalizeDesired("example.com", { name: "www", type: "AAAA", records: ["1.2.3.4"] })).toThrow(/IPv6/);
  });

  it("normalizes names and TXT quoting", () => {
    const d = normalizeDesired("example.com", { name: "www.example.com", type: "TXT", records: ["v=spf1 -all"] });
    expect(d.name).toBe("www.example.com.");
    expect(d.records).toEqual(['"v=spf1 -all"']);
  });

  it("computes create/update/unchanged", () => {
    const existing = [rr("a", "www.example.com.", "A", 300, ["1.1.1.1"]), rr("b", "api.example.com.", "A", 300, ["2.2.2.2"])];
    const desired = [
      normalizeDesired("example.com", { name: "www", type: "A", ttl: 300, records: ["1.1.1.1"] }),
      normalizeDesired("example.com", { name: "api", type: "A", ttl: 300, records: ["3.3.3.3"] }),
      normalizeDesired("example.com", { name: "new", type: "A", ttl: 60, records: ["4.4.4.4"] }),
    ];
    const { changes } = computeUpserts("example.com.", existing, desired);
    expect(changes.map((c) => [c.name, c.action])).toEqual([
      ["www.example.com.", "unchanged"],
      ["api.example.com.", "update"],
      ["new.example.com.", "create"],
    ]);
  });

  it("parses BIND files", () => {
    const text = `$ORIGIN example.com.
$TTL 1h
@ IN SOA ns1.example.com. admin.example.com. ( 1 2 3 4 5 )
@ IN NS ns1.example.com.
@ 300 IN MX 10 mail
  IN MX 20 mail2.example.net.
www IN A 1.2.3.4
blog CNAME www
@ TXT "v=spf1 include:_spf.example.com" " -all" ; comment
_sip._tcp SRV 10 60 5060 sip
@ CAA 0 issue "letsencrypt.org"
`;
    const { records, notes } = parseBindZone(text, "example.com");
    const find = (n: string, t: string) => records.find((r) => r.name === n && r.type === t)!;
    expect(find("example.com.", "MX").records).toEqual(["10 mail.example.com.", "20 mail2.example.net."]);
    expect(find("example.com.", "MX").ttl).toBe(300);
    expect(find("www.example.com.", "A").ttl).toBe(3600);
    expect(find("blog.example.com.", "CNAME").records).toEqual(["www.example.com."]);
    expect(find("example.com.", "TXT").records).toEqual(['"v=spf1 include:_spf.example.com" " -all"']);
    expect(find("_sip._tcp.example.com.", "SRV").records).toEqual(["10 60 5060 sip.example.com."]);
    expect(find("example.com.", "CAA").records).toEqual(['0 issue "letsencrypt.org"']);
    expect(records.find((r) => r.type === "NS")).toBeUndefined();
    expect(notes.join("\n")).toContain("SOA");
    expect(notes.join("\n")).toContain("apex NS");
  });
});

describe("dns tools", () => {
  const dnsHandler = (existing: unknown[], sink: { method: string; url: string; body?: unknown }[]): Handler => (c) => {
    if (!c.url.startsWith("https://dnsv2.ru-1.test/v1")) return undefined;
    const path = new URL(c.url).pathname.replace("/v1", "");
    if (c.method === "GET" && path === "/zones") return { body: { count: 1, next_offset: 0, result: [ZONE] } };
    if (c.method === "GET" && path === `/zones/${ZONE.id}/rrset`) return { body: { count: existing.length, next_offset: 0, result: existing } };
    sink.push({ method: c.method, url: c.url, body: c.body });
    return { status: c.method === "DELETE" ? 204 : 200, body: c.method === "DELETE" ? undefined : { id: "new" } };
  };

  it("upsert: plan shows diff, confirm sends PATCH body", async () => {
    const sink: { method: string; url: string; body?: unknown }[] = [];
    const { callConfirmed } = await setup(dnsHandler([rr("rid", "www.example.com.", "A", 300, ["1.1.1.1"])], sink));
    const { plan, result } = await callConfirmed("dns_record_upsert", {
      zone: "example.com",
      name: "www",
      type: "A",
      ttl: 60,
      records: ["5.5.5.5"],
    });
    expect(plan.text).toContain("PLAN ONLY");
    expect(plan.text).toContain("1.1.1.1");
    expect(plan.text).toContain("5.5.5.5");
    expect(result.isError).toBe(false);
    expect(sink).toHaveLength(1);
    expect(sink[0]!.method).toBe("PATCH");
    expect(sink[0]!.url).toContain("/rrset/rid");
    expect(sink[0]!.body).toEqual({ ttl: 60, records: [{ content: "5.5.5.5", disabled: false }] });
  });

  it("upsert: bad IP is refused at plan time and nothing is sent", async () => {
    const sink: { method: string; url: string; body?: unknown }[] = [];
    const { call } = await setup(dnsHandler([], sink));
    const r = await call("dns_record_upsert", { zone: "example.com", name: "www", type: "A", records: ["300.1.1.1"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("IPv4");
    expect(sink).toHaveLength(0);
  });

  it("apply creates, updates, leaves unchanged, never deletes", async () => {
    const sink: { method: string; url: string; body?: unknown }[] = [];
    const existing = [
      rr("1", "www.example.com.", "A", 300, ["1.1.1.1"]),
      rr("2", "old.example.com.", "A", 300, ["9.9.9.9"]),
    ];
    const { callConfirmed } = await setup(dnsHandler(existing, sink));
    const { plan, result } = await callConfirmed("dns_records_apply", {
      zone: "example.com",
      records: [
        { name: "www", type: "A", ttl: 300, records: ["1.1.1.1"] },
        { name: "api", type: "A", records: ["2.2.2.2"] },
      ],
    });
    expect(plan.text).toContain("1 create, 0 update, 0 delete, 1 unchanged");
    expect(result.isError).toBe(false);
    expect(sink.map((s) => s.method)).toEqual(["POST"]);
    expect((sink[0]!.body as { name: string }).name).toBe("api.example.com.");
  });
});
