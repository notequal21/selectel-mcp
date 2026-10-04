import { Readable } from "node:stream";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SelectelClient } from "../src/core/client.js";
import type { Config } from "../src/core/config.js";
import { Context } from "../src/core/context.js";
import { registerTools } from "../src/core/tool.js";
import { s3Tools, setS3ClientFactory, validateBucketName } from "../src/tools/s3.js";
import { testConfig } from "./helpers.js";

type Handler = (input: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler>;
let sent: { name: string; input: Record<string, unknown> }[];
let root: string;

function fakeClient(pool: string) {
  const c = new S3Client({
    region: pool,
    endpoint: `https://s3.${pool}.storage.selcloud.ru`,
    forcePathStyle: true,
    credentials: { accessKeyId: "AK", secretAccessKey: "SK-very-secret" },
  });
  (c as unknown as { send: unknown }).send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    sent.push({ name, input: cmd.input });
    const h = handlers[name];
    if (!h) throw Object.assign(new Error(`no fake for ${name}`), { name: "NoFake" });
    return h(cmd.input);
  };
  return c;
}

async function setup(overrides: Partial<Config> = {}) {
  const config = testConfig({
    mode: "full",
    filesRoot: root,
    s3: { accessKey: "AK", secretKey: "SK-very-secret", defaultPool: "ru-1" },
    ...overrides,
  });
  const ctx = new Context(config, new SelectelClient(config, fetch));
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, ctx, s3Tools);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    try {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: res.content.map((c) => c.text).join("\n"), isError: Boolean(res.isError) };
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
  };
  const callConfirmed = async (name: string, args: Record<string, unknown> = {}) => {
    const plan = await call(name, args);
    const m = plan.text.match(/confirm_token="([^"]+)"/);
    if (!m) return plan;
    return call(name, { ...args, confirm_token: m[1] });
  };
  return { call, callConfirmed };
}

beforeEach(async () => {
  handlers = {};
  sent = [];
  root = await mkdtemp(join(tmpdir(), "s3test-"));
  setS3ClientFactory((pool) => fakeClient(pool));
});
afterEach(async () => {
  setS3ClientFactory();
  await rm(root, { recursive: true, force: true });
});

describe("s3 tools", () => {
  it("returns a clear error without S3 config", async () => {
    const { call } = await setup({ s3: undefined });
    const r = await call("s3_buckets_list");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("SELECTEL_S3_ACCESS_KEY");
    expect(r.text).toContain("SELECTEL_S3_SECRET_KEY");
  });

  it("lists buckets and never leaks the secret", async () => {
    handlers.ListBucketsCommand = () => ({ Buckets: [{ Name: "b1", CreationDate: new Date(0) }] });
    const { call } = await setup();
    const r = await call("s3_buckets_list", { pool: "ru-7" });
    expect(r.text).toContain("b1");
    expect(r.text).not.toContain("SK-very-secret");
  });

  it("validates bucket names", async () => {
    expect(validateBucketName("my-bucket.1")).toBeNull();
    for (const bad of ["ab", "UPPER", "-start", "end-", "a..b", "192.168.0.1", "has_underscore", "x".repeat(64)]) {
      expect(validateBucketName(bad), bad).not.toBeNull();
    }
    const { callConfirmed } = await setup();
    const r = await callConfirmed("s3_bucket_create", { bucket: "Bad_Name" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Invalid bucket name");
    expect(sent.length).toBe(0);
  });

  it("creates a private bucket", async () => {
    handlers.CreateBucketCommand = () => ({});
    const { callConfirmed } = await setup();
    const r = await callConfirmed("s3_bucket_create", { bucket: "good-name" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("private");
  });

  it("refuses to delete a non-empty bucket", async () => {
    handlers.ListObjectsV2Command = () => ({ Contents: [{ Key: "a" }], KeyCount: 1, IsTruncated: true });
    const { call } = await setup();
    const r = await call("s3_bucket_delete", { bucket: "full-bucket" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("1000+");
  });

  it("refuses upload paths outside the files root", async () => {
    handlers.HeadObjectCommand = () => {
      throw Object.assign(new Error("nf"), { name: "NotFound" });
    };
    const { call } = await setup();
    for (const p of ["../../etc/passwd", "/etc/passwd"]) {
      const r = await call("s3_object_upload", { bucket: "bkt", key: "k", local_path: p });
      expect(r.isError, p).toBe(true);
      expect(r.text).toMatch(/outside|does not exist/);
    }
    expect(sent.some((s) => s.name === "PutObjectCommand")).toBe(false);
  });

  it("refuses symlink escapes", async () => {
    const outside = await mkdtemp(join(tmpdir(), "s3out-"));
    try {
      await writeFile(join(outside, "secret.txt"), "x");
      await symlink(outside, join(root, "link"));
      await symlink(join(outside, "secret.txt"), join(root, "file-link"));
      const { call } = await setup();
      const a = await call("s3_object_upload", { bucket: "bkt", key: "k", local_path: "link/secret.txt" });
      const b = await call("s3_object_upload", { bucket: "bkt", key: "k", local_path: "file-link" });
      expect(a.isError).toBe(true);
      expect(b.isError).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("uploads a file from the root and inline text", async () => {
    await writeFile(join(root, "a.json"), "{}");
    handlers.HeadObjectCommand = () => {
      throw Object.assign(new Error("nf"), { name: "NotFound" });
    };
    handlers.PutObjectCommand = (i) => (i.Body ? {} : {});
    const { callConfirmed } = await setup();
    const r = await callConfirmed("s3_object_upload", { bucket: "bkt", key: "a.json", local_path: "a.json" });
    expect(r.isError).toBe(false);
    const put = sent.find((s) => s.name === "PutObjectCommand")!;
    expect(put.input.ContentType).toBe("application/json");
    const t = await callConfirmed("s3_object_upload", { bucket: "bkt", key: "n.txt", text: "hello" });
    expect(t.isError).toBe(false);
  });

  it("refuses to overwrite existing local file on download unless overwrite=true", async () => {
    await writeFile(join(root, "x.txt"), "old");
    handlers.HeadObjectCommand = () => ({ ContentLength: 3 });
    const { call } = await setup();
    const r = await call("s3_object_download", { bucket: "bkt", key: "k", local_path: "x.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("overwrite");
    expect(await readFile(join(root, "x.txt"), "utf8")).toBe("old");
  });

  it("downloads into the root", async () => {
    await mkdir(join(root, "d"));
    handlers.HeadObjectCommand = () => ({ ContentLength: 5 });
    handlers.GetObjectCommand = () => {
      return { Body: Readable.from([Buffer.from("hello")]) };
    };
    const { callConfirmed } = await setup();
    const r = await callConfirmed("s3_object_download", { bucket: "bkt", key: "k", local_path: "d/out.txt" });
    expect(r.isError).toBe(false);
    expect(await readFile(join(root, "d", "out.txt"), "utf8")).toBe("hello");
  });

  it("delete plan lists keys and total size", async () => {
    handlers.HeadObjectCommand = (i) => ({ ContentLength: i.Key === "a" ? 100 : 2048 });
    handlers.DeleteObjectsCommand = () => ({});
    const { call, callConfirmed } = await setup();
    const plan = await call("s3_object_delete", { bucket: "bkt", keys: ["a", "dir/b"] });
    expect(plan.text).toContain("PLAN ONLY");
    expect(plan.text).toContain('"dir/b"');
    expect(plan.text).toContain("total_size_bytes");
    expect(plan.text).toContain("2148");
    expect(sent.some((s) => s.name === "DeleteObjectsCommand")).toBe(false);
    const done = await callConfirmed("s3_object_delete", { bucket: "bkt", keys: ["a", "dir/b"] });
    expect(done.isError).toBe(false);
    expect(sent.find((s) => s.name === "DeleteObjectsCommand")!.input).toMatchObject({
      Delete: { Objects: [{ Key: "a" }, { Key: "dir/b" }] },
    });
  });

  it("presign enforces expiry bounds", async () => {
    const { call } = await setup();
    for (const e of [0, -5, 604801, 1.5]) {
      const r = await call("s3_presign_get", { bucket: "bkt", key: "k", expires_in: e });
      expect(r.isError, String(e)).toBe(true);
    }
    const ok = await call("s3_presign_get", { bucket: "bkt", key: "k", expires_in: 604800 });
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain("storage.selcloud.ru/bkt/k");
    expect(ok.text).toContain("X-Amz-Expires=604800");
    expect(ok.text).not.toContain("SK-very-secret");
    const dflt = await call("s3_presign_get", { bucket: "bkt", key: "k" });
    expect(dflt.text).toContain("X-Amz-Expires=3600");
  });

  it("get_text refuses binary and large objects", async () => {
    handlers.HeadObjectCommand = (i) =>
      i.Key === "big.txt" ? { ContentLength: 300 * 1024, ContentType: "text/plain" } : { ContentLength: 10, ContentType: "image/png" };
    const { call } = await setup();
    expect((await call("s3_object_get_text", { bucket: "b", key: "big.txt" })).isError).toBe(true);
    expect((await call("s3_object_get_text", { bucket: "b", key: "x.png" })).isError).toBe(true);
  });
});
