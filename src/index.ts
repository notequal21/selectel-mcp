#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./core/config.js";
import { createServer, VERSION } from "./server.js";

async function main() {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(`[selectel-mcp] ${e instanceof ConfigError ? "config error" : "error"}: ${(e as Error).message}\n`);
    process.exit(1);
  }
  const { server, tools } = createServer(config);
  if (process.argv.includes("--list-tools")) {
    process.stdout.write(tools.join("\n") + "\n");
    return;
  }
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel — log only to stderr.
  process.stderr.write(`[selectel-mcp] v${VERSION} started: mode=${config.mode}, ${tools.length} tools\n`);
}

main().catch((e) => {
  process.stderr.write(`[selectel-mcp] fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
