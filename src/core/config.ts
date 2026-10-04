import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Access mode:
 *  - readonly: only tools that never change anything are exposed (default);
 *  - safe:     + create/modify tools (create server, resize, DNS records, uploads); nothing gets deleted;
 *  - full:     + destructive tools (delete servers, volumes, DNS zones, buckets, objects).
 */
export type Mode = "readonly" | "safe" | "full";

/**
 * How mutating calls are confirmed:
 *  - auto:   ask the human via MCP elicitation if the client supports it, otherwise fall back to "token";
 *  - elicit: always ask via elicitation; refuse if the client does not support it;
 *  - token:  two-step plan -> confirm_token flow (the agent must call the tool twice);
 *  - none:   no confirmation for "write" tools. Destructive tools still use "auto".
 */
export type ConfirmMode = "auto" | "elicit" | "token" | "none";

export interface Config {
  accountId: string;
  username: string;
  password: string;
  userDomainName: string;
  authUrl: string;
  authRegion: string;

  defaultProjectId?: string;
  allowedProjects?: string[];
  defaultRegion?: string;
  allowedRegions?: string[];

  mode: Mode;
  confirm: ConfirmMode;
  confirmTtlSec: number;
  protectedServers: string[];
  protectedTag: string;
  maxServersPerCall: number;
  enabledTools?: string[];
  disabledTools: string[];

  auditLog: string | null;
  filesRoot: string;

  s3?: { accessKey: string; secretKey: string; defaultPool: string };

  httpTimeoutMs: number;
}

export class ConfigError extends Error {}

function list(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const items = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/**
 * Reads a secret from (in order): VAR, VAR_FILE (path, must not be group/world readable), VAR_CMD (command output,
 * e.g. `security find-generic-password -w -s selectel` or `pass show selectel`).
 */
function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct) return direct;
  const file = env[`${name}_FILE`];
  if (file) {
    const path = resolve(file.replace(/^~(?=\/)/, homedir()));
    if (process.platform !== "win32") {
      const mode = statSync(path).mode & 0o077;
      if (mode !== 0) {
        throw new ConfigError(`${name}_FILE (${path}) is readable by group/others; run: chmod 600 ${path}`);
      }
    }
    return readFileSync(path, "utf8").trim();
  }
  const cmd = env[`${name}_CMD`];
  if (cmd) {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
    return execFileSync(shell, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }
  return undefined;
}

function oneOf<T extends string>(name: string, v: string | undefined, allowed: readonly T[], dflt: T): T {
  if (!v) return dflt;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new ConfigError(`${name} must be one of: ${allowed.join(", ")} (got "${v}")`);
}

function int(name: string, v: string | undefined, dflt: number): number {
  if (!v) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const accountId = env.SELECTEL_ACCOUNT_ID ?? "";
  const username = env.SELECTEL_USERNAME ?? "";
  const password = secret(env, "SELECTEL_PASSWORD") ?? "";
  if (!accountId) missing.push("SELECTEL_ACCOUNT_ID");
  if (!username) missing.push("SELECTEL_USERNAME");
  if (!password) missing.push("SELECTEL_PASSWORD (or SELECTEL_PASSWORD_FILE / SELECTEL_PASSWORD_CMD)");
  if (missing.length) throw new ConfigError(`Missing required settings: ${missing.join(", ")}`);

  const s3Access = env.SELECTEL_S3_ACCESS_KEY;
  const s3Secret = secret(env, "SELECTEL_S3_SECRET_KEY");

  const audit = env.SELECTEL_AUDIT_LOG;
  const auditLog =
    audit === "off" || audit === "false" ? null : audit || join(homedir(), ".selectel-mcp", "audit.jsonl");

  return {
    accountId,
    username,
    password,
    userDomainName: env.SELECTEL_USER_DOMAIN_NAME || accountId,
    authUrl: (env.SELECTEL_AUTH_URL || "https://cloud.api.selcloud.ru/identity/v3").replace(/\/+$/, ""),
    authRegion: env.SELECTEL_AUTH_REGION || "ru-1",

    defaultProjectId: env.SELECTEL_PROJECT_ID || undefined,
    allowedProjects: list(env.SELECTEL_ALLOWED_PROJECTS),
    defaultRegion: env.SELECTEL_REGION || undefined,
    allowedRegions: list(env.SELECTEL_ALLOWED_REGIONS),

    mode: oneOf("SELECTEL_MCP_MODE", env.SELECTEL_MCP_MODE, ["readonly", "safe", "full"] as const, "readonly"),
    confirm: oneOf("SELECTEL_CONFIRM", env.SELECTEL_CONFIRM, ["auto", "elicit", "token", "none"] as const, "auto"),
    confirmTtlSec: int("SELECTEL_CONFIRM_TTL_SEC", env.SELECTEL_CONFIRM_TTL_SEC, 300),
    protectedServers: list(env.SELECTEL_PROTECTED_SERVERS) ?? [],
    protectedTag: env.SELECTEL_PROTECTED_TAG || "protected",
    maxServersPerCall: int("SELECTEL_MAX_SERVERS_PER_CALL", env.SELECTEL_MAX_SERVERS_PER_CALL, 3),
    enabledTools: list(env.SELECTEL_ENABLED_TOOLS),
    disabledTools: list(env.SELECTEL_DISABLED_TOOLS) ?? [],

    auditLog,
    filesRoot: resolve(env.SELECTEL_FILES_ROOT || process.cwd()),

    s3:
      s3Access && s3Secret
        ? { accessKey: s3Access, secretKey: s3Secret, defaultPool: env.SELECTEL_S3_POOL || "ru-1" }
        : undefined,

    httpTimeoutMs: int("SELECTEL_HTTP_TIMEOUT_MS", env.SELECTEL_HTTP_TIMEOUT_MS, 30000),
  };
}

/** Config without secrets — safe to show to the agent. */
export function publicConfig(c: Config) {
  return {
    accountId: c.accountId,
    username: c.username,
    authRegion: c.authRegion,
    defaultProjectId: c.defaultProjectId ?? null,
    allowedProjects: c.allowedProjects ?? "any",
    defaultRegion: c.defaultRegion ?? null,
    allowedRegions: c.allowedRegions ?? "any",
    mode: c.mode,
    confirm: c.confirm,
    protectedServers: c.protectedServers,
    protectedTag: c.protectedTag,
    maxServersPerCall: c.maxServersPerCall,
    auditLog: c.auditLog ?? "off",
    filesRoot: c.filesRoot,
    s3: c.s3 ? { configured: true, defaultPool: c.s3.defaultPool } : { configured: false },
  };
}
