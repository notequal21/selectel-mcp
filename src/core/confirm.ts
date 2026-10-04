import { createHash, randomBytes } from "node:crypto";

interface Pending {
  tool: string;
  argsHash: string;
  expiresAt: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

export function hashArgs(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(args))).digest("hex");
}

/**
 * One-time confirmation tokens bound to (tool, exact arguments). A token cannot be reused, expires after `ttlSec`,
 * and becomes invalid if any argument changes — so the agent cannot get approval for one plan and execute another.
 */
export class ConfirmTokens {
  private pending = new Map<string, Pending>();

  constructor(private readonly ttlSec: number) {}

  issue(tool: string, args: unknown): { token: string; expiresInSec: number } {
    this.gc();
    const token = randomBytes(12).toString("base64url");
    this.pending.set(token, { tool, argsHash: hashArgs(args), expiresAt: Date.now() + this.ttlSec * 1000 });
    return { token, expiresInSec: this.ttlSec };
  }

  /** Validates and consumes the token. Returns an error message or null on success. */
  consume(token: string, tool: string, args: unknown): string | null {
    this.gc();
    const p = this.pending.get(token);
    if (!p) return "confirm_token is unknown, already used or expired — request a new plan (call without confirm_token)";
    if (p.tool !== tool) return "confirm_token was issued for a different tool";
    if (p.argsHash !== hashArgs(args)) {
      return "arguments differ from the confirmed plan — request a new plan (call without confirm_token)";
    }
    this.pending.delete(token);
    return null;
  }

  private gc() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
  }
}
