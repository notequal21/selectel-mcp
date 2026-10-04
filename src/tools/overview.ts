import { z } from "zod";
import type { Context } from "../core/context.js";
import { defineTool, type AnyToolDef } from "../core/tool.js";
import { projectArg } from "./common.js";

/**
 * Cross-module "everything at a glance" tool. Built from the other tools' run() functions so the logic
 * (IP classification, billing parsing) lives in one place.
 */
export function overviewTools(all: () => AnyToolDef[]): AnyToolDef[] {
  const run = async (name: string, args: Record<string, unknown>, ctx: Context) => {
    const def = all().find((d) => d.name === name);
    if (!def) return { skipped: `${name} is not available` };
    try {
      return await def.run(args, ctx);
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

  return [
    defineTool({
      name: "infra_overview",
      title: "Infrastructure overview",
      kind: "read",
      description:
        "One-call overview of a project: all servers in every allowed region (status, flavor, IPs), floating IPs and volumes per region (unattached ones still cost money), and the account balance/forecast. Use it to answer broad questions like 'what do I have and what does it cost'.",
      input: {
        project: projectArg,
        include_billing: z.boolean().default(true).describe("Include balance and spend summary"),
      },
      async run(args, ctx) {
        const { project, scope } = await ctx.projectScope(args.project);
        const regions = await ctx.availableRegions("compute", scope);
        const servers = await run("servers_list", { project: project.id, region: "all" }, ctx);
        const perRegion: Record<string, unknown> = {};
        await Promise.all(
          regions.map(async (region) => {
            const [floating_ips, volumes] = await Promise.all([
              run("floating_ips_list", { project: project.id, region }, ctx),
              run("volumes_list", { project: project.id, region }, ctx),
            ]);
            perRegion[region] = { floating_ips, volumes };
          }),
        );
        const billing = args.include_billing ? await run("billing_summary", {}, ctx) : undefined;
        return { project, regions, servers, per_region: perRegion, billing };
      },
    }),
  ];
}
