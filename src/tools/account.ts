import { z } from "zod";
import { publicConfig } from "../core/config.js";
import { defineTool, type AnyToolDef } from "../core/tool.js";

export const accountTools: AnyToolDef[] = [
  defineTool({
    name: "selectel_status",
    title: "MCP status & safety settings",
    kind: "read",
    description:
      "Shows the active safety settings of this MCP server (mode, allowed projects/regions, protected servers, confirmation method) and checks that Selectel credentials work. Call this first if unsure what is allowed.",
    input: {},
    async run(_args, ctx) {
      let auth: string;
      try {
        await ctx.api.getToken({ kind: "account" });
        auth = "ok";
      } catch (e) {
        auth = `failed: ${(e as Error).message}`;
      }
      return { auth, settings: publicConfig(ctx.config) };
    },
  }),
  defineTool({
    name: "projects_list",
    title: "List projects",
    kind: "read",
    description: "Lists cloud projects of the account (id, name). Projects outside SELECTEL_ALLOWED_PROJECTS are hidden.",
    input: {},
    async run(_args, ctx) {
      const projects = await ctx.listProjects(true);
      return projects
        .filter((p) => ctx.isProjectAllowed(p))
        .map((p) => ({ ...p, default: p.id === ctx.config.defaultProjectId }));
    },
  }),
  defineTool({
    name: "regions_list",
    title: "List regions (pools)",
    kind: "read",
    description: "Lists regions (pools such as ru-1, ru-3, ru-7, ru-9) where cloud servers are available for the project.",
    input: { project: z.string().optional().describe("Project id or name; default SELECTEL_PROJECT_ID") },
    async run(args, ctx) {
      const { project, scope } = await ctx.projectScope(args.project);
      const regions = await ctx.availableRegions("compute", scope);
      return { project, defaultRegion: ctx.config.defaultRegion ?? null, regions };
    },
  }),
];
