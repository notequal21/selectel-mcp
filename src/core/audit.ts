import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "./redact.js";

export interface AuditEntry {
  tool: string;
  kind: string;
  args: unknown;
  outcome: "ok" | "error" | "cancelled" | "planned";
  summary?: string;
  error?: string;
  durationMs?: number;
}

/** Append-only JSONL log of every mutating call. File is created with 0600 permissions. */
export class AuditLog {
  private ready: Promise<void> | null = null;

  constructor(private readonly path: string | null) {}

  async write(entry: AuditEntry): Promise<void> {
    if (!this.path) return;
    try {
      this.ready ??= mkdir(dirname(this.path), { recursive: true, mode: 0o700 }).then(() => undefined);
      await this.ready;
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry, args: redact(entry.args) }) + "\n";
      await appendFile(this.path, line, { mode: 0o600 });
    } catch (e) {
      // Never fail a tool call because of the audit log, but make it visible on stderr.
      process.stderr.write(`[selectel-mcp] audit log write failed: ${(e as Error).message}\n`);
    }
  }
}
