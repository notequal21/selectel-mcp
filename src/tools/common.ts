import { z } from "zod";
import type { RequestOptions, Scope } from "../core/client.js";
import type { Context, Project } from "../core/context.js";

/** Standard optional location arguments for regional (OpenStack) tools. */
export const projectArg = z.string().optional().describe("Project id or name; default SELECTEL_PROJECT_ID");
export const regionArg = z
  .string()
  .optional()
  .describe(
    "Region/pool, e.g. ru-9; default SELECTEL_REGION. For tools that take a server name/id it may be omitted: the server is then searched in all regions",
  );

export interface Location {
  project: Project;
  region: string;
  scope: Scope;
}

export async function resolveLocation(ctx: Context, args: { project?: string; region?: string }): Promise<Location> {
  const { project, scope } = await ctx.projectScope(args.project);
  const region = ctx.resolveRegion(args.region);
  return { project, region, scope };
}

/** OpenStack service types in the Selectel catalog. */
export type OsService = "compute" | "network" | "image" | "volumev3" | "load-balancer";

export function os<T = unknown>(
  ctx: Context,
  loc: Location,
  service: OsService,
  path: string,
  opts?: RequestOptions,
): Promise<T> {
  return ctx.api.request<T>(service, loc.scope, loc.region, path, opts);
}

/** Polls `check` until it returns a value or the timeout expires. */
export async function waitFor<T>(
  check: () => Promise<T | undefined>,
  { timeoutMs = 300_000, intervalMs = 5_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() + intervalMs > deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
