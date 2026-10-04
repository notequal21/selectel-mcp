import { z } from "zod";
import type { Context } from "../core/context.js";
import { defineTool, type AnyToolDef } from "../core/tool.js";
import { os, projectArg, regionArg, resolveLocation, type Location } from "./common.js";

interface Attachment {
  server_id: string;
  device?: string;
  attachment_id?: string;
}
interface Volume {
  id: string;
  name?: string | null;
  size: number;
  volume_type?: string | null;
  status: string;
  bootable?: string | boolean;
  availability_zone?: string;
  attachments?: Attachment[];
  snapshot_id?: string | null;
}
interface Snapshot {
  id: string;
  name?: string | null;
  volume_id: string;
  size: number;
  status: string;
  created_at?: string;
}
interface Server {
  id: string;
  name: string;
  tags?: string[];
  metadata?: Record<string, string>;
  "OS-EXT-SRV-ATTR:root_device_name"?: string;
  root_device_name?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const loc = { project: projectArg, region: regionArg };
const isBootable = (v: Volume) => v.bootable === true || v.bootable === "true";

async function getVolume(ctx: Context, l: Location, id: string): Promise<Volume> {
  return (await os<{ volume: Volume }>(ctx, l, "volumev3", `/volumes/${id}`)).volume;
}

async function getServer(ctx: Context, l: Location, ref: string): Promise<Server> {
  if (UUID_RE.test(ref)) return (await os<{ server: Server }>(ctx, l, "compute", `/servers/${ref}`)).server;
  const res = await os<{ servers: Server[] }>(ctx, l, "compute", "/servers/detail", { query: { name: ref } });
  const exact = (res.servers ?? []).filter((s) => s.name === ref);
  if (exact.length === 0) throw new Error(`Server "${ref}" not found (pass the exact name or id)`);
  if (exact.length > 1) throw new Error(`Server name "${ref}" is ambiguous — pass the id`);
  return exact[0]!;
}

function refuseIfProtected(ctx: Context, s: Server): void {
  if (ctx.isServerProtected({ id: s.id, name: s.name, tags: s.tags, metadata: s.metadata })) {
    throw new Error(`Server "${s.name}" (${s.id}) is protected; refusing to modify its volumes.`);
  }
}

function serverNamer(ctx: Context, l: Location) {
  const cache = new Map<string, string | null>();
  return async (id: string) => {
    if (!cache.has(id)) cache.set(id, await os<{ server: Server }>(ctx, l, "compute", `/servers/${id}`).then((r) => r.server.name, () => null));
    return cache.get(id)!;
  };
}

export const volumeTools: AnyToolDef[] = [
  defineTool({
    name: "volumes_list",
    title: "List volumes",
    kind: "read",
    description: "Lists block volumes with size, type, status, attached server and AZ. Use to find unattached volumes that are still billed.",
    input: { ...loc },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const r = await os<{ volumes: Volume[] }>(ctx, l, "volumev3", "/volumes/detail");
      const name = serverNamer(ctx, l);
      const out = [];
      for (const v of r.volumes ?? []) {
        const attached = [];
        for (const a of v.attachments ?? []) attached.push({ id: a.server_id, name: await name(a.server_id), device: a.device });
        out.push({
          id: v.id,
          name: v.name,
          size_gb: v.size,
          volume_type: v.volume_type,
          status: v.status,
          bootable: isBootable(v),
          availability_zone: v.availability_zone,
          attached_to: attached,
          ...(v.status === "available" ? { note: "unattached — still billed" } : {}),
        });
      }
      return out;
    },
  }),

  defineTool({
    name: "volume_create",
    title: "Create volume",
    kind: "write",
    description: "Creates a block volume, empty or from a snapshot/image. Billed while it exists.",
    input: {
      ...loc,
      name: z.string().optional(),
      size_gb: z.number().int().min(1).describe("Size in GB"),
      volume_type: z.string().optional().describe("Volume type, e.g. 'fast.ru-9a'; defines disk class and zone"),
      availability_zone: z.string().optional().describe("Availability zone, e.g. ru-9a"),
      snapshot_id: z.string().optional().describe("Create from this snapshot"),
      image_id: z.string().optional().describe("Create bootable volume from this image"),
    },
    async plan(args) {
      if (args.snapshot_id && args.image_id) throw new Error("Pass either snapshot_id or image_id, not both");
      return {
        summary: `Create ${args.size_gb} GB volume${args.name ? ` "${args.name}"` : ""}`,
        details: args,
        warnings: ["The volume is billed per GB while it exists."],
      };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const v: Record<string, unknown> = { size: args.size_gb };
      if (args.name) v.name = args.name;
      if (args.volume_type) v.volume_type = args.volume_type;
      if (args.availability_zone) v.availability_zone = args.availability_zone;
      if (args.snapshot_id) v.snapshot_id = args.snapshot_id;
      if (args.image_id) v.imageRef = args.image_id;
      const r = await os<{ volume: Volume }>(ctx, l, "volumev3", "/volumes", { method: "POST", body: { volume: v } });
      return { id: r.volume.id, name: r.volume.name, size_gb: r.volume.size, status: r.volume.status };
    },
  }),

  defineTool({
    name: "volume_extend",
    title: "Extend volume",
    kind: "write",
    description: "Increases a volume's size (cannot shrink). Works online for attached volumes. The filesystem inside the OS must be grown afterwards.",
    input: { ...loc, volume: z.string().describe("Volume id"), new_size_gb: z.number().int().min(1) },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const v = await getVolume(ctx, l, args.volume);
      if (args.new_size_gb <= v.size) {
        throw new Error(`New size ${args.new_size_gb} GB must be larger than the current ${v.size} GB; volumes cannot be shrunk.`);
      }
      const warnings = ["Shrinking is impossible — this is irreversible. Billing increases with size."];
      if (v.status === "in-use") warnings.push("Volume is in use: online extend (API microversion 3.42) will be attempted.");
      else if (v.status !== "available") warnings.push(`Volume status is "${v.status}"; the API may refuse.`);
      return { summary: `Extend volume ${v.name ?? v.id}: ${v.size} GB -> ${args.new_size_gb} GB`, details: { id: v.id, current_gb: v.size, new_gb: args.new_size_gb, status: v.status }, warnings };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const v = await getVolume(ctx, l, args.volume);
      if (args.new_size_gb <= v.size) throw new Error(`New size must be larger than ${v.size} GB`);
      await os(ctx, l, "volumev3", `/volumes/${v.id}/action`, {
        method: "POST",
        body: { "os-extend": { new_size: args.new_size_gb } },
        headers: v.status === "in-use" ? { "OpenStack-API-Version": "volume 3.42" } : undefined,
      });
      return {
        id: v.id,
        previous_gb: v.size,
        new_gb: args.new_size_gb,
        next_step:
          "Grow the partition and filesystem inside the OS (e.g. `growpart /dev/vdb 1 && resize2fs /dev/vdb1`, or `xfs_growfs`), unless cloud-init does it on reboot.",
      };
    },
  }),

  defineTool({
    name: "volume_attach",
    title: "Attach volume",
    kind: "write",
    description: "Attaches an available volume to a server.",
    input: { ...loc, volume: z.string().describe("Volume id"), server: z.string().describe("Server id or exact name") },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const [v, s] = await Promise.all([getVolume(ctx, l, args.volume), getServer(ctx, l, args.server)]);
      if (v.status !== "available") throw new Error(`Volume status is "${v.status}"; only "available" volumes can be attached`);
      return {
        summary: `Attach volume ${v.name ?? v.id} (${v.size} GB) to ${s.name}`,
        details: { volume: v.id, server: { id: s.id, name: s.name } },
        warnings: ["The volume must be mounted inside the OS (and formatted if new)."],
      };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const s = await getServer(ctx, l, args.server);
      const r = await os<{ volumeAttachment: { device?: string } }>(ctx, l, "compute", `/servers/${s.id}/os-volume_attachments`, {
        method: "POST",
        body: { volumeAttachment: { volumeId: args.volume } },
      });
      return { volume: args.volume, server: s.name, device: r.volumeAttachment?.device };
    },
  }),

  defineTool({
    name: "volume_detach",
    title: "Detach volume",
    kind: "destructive",
    description: "Detaches a volume from a server. Refused for boot volumes and protected servers. May break a running server.",
    input: { ...loc, volume: z.string().describe("Volume id") },
    async plan(args, ctx) {
      const { v, s } = await checkDetach(ctx, await resolveLocation(ctx, args), args.volume);
      return {
        summary: `Detach volume ${v.name ?? v.id} from ${s.name}`,
        details: { volume: v.id, server: { id: s.id, name: s.name } },
        warnings: ["Unmount the volume inside the OS first; detaching a mounted volume may corrupt data or hang the server."],
      };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const { v, s } = await checkDetach(ctx, l, args.volume);
      await os(ctx, l, "compute", `/servers/${s.id}/os-volume_attachments/${v.id}`, { method: "DELETE" });
      return { volume: v.id, detached_from: s.name };
    },
  }),

  defineTool({
    name: "volume_snapshots_list",
    title: "List volume snapshots",
    kind: "read",
    description: "Lists volume snapshots (id, source volume, size, status).",
    input: { ...loc },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const r = await os<{ snapshots: Snapshot[] }>(ctx, l, "volumev3", "/snapshots/detail");
      return (r.snapshots ?? []).map((s) => ({ id: s.id, name: s.name, volume_id: s.volume_id, size_gb: s.size, status: s.status, created_at: s.created_at }));
    },
  }),

  defineTool({
    name: "volume_snapshot_create",
    title: "Create volume snapshot",
    kind: "write",
    description: "Creates a snapshot of a volume (force-enabled for attached volumes). Billed while it exists.",
    input: { ...loc, volume: z.string().describe("Volume id"), name: z.string().optional(), description: z.string().optional() },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const v = await getVolume(ctx, l, args.volume);
      return {
        summary: `Snapshot volume ${v.name ?? v.id} (${v.size} GB)`,
        details: { volume: v.id, name: args.name, status: v.status },
        warnings: [
          "Snapshots are billed while they exist.",
          ...(v.status === "in-use" ? ["Volume is attached: the snapshot is crash-consistent only (flush/freeze filesystem for consistency)."] : []),
        ],
      };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const v = await getVolume(ctx, l, args.volume);
      const r = await os<{ snapshot: Snapshot }>(ctx, l, "volumev3", "/snapshots", {
        method: "POST",
        body: { snapshot: { volume_id: v.id, name: args.name, description: args.description, force: v.status === "in-use" } },
      });
      return { id: r.snapshot.id, status: r.snapshot.status };
    },
  }),

  defineTool({
    name: "volume_snapshot_delete",
    title: "Delete volume snapshot",
    kind: "destructive",
    description: "Deletes a volume snapshot permanently.",
    input: { ...loc, snapshot: z.string().describe("Snapshot id") },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const s = (await os<{ snapshot: Snapshot }>(ctx, l, "volumev3", `/snapshots/${args.snapshot}`)).snapshot;
      return {
        summary: `Delete snapshot ${s.name ?? s.id} (${s.size} GB)`,
        details: { id: s.id, volume_id: s.volume_id },
        warnings: ["Irreversible: restore points from this snapshot are lost."],
      };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      await os(ctx, l, "volumev3", `/snapshots/${args.snapshot}`, { method: "DELETE" });
      return { deleted: args.snapshot };
    },
  }),

  defineTool({
    name: "volume_delete",
    title: "Delete volume",
    kind: "destructive",
    description: "Deletes an unattached volume permanently. Refused if the volume is in use.",
    input: { ...loc, volume: z.string().describe("Volume id") },
    async plan(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const v = await getVolume(ctx, l, args.volume);
      if (v.status === "in-use" || (v.attachments ?? []).length > 0) {
        throw new Error(`Volume ${v.name ?? v.id} is in use (attached); detach it first. Refusing to delete.`);
      }
      return {
        summary: `Delete volume ${v.name ?? v.id} (${v.size} GB)`,
        details: { id: v.id, status: v.status, bootable: isBootable(v) },
        warnings: ["All data on the volume will be permanently lost; this cannot be undone."],
      };
    },
    async run(args, ctx) {
      const l = await resolveLocation(ctx, args);
      const v = await getVolume(ctx, l, args.volume);
      if (v.status === "in-use" || (v.attachments ?? []).length > 0) throw new Error("Volume is in use; refusing to delete.");
      await os(ctx, l, "volumev3", `/volumes/${v.id}`, { method: "DELETE" });
      return { deleted: v.id };
    },
  }),
];

async function checkDetach(ctx: Context, l: Location, volumeId: string): Promise<{ v: Volume; s: Server }> {
  const v = await getVolume(ctx, l, volumeId);
  const att = v.attachments?.[0];
  if (!att) throw new Error(`Volume ${v.name ?? v.id} is not attached to any server`);
  const s = await getServer(ctx, l, att.server_id);
  refuseIfProtected(ctx, s);
  const root = s["OS-EXT-SRV-ATTR:root_device_name"] ?? s.root_device_name;
  if (isBootable(v) || (root && att.device === root)) {
    throw new Error(`Volume ${v.name ?? v.id} is the boot volume of "${s.name}"; refusing to detach it.`);
  }
  return { v, s };
}
