import { describe, expect, it } from "vitest";
import { redact } from "../src/core/redact.js";
import { connect, fakeFetch, testConfig } from "./helpers.js";

const HASH = "$6$rounds=5000$saltsalt$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";

describe("redact", () => {
  it("redacts vendor-specific password fields and crypt hashes", () => {
    const r = redact({
      metadata: { x_sel_server_password_hash: HASH, role: "web", note: HASH },
      adminPass: "x",
      user_data: "#cloud-config",
      ssh: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
      api_key: "k",
      token: "t",
      "X-Auth-Token": "t",
    });
    expect(JSON.stringify(r)).not.toContain("saltsalt");
    expect(r.metadata.role).toBe("web");
    expect(r.metadata.x_sel_server_password_hash).toBe("[redacted]");
    expect(r.metadata.note).toBe("[redacted]");
    for (const k of ["adminPass", "user_data", "ssh", "api_key", "token", "X-Auth-Token"] as const) {
      expect(r[k], k).toBe("[redacted]");
    }
  });

  it("keeps non-secret fields that merely contain 'token' or 'key'", () => {
    const r = redact({ next_continuation_token: "abc", key: "photos/1.jpg", key_name: "laptop", fingerprint: "aa:bb" });
    expect(r).toEqual({ next_continuation_token: "abc", key: "photos/1.jpg", key_name: "laptop", fingerprint: "aa:bb" });
  });
});

describe("server metadata", () => {
  const srv = {
    id: "11111111-2222-3333-4444-555555555555",
    name: "web",
    status: "ACTIVE",
    flavor: { id: "f1" },
    addresses: {},
    metadata: { x_sel_server_password_hash: HASH, env: "prod" },
  };
  const handler = (c: { url: string }) => {
    if (c.url.includes("/flavors/")) return { body: { flavor: { id: "f1", name: "SL1", vcpus: 1, ram: 1024 } } };
    if (c.url.includes("/servers/detail")) return { body: { servers: [srv] } };
    if (c.url.includes("/servers/")) return { body: { server: srv } };
    return { body: {} };
  };

  for (const [tool, args] of [
    ["servers_list", {}],
    ["server_get", { server: "web" }],
    ["server_find", { query: "web" }],
    ["infra_overview", { include_billing: false }],
  ] as const) {
    it(`${tool} never returns the root password hash`, async () => {
      const { call } = await connect(testConfig(), fakeFetch(handler).impl);
      const r = await call(tool, args);
      expect(r.text).not.toContain("saltsalt");
      expect(r.text).not.toContain("$6$");
    });
  }
});
