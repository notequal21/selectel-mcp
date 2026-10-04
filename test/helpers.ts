import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type Config } from "../src/core/config.js";
import { createServer } from "../src/server.js";

export const PROJECT_ID = "0123456789abcdef0123456789abcdef";

export interface Call {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
}

export type Handler = (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

/** Fake Keystone catalog: every service type gets https://<type>.<region>.test/ endpoints. */
export function catalog(types: string[], regions = ["ru-1", "ru-9"]) {
  return types.map((type) => ({
    type,
    endpoints: regions.map((r) => ({ interface: "public", region_id: r, region: r, url: `https://${type}.${r}.test/v1` })),
  }));
}

const DEFAULT_TYPES = ["compute", "network", "image", "volumev3", "resell", "dnsv2", "quota-manager"];

/**
 * Creates a fake fetch. Auth (POST .../auth/tokens) is answered automatically.
 * `handler` gets every other request; return undefined to produce a 404.
 */
export function fakeFetch(handler: Handler, types = DEFAULT_TYPES) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body = typeof init?.body === "string" ? safeJson(init.body) : init?.body;
    if (url.endsWith("/auth/tokens")) {
      return new Response(
        JSON.stringify({ token: { expires_at: new Date(Date.now() + 86400e3).toISOString(), catalog: catalog(types) } }),
        { status: 201, headers: { "x-subject-token": "tok", "content-type": "application/json" } },
      );
    }
    const call = { method, url, body, headers };
    calls.push(call);
    const r = handler(call);
    if (!r) return new Response(JSON.stringify({ itemNotFound: { message: `no fake for ${method} ${url}` } }), { status: 404 });
    return new Response(r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...r.headers },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function testConfig(overrides: Partial<Config> = {}, env: Record<string, string> = {}): Config {
  return {
    ...loadConfig({
      SELECTEL_ACCOUNT_ID: "123456",
      SELECTEL_USERNAME: "svc",
      SELECTEL_PASSWORD: "secret-password",
      SELECTEL_PROJECT_ID: PROJECT_ID,
      SELECTEL_REGION: "ru-9",
      SELECTEL_AUDIT_LOG: "off",
      SELECTEL_CONFIRM: "token",
      ...env,
    }),
    ...overrides,
  };
}

/** Connects an MCP client to a server built with the fake fetch. */
export async function connect(config: Config, fetchImpl: typeof fetch) {
  const { server, ctx, tools } = createServer(config, fetchImpl);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    return { text: res.content.map((c) => c.text).join("\n"), isError: Boolean(res.isError) };
  };
  /** Calls a mutating tool through the token flow: plan, then confirm. */
  const callConfirmed = async (name: string, args: Record<string, unknown> = {}) => {
    const plan = await call(name, args);
    const m = plan.text.match(/confirm_token="([^"]+)"/);
    if (!m) return plan;
    return call(name, { ...args, confirm_token: m[1] });
  };
  return { client, ctx, tools, call, callConfirmed };
}
