import { isIPv4, isIPv6 } from "node:net";
import { z } from "zod";
import type { Scope } from "../core/client.js";
import type { Context } from "../core/context.js";
import { defineTool, type AnyToolDef, type Plan } from "../core/tool.js";
import { projectArg, regionArg } from "./common.js";

/* ------------------------------------------------------------------ types & API access */

const DNS_FALLBACK_BASE = "https://api.selectel.ru/domains/v2";
const DEFAULT_TTL = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RECORD_TYPES = ["A", "AAAA", "ALIAS", "CAA", "CNAME", "MX", "NS", "SRV", "SSHFP", "TXT"] as const;
type RecordType = (typeof RECORD_TYPES)[number];

interface ApiZone {
  id: string;
  name: string;
  comment?: string;
  disabled?: boolean;
  created_at?: string;
  updated_at?: string;
  last_check_status?: boolean;
  last_delegated_at?: string;
  delegation_checked_at?: string;
}

interface ApiRRSet {
  id: string;
  name: string;
  type: string;
  ttl: number;
  comment?: string;
  managed_by?: string | null;
  records: { content: string; disabled?: boolean }[];
}

interface Page<T> {
  count?: number;
  next_offset?: number;
  result?: T[];
}

interface Dns {
  ctx: Context;
  scope: Scope;
  base: string;
}

async function dnsFor(ctx: Context, project?: string): Promise<Dns> {
  const { scope } = await ctx.projectScope(project);
  let base: string;
  try {
    base = await ctx.api.endpoint("dnsv2", scope, ctx.config.authRegion);
  } catch {
    base = DNS_FALLBACK_BASE;
  }
  return { ctx, scope, base };
}

function call<T>(d: Dns, path: string, opts?: { method?: string; body?: unknown; query?: Record<string, string | number> }) {
  return d.ctx.api.requestUrl<T>(d.scope, `${d.base}${path}`, opts);
}

async function listAll<T>(d: Dns, path: string, query: Record<string, string> = {}): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  for (let page = 0; page < 200; page++) {
    const res = await call<Page<T>>(d, path, { query: { ...query, limit: 1000, offset } });
    const items = res?.result ?? [];
    out.push(...items);
    if (!res?.next_offset || items.length === 0) break;
    offset = res.next_offset;
  }
  return out;
}

/* ------------------------------------------------------------------ names & records */

export function toZoneName(input: string): string {
  const z = input.trim().toLowerCase();
  if (!z || /[\s/\\]/.test(z)) throw new Error(`Invalid zone name "${input}"`);
  return z.endsWith(".") ? z : `${z}.`;
}

/** Normalizes a record name (relative, "@", or FQDN with/without trailing dot) to an FQDN inside the zone. */
export function toFqdn(name: string, zone: string): string {
  const z = toZoneName(zone);
  const bare = z.slice(0, -1);
  const n = name.trim().toLowerCase();
  let fqdn: string;
  if (n === "" || n === "@") fqdn = z;
  else if (n.endsWith(".")) fqdn = n;
  else if (n === bare || n.endsWith(`.${bare}`)) fqdn = `${n}.`;
  else fqdn = `${n}.${z}`;
  if (fqdn !== z && !fqdn.endsWith(`.${z}`)) throw new Error(`Name "${name}" is outside zone ${z}`);
  return fqdn;
}

const TXT_QUOTED_RE = /^\s*"[^"]*"(?:\s+"[^"]*")*\s*$/;

function host(h: string, what: string): string {
  const t = h.trim().toLowerCase();
  if (!t || /\s/.test(t)) throw new Error(`Invalid ${what} "${h}"`);
  return t.endsWith(".") ? t : `${t}.`;
}

/** Validates and normalizes one record content for the given type. */
export function normalizeRecord(type: RecordType, content: string): string {
  const c = content.trim();
  if (!c) throw new Error(`Empty ${type} record`);
  switch (type) {
    case "A":
      if (!isIPv4(c)) throw new Error(`"${c}" is not a valid IPv4 address (A record)`);
      return c;
    case "AAAA":
      if (!isIPv6(c)) throw new Error(`"${c}" is not a valid IPv6 address (AAAA record)`);
      return c.toLowerCase();
    case "CNAME":
    case "ALIAS":
    case "NS":
      return host(c, `${type} target`);
    case "MX": {
      const p = c.split(/\s+/);
      if (p.length !== 2 || !/^\d+$/.test(p[0]!) || Number(p[0]) > 65535) {
        throw new Error(`MX record must be "<priority> <mailserver>", got "${c}"`);
      }
      return `${Number(p[0])} ${host(p[1]!, "MX host")}`;
    }
    case "SRV": {
      const p = c.split(/\s+/);
      if (p.length !== 4 || !p.slice(0, 3).every((x) => /^\d+$/.test(x))) {
        throw new Error(`SRV record must be "<priority> <weight> <port> <target>", got "${c}"`);
      }
      return `${p[0]} ${p[1]} ${p[2]} ${p[3] === "." ? "." : host(p[3]!, "SRV target")}`;
    }
    case "CAA": {
      const m = /^(\d+)\s+([A-Za-z0-9]+)\s+(.+)$/.exec(c);
      if (!m) throw new Error(`CAA record must be '<flags> <tag> "<value>"', got "${c}"`);
      const v = m[3]!.trim();
      return `${m[1]} ${m[2]!.toLowerCase()} ${v.startsWith('"') ? v : `"${v}"`}`;
    }
    case "TXT": {
      if (TXT_QUOTED_RE.test(c)) return c;
      if (c.includes('"')) {
        throw new Error(`TXT record has stray quotes; give plain text or one/more "quoted" strings: ${c}`);
      }
      const chunks = c.match(/[\s\S]{1,255}/g) ?? [c];
      return chunks.map((x) => `"${x}"`).join(" ");
    }
    default:
      return c;
  }
}

export interface Desired {
  name: string; // FQDN
  type: RecordType;
  ttl: number;
  records: string[];
  comment?: string;
}

interface RrsetInput {
  name: string;
  type: RecordType;
  ttl?: number;
  records: string[];
  comment?: string;
}

export function normalizeDesired(zone: string, input: RrsetInput): Desired {
  const name = toFqdn(input.name, zone);
  const records = [...new Set(input.records.map((r) => normalizeRecord(input.type, r)))];
  if (records.length === 0) throw new Error(`${input.type} ${name}: no records`);
  if ((input.type === "CNAME" || input.type === "ALIAS") && records.length > 1) {
    throw new Error(`${input.type} ${name} must have exactly one record`);
  }
  if (input.type === "CNAME" && name === toZoneName(zone)) {
    throw new Error(`CNAME is not allowed at the zone apex (${name}); use ALIAS or A/AAAA records instead`);
  }
  return { name, type: input.type, ttl: input.ttl ?? DEFAULT_TTL, records, comment: input.comment };
}

/* ------------------------------------------------------------------ diff */

export interface Change {
  action: "create" | "update" | "unchanged" | "delete";
  name: string;
  type: string;
  rrsetId?: string;
  old?: { ttl: number; records: string[] };
  new?: { ttl: number; records: string[] };
  comment?: string;
}

const sorted = (xs: string[]) => [...xs].sort();
const keyOf = (name: string, type: string) => `${name}|${type}`;
const isProtectedApex = (name: string, type: string, zone: string) => name === zone && (type === "NS" || type === "SOA");

/** Upsert diff: which desired rrsets are created / updated / unchanged. Never deletes. */
export function computeUpserts(zone: string, existing: ApiRRSet[], desired: Desired[]) {
  const z = toZoneName(zone);
  const notes: string[] = [];
  const byKey = new Map(existing.map((r) => [keyOf(r.name.toLowerCase(), r.type), r]));
  const seen = new Set<string>();
  const changes: Change[] = [];
  const kept: Desired[] = [];
  for (const d of desired) {
    const k = keyOf(d.name, d.type);
    if (seen.has(k)) throw new Error(`Duplicate rrset in input: ${d.type} ${d.name}`);
    seen.add(k);
    if (isProtectedApex(d.name, d.type, z)) {
      notes.push(`Skipped ${d.type} ${d.name}: apex NS/SOA are managed by Selectel`);
      continue;
    }
    kept.push(d);
    const cur = byKey.get(k);
    const next = { ttl: d.ttl, records: d.records };
    if (!cur) {
      changes.push({ action: "create", name: d.name, type: d.type, new: next, comment: d.comment });
      continue;
    }
    const old = { ttl: cur.ttl, records: cur.records.map((r) => r.content) };
    const same =
      old.ttl === next.ttl &&
      cur.records.every((r) => !r.disabled) &&
      JSON.stringify(sorted(old.records)) === JSON.stringify(sorted(next.records));
    changes.push({
      action: same ? "unchanged" : "update",
      name: d.name,
      type: d.type,
      rrsetId: cur.id,
      old,
      new: next,
      comment: d.comment,
    });
  }
  // CNAME must be alone at its name.
  const final = new Map<string, Set<string>>();
  for (const r of existing) {
    const n = r.name.toLowerCase();
    (final.get(n) ?? final.set(n, new Set()).get(n)!).add(r.type);
  }
  for (const d of kept) (final.get(d.name) ?? final.set(d.name, new Set()).get(d.name)!).add(d.type);
  for (const d of kept) {
    const types = final.get(d.name)!;
    if (types.has("CNAME") && [...types].some((t) => t !== "CNAME")) {
      throw new Error(
        `${d.name} would have both CNAME and other records (${[...types].join(", ")}) — DNS forbids this. Remove the conflicting rrset first.`,
      );
    }
  }
  return { changes, notes };
}

/** Prune diff: rrsets of the zone that are not in `keep` (apex NS/SOA and Selectel-managed ones are never touched). */
export function computePrunes(zone: string, existing: ApiRRSet[], keep: { name: string; type: string }[]) {
  const z = toZoneName(zone);
  const keepKeys = new Set(keep.map((k) => keyOf(toFqdn(k.name, z), k.type.toUpperCase())));
  const notes: string[] = [];
  const changes: Change[] = [];
  for (const r of existing) {
    const name = r.name.toLowerCase();
    if (isProtectedApex(name, r.type, z)) continue;
    if (keepKeys.has(keyOf(name, r.type))) continue;
    if (r.managed_by) {
      notes.push(`Not deleting ${r.type} ${name}: managed by "${r.managed_by}"`);
      continue;
    }
    changes.push({
      action: "delete",
      name,
      type: r.type,
      rrsetId: r.id,
      old: { ttl: r.ttl, records: r.records.map((x) => x.content) },
    });
  }
  return { changes, notes };
}

function countBy(changes: Change[]) {
  const c = { create: 0, update: 0, unchanged: 0, delete: 0 };
  for (const x of changes) c[x.action]++;
  return c;
}

function describeCounts(changes: Change[]): string {
  const c = countBy(changes);
  return `${c.create} create, ${c.update} update, ${c.delete} delete, ${c.unchanged} unchanged`;
}

function changeWarnings(zone: string, changes: Change[]): string[] {
  const z = toZoneName(zone);
  const w: string[] = [];
  for (const c of changes) {
    if (c.action === "unchanged" || c.name !== z) continue;
    const what =
      c.type === "MX"
        ? "mail delivery for the whole domain"
        : c.type === "A" || c.type === "AAAA" || c.type === "ALIAS"
          ? "the main website / domain root"
          : `the zone apex`;
    w.push(`Apex ${c.type} ${c.action}: affects ${what}.`);
  }
  const active = changes.filter((c) => c.action === "update" || c.action === "delete");
  if (active.length) {
    const ttl = Math.max(...active.map((c) => c.old?.ttl ?? 0));
    w.push(`Propagation: resolvers may keep serving old values for up to the old TTL (max ${ttl}s here).`);
  }
  return w;
}

function compactChange(c: Change) {
  return {
    action: c.action,
    name: c.name,
    type: c.type,
    ...(c.old ? { old: c.old } : {}),
    ...(c.new && c.action !== "delete" ? { new: c.new } : {}),
  };
}

function planFor(summary: string, zone: string, changes: Change[], notes: string[] = [], extraWarnings: string[] = []): Plan {
  const shown = changes.filter((c) => c.action !== "unchanged").map(compactChange);
  return {
    summary,
    warnings: [...extraWarnings, ...changeWarnings(zone, changes), ...notes],
    details: { zone, changes: shown, unchanged: countBy(changes).unchanged },
  };
}

async function applyChanges(d: Dns, zone: ApiZone, changes: Change[]) {
  const applied: string[] = [];
  const failed: { rrset: string; error: string }[] = [];
  const order = { delete: 0, update: 1, create: 2, unchanged: 3 } as const;
  for (const c of [...changes].sort((a, b) => order[a.action] - order[b.action])) {
    if (c.action === "unchanged") continue;
    const label = `${c.action} ${c.type} ${c.name}`;
    try {
      if (c.action === "create") {
        await call(d, `/zones/${zone.id}/rrset`, {
          method: "POST",
          body: {
            name: c.name,
            type: c.type,
            ttl: c.new!.ttl,
            records: c.new!.records.map((content) => ({ content, disabled: false })),
            ...(c.comment ? { comment: c.comment } : {}),
          },
        });
      } else if (c.action === "update") {
        await call(d, `/zones/${zone.id}/rrset/${c.rrsetId}`, {
          method: "PATCH",
          body: {
            ttl: c.new!.ttl,
            records: c.new!.records.map((content) => ({ content, disabled: false })),
            ...(c.comment ? { comment: c.comment } : {}),
          },
        });
      } else {
        await call(d, `/zones/${zone.id}/rrset/${c.rrsetId}`, { method: "DELETE" });
      }
      applied.push(label);
    } catch (e) {
      failed.push({ rrset: label, error: (e as Error).message });
    }
  }
  return { applied, failed };
}

/* ------------------------------------------------------------------ zones */

async function findZone(d: Dns, zoneArg: string): Promise<ApiZone> {
  if (UUID_RE.test(zoneArg.trim())) return call<ApiZone>(d, `/zones/${zoneArg.trim()}`);
  const name = toZoneName(zoneArg);
  const zones = await listAll<ApiZone>(d, "/zones", { filter: name.slice(0, -1) });
  const hit = zones.find((z) => z.name.toLowerCase() === name);
  if (!hit) {
    throw new Error(
      `Zone ${name} not found in this project.${zones.length ? ` Similar: ${zones.map((z) => z.name).join(", ")}` : " Call dns_zones_list to see zones."}`,
    );
  }
  return hit;
}

const zoneBrief = (z: ApiZone) => ({
  id: z.id,
  name: z.name,
  comment: z.comment || undefined,
  disabled: z.disabled ?? false,
  delegated: z.last_check_status ?? false,
  created_at: z.created_at,
});

const rrsetBrief = (r: ApiRRSet) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  ttl: r.ttl,
  records: r.records.map((x) => (x.disabled ? `${x.content} (disabled)` : x.content)),
  ...(r.managed_by ? { managed_by: r.managed_by } : {}),
});

const zoneArg = z.string().describe("Zone (domain) name like example.com, or zone id");
const rrsetShape = z.object({
  name: z.string().describe('Record name: relative ("www", "@" for apex) or FQDN'),
  type: z.enum(RECORD_TYPES),
  ttl: z.number().int().min(1).optional().describe(`TTL seconds, default ${DEFAULT_TTL}`),
  records: z.array(z.string()).min(1).describe('Record values, e.g. ["1.2.3.4"], ["10 mail.example.com"], ["v=spf1 -all"]'),
  comment: z.string().optional(),
});

async function loadRrsets(d: Dns, zoneId: string) {
  return listAll<ApiRRSet>(d, `/zones/${zoneId}/rrset`);
}

/** Shared by apply / import / point_to_server: compute upsert diff for a list of inputs. */
async function prepareUpserts(ctx: Context, project: string | undefined, zoneIn: string, inputs: RrsetInput[]) {
  const d = await dnsFor(ctx, project);
  const zone = await findZone(d, zoneIn);
  const desired = inputs.map((i) => normalizeDesired(zone.name, i));
  const existing = await loadRrsets(d, zone.id);
  return { d, zone, existing, ...computeUpserts(zone.name, existing, desired) };
}

async function runUpserts(ctx: Context, project: string | undefined, zoneIn: string, inputs: RrsetInput[]) {
  const p = await prepareUpserts(ctx, project, zoneIn, inputs);
  const res = await applyChanges(p.d, p.zone, p.changes);
  return {
    zone: p.zone.name,
    summary: describeCounts(p.changes),
    ...res,
    unchanged: countBy(p.changes).unchanged,
    notes: p.notes,
    ...(res.failed.length ? { warning: "Some changes failed; fix the errors and re-run — already applied ones will show as unchanged." } : {}),
  };
}

/* ------------------------------------------------------------------ BIND parser */

const TTL_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

export function parseTtl(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^(\d+[smhdwSMHDW])+$/.test(s)) return undefined;
  let total = 0;
  for (const m of s.matchAll(/(\d+)([smhdwSMHDW])/g)) total += Number(m[1]) * TTL_UNITS[m[2]!.toLowerCase()]!;
  return total;
}

interface Logical {
  tokens: string[];
  leadingWs: boolean;
}

function tokenizeBind(text: string): Logical[] {
  const out: Logical[] = [];
  let tokens: string[] = [];
  let depth = 0;
  let leadingWs = false;
  let started = false;
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (!started) {
      leadingWs = /^\s/.test(line);
      started = true;
    }
    let cur = "";
    let inQuote = false;
    const flush = () => {
      if (cur) tokens.push(cur);
      cur = "";
    };
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inQuote) {
        cur += ch;
        if (ch === "\\" && i + 1 < line.length) cur += line[++i];
        else if (ch === '"') {
          inQuote = false;
          flush();
        }
        continue;
      }
      if (ch === '"') {
        flush();
        inQuote = true;
        cur = '"';
      } else if (ch === ";") break;
      else if (ch === "(") {
        flush();
        depth++;
      } else if (ch === ")") {
        flush();
        depth = Math.max(0, depth - 1);
      } else if (/\s/.test(ch)) flush();
      else cur += ch;
    }
    flush();
    if (depth === 0) {
      if (tokens.length) out.push({ tokens, leadingWs });
      tokens = [];
      started = false;
    }
  }
  if (tokens.length) out.push({ tokens, leadingWs });
  return out;
}

export interface BindResult {
  records: RrsetInput[];
  notes: string[];
}

export function parseBindZone(text: string, zoneName: string): BindResult {
  const zone = toZoneName(zoneName);
  const notes: string[] = [];
  let origin = zone;
  let defaultTtl = 3600;
  let lastOwner = zone;
  const groups = new Map<string, { name: string; type: RecordType; ttls: number[]; records: string[] }>();
  const abs = (t: string) => {
    const l = t.toLowerCase();
    if (l === "@") return origin;
    return l.endsWith(".") ? l : `${l}.${origin}`;
  };
  const absRdata = (t: string) => (t === "." ? t : abs(t));
  const quoteTxt = (t: string) => (t.startsWith('"') ? t : `"${t}"`);

  for (const { tokens, leadingWs } of tokenizeBind(text)) {
    const first = tokens[0]!;
    if (first.startsWith("$")) {
      const dir = first.toUpperCase();
      if (dir === "$ORIGIN" && tokens[1]) origin = tokens[1].endsWith(".") ? tokens[1].toLowerCase() : abs(tokens[1]);
      else if (dir === "$TTL" && tokens[1]) {
        const t = parseTtl(tokens[1]);
        if (t === undefined) notes.push(`Ignored invalid $TTL ${tokens[1]}`);
        else defaultTtl = t;
      } else notes.push(`Ignored unsupported directive ${first}`);
      continue;
    }
    const rest = [...tokens];
    let owner: string;
    if (leadingWs) owner = lastOwner;
    else {
      owner = abs(rest.shift()!);
      lastOwner = owner;
    }
    let ttl: number | undefined;
    let type: string | undefined;
    while (rest.length) {
      const t = rest[0]!;
      const parsed = parseTtl(t);
      if (parsed !== undefined) {
        ttl = parsed;
        rest.shift();
      } else if (/^(IN|CH|HS)$/i.test(t)) rest.shift();
      else {
        type = rest.shift()!.toUpperCase();
        break;
      }
    }
    if (!type) {
      notes.push(`Skipped unparsable line: ${tokens.join(" ")}`);
      continue;
    }
    if (type === "SOA") {
      notes.push("Skipped SOA (managed by Selectel)");
      continue;
    }
    if (owner !== zone && !owner.endsWith(`.${zone}`)) {
      notes.push(`Skipped ${type} ${owner}: outside zone ${zone}`);
      continue;
    }
    if (type === "NS" && owner === zone) {
      notes.push(`Skipped apex NS ${rest[0] ?? ""}: apex NS are managed by Selectel (change delegation at your registrar)`);
      continue;
    }
    if (!(RECORD_TYPES as readonly string[]).includes(type)) {
      notes.push(`Skipped ${type} ${owner}: type not supported${type === "SPF" ? " (use TXT)" : ""}`);
      continue;
    }
    let content: string;
    switch (type) {
      case "CNAME":
      case "NS":
      case "ALIAS":
        content = absRdata(rest[0] ?? "");
        break;
      case "MX":
        content = `${rest[0]} ${absRdata(rest[1] ?? "")}`;
        break;
      case "SRV":
        content = `${rest[0]} ${rest[1]} ${rest[2]} ${absRdata(rest[3] ?? "")}`;
        break;
      case "CAA":
        content = `${rest[0]} ${rest[1]} ${quoteTxt(rest.slice(2).join(" "))}`;
        break;
      case "TXT":
        content = rest.map(quoteTxt).join(" ");
        break;
      default:
        content = rest.join(" ");
    }
    const k = keyOf(owner, type);
    const g = groups.get(k) ?? { name: owner, type: type as RecordType, ttls: [], records: [] };
    g.ttls.push(ttl ?? defaultTtl);
    g.records.push(content);
    groups.set(k, g);
  }
  const records: RrsetInput[] = [];
  for (const g of groups.values()) {
    const ttl = Math.min(...g.ttls);
    if (new Set(g.ttls).size > 1) notes.push(`${g.type} ${g.name}: records have different TTLs, using the smallest (${ttl}s)`);
    records.push({ name: g.name, type: g.type, ttl, records: g.records });
  }
  return { records, notes };
}

/* ------------------------------------------------------------------ server IP lookup (point_to_server) */

interface NovaAddress {
  addr: string;
  version: number;
  "OS-EXT-IPS:type"?: string;
}
interface NovaServer {
  id: string;
  name: string;
  addresses?: Record<string, NovaAddress[]>;
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isGlobalV6(ip: string): boolean {
  const l = ip.toLowerCase();
  return !(l === "::1" || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb") || /^f[cd]/.test(l));
}

export function pickServerIps(server: NovaServer): { v4?: string; v6?: string; source?: string } {
  const all = Object.values(server.addresses ?? {}).flat();
  const v4s = all.filter((a) => a.version === 4 && isIPv4(a.addr));
  const floating = v4s.find((a) => a["OS-EXT-IPS:type"] === "floating");
  const pub = floating ?? v4s.find((a) => !isPrivateV4(a.addr));
  const v6 = all.find((a) => a.version === 6 && isIPv6(a.addr) && isGlobalV6(a.addr));
  return { v4: pub?.addr, v6: v6?.addr, source: floating ? "floating IP" : pub ? "public fixed IP" : undefined };
}

async function findServer(ctx: Context, scope: Scope, region: string, ref: string): Promise<NovaServer> {
  if (UUID_RE.test(ref.trim())) {
    const r = await ctx.api.request<{ server: NovaServer }>("compute", scope, region, `/servers/${ref.trim()}`);
    return r.server;
  }
  const r = await ctx.api.request<{ servers?: NovaServer[] }>("compute", scope, region, "/servers/detail", {
    query: { name: ref },
  });
  const exact = (r.servers ?? []).filter((s) => s.name === ref);
  if (exact.length === 0) throw new Error(`Server "${ref}" not found in region ${region}`);
  if (exact.length > 1) throw new Error(`Several servers are named "${ref}" (${exact.map((s) => s.id).join(", ")}) — pass the server id`);
  return exact[0]!;
}

/* ------------------------------------------------------------------ tools */

export const dnsTools: AnyToolDef[] = [
  defineTool({
    name: "dns_zones_list",
    title: "List DNS zones",
    kind: "read",
    description: "Lists DNS zones (domains) hosted in Selectel DNS for a project, with delegation status. Use to see which domains are managed.",
    input: { project: projectArg },
    async run(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const zones = await listAll<ApiZone>(d, "/zones");
      return zones.map(zoneBrief);
    },
  }),

  defineTool({
    name: "dns_zone_get",
    title: "Get DNS zone with all records",
    kind: "read",
    description: "Shows a DNS zone and all its record sets (rrsets). Use to inspect or back up the full DNS configuration of a domain.",
    input: { project: projectArg, zone: zoneArg },
    async run(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const zone = await findZone(d, args.zone);
      const rrsets = await loadRrsets(d, zone.id);
      return { zone: zoneBrief(zone), rrsets: rrsets.map(rrsetBrief) };
    },
  }),

  defineTool({
    name: "dns_records_list",
    title: "List DNS records",
    kind: "read",
    description: "Lists record sets of a zone, optionally filtered by name (relative or FQDN) and/or type. Use to look up how a host name resolves in Selectel DNS.",
    input: {
      project: projectArg,
      zone: zoneArg,
      name: z.string().optional().describe('Exact record name, e.g. "www" or "@"'),
      type: z.enum(RECORD_TYPES).optional(),
    },
    async run(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const zone = await findZone(d, args.zone);
      let rrsets = await loadRrsets(d, zone.id);
      if (args.name !== undefined) {
        const n = toFqdn(args.name, zone.name);
        rrsets = rrsets.filter((r) => r.name.toLowerCase() === n);
      }
      if (args.type) rrsets = rrsets.filter((r) => r.type === args.type);
      return { zone: zone.name, count: rrsets.length, rrsets: rrsets.map(rrsetBrief) };
    },
  }),

  defineTool({
    name: "dns_zone_create",
    title: "Create DNS zone",
    kind: "write",
    description:
      "Adds a domain to Selectel DNS. The result lists the NS servers that must be set at the domain registrar to delegate the domain.",
    input: {
      project: projectArg,
      name: z.string().describe("Domain name, e.g. example.com"),
    },
    async plan(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const name = toZoneName(args.name);
      const exists = await findZone(d, name).then(
        () => true,
        () => false,
      );
      if (exists) throw new Error(`Zone ${name} already exists in this project`);
      return {
        summary: `Create DNS zone ${name}`,
        warnings: ["The domain only starts resolving through Selectel after its NS records are changed at the registrar."],
        details: { zone: name },
      };
    },
    async run(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const name = toZoneName(args.name);
      const zone = await call<ApiZone>(d, "/zones", { method: "POST", body: { name } });
      const rrsets = await listAll<ApiRRSet>(d, `/zones/${zone.id}/rrset`).catch(() => [] as ApiRRSet[]);
      const ns = rrsets.find((r) => r.type === "NS" && r.name.toLowerCase() === name);
      const nameservers = ns?.records.map((r) => r.content) ?? [];
      return {
        zone: zoneBrief(zone),
        nameservers,
        next_step: nameservers.length
          ? `Set these NS servers at your domain registrar: ${nameservers.join(", ")}. Delegation can take up to 24-48 h.`
          : "Nameservers were not returned by the API — open the zone in the Selectel control panel to see the NS servers to set at your registrar.",
      };
    },
  }),

  defineTool({
    name: "dns_zone_delete",
    title: "Delete DNS zone",
    kind: "destructive",
    description: "Deletes a DNS zone with ALL its records. The domain stops resolving via Selectel. Irreversible.",
    input: { project: projectArg, zone: zoneArg },
    async plan(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const zone = await findZone(d, args.zone);
      const rrsets = await loadRrsets(d, zone.id);
      return {
        summary: `Delete DNS zone ${zone.name} with ${rrsets.length} record sets`,
        warnings: [
          "All records of the zone are lost and the domain stops resolving (if delegated to Selectel). Export/backup first with dns_zone_get.",
        ],
        details: { zone: zoneBrief(zone), rrsets: rrsets.map(rrsetBrief) },
      };
    },
    async run(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const zone = await findZone(d, args.zone);
      await call(d, `/zones/${zone.id}`, { method: "DELETE" });
      return { deleted: zone.name };
    },
  }),

  defineTool({
    name: "dns_record_upsert",
    title: "Create or replace DNS record set",
    kind: "write",
    description:
      "Creates or REPLACES one record set (name+type) in a zone. Name may be relative ('www', '@') or FQDN; values are validated (A=IPv4, AAAA=IPv6, no CNAME at apex), TXT is auto-quoted. The plan shows the diff against current values.",
    input: {
      project: projectArg,
      zone: zoneArg,
      name: z.string().describe('Record name: "www", "@" (apex) or FQDN'),
      type: z.enum(RECORD_TYPES),
      ttl: z.number().int().min(1).optional().describe(`TTL seconds, default ${DEFAULT_TTL}`),
      records: z.array(z.string()).min(1).describe("All values of the record set (replaces existing ones)"),
      comment: z.string().optional(),
    },
    async plan(args, ctx) {
      const p = await prepareUpserts(ctx, args.project, args.zone, [args]);
      if (p.changes.length === 0) throw new Error(p.notes.join("; ") || "Nothing to change");
      const c = p.changes[0]!;
      return planFor(
        c.action === "unchanged"
          ? `${c.type} ${c.name} is already up to date`
          : `${c.action === "create" ? "Create" : "Update"} ${c.type} ${c.name} in ${p.zone.name}`,
        p.zone.name,
        p.changes,
        p.notes,
      );
    },
    async run(args, ctx) {
      const r = await runUpserts(ctx, args.project, args.zone, [args]);
      if (r.failed.length) throw new Error(r.failed.map((f) => `${f.rrset}: ${f.error}`).join("; "));
      return r;
    },
  }),

  defineTool({
    name: "dns_record_delete",
    title: "Delete DNS record set",
    kind: "destructive",
    description: "Deletes a whole record set (name+type) from a zone. Apex NS/SOA cannot be deleted.",
    input: {
      project: projectArg,
      zone: zoneArg,
      name: z.string().describe('Record name: "www", "@" or FQDN'),
      type: z.enum(RECORD_TYPES),
    },
    async plan(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const zone = await findZone(d, args.zone);
      const name = toFqdn(args.name, zone.name);
      if (isProtectedApex(name, args.type, zone.name)) throw new Error("Apex NS/SOA records are managed by Selectel and cannot be deleted");
      const rr = (await loadRrsets(d, zone.id)).find((r) => r.name.toLowerCase() === name && r.type === args.type);
      if (!rr) throw new Error(`No ${args.type} record set named ${name} in ${zone.name}`);
      const change: Change = {
        action: "delete",
        name,
        type: rr.type,
        rrsetId: rr.id,
        old: { ttl: rr.ttl, records: rr.records.map((x) => x.content) },
      };
      return planFor(`Delete ${rr.type} ${name} from ${zone.name}`, zone.name, [change]);
    },
    async run(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const zone = await findZone(d, args.zone);
      const name = toFqdn(args.name, zone.name);
      const rr = (await loadRrsets(d, zone.id)).find((r) => r.name.toLowerCase() === name && r.type === args.type);
      if (!rr) throw new Error(`No ${args.type} record set named ${name} in ${zone.name}`);
      await call(d, `/zones/${zone.id}/rrset/${rr.id}`, { method: "DELETE" });
      return { deleted: `${rr.type} ${name}` };
    },
  }),

  defineTool({
    name: "dns_records_apply",
    title: "Apply desired DNS records (bulk, no deletes)",
    kind: "write",
    description:
      "Bulk desired state for a zone: creates missing record sets and updates changed ones (matched by name+type); NEVER deletes anything. Use for migrating a zone from another DNS provider; follow with dns_records_prune to remove leftovers. Apex NS/SOA entries are skipped.",
    input: {
      project: projectArg,
      zone: zoneArg,
      records: z.array(rrsetShape).min(1).describe("Desired record sets: {name,type,ttl,records}"),
    },
    async plan(args, ctx) {
      const p = await prepareUpserts(ctx, args.project, args.zone, args.records);
      return planFor(`Apply to ${p.zone.name}: ${describeCounts(p.changes)}`, p.zone.name, p.changes, p.notes);
    },
    async run(args, ctx) {
      return runUpserts(ctx, args.project, args.zone, args.records);
    },
  }),

  defineTool({
    name: "dns_records_prune",
    title: "Delete DNS record sets not in a keep-list",
    kind: "destructive",
    description:
      "Deletes every record set of a zone that is NOT in `keep` (name+type). Apex SOA/NS and Selectel-managed rrsets are never deleted. Use after dns_records_apply / dns_import_bind to remove leftovers; pass the same list.",
    input: {
      project: projectArg,
      zone: zoneArg,
      keep: z
        .array(z.object({ name: z.string(), type: z.enum(RECORD_TYPES) }))
        .describe("Record sets to keep (name+type); everything else is deleted. Full apply-items are accepted too."),
    },
    async plan(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const zone = await findZone(d, args.zone);
      const { changes, notes } = computePrunes(zone.name, await loadRrsets(d, zone.id), args.keep);
      return planFor(`Prune ${zone.name}: delete ${changes.length} record sets not in the keep-list`, zone.name, changes, notes, [
        "Deleted record sets cannot be restored automatically.",
      ]);
    },
    async run(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const zone = await findZone(d, args.zone);
      const { changes, notes } = computePrunes(zone.name, await loadRrsets(d, zone.id), args.keep);
      return { zone: zone.name, ...(await applyChanges(d, zone, changes)), notes };
    },
  }),

  defineTool({
    name: "dns_import_bind",
    title: "Import BIND zone file",
    kind: "write",
    description:
      "Imports a BIND zone file (text) into an existing Selectel zone: supports $ORIGIN, $TTL, @, relative names, A/AAAA/CNAME/MX/TXT (multi-string)/SRV/CAA/NS. SOA and apex NS are skipped. Creates/updates record sets, never deletes. Use for migrating from another DNS provider (export the zone there first).",
    input: {
      project: projectArg,
      zone: zoneArg,
      zone_file: z.string().min(1).describe("Contents of the BIND zone file"),
    },
    async plan(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const zone = await findZone(d, args.zone);
      const parsed = parseBindZone(args.zone_file, zone.name);
      if (!parsed.records.length) throw new Error(`No importable records found. ${parsed.notes.join("; ")}`);
      const p = await prepareUpserts(ctx, args.project, zone.name, parsed.records);
      return planFor(`Import into ${zone.name}: ${describeCounts(p.changes)}`, zone.name, p.changes, [...parsed.notes, ...p.notes]);
    },
    async run(args, ctx) {
      const d = await dnsFor(ctx, args.project);
      const zone = await findZone(d, args.zone);
      const parsed = parseBindZone(args.zone_file, zone.name);
      const r = await runUpserts(ctx, args.project, zone.name, parsed.records);
      return { ...r, notes: [...parsed.notes, ...r.notes] };
    },
  }),

  defineTool({
    name: "dns_point_to_server",
    title: "Point DNS name to a cloud server",
    kind: "write",
    description:
      "Sets the A record (and AAAA if the server has a public IPv6) of a name to a cloud server's public IP (floating IP, else first public fixed IPv4). Server is given by id or exact name. Use for 'point www.example.com to my server'.",
    input: {
      project: projectArg,
      region: regionArg,
      zone: zoneArg,
      name: z.string().describe('Record name: "www", "@" or FQDN'),
      server: z.string().describe("Server id or exact name"),
      ttl: z.number().int().min(1).optional().describe(`TTL seconds, default ${DEFAULT_TTL}`),
    },
    async plan(args, ctx) {
      const t = await resolveTarget(args, ctx);
      const p = await prepareUpserts(ctx, args.project, args.zone, t.inputs);
      const warnings = [...t.warnings];
      return planFor(
        `Point ${toFqdn(args.name, p.zone.name)} to server ${t.server.name} (${t.ips.v4}${t.ips.v6 ? `, ${t.ips.v6}` : ""})`,
        p.zone.name,
        p.changes,
        p.notes,
        warnings,
      );
    },
    async run(args, ctx) {
      const t = await resolveTarget(args, ctx);
      const r = await runUpserts(ctx, args.project, args.zone, t.inputs);
      if (r.failed.length) throw new Error(r.failed.map((f) => `${f.rrset}: ${f.error}`).join("; "));
      return { server: { id: t.server.id, name: t.server.name }, ip: t.ips, ...r };
    },
  }),
];

async function resolveTarget(
  args: { project?: string; region?: string; zone: string; name: string; server: string; ttl?: number },
  ctx: Context,
) {
  const { scope } = await ctx.projectScope(args.project);
  const region = ctx.resolveRegion(args.region);
  const server = await findServer(ctx, scope, region, args.server);
  const ips = pickServerIps(server);
  if (!ips.v4) throw new Error(`Server ${server.name} has no public IPv4 (no floating IP and no non-private fixed IP)`);
  const inputs: RrsetInput[] = [{ name: args.name, type: "A", ttl: args.ttl, records: [ips.v4] }];
  const warnings = [`Using ${ips.source} ${ips.v4}.`];
  if (ips.v6) inputs.push({ name: args.name, type: "AAAA", ttl: args.ttl, records: [ips.v6] });
  else warnings.push("Server has no public IPv6; any existing AAAA record for this name is left untouched.");
  return { server, ips, inputs, warnings };
}
