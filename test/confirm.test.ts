import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SelectelClient } from "../src/core/client.js";
import type { Config } from "../src/core/config.js";
import { Context } from "../src/core/context.js";
import { defineTool, registerTools } from "../src/core/tool.js";
import { fakeFetch, testConfig } from "./helpers.js";

function setup(config: Config, opts: { elicit?: "accept" | "decline" } = {}) {
  const runs: unknown[] = [];
  const tools = [
    defineTool({
      name: "thing_write",
      title: "w",
      kind: "write",
      description: "test write",
      input: { size: z.number() },
      plan: async (a) => ({ summary: `set size ${a.size}` }),
      run: async (a) => {
        runs.push(a);
        return { done: true };
      },
    }),
    defineTool({
      name: "thing_delete",
      title: "d",
      kind: "destructive",
      description: "test delete",
      input: { id: z.string() },
      plan: async (a) => {
        if (a.id === "prot") throw new Error("protected");
        return { summary: `delete ${a.id}` };
      },
      run: async (a) => {
        runs.push(a);
        return { deleted: a.id };
      },
    }),
  ];
  return {
    runs,
    async connect() {
      const ctx = new Context(config, new SelectelClient(config, fakeFetch(() => undefined).impl));
      const server = new McpServer({ name: "t", version: "0" });
      const names = registerTools(server, ctx, tools);
      const client = new Client({ name: "c", version: "0" }, opts.elicit ? { capabilities: { elicitation: {} } } : {});
      if (opts.elicit) {
        client.setRequestHandler(ElicitRequestSchema, async () =>
          opts.elicit === "accept" ? { action: "accept", content: { confirm: true } } : { action: "decline" },
        );
      }
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
      };
      return { names, call };
    },
  };
}

describe("modes", () => {
  it("readonly hides write+destructive, safe hides destructive, full shows all", async () => {
    expect((await setup(testConfig({ mode: "readonly" })).connect()).names).toEqual([]);
    expect((await setup(testConfig({ mode: "safe" })).connect()).names).toEqual(["thing_write"]);
    expect((await setup(testConfig({ mode: "full" })).connect()).names).toEqual(["thing_write", "thing_delete"]);
  });
  it("disabled tools patterns", async () => {
    const s = setup(testConfig({ mode: "full", disabledTools: ["thing_d*"] }));
    expect((await s.connect()).names).toEqual(["thing_write"]);
  });
});

describe("token confirmation", () => {
  it("first call only plans, second call with token executes once", async () => {
    const s = setup(testConfig({ mode: "safe", confirm: "token" }));
    const { call } = await s.connect();
    const plan = await call("thing_write", { size: 5 });
    expect(plan.text).toContain("PLAN ONLY");
    expect(s.runs).toHaveLength(0);
    const token = plan.text.match(/confirm_token="([^"]+)"/)![1];
    const done = await call("thing_write", { size: 5, confirm_token: token });
    expect(done.isError).toBe(false);
    expect(s.runs).toHaveLength(1);
    const again = await call("thing_write", { size: 5, confirm_token: token });
    expect(again.isError).toBe(true);
    expect(s.runs).toHaveLength(1);
  });

  it("token is bound to the exact arguments and tool", async () => {
    const s = setup(testConfig({ mode: "full", confirm: "token" }));
    const { call } = await s.connect();
    const token = (await call("thing_write", { size: 5 })).text.match(/confirm_token="([^"]+)"/)![1];
    expect((await call("thing_write", { size: 500, confirm_token: token })).text).toMatch(/arguments differ/);
    expect((await call("thing_delete", { id: "x", confirm_token: token })).isError).toBe(true);
    expect(s.runs).toHaveLength(0);
  });

  it("plan errors (e.g. protected) refuse execution", async () => {
    const s = setup(testConfig({ mode: "full", confirm: "token" }));
    const { call } = await s.connect();
    const r = await call("thing_delete", { id: "prot" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("protected");
  });

  it("confirm=none skips confirmation for write but not destructive", async () => {
    const s = setup(testConfig({ mode: "full", confirm: "none" }));
    const { call } = await s.connect();
    await call("thing_write", { size: 1 });
    expect(s.runs).toHaveLength(1);
    expect((await call("thing_delete", { id: "a" })).text).toContain("PLAN ONLY");
    expect(s.runs).toHaveLength(1);
  });
});

describe("elicitation confirmation", () => {
  it("executes when the user accepts", async () => {
    const s = setup(testConfig({ mode: "full", confirm: "auto" }), { elicit: "accept" });
    const { call } = await s.connect();
    expect((await call("thing_delete", { id: "a" })).text).toContain("deleted");
    expect(s.runs).toHaveLength(1);
  });
  it("does nothing when the user declines", async () => {
    const s = setup(testConfig({ mode: "full", confirm: "auto" }), { elicit: "decline" });
    const { call } = await s.connect();
    expect((await call("thing_delete", { id: "a" })).text).toContain("Cancelled");
    expect(s.runs).toHaveLength(0);
  });
  it("elicit mode refuses when client lacks support", async () => {
    const s = setup(testConfig({ mode: "full", confirm: "elicit" }));
    const { call } = await s.connect();
    expect((await call("thing_delete", { id: "a" })).isError).toBe(true);
    expect(s.runs).toHaveLength(0);
  });
});
