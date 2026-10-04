import { z } from "zod";
import type { Context } from "../core/context.js";
import { defineTool, type AnyToolDef } from "../core/tool.js";
import { os, projectArg, regionArg, resolveLocation, type Location } from "./common.js";

// ---------- shared helpers (also used by servers.ts) ----------

export interface Flavor {
  id: string;
  name: string;
  vcpus: number;
  ram_mb: number;
  disk_gb: number;
  is_public: boolean;
}

interface RawFlavor {
  id: string;
  name: string;
  vcpus: number;
  ram: number;
  disk: number;
  "os-flavor-access:is_public"?: boolean;
  is_public?: boolean;
}

export function normFlavor(f: RawFlavor): Flavor {
  return {
    id: f.id,
    name: f.name,
    vcpus: f.vcpus,
    ram_mb: f.ram,
    disk_gb: f.disk,
    is_public: f["os-flavor-access:is_public"] ?? f.is_public ?? true,
  };
}

export async function listFlavors(ctx: Context, loc: Location): Promise<Flavor[]> {
  const res = await os<{ flavors?: RawFlavor[] }>(ctx, loc, "compute", "/flavors/detail");
  return (res.flavors ?? []).map(normFlavor);
}

export function customFlavorName(vcpus: number, ramMb: number): string {
  return `custom-${vcpus}-${ramMb}`;
}

/** Creates a private flavor and grants the current project access to it. */
export async function createCustomFlavor(
  ctx: Context,
  loc: Location,
  spec: { name: string; vcpus: number; ram_mb: number; disk_gb: number },
): Promise<Flavor> {
  const res = await os<{ flavor: RawFlavor }>(ctx, loc, "compute", "/flavors", {
    method: "POST",
    body: {
      flavor: {
        name: spec.name,
        vcpus: spec.vcpus,
        ram: spec.ram_mb,
        disk: spec.disk_gb,
        "os-flavor-access:is_public": false,
      },
    },
  });
  const flavor = normFlavor(res.flavor);
  try {
    await os(ctx, loc, "compute", `/flavors/${flavor.id}/action`, {
      method: "POST",
      body: { addTenantAccess: { tenant: loc.project.id } },
    });
  } catch {
    /* access may already be granted automatically */
  }
  return flavor;
}

const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/]+={0,3}(\s+\S.*)?$/;

// ---------- tools ----------

export const computeCatalogTools: AnyToolDef[] = [
  defineTool({
    name: "flavors_list",
    title: "List flavors",
    kind: "read",
    description:
      "Lists server flavors (vCPU/RAM presets) in a region, sorted by vcpus then RAM. Use before server_create or server_resize to pick a flavor; arbitrary vcpu/RAM combinations are also possible via flavor_create.",
    input: {
      project: projectArg,
      region: regionArg,
      min_vcpus: z.number().int().min(1).optional().describe("Minimum number of vCPUs"),
      min_ram_mb: z.number().int().min(1).optional().describe("Minimum RAM in MB"),
      name: z.string().max(100).optional().describe("Case-insensitive substring of the flavor name"),
      include_private: z.boolean().default(true).describe("Include private (custom) flavors of the project"),
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const needle = args.name?.toLowerCase();
      const flavors = (await listFlavors(ctx, loc))
        .filter((f) => (args.include_private ? true : f.is_public))
        .filter((f) => args.min_vcpus === undefined || f.vcpus >= args.min_vcpus)
        .filter((f) => args.min_ram_mb === undefined || f.ram_mb >= args.min_ram_mb)
        .filter((f) => !needle || f.name.toLowerCase().includes(needle))
        .sort((a, b) => a.vcpus - b.vcpus || a.ram_mb - b.ram_mb || a.name.localeCompare(b.name));
      return { region: loc.region, count: flavors.length, flavors };
    },
  }),

  defineTool({
    name: "images_list",
    title: "List images",
    kind: "read",
    description:
      "Lists active OS images (Glance) available for creating servers. Use to find an image id/name for server_create or server_rebuild.",
    input: {
      project: projectArg,
      region: regionArg,
      name: z.string().max(100).optional().describe("Case-insensitive substring of the image name, e.g. 'ubuntu 24'"),
      visibility: z.enum(["public", "private", "shared", "community", "all"]).default("all").describe("Image visibility filter"),
      limit: z.number().int().min(1).max(500).default(100).describe("Max images to return"),
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const res = await os<{ images?: Record<string, unknown>[] }>(ctx, loc, "image", "/v2/images", {
        query: { status: "active", limit: 1000, visibility: args.visibility === "all" ? undefined : args.visibility },
      });
      const needle = args.name?.toLowerCase();
      const images = (res.images ?? [])
        .filter((i) => !needle || String(i.name ?? "").toLowerCase().includes(needle))
        .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
        .slice(0, args.limit)
        .map((i) => ({
          id: i.id,
          name: i.name,
          os_distro: i.os_distro,
          os_version: i.os_version,
          min_disk: i.min_disk,
          size: i.size,
          visibility: i.visibility,
          created_at: i.created_at,
        }));
      return { region: loc.region, count: images.length, images };
    },
  }),

  defineTool({
    name: "keypairs_list",
    title: "List SSH keypairs",
    kind: "read",
    description: "Lists SSH keypairs registered in the region (name, fingerprint). Use to choose key_name for server_create.",
    input: { project: projectArg, region: regionArg },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const res = await os<{ keypairs?: { keypair: Record<string, unknown> }[] }>(ctx, loc, "compute", "/os-keypairs");
      return (res.keypairs ?? []).map((k) => ({
        name: k.keypair.name,
        type: k.keypair.type,
        fingerprint: k.keypair.fingerprint,
      }));
    },
  }),

  defineTool({
    name: "keypair_import",
    title: "Import SSH public key",
    kind: "write",
    description:
      "Registers an existing SSH PUBLIC key (ssh-ed25519/ssh-rsa/ecdsa) under a name so servers can be created with it. Never pass a private key; generating keys is not supported.",
    input: {
      project: projectArg,
      region: regionArg,
      name: z.string().min(1).max(255).regex(/^[\w .@-]+$/, "letters, digits, space, . _ @ -").describe("Keypair name"),
      public_key: z.string().min(40).max(8192).describe("One-line OpenSSH public key, e.g. 'ssh-ed25519 AAAA... user@host'"),
    },
    async plan(args, ctx) {
      validatePublicKey(args.public_key);
      const loc = await resolveLocation(ctx, args);
      return {
        summary: `Import SSH public key "${args.name}" in ${loc.region} (project ${loc.project.name})`,
        details: { name: args.name, key_type: args.public_key.trim().split(/\s+/)[0], comment: args.public_key.trim().split(/\s+/)[2] },
      };
    },
    async run(args, ctx) {
      validatePublicKey(args.public_key);
      const loc = await resolveLocation(ctx, args);
      const res = await os<{ keypair: Record<string, unknown> }>(ctx, loc, "compute", "/os-keypairs", {
        method: "POST",
        body: { keypair: { name: args.name, public_key: args.public_key.trim() } },
      });
      return { name: res.keypair.name, fingerprint: res.keypair.fingerprint, type: res.keypair.type };
    },
  }),

  defineTool({
    name: "keypair_delete",
    title: "Delete SSH keypair",
    kind: "destructive",
    description: "Deletes a registered SSH keypair by name. Existing servers keep working, but the key can no longer be selected for new servers.",
    input: { project: projectArg, region: regionArg, name: z.string().min(1).max(255).describe("Keypair name") },
    async plan(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const k = await os<{ keypair: Record<string, unknown> }>(ctx, loc, "compute", `/os-keypairs/${encodeURIComponent(args.name)}`);
      return {
        summary: `Delete keypair "${args.name}" in ${loc.region}`,
        details: { name: args.name, fingerprint: k.keypair.fingerprint },
        warnings: ["Servers already created with this key are not affected, but keys removed from the cloud cannot be restored from here."],
      };
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      await os(ctx, loc, "compute", `/os-keypairs/${encodeURIComponent(args.name)}`, { method: "DELETE" });
      return { deleted: args.name };
    },
  }),

  defineTool({
    name: "availability_zones_list",
    title: "List availability zones",
    kind: "read",
    description: "Lists compute availability zones of a region (e.g. ru-9a, ru-9b). Needed to choose where to create a server and its boot volume.",
    input: { project: projectArg, region: regionArg },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const res = await os<{ availabilityZoneInfo?: { zoneName: string; zoneState?: { available?: boolean } }[] }>(
        ctx,
        loc,
        "compute",
        "/os-availability-zone",
      );
      return (res.availabilityZoneInfo ?? []).map((z) => ({ name: z.zoneName, available: z.zoneState?.available ?? true }));
    },
  }),

  defineTool({
    name: "volume_types_list",
    title: "List volume types",
    kind: "read",
    description:
      "Lists block storage volume types (e.g. fast.ru-9a, universal.ru-9a, basic.ru-9a). The zone suffix must match the server's availability zone. Use before server_create or creating volumes.",
    input: { project: projectArg, region: regionArg },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const res = await os<{ volume_types?: Record<string, unknown>[] }>(ctx, loc, "volumev3", "/types");
      return (res.volume_types ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        is_public: t.is_public,
      }));
    },
  }),

  defineTool({
    name: "flavor_create",
    title: "Create custom flavor",
    kind: "write",
    description:
      "Creates a private custom flavor with arbitrary vCPU/RAM (disk 0 = network boot from a volume). Usually unnecessary: server_create and server_resize with vcpus+ram_mb create one automatically when no exact public flavor exists.",
    input: {
      project: projectArg,
      region: regionArg,
      vcpus: z.number().int().min(1).max(128).describe("Number of vCPUs"),
      ram_mb: z.number().int().min(512).max(1048576).describe("RAM in MB"),
      disk_gb: z.number().int().min(0).max(10000).default(0).describe("Local disk in GB; 0 for boot-from-volume"),
      name: z.string().min(1).max(255).optional().describe("Flavor name; default custom-<vcpus>-<ram_mb>"),
    },
    async plan(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const name = args.name ?? customFlavorName(args.vcpus, args.ram_mb);
      const existing = (await listFlavors(ctx, loc)).find((f) => f.name === name);
      if (existing) throw new Error(`Flavor "${name}" already exists (id ${existing.id}); use it directly.`);
      return {
        summary: `Create private flavor "${name}": ${args.vcpus} vCPU, ${args.ram_mb} MB RAM, ${args.disk_gb} GB disk in ${loc.region}`,
        details: { name, vcpus: args.vcpus, ram_mb: args.ram_mb, disk_gb: args.disk_gb, is_public: false },
        warnings: ["Servers using a custom flavor are billed according to the configured vCPU/RAM."],
      };
    },
    async run(args, ctx) {
      const loc = await resolveLocation(ctx, args);
      const name = args.name ?? customFlavorName(args.vcpus, args.ram_mb);
      return createCustomFlavor(ctx, loc, { name, vcpus: args.vcpus, ram_mb: args.ram_mb, disk_gb: args.disk_gb });
    },
  }),
];

function validatePublicKey(key: string): void {
  if (/PRIVATE KEY/i.test(key)) throw new Error("This looks like a private key. Only public keys are accepted — do not share private keys.");
  if (!SSH_KEY_RE.test(key.trim())) {
    throw new Error("Not a valid one-line OpenSSH public key (expected 'ssh-ed25519|ssh-rsa|ecdsa-sha2-... <base64> [comment]').");
  }
}
