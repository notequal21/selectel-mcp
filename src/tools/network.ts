import { z } from "zod";
import type { Context } from "../core/context.js";
import { defineTool, type AnyToolDef } from "../core/tool.js";
import { os, projectArg, regionArg, resolveLocation, type Location } from "./common.js";

interface Subnet {
  id: string;
  name?: string;
  cidr: string;
  gateway_ip?: string | null;
  ip_version?: number;
  network_id: string;
}
interface Network {
  id: string;
  name: string;
  status?: string;
  subnets?: string[];
  "router:external"?: boolean;
  shared?: boolean;
}
interface FloatingIp {
  id: string;
  floating_ip_address: string;
  fixed_ip_address?: string | null;
  port_id?: string | null;
  status?: string;
  floating_network_id?: string;
}
interface Port {
  id: string;
  device_id?: string;
  device_owner?: string;
  fixed_ips?: { ip_address: string; subnet_id?: string }[];
}
interface SgRule {
  id: string;
  direction: string;
  ethertype?: string;
  protocol?: string | null;
  port_range_min?: number | null;
  port_range_max?: number | null;
  remote_ip_prefix?: string | null;
  remote_group_id?: string | null;
  description?: string;
}
interface SecGroup {
  id: string;
  name: string;
  description?: string;
  security_group_rules?: SgRule[];
}
interface Server {
  id: string;
  name: string;
  tags?: string[];
  metadata?: Record<string, string>;
  security_groups?: { name: string }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getServer(ctx: Context, loc: Location, ref: string): Promise<Server> {
  if (UUID_RE.test(ref)) {
    return (await os<{ server: Server }>(ctx, loc, "compute", `/servers/${ref}`)).server;
  }
  const res = await os<{ servers: Server[] }>(ctx, loc, "compute", "/servers/detail", { query: { name: `^${escapeRe(ref)}$` } });
  const exact = (res.servers ?? []).filter((s) => s.name === ref);
  if (exact.length === 0) throw new Error(`Server "${ref}" not found (pass the exact name or id)`);
  if (exact.length > 1) throw new Error(`Server name "${ref}" is ambiguous (${exact.map((s) => s.id).join(", ")}) — pass the id`);
  return exact[0]!;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function serverPort(ctx: Context, loc: Location, server: Server): Promise<Port> {
  const res = await os<{ ports: Port[] }>(ctx, loc, "network", "/v2.0/ports", { query: { device_id: server.id } });
  const ports = (res.ports ?? []).filter((p) => (p.fixed_ips ?? []).length > 0);
  if (ports.length === 0) throw new Error(`Server "${server.name}" has no network port with an IP address`);
  return ports[0]!;
}

function summarizeRule(r: SgRule) {
  const ports =
    r.port_range_min == null && r.port_range_max == null
      ? "any"
      : r.port_range_min === r.port_range_max
        ? String(r.port_range_min)
        : `${r.port_range_min}-${r.port_range_max}`;
  return {
    id: r.id,
    direction: r.direction,
    ethertype: r.ethertype,
    protocol: r.protocol ?? "any",
    ports,
    remote: r.remote_ip_prefix ?? (r.remote_group_id ? `group:${r.remote_group_id}` : r.ethertype === "IPv6" ? "::/0" : "0.0.0.0/0"),
  };
}

async function getSg(ctx: Context, loc: Location, id: string): Promise<SecGroup> {
  return (await os<{ security_group: SecGroup }>(ctx, loc, "network", `/v2.0/security-groups/${id}`)).security_group;
}

async function getFip(ctx: Context, loc: Location, id: string): Promise<FloatingIp> {
  return (await os<{ floatingip: FloatingIp }>(ctx, loc, "network", `/v2.0/floatingips/${id}`)).floatingip;
}

async function externalNetwork(ctx: Context, loc: Location, ref?: string): Promise<Network> {
  const res = await os<{ networks: Network[] }>(ctx, loc, "network", "/v2.0/networks", { query: { "router:external": true } });
  const nets = res.networks ?? [];
  if (ref) {
    const n = nets.find((x) => x.id === ref || x.name === ref);
    if (!n) throw new Error(`External network "${ref}" not found. Available: ${nets.map((x) => x.name).join(", ")}`);
    return n;
  }
  if (nets.length === 1) return nets[0]!;
  throw new Error(`Specify external_network: ${nets.length ? nets.map((x) => `${x.name} (${x.id})`).join(", ") : "none found"}`);
}

const loc = { project: projectArg, region: regionArg };
const WEB_PORTS = new Set([80, 443]);

export const networkTools: AnyToolDef[] = [
  defineTool({
    name: "networks_list",
    title: "List networks",
    kind: "read",
    description: "Lists networks with their subnets (CIDR, gateway). Use to find network ids or the external (public) network.",
    input: { ...loc },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const [n, s] = await Promise.all([
        os<{ networks: Network[] }>(ctx, l, "network", "/v2.0/networks"),
        os<{ subnets: Subnet[] }>(ctx, l, "network", "/v2.0/subnets"),
      ]);
      return (n.networks ?? []).map((net) => ({
        id: net.id,
        name: net.name,
        status: net.status,
        external: Boolean(net["router:external"]),
        shared: net.shared,
        subnets: (s.subnets ?? [])
          .filter((x) => x.network_id === net.id)
          .map((x) => ({ id: x.id, name: x.name, cidr: x.cidr, gateway: x.gateway_ip ?? null })),
      }));
    },
  }),

  defineTool({
    name: "floating_ips_list",
    title: "List floating IPs",
    kind: "read",
    description: "Lists floating (public) IPs with status and the server each is attached to. Use to find unused IPs that are still billed.",
    input: { ...loc },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const [f, p] = await Promise.all([
        os<{ floatingips: FloatingIp[] }>(ctx, l, "network", "/v2.0/floatingips"),
        os<{ ports: Port[] }>(ctx, l, "network", "/v2.0/ports"),
      ]);
      const ports = new Map((p.ports ?? []).map((x) => [x.id, x]));
      const names = new Map<string, string | null>();
      const serverName = async (id: string) => {
        if (!names.has(id)) {
          names.set(id, await os<{ server: Server }>(ctx, l, "compute", `/servers/${id}`).then((r) => r.server.name, () => null));
        }
        return names.get(id)!;
      };
      const out = [];
      for (const ip of f.floatingips ?? []) {
        const port = ip.port_id ? ports.get(ip.port_id) : undefined;
        const isServer = port?.device_owner?.startsWith("compute:") && port.device_id;
        const server = isServer ? { id: port!.device_id!, name: await serverName(port!.device_id!) } : null;
        out.push({
          id: ip.id,
          ip: ip.floating_ip_address,
          status: ip.status,
          port_id: ip.port_id ?? null,
          fixed_ip: ip.fixed_ip_address ?? null,
          server,
          ...(ip.port_id ? {} : { note: "unattached — costs money while unused" }),
        });
      }
      return out;
    },
  }),

  defineTool({
    name: "floating_ip_create",
    title: "Allocate floating IP",
    kind: "write",
    description: "Allocates a new floating (public) IP, optionally attaching it to a server. Billed while it exists.",
    input: {
      ...loc,
      external_network: z.string().optional().describe("External network id or name; auto-detected if there is exactly one"),
      server: z.string().optional().describe("Server id or exact name to attach the IP to"),
    },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const net = await externalNetwork(ctx, l, args.external_network);
      const server = args.server ? await getServer(ctx, l, args.server) : undefined;
      if (server) await serverPort(ctx, l, server);
      return {
        summary: `Allocate a floating IP from ${net.name}${server ? ` and attach it to ${server.name}` : ""}`,
        details: { network: { id: net.id, name: net.name }, server: server ? { id: server.id, name: server.name } : null },
        warnings: ["A floating IP is billed while it exists, even if unattached."],
      };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const net = await externalNetwork(ctx, l, args.external_network);
      const fip: Record<string, unknown> = { floating_network_id: net.id };
      if (args.server) {
        const server = await getServer(ctx, l, args.server);
        fip.port_id = (await serverPort(ctx, l, server)).id;
      }
      const r = await os<{ floatingip: FloatingIp }>(ctx, l, "network", "/v2.0/floatingips", { method: "POST", body: { floatingip: fip } });
      return { id: r.floatingip.id, ip: r.floatingip.floating_ip_address, status: r.floatingip.status, attached: Boolean(r.floatingip.port_id) };
    },
  }),

  defineTool({
    name: "floating_ip_attach",
    title: "Attach floating IP",
    kind: "write",
    description: "Attaches an existing floating IP to a server (replaces its current attachment, if any).",
    input: {
      ...loc,
      floating_ip: z.string().describe("Floating IP id"),
      server: z.string().describe("Server id or exact name"),
    },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const [fip, server] = await Promise.all([getFip(ctx, l, args.floating_ip), getServer(ctx, l, args.server)]);
      const port = await serverPort(ctx, l, server);
      const warnings = fip.port_id ? ["This IP is currently attached elsewhere; it will be moved and the previous host loses this address."] : [];
      return {
        summary: `Attach ${fip.floating_ip_address} to ${server.name}`,
        details: { from: fip.port_id ?? null, to: { server: server.name, port: port.id, fixed_ip: port.fixed_ips![0]!.ip_address } },
        warnings,
      };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const server = await getServer(ctx, l, args.server);
      const port = await serverPort(ctx, l, server);
      const r = await os<{ floatingip: FloatingIp }>(ctx, l, "network", `/v2.0/floatingips/${args.floating_ip}`, {
        method: "PUT",
        body: { floatingip: { port_id: port.id } },
      });
      return { ip: r.floatingip.floating_ip_address, attached_to: server.name, fixed_ip: r.floatingip.fixed_ip_address };
    },
  }),

  defineTool({
    name: "floating_ip_detach",
    title: "Detach floating IP",
    kind: "write",
    description: "Detaches a floating IP from its server but keeps the IP allocated to the project.",
    input: { ...loc, floating_ip: z.string().describe("Floating IP id") },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const fip = await getFip(ctx, l, args.floating_ip);
      if (!fip.port_id) throw new Error(`${fip.floating_ip_address} is not attached`);
      return {
        summary: `Detach ${fip.floating_ip_address} from port ${fip.port_id}`,
        details: { from: { port: fip.port_id, fixed_ip: fip.fixed_ip_address }, to: null },
        warnings: ["The server becomes unreachable via this public IP. The IP stays allocated and billed."],
      };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const r = await os<{ floatingip: FloatingIp }>(ctx, l, "network", `/v2.0/floatingips/${args.floating_ip}`, {
        method: "PUT",
        body: { floatingip: { port_id: null } },
      });
      return { ip: r.floatingip.floating_ip_address, status: r.floatingip.status };
    },
  }),

  defineTool({
    name: "floating_ip_release",
    title: "Release floating IP",
    kind: "destructive",
    description: "Deletes a floating IP, returning it to the pool. Use only when the address is no longer needed.",
    input: { ...loc, floating_ip: z.string().describe("Floating IP id") },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const fip = await getFip(ctx, l, args.floating_ip);
      const warnings = [
        `The address ${fip.floating_ip_address} will be lost and may be impossible to get back. DNS records pointing to it will break.`,
      ];
      if (fip.port_id) warnings.push("It is currently attached to a port; the server will lose its public address.");
      return { summary: `Release floating IP ${fip.floating_ip_address}`, details: { id: fip.id, port_id: fip.port_id ?? null }, warnings };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      await os(ctx, l, "network", `/v2.0/floatingips/${args.floating_ip}`, { method: "DELETE" });
      return { released: args.floating_ip };
    },
  }),

  defineTool({
    name: "security_groups_list",
    title: "List security groups",
    kind: "read",
    description: "Lists security groups with rules summarized (direction, protocol, ports, remote prefix).",
    input: { ...loc },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const r = await os<{ security_groups: SecGroup[] }>(ctx, l, "network", "/v2.0/security-groups");
      return (r.security_groups ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        rules: (g.security_group_rules ?? []).map(summarizeRule),
      }));
    },
  }),

  defineTool({
    name: "security_group_create",
    title: "Create security group",
    kind: "write",
    description: "Creates an empty security group (default egress-allow rules are added by OpenStack).",
    input: { ...loc, name: z.string().describe("Group name"), description: z.string().optional() },
    async plan(args) {
      return { summary: `Create security group "${args.name}"`, details: { name: args.name, description: args.description } };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const r = await os<{ security_group: SecGroup }>(ctx, l, "network", "/v2.0/security-groups", {
        method: "POST",
        body: { security_group: { name: args.name, description: args.description ?? "" } },
      });
      return { id: r.security_group.id, name: r.security_group.name };
    },
  }),

  defineTool({
    name: "security_group_rule_add",
    title: "Add security group rule",
    kind: "write",
    description: "Adds a rule to a security group (e.g. allow TCP 443 from a CIDR). Opening ports to the whole internet is flagged in the plan.",
    input: {
      ...loc,
      security_group: z.string().describe("Security group id"),
      direction: z.enum(["ingress", "egress"]).default("ingress"),
      protocol: z.enum(["tcp", "udp", "icmp", "any"]).default("tcp"),
      port_min: z.number().int().min(1).max(65535).optional().describe("First port (tcp/udp)"),
      port_max: z.number().int().min(1).max(65535).optional().describe("Last port; defaults to port_min"),
      remote_ip_prefix: z.string().optional().describe("CIDR, e.g. 203.0.113.0/24; default 0.0.0.0/0"),
      remote_group: z.string().optional().describe("Remote security group id instead of a CIDR"),
      ethertype: z.enum(["IPv4", "IPv6"]).default("IPv4"),
      description: z.string().optional(),
    },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const sg = await getSg(ctx, l, args.security_group);
      const body = ruleBody(args);
      const warnings: string[] = [];
      const prefix = body.remote_ip_prefix;
      const open = !body.remote_group_id && (prefix === undefined || prefix === "0.0.0.0/0" || prefix === "::/0" || /\/0$/.test(prefix));
      if (args.direction === "ingress" && open) {
        const min = body.port_range_min as number | undefined;
        const max = body.port_range_max as number | undefined;
        const onlyWeb = min !== undefined && max !== undefined && min === max && WEB_PORTS.has(min);
        if (!onlyWeb) {
          const where = min === undefined ? "ALL ports" : min === max ? `port ${min}` : `ports ${min}-${max}`;
          warnings.push(
            `SECURITY: this opens ${where} (${body.protocol ?? "any protocol"}) to the ENTIRE INTERNET (${prefix ?? "0.0.0.0/0"}). ` +
              `SSH (22), RDP, and databases should be restricted to known addresses.`,
          );
        }
      }
      return { summary: `Add ${args.direction} rule to security group "${sg.name}"`, details: { group: sg.id, rule: body }, warnings };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const r = await os<{ security_group_rule: SgRule }>(ctx, l, "network", "/v2.0/security-group-rules", {
        method: "POST",
        body: { security_group_rule: ruleBody(args) },
      });
      return summarizeRule(r.security_group_rule);
    },
  }),

  defineTool({
    name: "security_group_rule_delete",
    title: "Delete security group rule",
    kind: "destructive",
    description: "Deletes one rule from a security group. May cut off connectivity for servers using the group.",
    input: { ...loc, rule_id: z.string().describe("Security group rule id") },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const r = await os<{ security_group_rule: SgRule & { security_group_id?: string } }>(
        ctx, l, "network", `/v2.0/security-group-rules/${args.rule_id}`,
      );
      return {
        summary: `Delete security group rule ${args.rule_id}`,
        details: { group: r.security_group_rule.security_group_id, rule: summarizeRule(r.security_group_rule) },
        warnings: ["Servers using this group may lose connectivity (e.g. SSH access)."],
      };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      await os(ctx, l, "network", `/v2.0/security-group-rules/${args.rule_id}`, { method: "DELETE" });
      return { deleted: args.rule_id };
    },
  }),

  defineTool({
    name: "security_group_delete",
    title: "Delete security group",
    kind: "destructive",
    description: "Deletes a security group (fails if it is still in use by ports).",
    input: { ...loc, security_group: z.string().describe("Security group id") },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const sg = await getSg(ctx, l, args.security_group);
      return {
        summary: `Delete security group "${sg.name}"`,
        details: { id: sg.id, rules: (sg.security_group_rules ?? []).length },
        warnings: ["All its rules are deleted too. The API refuses if the group is attached to any server."],
      };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      await os(ctx, l, "network", `/v2.0/security-groups/${args.security_group}`, { method: "DELETE" });
      return { deleted: args.security_group };
    },
  }),

  defineTool({
    name: "server_security_groups_set",
    title: "Add/remove server security group",
    kind: "write",
    description: "Adds a security group to a server or removes one from it. Removing can cut off connectivity.",
    input: {
      ...loc,
      server: z.string().describe("Server id or exact name"),
      security_group: z.string().describe("Security group name or id"),
      action: z.enum(["add", "remove"]),
    },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const server = await getServer(ctx, l, args.server);
      const name = await sgName(ctx, l, args.security_group);
      const current = (server.security_groups ?? []).map((g) => g.name);
      const has = current.includes(name);
      if (args.action === "add" && has) throw new Error(`Server "${server.name}" already has group "${name}"`);
      if (args.action === "remove" && !has) throw new Error(`Server "${server.name}" does not have group "${name}"`);
      const after = args.action === "add" ? [...current, name] : current.filter((n) => n !== name);
      return {
        summary: `${args.action === "add" ? "Add" : "Remove"} security group "${name}" ${args.action === "add" ? "to" : "from"} ${server.name}`,
        details: { current, after },
        warnings: args.action === "remove" ? ["Removing a group can block traffic (e.g. SSH) to the server."] : [],
      };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const server = await getServer(ctx, l, args.server);
      const name = await sgName(ctx, l, args.security_group);
      await os(ctx, l, "compute", `/servers/${server.id}/action`, {
        method: "POST",
        body: args.action === "add" ? { addSecurityGroup: { name } } : { removeSecurityGroup: { name } },
      });
      return { server: server.name, security_group: name, action: args.action, done: true };
    },
  }),

  defineTool({
    name: "routers_list",
    title: "List routers",
    kind: "read",
    description: "Lists routers with status and external gateway network.",
    input: { ...loc },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const r = await os<{
        routers: { id: string; name: string; status?: string; admin_state_up?: boolean; external_gateway_info?: { network_id?: string; external_fixed_ips?: { ip_address: string }[] } | null }[];
      }>(ctx, l, "network", "/v2.0/routers");
      return (r.routers ?? []).map((x) => ({
        id: x.id,
        name: x.name,
        status: x.status,
        admin_state_up: x.admin_state_up,
        external_network_id: x.external_gateway_info?.network_id ?? null,
        external_ips: (x.external_gateway_info?.external_fixed_ips ?? []).map((i) => i.ip_address),
      }));
    },
  }),
];

async function sgName(ctx: Context, l: Location, ref: string): Promise<string> {
  if (!UUID_RE.test(ref)) return ref;
  return (await getSg(ctx, l, ref)).name;
}

function ruleBody(args: {
  security_group: string;
  direction: string;
  protocol: string;
  port_min?: number;
  port_max?: number;
  remote_ip_prefix?: string;
  remote_group?: string;
  ethertype: string;
  description?: string;
}): Record<string, unknown> & { remote_ip_prefix?: string; remote_group_id?: string } {
  if (args.port_min !== undefined && (args.protocol === "any" || args.protocol === "icmp")) {
    throw new Error("Ports can only be set for tcp/udp");
  }
  const body: Record<string, unknown> = {
    security_group_id: args.security_group,
    direction: args.direction,
    ethertype: args.ethertype,
  };
  if (args.protocol !== "any") body.protocol = args.protocol;
  if (args.port_min !== undefined) {
    body.port_range_min = args.port_min;
    body.port_range_max = args.port_max ?? args.port_min;
  }
  if (args.remote_group) body.remote_group_id = args.remote_group;
  else if (args.remote_ip_prefix) body.remote_ip_prefix = args.remote_ip_prefix;
  if (args.description) body.description = args.description;
  return body;
}
