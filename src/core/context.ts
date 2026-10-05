import { AuditLog } from "./audit.js";
import { SelectelClient, type Scope } from "./client.js";
import type { Config } from "./config.js";
import { ConfirmTokens } from "./confirm.js";

export interface Project {
  id: string;
  name: string;
  enabled?: boolean;
}

const PROJECT_ID_RE = /^[0-9a-f]{32}$/i;
const PROJECTS_TTL_MS = 5 * 60 * 1000;

/** Shared state handed to every tool. */
export class Context {
  readonly audit: AuditLog;
  readonly confirmTokens: ConfirmTokens;
  /** Filled after the MCP handshake: which client is connected and whether it claims dialog (elicitation) support. */
  client: { name?: string; version?: string; elicitation: boolean } | null = null;
  private projectsCache: { at: number; items: Project[] } | null = null;

  constructor(
    readonly config: Config,
    readonly api: SelectelClient,
  ) {
    this.audit = new AuditLog(config.auditLog);
    this.confirmTokens = new ConfirmTokens(config.confirmTtlSec);
  }

  /** All projects of the account (resell API v2), cached for 5 minutes. */
  async listProjects(force = false): Promise<Project[]> {
    if (!force && this.projectsCache && Date.now() - this.projectsCache.at < PROJECTS_TTL_MS) {
      return this.projectsCache.items;
    }
    const scope: Scope = { kind: "account" };
    const base = await this.api.endpoint("resell", scope, this.config.authRegion).catch(() =>
      this.api.endpoint("resell", scope),
    );
    const res = await this.api.requestUrl<{ projects?: Project[] }>(scope, `${base}/v2/projects`);
    const items = (res.projects ?? []).map((p) => ({ id: p.id, name: p.name, enabled: p.enabled }));
    this.projectsCache = { at: Date.now(), items };
    return items;
  }

  /** Project id is visible to tools if no allowlist is set, or if its id or name is in the allowlist. */
  isProjectAllowed(p: Project): boolean {
    const allow = this.config.allowedProjects;
    return !allow || allow.includes(p.id) || allow.includes(p.name);
  }

  /** Resolves a project id or name (or the default project) and enforces SELECTEL_ALLOWED_PROJECTS. */
  async resolveProject(projectIdOrName?: string): Promise<Project> {
    const wanted = projectIdOrName?.trim() || this.config.defaultProjectId;
    if (!wanted) {
      throw new Error(
        "Project is not specified and SELECTEL_PROJECT_ID is not set. Call projects_list and pass `project`.",
      );
    }
    let project: Project | undefined;
    if (PROJECT_ID_RE.test(wanted)) {
      // Don't require resell access just to use a known project id.
      project = (await this.listProjects().catch(() => [])).find((p) => p.id === wanted) ?? { id: wanted, name: wanted };
    } else {
      const all = await this.listProjects();
      const matches = all.filter((p) => p.name === wanted);
      if (matches.length > 1) throw new Error(`Project name "${wanted}" is ambiguous — pass the project id`);
      project = matches[0];
      if (!project) throw new Error(`Project "${wanted}" not found. Known: ${all.map((p) => p.name).join(", ")}`);
    }
    if (!this.isProjectAllowed(project)) {
      throw new Error(`Project "${project.name}" (${project.id}) is not in SELECTEL_ALLOWED_PROJECTS`);
    }
    return project;
  }

  async projectScope(projectIdOrName?: string): Promise<{ project: Project; scope: Scope }> {
    const project = await this.resolveProject(projectIdOrName);
    return { project, scope: { kind: "project", projectId: project.id } };
  }

  /** Resolves a region (pool) and enforces SELECTEL_ALLOWED_REGIONS. */
  resolveRegion(region?: string): string {
    const r = region?.trim() || this.config.defaultRegion;
    if (!r) throw new Error("Region is not specified and SELECTEL_REGION is not set. Call regions_list and pass `region`.");
    const allow = this.config.allowedRegions;
    if (allow && !allow.includes(r)) {
      throw new Error(`Region "${r}" is not in SELECTEL_ALLOWED_REGIONS (${allow.join(", ")})`);
    }
    return r;
  }

  /** Regions where the service is available for this project, filtered by the allowlist. */
  async availableRegions(serviceType: string, scope: Scope): Promise<string[]> {
    const regions = await this.api.regionsFor(serviceType, scope);
    const allow = this.config.allowedRegions;
    return allow ? regions.filter((r) => allow.includes(r)) : regions;
  }

  /** True if a server is protected from destructive operations by name/id list or by tag/metadata. */
  isServerProtected(server: { id: string; name?: string; tags?: string[]; metadata?: Record<string, string> }): boolean {
    const c = this.config;
    if (c.protectedServers.includes(server.id) || (server.name && c.protectedServers.includes(server.name))) return true;
    if (server.tags?.includes(c.protectedTag)) return true;
    const meta = server.metadata?.[c.protectedTag];
    return meta !== undefined && meta !== "false" && meta !== "0";
  }
}
