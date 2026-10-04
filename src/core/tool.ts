import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Context } from "./context.js";
import { redact, scrubText } from "./redact.js";

/**
 * read        — never changes anything; available in every mode.
 * write       — creates or changes resources but does not destroy data (mode "safe" and "full").
 * destructive — deletes resources or may lose data (mode "full" only). Always confirmed.
 */
export type ToolKind = "read" | "write" | "destructive";

export interface Plan {
  /** One-line human-readable description of what will happen. */
  summary: string;
  /** Structured details: current vs new state, affected resources, etc. */
  details?: unknown;
  /** Downtime, cost, irreversibility… */
  warnings?: string[];
}

export interface ToolDef<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  input: S;
  /** Required for write/destructive tools. Must not change anything. Throw to refuse (e.g. protected server). */
  plan?: (args: z.objectOutputType<S, z.ZodTypeAny>, ctx: Context) => Promise<Plan>;
  run: (args: z.objectOutputType<S, z.ZodTypeAny>, ctx: Context) => Promise<unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: text(redact(value)) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function matches(name: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

export function isToolEnabled(def: AnyToolDef, ctx: Context): boolean {
  const { mode, enabledTools, disabledTools } = ctx.config;
  if (def.kind === "write" && mode === "readonly") return false;
  if (def.kind === "destructive" && mode !== "full") return false;
  if (enabledTools && !matches(def.name, enabledTools)) return false;
  if (matches(def.name, disabledTools)) return false;
  return true;
}

function formatPlan(tool: string, plan: Plan): string {
  const lines = [`[${tool}] ${plan.summary}`];
  for (const w of plan.warnings ?? []) lines.push(`⚠ ${w}`);
  if (plan.details !== undefined) lines.push("", text(redact(plan.details)));
  return lines.join("\n");
}

type ConfirmResult = { proceed: true } | { proceed: false; result: CallToolResult };

async function confirm(
  server: McpServer,
  def: AnyToolDef,
  ctx: Context,
  args: Record<string, unknown>,
  confirmToken: string | undefined,
  plan: Plan,
): Promise<ConfirmResult> {
  let method = ctx.config.confirm;
  if (method === "none") {
    if (def.kind === "write") return { proceed: true };
    method = "auto";
  }
  const canElicit = Boolean(server.server.getClientCapabilities()?.elicitation);
  if (method === "elicit" && !canElicit) {
    return {
      proceed: false,
      result: fail(
        "SELECTEL_CONFIRM=elicit, but this MCP client does not support elicitation. Use a client with elicitation support or set SELECTEL_CONFIRM=token.",
      ),
    };
  }

  if (method === "elicit" || (method === "auto" && canElicit)) {
    const res = await server.server.elicitInput({
      mode: "form",
      message: `Selectel: подтвердите действие\n\n${formatPlan(def.name, plan)}`,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean", title: "Выполнить?", description: plan.summary, default: false },
        },
        required: ["confirm"],
      },
    });
    if (res.action === "accept" && res.content?.confirm === true) return { proceed: true };
    await ctx.audit.write({ tool: def.name, kind: def.kind, args, outcome: "cancelled", summary: plan.summary });
    return { proceed: false, result: ok(`Cancelled by user. Nothing was changed.\n\n${formatPlan(def.name, plan)}`) };
  }

  // token flow
  if (!confirmToken) {
    const { token, expiresInSec } = ctx.confirmTokens.issue(def.name, args);
    await ctx.audit.write({ tool: def.name, kind: def.kind, args, outcome: "planned", summary: plan.summary });
    return {
      proceed: false,
      result: ok(
        [
          "PLAN ONLY — nothing has been changed yet.",
          "",
          formatPlan(def.name, plan),
          "",
          `To execute: show this plan to the user, get their explicit approval, then call ${def.name} again with exactly the same arguments plus confirm_token="${token}" (valid ${expiresInSec}s, single use).`,
        ].join("\n"),
      ),
    };
  }
  const err = ctx.confirmTokens.consume(confirmToken, def.name, args);
  if (err) return { proceed: false, result: fail(err) };
  return { proceed: true };
}

export function registerTools(server: McpServer, ctx: Context, defs: AnyToolDef[]): string[] {
  const registered: string[] = [];
  const seen = new Set<string>();
  for (const def of defs) {
    if (seen.has(def.name)) throw new Error(`Duplicate tool name: ${def.name}`);
    seen.add(def.name);
    if (!isToolEnabled(def, ctx)) continue;
    if (def.kind !== "read" && !def.plan) throw new Error(`Tool ${def.name} must define plan()`);

    const mutating = def.kind !== "read";
    const shape = mutating
      ? {
          ...def.input,
          confirm_token: z
            .string()
            .optional()
            .describe("Token from the plan response. Omit on the first call to get a plan."),
        }
      : def.input;

    const description = mutating
      ? `${def.description}\n\n${
          def.kind === "destructive" ? "DESTRUCTIVE. " : ""
        }Changes Selectel resources: the call first returns a plan and requires explicit user confirmation.`
      : def.description;

    server.registerTool(
      def.name,
      {
        title: def.title,
        description,
        inputSchema: shape,
        annotations: {
          title: def.title,
          readOnlyHint: !mutating,
          destructiveHint: def.kind === "destructive",
          idempotentHint: !mutating,
          openWorldHint: true,
        },
      },
      async (rawArgs: Record<string, unknown>) => {
        const { confirm_token, ...args } = rawArgs as Record<string, unknown> & { confirm_token?: string };
        const started = Date.now();
        let plan: Plan | undefined;
        try {
          if (mutating) {
            plan = await def.plan!(args, ctx);
            const c = await confirm(server, def, ctx, args, confirm_token, plan);
            if (!c.proceed) return c.result;
          }
          const result = await def.run(args, ctx);
          if (mutating) {
            await ctx.audit.write({
              tool: def.name,
              kind: def.kind,
              args,
              outcome: "ok",
              summary: plan?.summary,
              durationMs: Date.now() - started,
            });
          }
          return ok(result);
        } catch (e) {
          const message = scrubText((e as Error).message ?? String(e), [
            ctx.config.password,
            ctx.config.s3?.secretKey,
          ]);
          if (mutating && plan) {
            await ctx.audit.write({
              tool: def.name,
              kind: def.kind,
              args,
              outcome: "error",
              summary: plan.summary,
              error: message,
              durationMs: Date.now() - started,
            });
          }
          return fail(`Error: ${message}`);
        }
      },
    );
    registered.push(def.name);
  }
  return registered;
}
