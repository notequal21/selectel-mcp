import { z } from "zod";
import { SelectelApiError } from "../core/client.js";
import type { Context } from "../core/context.js";
import { defineTool, type AnyToolDef } from "../core/tool.js";
import { os, projectArg, regionArg, resolveLocation, waitFor, type Location } from "./common.js";
import { createCustomFlavor, customFlavorName, listFlavors, normFlavor, type Flavor } from "./compute-catalog.js";

/** Polling settings; tests lower the interval. */
export const timing = { intervalMs: 5_000 };

const NOVA_HDR = { "X-OpenStack-Nova-API-Version": "2.26" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

// ---------- helpers ----------

export function isPrivateIp(addr: string): boolean {
  if (addr.includes(":")) {
    const a = addr.toLowerCase();
    return a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80");
  }
  const p = addr.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  const [a, b] = p as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

interface IpInfo {
  addr: string;
  network: string;
  type: "fixed" | "floating";
  scope: "public" | "private";
  version: number;
}

function classifyAddresses(addresses: Raw | undefined): IpInfo[] {
  const out: IpInfo[] = [];
  for (const [network, list] of Object.entries(addresses ?? {})) {
    for (const a of (list as Raw[]) ?? []) {
      out.push({
        addr: a.addr,
        network,
        type: a["OS-EXT-IPS:type"] === "floating" ? "floating" : "fixed",
        scope: isPrivateIp(a.addr) ? "private" : "public",
        version: a.version ?? (String(a.addr).includes(":") ? 6 : 4),
      });
    }
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function protectedMeta(ctx: Context, srv: Raw): boolean {
  const meta: Record<string, string> = srv.metadata ?? {};
  const m = meta.protected;
  return (
    ctx.isServerProtected({ id: srv.id, name: srv.name, tags: srv.tags, metadata: meta }) ||
    (m !== undefined && m !== "false" && m !== "0")
  );
}

function assertNotProtected(ctx: Context, srv: Raw, what: string): void {
  if (protectedMeta(ctx, srv)) {
    throw new Error(
      `Server "${srv.name}" (${srv.id}) is protected; refusing to ${what}. Remove protection with server_unprotect first (if it is protected via SELECTEL_PROTECTED_SERVERS, edit the server configuration).`,
    );
  }
}

type FlavorCache = Map<string, Promise<Flavor | undefined>>;

async function flavorOf(ctx: Context, loc: Location, srv: Raw, cache: FlavorCache) {
  const f = srv.flavor ?? {};
  if (f.vcpus !== undefined && f.ram !== undefined) {
    return { id: f.id, name: f.original_name ?? f.name, vcpus: f.vcpus as number, ram_mb: f.ram as number };
  }
  if (!f.id) return { id: undefined, name: undefined, vcpus: undefined, ram_mb: undefined };
  const key = `${loc.region}:${f.id}`;
  let p = cache.get(key);
  if (!p) {
    p = os<{ flavor: Raw }>(ctx, loc, "compute", `/flavors/${f.id}`)
      .then((r) => normFlavor(r.flavor as never))
      .catch(() => undefined);
    cache.set(key, p);
  }
  const full = await p;
  return { id: f.id as string, name: full?.name, vcpus: full?.vcpus, ram_mb: full?.ram_mb };
}

async function summarize(ctx: Context, loc: Location, srv: Raw, cache: FlavorCache) {
  const ips = classifyAddresses(srv.addresses);
  return {
    id: srv.id as string,
    name: srv.name as string,
    status: srv.status as string,
    region: loc.region,
    flavor: await flavorOf(ctx, loc, srv, cache),
    public_ips: ips.filter((i) => i.scope === "public").map((i) => i.addr),
    private_ips: ips.filter((i) => i.scope === "private").map((i) => i.addr),
    floating_ips: ips.filter((i) => i.type === "floating").map((i) => i.addr),
    created: srv.created as string,
    metadata: (srv.metadata ?? {}) as Record<string, string>,
    tags: (srv.tags ?? []) as string[],
    protected: protectedMeta(ctx, srv),
  };
}

async function fetchServer(ctx: Context, loc: Location, id: string): Promise<Raw> {
  const r = await os<{ server: Raw }>(ctx, loc, "compute", `/servers/${id}`, { headers: NOVA_HDR });
  return r.server;
}

/** Finds a server by id or exact name in one region. Ambiguous names list candidates. */
async function resolveServer(ctx: Context, loc: Location, ref: string): Promise<Raw> {
  if (UUID_RE.test(ref)) {
    try {
      return await fetchServer(ctx, loc, ref);
    } catch (e) {
      if (!(e instanceof SelectelApiError && e.status === 404)) throw e;
    }
  }
  const res = await os<{ servers?: Raw[] }>(ctx, loc, "compute", "/servers/detail", {
    query: { name: `^${esc(ref)}$` },
    headers: NOVA_HDR,
  });
  const matches = (res.servers ?? []).filter((s) => s.name === ref);
  if (matches.length === 0) throw new Error(`Server "${ref}" not found in ${loc.region}. Use servers_list or server_find.`);
  if (matches.length > 1) {
    throw new Error(
      `Server name "${ref}" is ambiguous in ${loc.region}; pass the id. Candidates: ${matches
        .map((s) => `${s.id} (${s.status})`)
        .join(", ")}`,
    );
  }
  return matches[0]!;
}

async function waitStatus(
  ctx: Context,
  loc: Location,
  id: string,
  targets: string[],
  timeoutMs: number,
): Promise<{ server: Raw; reached: boolean }> {
  let last: Raw | undefined;
  const hit = await waitFor(
    async () => {
      last = await fetchServer(ctx, loc, id);
      return targets.includes(last.status) || last.status === "ERROR" ? last : undefined;
    },
    { timeoutMs, intervalMs: timing.intervalMs },
  );
  const server = hit ?? last ?? (await fetchServer(ctx, loc, id));
  return { server, reached: targets.includes(server.status) };
}

async function serverAction(ctx: Context, loc: Location, id: string, body: unknown, headers?: Record<string, string>) {
  return os<Raw | undefined>(ctx, loc, "compute", `/servers/${id}/action`, { method: "POST", body, headers });
}

async function regionsFor(ctx: Context, args: { project?: string; region?: string }): Promise<Location[]> {
  if (args.region?.trim() === "all") {
    const { project, scope } = await ctx.projectScope(args.project);
    const regions = await ctx.availableRegions("compute", scope);
    return regions.map((region) => ({ project, region, scope }));
  }
  return [await resolveLocation(ctx, args)];
}

interface ListFilter {
  name?: string;
  ip?: string;
  status?: string;
}

async function collectServers(ctx: Context, locs: Location[], f: ListFilter) {
  const cache: FlavorCache = new Map();
  const errors: { region: string; error: string }[] = [];
  const servers: Awaited<ReturnType<typeof summarize>>[] = [];
  await Promise.all(
    locs.map(async (loc) => {
      try {
        const res = await os<{ servers?: Raw[] }>(ctx, loc, "compute", "/servers/detail", {
          query: { status: f.status?.toUpperCase() },
          headers: NOVA_HDR,
        });
        for (const s of res.servers ?? []) {
          if (f.name && !String(s.name).toLowerCase().includes(f.name.toLowerCase())) continue;
          if (f.ip && !classifyAddresses(s.addresses).some((i) => i.addr.includes(f.ip!))) continue;
          servers.push(await summarize(ctx, loc, s, cache));
        }
      } catch (e) {
        errors.push({ region: loc.region, error: (e as Error).message });
      }
    }),
  );
  servers.sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name));
  return { servers, ...(errors.length ? { errors } : {}) };
}

// ----- flavor / image / network resolution -----

interface FlavorSpec {
  flavor?: string;
  vcpus?: number;
  ram_mb?: number;
}

function checkFlavorSpec(s: FlavorSpec): void {
  const byParams = s.vcpus !== undefined || s.ram_mb !== undefined;
  if (s.flavor && byParams) throw new Error("Pass either `flavor` or `vcpus`+`ram_mb`, not both.");
  if (!s.flavor && (s.vcpus === undefined || s.ram_mb === undefined)) {
    throw new Error("Specify `flavor` (id or name) or both `vcpus` and `ram_mb`.");
  }
}

interface FlavorChoice {
  flavor?: Flavor;
  toCreate?: { name: string; vcpus: number; ram_mb: number; disk_gb: number };
}

async function resolveFlavor(ctx: Context, loc: Location, s: FlavorSpec): Promise<FlavorChoice> {
  checkFlavorSpec(s);
  const all = await listFlavors(ctx, loc);
  if (s.flavor) {
    const f = all.find((x) => x.id === s.flavor) ?? all.find((x) => x.name === s.flavor);
    if (!f) {
      const hint = all
        .filter((x) => x.name.toLowerCase().includes(s.flavor!.toLowerCase()))
        .slice(0, 10)
        .map((x) => x.name);
      throw new Error(`Flavor "${s.flavor}" not found in ${loc.region}.${hint.length ? ` Similar: ${hint.join(", ")}` : " Use flavors_list."}`);
    }
    return { flavor: f };
  }
  const match = all
    .filter((f) => f.vcpus === s.vcpus && f.ram_mb === s.ram_mb)
    .sort((a, b) => Number(b.is_public) - Number(a.is_public) || a.disk_gb - b.disk_gb)[0];
  if (match) return { flavor: match };
  return { toCreate: { name: customFlavorName(s.vcpus!, s.ram_mb!), vcpus: s.vcpus!, ram_mb: s.ram_mb!, disk_gb: 0 } };
}

async function ensureFlavor(ctx: Context, loc: Location, c: FlavorChoice): Promise<Flavor> {
  return c.flavor ?? createCustomFlavor(ctx, loc, c.toCreate!);
}

interface ImageInfo {
  id: string;
  name: string;
  min_disk: number;
}

async function resolveImage(ctx: Context, loc: Location, ref: string): Promise<ImageInfo> {
  if (UUID_RE.test(ref)) {
    const i = await os<Raw>(ctx, loc, "image", `/v2/images/${ref}`);
    return { id: i.id, name: i.name, min_disk: i.min_disk ?? 0 };
  }
  const res = await os<{ images?: Raw[] }>(ctx, loc, "image", "/v2/images", { query: { name: ref, status: "active" } });
  const exact = (res.images ?? []).filter((i) => i.name === ref);
  if (exact.length === 1) return { id: exact[0]!.id, name: exact[0]!.name, min_disk: exact[0]!.min_disk ?? 0 };
  if (exact.length > 1) {
    throw new Error(`Image name "${ref}" is ambiguous: ${exact.map((i) => i.id).join(", ")}. Pass the image id.`);
  }
  const all = await os<{ images?: Raw[] }>(ctx, loc, "image", "/v2/images", { query: { status: "active", limit: 1000 } });
  const similar = (all.images ?? [])
    .filter((i) => String(i.name).toLowerCase().includes(ref.toLowerCase()))
    .slice(0, 10)
    .map((i) => `${i.name} (${i.id})`);
  throw new Error(`Image "${ref}" not found in ${loc.region}.${similar.length ? ` Similar: ${similar.join("; ")}` : " Use images_list."}`);
}

async function resolveNetworks(ctx: Context, loc: Location, refs?: string[]): Promise<{ id: string; name: string }[]> {
  const res = await os<{ networks?: Raw[] }>(ctx, loc, "network", "/v2.0/networks");
  const nets = res.networks ?? [];
  if (refs?.length) {
    return refs.map((r) => {
      const n = nets.find((x) => x.id === r) ?? nets.find((x) => x.name === r);
      if (!n) throw new Error(`Network "${r}" not found in ${loc.region}. Available: ${nets.map((x) => `${x.name} (${x.id})`).join(", ")}`);
      return { id: n.id, name: n.name };
    });
  }
  const internal = nets.filter((n) => !n["router:external"]);
  if (internal.length === 1) return [{ id: internal[0]!.id, name: internal[0]!.name }];
  throw new Error(
    `${internal.length === 0 ? "No private networks" : "Several private networks"} in ${loc.region}; pass network_ids. Networks: ${nets
      .map((n) => `${n.name} (${n.id})${n["router:external"] ? " [external]" : ""}`)
      .join(", ")}`,
  );
}

async function attachFloatingIp(ctx: Context, loc: Location, serverId: string): Promise<{ id: string; address: string }> {
  const nets = await os<{ networks?: Raw[] }>(ctx, loc, "network", "/v2.0/networks", { query: { "router:external": true } });
  const ext = (nets.networks ?? []).find((n) => n.name === "external-network") ?? nets.networks?.[0];
  if (!ext) throw new Error(`No external network found in ${loc.region} to allocate a floating IP from.`);
  const ports = await os<{ ports?: Raw[] }>(ctx, loc, "network", "/v2.0/ports", { query: { device_id: serverId } });
  const port = (ports.ports ?? []).find((p) => (p.fixed_ips ?? []).length > 0);
  if (!port) throw new Error(`Server ${serverId} has no network port with a fixed IP; cannot attach a floating IP.`);
  const r = await os<{ floatingip: Raw }>(ctx, loc, "network", "/v2.0/floatingips", {
    method: "POST",
    body: { floatingip: { floating_network_id: ext.id, port_id: port.id } },
  });
  return { id: r.floatingip.id, address: r.floatingip.floating_ip_address };
}

async function serverFloatingIps(ctx: Context, loc: Location, serverId: string): Promise<{ id: string; address: string }[]> {
  const ports = await os<{ ports?: Raw[] }>(ctx, loc, "network", "/v2.0/ports", { query: { device_id: serverId } });
  const ids = (ports.ports ?? []).map((p) => p.id as string);
  if (ids.length === 0) return [];
  const fips = await os<{ floatingips?: Raw[] }>(ctx, loc, "network", "/v2.0/floatingips", { query: { port_id: ids } });
  return (fips.floatingips ?? []).map((f) => ({ id: f.id, address: f.floating_ip_address }));
}

async function volumesOf(ctx: Context, loc: Location, srv: Raw) {
  const attached: Raw[] = srv["os-extended-volumes:volumes_attached"] ?? [];
  return Promise.all(
    attached.map(async (a) => {
      const base = { id: a.id as string, delete_on_termination: Boolean(a.delete_on_termination) };
      try {
        const { volume: v } = await os<{ volume: Raw }>(ctx, loc, "volumev3", `/volumes/${a.id}`);
        return {
          ...base,
          name: v.name as string,
          size_gb: v.size as number,
          type: v.volume_type as string,
          bootable: v.bootable === "true" || v.bootable === true,
          status: v.status as string,
          device: (v.attachments ?? []).find((x: Raw) => x.server_id === srv.id)?.device as string | undefined,
          image: v.volume_image_metadata?.image_name as string | undefined,
        };
      } catch {
        return base;
      }
    }),
  );
}

const serverRef = z.string().min(1).max(255).describe("Server id (UUID) or exact name");
const waitArg = z.boolean().default(true).describe("Wait until the operation completes");

// ---------- tools ----------

export const serverTools: AnyToolDef[] = [
  defineTool({
    name: "servers_list",
    title: "List servers",
    kind: "read",
    description:
      "Lists cloud servers with status, flavor, public/private/floating IPs, metadata and protected flag. Use region \"all\" to scan every available region. For a single server's full details use server_get.",
    input: {
      project: projectArg,
      region: z.string().optional().describe('Region/pool, e.g. ru-9, or "all" for every available region; default SELECTEL_REGION'),
      name: z.string().max(255).optional().describe("Case-insensitive substring of the server name"),
      ip: z.string().max(64).optional().describe("IP address (or part of it) of the server"),
      status: z.string().max(32).optional().describe("Status filter, e.g. ACTIVE, SHUTOFF, ERROR"),
    },
    async run(args, ctx) {
      const locs = await regionsFor(ctx, args);
      return collectServers(ctx, locs, args);
    },
  }),

  defineTool({
    name: "server_find",
    title: "Find servers by name or IP",
    kind: "read",
    description: "Searches servers by name substring or IP address across all allowed regions. Use when you don't know which region a server is in.",
    input: {
      project: projectArg,
      query: z.string().min(1).max(255).describe("Name substring or IP address"),
      region: z.string().default("all").describe('Region or "all" (default)'),
    },
    async run(args, ctx) {
      const locs = await regionsFor(ctx, args);
      const byName = await collectServers(ctx, locs, { name: args.query });
      const byIp = /^[\d.:a-f]+$/i.test(args.query) ? await collectServers(ctx, locs, { ip: args.query }) : { servers: [] };
      const seen = new Set<string>();
      const servers = [...byName.servers, ...byIp.servers].filter((s) => !seen.has(s.id) && seen.add(s.id));
      return { servers, ...("errors" in byName ? { errors: byName.errors } : {}) };
    },
  }),

  defineTool({
    name: "server_get",
    title: "Get server details",
    kind: "read",
    description:
      "Full details of one server by id or exact name: status, IPs (floating/fixed, public/private), flavor, image, key, attached volumes, security groups, availability zone, metadata. Use this to answer questions like \"what is the IP of server X\".",
    input: { project: projectArg, region: regionArg, server: serverRef },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      const base = await summarize(ctx, loc, srv, new Map());
      const volumes = await volumesOf(ctx, loc, srv);
      const bootVol = volumes.find((v) => "bootable" in v && v.bootable) as { image?: string } | undefined;
      return {
        ...base,
        ips: classifyAddresses(srv.addresses),
        image: srv.image?.id ? { id: srv.image.id } : bootVol?.image ? { name: bootVol.image, boot_from_volume: true } : null,
        key_name: srv.key_name ?? null,
        availability_zone: srv["OS-EXT-AZ:availability_zone"],
        security_groups: (srv.security_groups ?? []).map((g: Raw) => g.name),
        volumes,
        power_state: srv["OS-EXT-STS:power_state"],
        task_state: srv["OS-EXT-STS:task_state"],
        fault: srv.fault?.message,
        updated: srv.updated,
      };
    },
  }),

  defineTool({
    name: "server_create",
    title: "Create server(s)",
    kind: "write",
    description:
      "Creates one or more cloud servers booting from a new volume created from an image. Choose flavor by id/name, or vcpus+ram_mb (exact public flavor, otherwise a private flavor is created). Use flavors_list, images_list, volume_types_list, availability_zones_list first if unsure. Billing starts immediately.",
    input: {
      project: projectArg,
      region: regionArg,
      name: z.string().min(1).max(63).regex(/^[\w.-]+$/, "letters, digits, . _ -").describe("Server name (suffix -1, -2... added if count > 1)"),
      flavor: z.string().max(255).optional().describe("Flavor id or name"),
      vcpus: z.number().int().min(1).max(128).optional().describe("vCPUs (with ram_mb) instead of flavor"),
      ram_mb: z.number().int().min(512).max(1048576).optional().describe("RAM in MB (with vcpus) instead of flavor"),
      image: z.string().min(1).max(255).describe("Image id or exact name"),
      size_gb: z.number().int().min(1).max(32000).describe("Boot volume size in GB"),
      volume_type: z.string().max(100).optional().describe("Volume type, e.g. fast.ru-9a; default: universal* type of the zone"),
      availability_zone: z.string().max(50).optional().describe("Availability zone, e.g. ru-9a; default <region>a if it exists"),
      network_ids: z.array(z.string().max(100)).max(10).optional().describe("Network ids or names; default: the only private network"),
      key_name: z.string().max(255).optional().describe("SSH keypair name"),
      user_data: z.string().max(65536).optional().describe("cloud-init user data (plain text; encoded to base64 automatically)"),
      security_groups: z.array(z.string().max(255)).max(20).optional().describe("Security group names"),
      metadata: z.record(z.string().max(255), z.string().max(255)).optional().describe("Server metadata key/value pairs"),
      protect: z.boolean().default(false).describe("Mark the server as protected from destructive operations"),
      count: z.number().int().min(1).max(50).default(1).describe("Number of servers to create"),
      assign_floating_ip: z.boolean().default(false).describe("Allocate a floating (public) IP and attach it; requires wait=true. Billed separately"),
      wait: waitArg,
    },
    async plan(args, ctx) {
      const p = await prepareCreate(args, ctx);
      return {
        summary: `Create ${args.count} server(s) "${args.name}" in ${p.loc.region} (${p.flavorDesc}, ${args.size_gb} GB ${p.volumeType ?? "default"} boot volume, image ${p.image.name})`,
        details: {
          project: p.loc.project.name,
          region: p.loc.region,
          count: args.count,
          names: p.names,
          flavor: p.flavorDesc,
          image: { id: p.image.id, name: p.image.name },
          boot_volume: { size_gb: args.size_gb, type: p.volumeType ?? "(cloud default)", delete_on_termination: true },
          availability_zone: p.az ?? "(cloud default)",
          networks: p.networks,
          key_name: args.key_name,
          security_groups: args.security_groups,
          user_data: args.user_data ? `${args.user_data.length} chars (cloud-init)` : undefined,
          metadata: p.metadata,
          assign_floating_ip: args.assign_floating_ip,
          wait: args.wait,
        },
        warnings: [
          "Billing for the servers and boot volumes starts immediately.",
          ...(p.choice.toCreate
            ? [`No public flavor with exactly ${p.choice.toCreate.vcpus} vCPU / ${p.choice.toCreate.ram_mb} MB; a private flavor "${p.choice.toCreate.name}" will be created.`]
            : []),
          ...(args.assign_floating_ip ? ["A floating IP will be allocated for each server; it is billed separately and stays allocated after server deletion unless released."] : []),
          ...(args.key_name || args.user_data ? [] : ["No SSH key and no user_data: you may not be able to log in to the server."]),
        ],
      };
    },
    async run(args, ctx) {
      const p = await prepareCreate(args, ctx);
      const flavor = await ensureFlavor(ctx, p.loc, p.choice);
      const results: Raw[] = [];
      for (const name of p.names) {
        const body: Raw = {
          name,
          flavorRef: flavor.id,
          networks: p.networks.map((n) => ({ uuid: n.id })),
          block_device_mapping_v2: [
            {
              boot_index: 0,
              uuid: p.image.id,
              source_type: "image",
              destination_type: "volume",
              volume_size: args.size_gb,
              ...(p.volumeType ? { volume_type: p.volumeType } : {}),
              delete_on_termination: true,
            },
          ],
          ...(p.az ? { availability_zone: p.az } : {}),
          ...(args.key_name ? { key_name: args.key_name } : {}),
          ...(args.user_data ? { user_data: Buffer.from(args.user_data, "utf8").toString("base64") } : {}),
          ...(args.security_groups?.length ? { security_groups: args.security_groups.map((n) => ({ name: n })) } : {}),
          ...(Object.keys(p.metadata).length ? { metadata: p.metadata } : {}),
        };
        const r = await os<{ server: Raw }>(ctx, p.loc, "compute", "/servers", { method: "POST", body: { server: body } });
        results.push({ id: r.server.id, name, status: "BUILD" });
      }
      if (!args.wait) return { created: results, note: "Not waiting; use server_wait or server_get to check status." };
      const out: Raw[] = [];
      for (const r of results) {
        const { server, reached } = await waitStatus(ctx, p.loc, r.id, ["ACTIVE"], 10 * 60_000);
        const entry: Raw = { id: r.id, name: r.name, status: server.status };
        if (server.status === "ERROR") entry.fault = server.fault?.message;
        else if (!reached) entry.note = "Timed out waiting for ACTIVE; still building.";
        if (reached && args.assign_floating_ip) {
          try {
            entry.floating_ip = (await attachFloatingIp(ctx, p.loc, r.id)).address;
          } catch (e) {
            entry.floating_ip_error = (e as Error).message;
          }
        }
        const fresh = await fetchServer(ctx, p.loc, r.id);
        const ips = classifyAddresses(fresh.addresses);
        entry.public_ips = ips.filter((i) => i.scope === "public").map((i) => i.addr);
        entry.private_ips = ips.filter((i) => i.scope === "private").map((i) => i.addr);
        if (entry.floating_ip && !entry.public_ips.includes(entry.floating_ip)) entry.public_ips.push(entry.floating_ip);
        out.push(entry);
      }
      return { region: p.loc.region, servers: out };
    },
  }),

  defineTool({
    name: "server_action",
    title: "Start / stop / reboot server",
    kind: "write",
    description: "Starts, stops (power off) or reboots a server. Stopped servers still incur disk costs. Use server_delete to remove a server.",
    input: {
      project: projectArg,
      region: regionArg,
      server: serverRef,
      action: z.enum(["start", "stop", "reboot"]).describe("Action to perform"),
      reboot_type: z.enum(["soft", "hard"]).default("soft").describe("For reboot: soft (graceful) or hard (power cycle)"),
      wait: waitArg,
    },
    async plan(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      if (args.action === "start" && srv.status === "ACTIVE") throw new Error(`Server "${srv.name}" is already ACTIVE.`);
      if (args.action === "stop" && srv.status === "SHUTOFF") throw new Error(`Server "${srv.name}" is already SHUTOFF.`);
      const label = args.action === "reboot" ? `${args.reboot_type} reboot` : args.action;
      return {
        summary: `${label} server "${srv.name}" (${srv.id}) in ${loc.region}; current status ${srv.status}`,
        details: { id: srv.id, name: srv.name, current_status: srv.status, action: label, wait: args.wait },
        warnings:
          args.action === "start"
            ? []
            : [args.action === "stop" ? "The server will go offline until started again; services on it become unavailable." : `Short downtime during reboot${args.reboot_type === "hard" ? "; hard reboot may lose unsaved data" : ""}.`],
      };
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      const body =
        args.action === "start"
          ? { "os-start": null }
          : args.action === "stop"
            ? { "os-stop": null }
            : { reboot: { type: args.reboot_type.toUpperCase() } };
      await serverAction(ctx, loc, srv.id, body);
      if (!args.wait) return { id: srv.id, name: srv.name, requested: args.action };
      const target = args.action === "stop" ? "SHUTOFF" : "ACTIVE";
      if (args.action === "reboot") {
        // Give Nova a moment to leave ACTIVE so we do not return before the reboot starts.
        await waitFor(async () => ((await fetchServer(ctx, loc, srv.id)).status !== "ACTIVE" ? true : undefined), {
          timeoutMs: Math.min(15_000, timing.intervalMs * 3),
          intervalMs: timing.intervalMs,
        });
      }
      const { server, reached } = await waitStatus(ctx, loc, srv.id, [target], 5 * 60_000);
      return { id: srv.id, name: srv.name, status: server.status, reached_target: reached, fault: server.fault?.message };
    },
  }),

  defineTool({
    name: "server_resize",
    title: "Resize server (change flavor)",
    kind: "write",
    description:
      "Changes a server's vCPU/RAM by switching flavor (by id/name or vcpus+ram_mb). The server is rebooted (downtime), the resize is confirmed automatically. Disk size is not changed; extend volumes separately.",
    input: {
      project: projectArg,
      region: regionArg,
      server: serverRef,
      flavor: z.string().max(255).optional().describe("New flavor id or name"),
      vcpus: z.number().int().min(1).max(128).optional().describe("New vCPUs (with ram_mb)"),
      ram_mb: z.number().int().min(512).max(1048576).optional().describe("New RAM in MB (with vcpus)"),
    },
    async plan(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      if (!["ACTIVE", "SHUTOFF"].includes(srv.status)) throw new Error(`Server is ${srv.status}; resize requires ACTIVE or SHUTOFF.`);
      const choice = await resolveFlavor(ctx, loc, args);
      const cur = await flavorOf(ctx, loc, srv, new Map());
      if (choice.flavor && choice.flavor.id === cur.id) throw new Error(`Server already uses flavor "${choice.flavor.name}".`);
      const nf = choice.flavor ?? { name: choice.toCreate!.name, vcpus: choice.toCreate!.vcpus, ram_mb: choice.toCreate!.ram_mb };
      return {
        summary: `Resize "${srv.name}" in ${loc.region}: ${cur.vcpus} vCPU/${cur.ram_mb} MB -> ${nf.vcpus} vCPU/${nf.ram_mb} MB`,
        details: {
          id: srv.id,
          name: srv.name,
          status: srv.status,
          current: { flavor: cur.name, vcpus: cur.vcpus, ram_mb: cur.ram_mb },
          new: { flavor: nf.name, vcpus: nf.vcpus, ram_mb: nf.ram_mb },
        },
        warnings: [
          "The server will be rebooted: expect several minutes of downtime.",
          "Billing changes according to the new flavor.",
          ...(choice.toCreate ? [`A private flavor "${choice.toCreate.name}" will be created.`] : []),
          "Disk size is not changed.",
        ],
      };
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      const choice = await resolveFlavor(ctx, loc, args);
      const flavor = await ensureFlavor(ctx, loc, choice);
      const originalStatus = srv.status as string;
      await serverAction(ctx, loc, srv.id, { resize: { flavorRef: flavor.id } });
      const r1 = await waitStatus(ctx, loc, srv.id, ["VERIFY_RESIZE"], 10 * 60_000);
      if (r1.server.status !== "VERIFY_RESIZE") {
        return { id: srv.id, status: r1.server.status, error: r1.server.fault?.message ?? "Resize did not reach VERIFY_RESIZE", flavor: flavor.name };
      }
      await serverAction(ctx, loc, srv.id, { confirmResize: null });
      const r2 = await waitStatus(ctx, loc, srv.id, [originalStatus === "SHUTOFF" ? "SHUTOFF" : "ACTIVE"], 5 * 60_000);
      return {
        id: srv.id,
        name: srv.name,
        status: r2.server.status,
        flavor: flavor.name,
        vcpus: flavor.vcpus,
        ram_mb: flavor.ram_mb,
        ...(r2.server.status === "ERROR" ? { error: r2.server.fault?.message } : {}),
      };
    },
  }),

  defineTool({
    name: "server_rename",
    title: "Rename server",
    kind: "write",
    description: "Renames a server (display name only; the hostname inside the OS is not changed).",
    input: { project: projectArg, region: regionArg, server: serverRef, new_name: z.string().min(1).max(255).describe("New server name") },
    async plan(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      return { summary: `Rename server ${srv.id} "${srv.name}" -> "${args.new_name}" in ${loc.region}`, details: { id: srv.id, from: srv.name, to: args.new_name } };
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      await os(ctx, loc, "compute", `/servers/${srv.id}`, { method: "PUT", body: { server: { name: args.new_name } } });
      return { id: srv.id, name: args.new_name };
    },
  }),

  defineTool({
    name: "server_set_metadata",
    title: "Set / remove server metadata",
    kind: "write",
    description: "Adds/updates and/or removes metadata keys on a server. The protection key is managed only by server_protect / server_unprotect.",
    input: {
      project: projectArg,
      region: regionArg,
      server: serverRef,
      set: z.record(z.string().min(1).max(255), z.string().max(255)).optional().describe("Keys to set"),
      remove: z.array(z.string().min(1).max(255)).max(50).optional().describe("Keys to remove"),
    },
    async plan(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      checkMetaKeys(ctx, args);
      if (!Object.keys(args.set ?? {}).length && !args.remove?.length) throw new Error("Nothing to do: pass `set` and/or `remove`.");
      const current: Record<string, string> = srv.metadata ?? {};
      return {
        summary: `Update metadata of "${srv.name}" in ${loc.region}`,
        details: {
          id: srv.id,
          set: Object.fromEntries(Object.entries(args.set ?? {}).map(([k, v]) => [k, { from: current[k] ?? null, to: v }])),
          remove: (args.remove ?? []).map((k) => ({ key: k, current: current[k] ?? null })),
        },
      };
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      checkMetaKeys(ctx, args);
      if (Object.keys(args.set ?? {}).length) {
        await os(ctx, loc, "compute", `/servers/${srv.id}/metadata`, { method: "POST", body: { metadata: args.set } });
      }
      for (const k of args.remove ?? []) {
        await os(ctx, loc, "compute", `/servers/${srv.id}/metadata/${encodeURIComponent(k)}`, { method: "DELETE" });
      }
      const r = await os<{ metadata: Record<string, string> }>(ctx, loc, "compute", `/servers/${srv.id}/metadata`);
      return { id: srv.id, metadata: r.metadata };
    },
  }),

  defineTool({
    name: "server_protect",
    title: "Protect server",
    kind: "write",
    description: "Marks a server as protected (metadata flag) so delete and rebuild are refused.",
    input: { project: projectArg, region: regionArg, server: serverRef },
    async plan(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      return {
        summary: `Protect server "${srv.name}" (${srv.id}) in ${loc.region}`,
        details: { id: srv.id, metadata_key: ctx.config.protectedTag, already_protected: protectedMeta(ctx, srv) },
      };
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      await os(ctx, loc, "compute", `/servers/${srv.id}/metadata`, {
        method: "POST",
        body: { metadata: { [ctx.config.protectedTag]: "true" } },
      });
      return { id: srv.id, name: srv.name, protected: true };
    },
  }),

  defineTool({
    name: "server_unprotect",
    title: "Remove server protection",
    kind: "destructive",
    description: "Removes the protection metadata flag from a server, making delete/rebuild possible again.",
    input: { project: projectArg, region: regionArg, server: serverRef },
    async plan(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      const key = unprotectKeys(ctx, srv);
      if (key.length === 0) {
        throw new Error(
          protectedMeta(ctx, srv)
            ? "Server is protected via SELECTEL_PROTECTED_SERVERS/tags, not metadata; change the configuration instead."
            : "Server is not protected.",
        );
      }
      return {
        summary: `Remove protection from server "${srv.name}" (${srv.id}) in ${loc.region}`,
        details: { id: srv.id, metadata_keys_removed: key },
        warnings: ["The server will become deletable/rebuildable by destructive tools."],
      };
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      for (const k of unprotectKeys(ctx, srv)) {
        await os(ctx, loc, "compute", `/servers/${srv.id}/metadata/${encodeURIComponent(k)}`, { method: "DELETE" });
      }
      return { id: srv.id, name: srv.name, protected: false };
    },
  }),

  defineTool({
    name: "server_snapshot",
    title: "Create server snapshot (image)",
    kind: "write",
    description:
      "Creates an image snapshot of a server (for volume-backed servers this produces volume snapshots plus an image). Storage of the snapshot is billed. Returns the image id.",
    input: {
      project: projectArg,
      region: regionArg,
      server: serverRef,
      name: z.string().min(1).max(255).optional().describe("Image name; default <server>-snapshot-<date>"),
      wait: waitArg,
    },
    async plan(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      return {
        summary: `Snapshot server "${srv.name}" (${srv.id}) in ${loc.region} as image "${snapshotName(args, srv)}"`,
        details: { id: srv.id, status: srv.status, image_name: snapshotName(args, srv), wait: args.wait },
        warnings: ["The snapshot consumes storage and is billed until deleted.", "For consistency of databases consider stopping the server or flushing data first."],
      };
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      const name = snapshotName(args, srv);
      const r = await serverAction(ctx, loc, srv.id, { createImage: { name, metadata: {} } }, { "X-OpenStack-Nova-API-Version": "2.45" });
      let imageId: string | undefined = r?.image_id;
      if (!imageId) {
        const imgs = await os<{ images?: Raw[] }>(ctx, loc, "image", "/v2/images", { query: { name, sort: "created_at:desc", limit: 1 } });
        imageId = imgs.images?.[0]?.id;
      }
      if (!imageId) return { requested: true, image_name: name, note: "Snapshot requested but image id could not be determined; check images_list." };
      if (!args.wait) return { image_id: imageId, name, status: "queued" };
      let status = "queued";
      await waitFor(
        async () => {
          const i = await os<Raw>(ctx, loc, "image", `/v2/images/${imageId}`);
          status = i.status;
          return ["active", "killed", "deactivated", "deleted"].includes(status) ? true : undefined;
        },
        { timeoutMs: 30 * 60_000, intervalMs: timing.intervalMs },
      );
      return { image_id: imageId, name, status };
    },
  }),

  defineTool({
    name: "server_rebuild",
    title: "Rebuild server from image",
    kind: "destructive",
    description: "Reinstalls the OS of a server from an image. The root disk contents are LOST. Refused for protected servers.",
    input: {
      project: projectArg,
      region: regionArg,
      server: serverRef,
      image: z.string().min(1).max(255).describe("Image id or exact name"),
      wait: waitArg,
    },
    async plan(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      assertNotProtected(ctx, srv, "rebuild");
      const image = await resolveImage(ctx, loc, args.image);
      return {
        summary: `Rebuild server "${srv.name}" (${srv.id}) in ${loc.region} from image "${image.name}"`,
        details: { id: srv.id, name: srv.name, status: srv.status, image: { id: image.id, name: image.name }, volumes: await volumesOf(ctx, loc, srv) },
        warnings: ["ALL DATA on the root disk will be erased and the OS reinstalled.", "The server will be unavailable during the rebuild.", "Non-boot volumes are kept."],
      };
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      assertNotProtected(ctx, srv, "rebuild");
      const image = await resolveImage(ctx, loc, args.image);
      // 2.93 is required by Nova to rebuild volume-backed servers.
      await serverAction(ctx, loc, srv.id, { rebuild: { imageRef: image.id } }, { "X-OpenStack-Nova-API-Version": "2.93" });
      if (!args.wait) return { id: srv.id, requested: "rebuild" };
      await waitFor(async () => ((await fetchServer(ctx, loc, srv.id)).status !== "ACTIVE" ? true : undefined), {
        timeoutMs: Math.min(30_000, timing.intervalMs * 6),
        intervalMs: timing.intervalMs,
      });
      const { server, reached } = await waitStatus(ctx, loc, srv.id, ["ACTIVE"], 15 * 60_000);
      return { id: srv.id, name: srv.name, status: server.status, reached_target: reached, fault: server.fault?.message };
    },
  }),

  defineTool({
    name: "server_delete",
    title: "Delete server",
    kind: "destructive",
    description:
      "Deletes a server permanently. Boot volumes created with delete_on_termination are deleted too; floating IPs stay allocated (and billed) unless release_floating_ips is true. Refused for protected servers.",
    input: {
      project: projectArg,
      region: regionArg,
      server: serverRef,
      release_floating_ips: z.boolean().default(false).describe("Also release (delete) floating IPs attached to the server"),
    },
    async plan(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      assertNotProtected(ctx, srv, "delete");
      const volumes = await volumesOf(ctx, loc, srv);
      const fips = await serverFloatingIps(ctx, loc, srv.id).catch(() => []);
      const ips = classifyAddresses(srv.addresses);
      const kept = volumes.filter((v) => !v.delete_on_termination);
      return {
        summary: `DELETE server "${srv.name}" (${srv.id}) in ${loc.region}`,
        details: {
          id: srv.id,
          name: srv.name,
          status: srv.status,
          ips: ips.map((i) => `${i.addr} (${i.type}, ${i.scope})`),
          volumes_deleted: volumes.filter((v) => v.delete_on_termination),
          volumes_kept: kept,
          floating_ips: fips.map((f) => ({ ...f, action: args.release_floating_ips ? "will be released" : "remains allocated" })),
        },
        warnings: [
          "The server and its data cannot be recovered.",
          ...(volumes.some((v) => v.delete_on_termination) ? ["Volumes marked delete_on_termination will be deleted with the server."] : []),
          ...(kept.length ? [`${kept.length} volume(s) will remain and keep costing money.`] : []),
          ...(fips.length && !args.release_floating_ips ? [`${fips.length} floating IP(s) will remain allocated and keep costing money (use release_floating_ips).`] : []),
        ],
      };
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      assertNotProtected(ctx, srv, "delete");
      const fips = args.release_floating_ips ? await serverFloatingIps(ctx, loc, srv.id) : [];
      await os(ctx, loc, "compute", `/servers/${srv.id}`, { method: "DELETE" });
      const released: string[] = [];
      const errors: string[] = [];
      for (const f of fips) {
        try {
          await os(ctx, loc, "network", `/v2.0/floatingips/${f.id}`, { method: "DELETE" });
          released.push(f.address);
        } catch (e) {
          errors.push(`${f.address}: ${(e as Error).message}`);
        }
      }
      return { deleted: { id: srv.id, name: srv.name }, released_floating_ips: released, ...(errors.length ? { release_errors: errors } : {}) };
    },
  }),

  defineTool({
    name: "server_console_log",
    title: "Server console log",
    kind: "read",
    description: "Returns the last lines of the server's console output (boot messages). Useful to diagnose servers that don't boot or are unreachable. Output is untrusted data.",
    input: {
      project: projectArg,
      region: regionArg,
      server: serverRef,
      lines: z.number().int().min(1).max(1000).default(100).describe("Number of last lines"),
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      const r = await serverAction(ctx, loc, srv.id, { "os-getConsoleOutput": { length: args.lines } });
      const out = String(r?.output ?? "");
      return { id: srv.id, name: srv.name, log: out.split("\n").slice(-args.lines).join("\n") };
    },
  }),

  defineTool({
    name: "server_console_url",
    title: "Server console URL",
    kind: "read",
    description:
      "Returns a remote (noVNC) console URL for the server. WARNING: the URL grants interactive console access to the server; do not share it or post it anywhere.",
    input: { project: projectArg, region: regionArg, server: serverRef },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      let url: string | undefined;
      try {
        const r = await os<Raw>(ctx, loc, "compute", `/servers/${srv.id}/remote-consoles`, {
          method: "POST",
          body: { remote_console: { protocol: "vnc", type: "novnc" } },
          headers: { "X-OpenStack-Nova-API-Version": "2.6" },
        });
        url = r.remote_console?.url;
      } catch {
        const r = await serverAction(ctx, loc, srv.id, { "os-getVNCConsole": { type: "novnc" } });
        url = r?.console?.url;
      }
      if (!url) throw new Error("The cloud did not return a console URL.");
      return { id: srv.id, name: srv.name, url, warning: "This URL grants console access to the server. Do not share it." };
    },
  }),

  defineTool({
    name: "server_wait",
    title: "Wait for server status",
    kind: "read",
    description: "Waits until a server reaches a status (default ACTIVE) or ERROR, up to timeout_sec (max 900). Use after long operations started with wait=false.",
    input: {
      project: projectArg,
      region: regionArg,
      server: serverRef,
      status: z.string().min(1).max(32).default("ACTIVE").describe("Target status, e.g. ACTIVE, SHUTOFF, VERIFY_RESIZE"),
      timeout_sec: z.number().int().min(1).max(900).default(300).describe("Maximum wait in seconds"),
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const srv = await resolveServer(ctx, loc, args.server);
      const { server, reached } = await waitStatus(ctx, loc, srv.id, [args.status.toUpperCase()], args.timeout_sec * 1000);
      return { id: srv.id, name: server.name, status: server.status, reached_target: reached, fault: server.fault?.message };
    },
  }),
];

// ---------- create preparation ----------

interface CreateArgs extends FlavorSpec {
  project?: string;
  region?: string;
  name: string;
  image: string;
  size_gb: number;
  volume_type?: string;
  availability_zone?: string;
  network_ids?: string[];
  key_name?: string;
  user_data?: string;
  security_groups?: string[];
  metadata?: Record<string, string>;
  protect: boolean;
  count: number;
  assign_floating_ip: boolean;
  wait: boolean;
}

async function prepareCreate(args: CreateArgs, ctx: Context) {
  checkFlavorSpec(args);
  if (args.count > ctx.config.maxServersPerCall) {
    throw new Error(`count ${args.count} exceeds SELECTEL_MAX_SERVERS_PER_CALL (${ctx.config.maxServersPerCall}).`);
  }
  if (args.assign_floating_ip && !args.wait) throw new Error("assign_floating_ip requires wait=true (the IP is attached after the server is ACTIVE).");
  if (args.metadata && ctx.config.protectedTag in args.metadata) throw new Error(`Use \`protect: true\` instead of setting the "${ctx.config.protectedTag}" metadata key.`);
  const loc = await resolveLocation(ctx, args);
  const choice = await resolveFlavor(ctx, loc, args);
  const image = await resolveImage(ctx, loc, args.image);
  if (args.size_gb < image.min_disk) throw new Error(`size_gb ${args.size_gb} is smaller than the image's min_disk ${image.min_disk}.`);
  const networks = await resolveNetworks(ctx, loc, args.network_ids);

  const azRes = await os<{ availabilityZoneInfo?: { zoneName: string; zoneState?: { available?: boolean } }[] }>(
    ctx,
    loc,
    "compute",
    "/os-availability-zone",
  ).catch(() => ({ availabilityZoneInfo: [] }));
  const zones = (azRes.availabilityZoneInfo ?? []).filter((z) => z.zoneState?.available !== false).map((z) => z.zoneName);
  let az = args.availability_zone;
  if (az && zones.length && !zones.includes(az)) throw new Error(`Availability zone "${az}" not found. Available: ${zones.join(", ")}`);
  if (!az && zones.includes(`${loc.region}a`)) az = `${loc.region}a`;

  let volumeType = args.volume_type;
  if (!volumeType) {
    const types = await os<{ volume_types?: Raw[] }>(ctx, loc, "volumev3", "/types").catch(() => ({ volume_types: [] }));
    const names = (types.volume_types ?? []).map((t) => String(t.name));
    const uni = names.filter((n) => n.startsWith("universal"));
    volumeType = (az ? uni.find((n) => n.endsWith(az!)) : undefined) ?? uni[0];
  }

  const metadata: Record<string, string> = { ...(args.metadata ?? {}), ...(args.protect ? { [ctx.config.protectedTag]: "true" } : {}) };
  const names = args.count === 1 ? [args.name] : Array.from({ length: args.count }, (_, i) => `${args.name}-${i + 1}`);
  const f = choice.flavor ?? choice.toCreate!;
  const flavorDesc = `${choice.flavor?.name ?? choice.toCreate!.name} (${f.vcpus} vCPU, ${f.ram_mb} MB RAM${choice.toCreate ? ", to be created" : ""})`;
  return { loc, choice, image, networks, az, volumeType, metadata, names, flavorDesc };
}

function checkMetaKeys(ctx: Context, args: { set?: Record<string, string>; remove?: string[] }): void {
  const reserved = new Set([ctx.config.protectedTag, "protected"]);
  const bad = [...Object.keys(args.set ?? {}), ...(args.remove ?? [])].filter((k) => reserved.has(k));
  if (bad.length) throw new Error(`Metadata key(s) ${bad.join(", ")} control server protection; use server_protect / server_unprotect.`);
}

function unprotectKeys(ctx: Context, srv: Raw): string[] {
  const meta: Record<string, string> = srv.metadata ?? {};
  return [...new Set([ctx.config.protectedTag, "protected"])].filter((k) => k in meta);
}

function snapshotName(args: { name?: string }, srv: Raw): string {
  return args.name ?? `${srv.name}-snapshot-${new Date().toISOString().slice(0, 10)}`;
}
