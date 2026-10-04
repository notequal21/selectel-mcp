import { z } from "zod";
import { SelectelApiError, type Scope } from "../core/client.js";
import type { Context } from "../core/context.js";
import { defineTool, type AnyToolDef } from "../core/tool.js";

const ACCOUNT: Scope = { kind: "account" };
const API = "https://api.selectel.ru";

const NO_BILLING_ROLE =
  'The service user has no access to billing (HTTP 403). Fix: in the Selectel control panel open Account → Users (IAM) → the service user used by this MCP server → assign the "billing" role (account scope), then retry.';

/** Kopecks → rubles with 2 decimals. */
export function rub(kopecks: unknown): number {
  const n = Number(kopecks ?? 0);
  return Math.round(Number.isFinite(n) ? n : 0) / 100;
}

async function billingGet<T>(ctx: Context, path: string, query?: Record<string, string | string[]>): Promise<T> {
  try {
    return await ctx.api.requestUrl<T>(ACCOUNT, `${API}${path}`, { query });
  } catch (e) {
    if (e instanceof SelectelApiError && e.status === 403) throw new Error(NO_BILLING_ROLE);
    throw e;
  }
}

interface RawBilling {
  agreement_id?: number | string;
  billing_type?: string;
  balances?: { balance_type?: string; value?: number }[];
  balances_values_sum?: number;
  debt_sum?: number;
  final_sum?: number;
}

export interface BalanceBilling {
  agreement_id?: number | string;
  billing_type?: string;
  balances: Record<string, number>;
  balances_sum: number;
  debt: number;
  available: number;
}

/** Parses both /v4/balances ({agreements:[{billings}]}) and /v3/balances ({billings}) responses. */
export function parseBalances(raw: unknown): { currency: string; billings: BalanceBilling[]; totalAvailable: number } {
  const data = ((raw as { data?: Record<string, unknown> })?.data ?? {}) as {
    agreements?: { agreement_id?: number | string; billings?: RawBilling[] }[];
    billings?: RawBilling[];
    settings?: { currency?: string };
  };
  const flat: RawBilling[] = data.agreements
    ? data.agreements.flatMap((a) => (a.billings ?? []).map((b) => ({ agreement_id: a.agreement_id, ...b })))
    : (data.billings ?? []);
  const billings = flat.map((b): BalanceBilling => {
    const balances: Record<string, number> = {};
    for (const x of b.balances ?? []) balances[x.balance_type ?? "unknown"] = rub(x.value);
    return {
      agreement_id: b.agreement_id,
      billing_type: b.billing_type,
      balances,
      balances_sum: rub(b.balances_values_sum ?? (b.balances ?? []).reduce((s, x) => s + (x.value ?? 0), 0)),
      debt: rub(b.debt_sum),
      available: rub(b.final_sum),
    };
  });
  const totalAvailable = Math.round(billings.reduce((s, b) => s + b.available * 100, 0)) / 100;
  return { currency: (data.settings?.currency ?? "rub").toUpperCase(), billings, totalAvailable };
}

const PREDICTION_LABELS: Record<string, string> = {
  primary: "Cloud servers and main services",
  storage: "Object storage",
  vmware: "VMware",
  vpc: "VPC",
};

export function humanHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return "no active services";
  if (hours <= 0) return "insufficient funds";
  const total = Math.floor(hours);
  const d = Math.floor(total / 24);
  const h = total % 24;
  if (d === 0) return `${h} h`;
  return h === 0 ? `${d} d` : `${d} d ${h} h`;
}

export function parsePrediction(raw: unknown) {
  const data = ((raw as { data?: Record<string, number | null> })?.data ?? {}) as Record<string, number | null>;
  return Object.entries(data).map(([category, hours]) => ({
    category,
    label: PREDICTION_LABELS[category] ?? category,
    hours: hours ?? null,
    lasts: humanHours(hours),
  }));
}

async function fetchBalances(ctx: Context) {
  // The reference Python project (with real fixtures) uses /v4/balances (agreements → billings → balances);
  // the Go exporter uses the older /v3/balances (only billings[].final_sum). Prefer v4, fall back to v3 on 404/405.
  try {
    return parseBalances(await billingGet(ctx, "/v4/balances"));
  } catch (e) {
    if (e instanceof SelectelApiError && (e.status === 404 || e.status === 405)) {
      return parseBalances(await billingGet(ctx, "/v3/balances"));
    }
    throw e;
  }
}

interface ReportRow {
  project_id?: string;
  project_name?: string;
  product_name?: string;
  service_name?: string;
  resource_id?: string;
  resource_name?: string;
  resource_type_name?: string;
  metric_name?: string;
  balance?: string;
  value?: number;
}

function extractRows(raw: unknown): ReportRow[] {
  if (Array.isArray(raw)) return raw as ReportRow[];
  const o = raw as { status?: string; data?: unknown; error?: unknown } | undefined;
  if (o?.status === "error") throw new Error(`Billing report failed: ${String(o.error)}`);
  return Array.isArray(o?.data) ? (o!.data as ReportRow[]) : [];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function fetchReport(ctx: Context, start: string, end: string, projects?: string[]) {
  for (const [k, v] of [["start", start], ["end", end]] as const) {
    if (!DATE_RE.test(v)) throw new Error(`${k} must be YYYY-MM-DD, got "${v}"`);
  }
  if (start > end) throw new Error("start must not be after end");
  const query: Record<string, string | string[]> = { start, end, locale: "en" };
  if (projects?.length) {
    const ids: string[] = [];
    for (const p of projects) ids.push((await ctx.resolveProject(p)).id);
    query.project_ids = ids;
  }
  let rows = extractRows(await billingGet(ctx, "/v1/billing/report/by_project/flat", query));
  let hiddenByAllowlist = 0;
  if (ctx.config.allowedProjects) {
    const before = rows.length;
    rows = rows.filter((r) =>
      ctx.isProjectAllowed({ id: r.project_id ?? "", name: r.project_name ?? "" }),
    );
    hiddenByAllowlist = before - rows.length;
  }
  return { rows, hiddenByAllowlist };
}

function sumBy<T>(rows: ReportRow[], key: (r: ReportRow) => string, label: (r: ReportRow) => T) {
  const m = new Map<string, { label: T; kopecks: number }>();
  for (const r of rows) {
    const k = key(r);
    const cur = m.get(k) ?? { label: label(r), kopecks: 0 };
    cur.kopecks += Number(r.value ?? 0);
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.kopecks - a.kopecks);
}

const projectKey = (r: ReportRow) => r.project_id ?? r.project_name ?? "?";
const serviceKey = (r: ReportRow) => r.service_name ?? r.product_name ?? "?";
const objectKey = (r: ReportRow) => `${projectKey(r)}|${serviceKey(r)}|${r.resource_id ?? r.resource_name ?? "?"}`;
const objectLabel = (r: ReportRow) => ({
  project: r.project_name,
  service: serviceKey(r),
  object: r.resource_name || r.resource_id || "(unnamed)",
  type: r.resource_type_name,
});

function share(k: number, total: number): number {
  return total > 0 ? Math.round((k / total) * 1000) / 10 : 0;
}

export const billingTools: AnyToolDef[] = [
  defineTool({
    name: "billing_balance",
    title: "Account balance and runway",
    kind: "read",
    description:
      "Shows the Selectel account balances (main/bonus/... in rubles), debt, and the prediction of how long the balance lasts per service category, in one call. Use for 'how much money is left' / 'when will funds run out'. Needs the service user to have the billing role.",
    input: {},
    async run(_args, ctx) {
      const balances = await fetchBalances(ctx);
      const prediction = await billingGet(ctx, "/v2/billing/prediction")
        .then(parsePrediction)
        .catch((e: Error) => `unavailable: ${e.message}`);
      return {
        currency: balances.currency,
        total_available: balances.totalAvailable,
        billings: balances.billings,
        balance_lasts: prediction,
      };
    },
  }),
  defineTool({
    name: "billing_report",
    title: "Consumption report",
    kind: "read",
    description:
      "Consumption (spend) report for a period, grouped by project, service or object (server, volume, ...), with totals in rubles. Default period: start of the current month to today. Use to find what costs money.",
    input: {
      start: z.string().optional().describe("Period start YYYY-MM-DD; default: first day of current month"),
      end: z.string().optional().describe("Period end YYYY-MM-DD; default: today"),
      group_by: z.enum(["project", "service", "object"]).default("project").describe("Grouping of the result"),
      top: z.number().int().min(1).max(200).default(20).describe("Return only the N biggest groups"),
      projects: z.array(z.string()).optional().describe("Limit to these project ids/names"),
    },
    async run(args, ctx) {
      const now = new Date();
      const start = args.start ?? ymd(new Date(now.getFullYear(), now.getMonth(), 1));
      const end = args.end ?? ymd(now);
      const { rows, hiddenByAllowlist } = await fetchReport(ctx, start, end, args.projects);
      const totalK = rows.reduce((s, r) => s + Number(r.value ?? 0), 0);
      const groupBy = args.group_by ?? "project";
      let groups: unknown[];
      if (groupBy === "project") {
        groups = sumBy(rows, projectKey, (r) => ({ project: r.project_name, project_id: r.project_id })).map((g) => {
          const pid = (g.label as { project_id?: string }).project_id;
          const services = sumBy(
            rows.filter((r) => r.project_id === pid),
            serviceKey,
            serviceKey,
          )
            .slice(0, 5)
            .map((s) => ({ service: s.label, amount: rub(s.kopecks) }));
          return { ...(g.label as object), amount: rub(g.kopecks), share_percent: share(g.kopecks, totalK), top_services: services };
        });
      } else if (groupBy === "service") {
        groups = sumBy(rows, serviceKey, serviceKey).map((g) => ({
          service: g.label,
          amount: rub(g.kopecks),
          share_percent: share(g.kopecks, totalK),
        }));
      } else {
        groups = sumBy(rows, objectKey, objectLabel).map((g) => ({
          ...g.label,
          amount: rub(g.kopecks),
          share_percent: share(g.kopecks, totalK),
        }));
      }
      const byBalance: Record<string, number> = {};
      for (const r of rows) byBalance[r.balance ?? "unknown"] = (byBalance[r.balance ?? "unknown"] ?? 0) + Number(r.value ?? 0);
      return {
        period: { start, end },
        currency: "RUB",
        group_by: groupBy,
        total: rub(totalK),
        total_by_balance: Object.fromEntries(Object.entries(byBalance).map(([k, v]) => [k, rub(v)])),
        groups_total: groups.length,
        groups: groups.slice(0, args.top ?? 20),
        ...(hiddenByAllowlist ? { note: `${hiddenByAllowlist} report rows of projects outside SELECTEL_ALLOWED_PROJECTS were excluded` } : {}),
      };
    },
  }),
  defineTool({
    name: "billing_summary",
    title: "Where does my money go",
    kind: "read",
    description:
      "One-call money overview: spend so far this month, projected month total (linear ESTIMATE), top 5 consumers and how many days the balance lasts. Use for 'how much do I spend' / 'what is the biggest cost'.",
    input: {},
    async run(_args, ctx) {
      const now = new Date();
      const start = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
      const end = ymd(now);
      const { rows, hiddenByAllowlist } = await fetchReport(ctx, start, end);
      const spentK = rows.reduce((s, r) => s + Number(r.value ?? 0), 0);
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const elapsed = now.getDate();
      const projectedK = (spentK / elapsed) * daysInMonth;
      const top = sumBy(rows, objectKey, objectLabel)
        .slice(0, 5)
        .map((g) => ({ ...g.label, amount: rub(g.kopecks), share_percent: share(g.kopecks, spentK) }));

      const balance = await fetchBalances(ctx).catch((e: Error) => e);
      if (balance instanceof Error && balance.message === NO_BILLING_ROLE) throw balance;
      const prediction = await billingGet(ctx, "/v2/billing/prediction").then(parsePrediction).catch(() => []);
      const primary = prediction.find((p) => p.category === "primary") ?? prediction[0];
      return {
        month: { start, end, days_elapsed: elapsed, days_in_month: daysInMonth },
        currency: "RUB",
        spent_so_far: rub(spentK),
        projected_month_total_estimate: rub(projectedK),
        projection_note: "ESTIMATE: spend so far / days elapsed × days in month; one-off charges and monthly fees billed later are not modelled.",
        top_consumers: top,
        balance_available: balance instanceof Error ? null : balance.totalAvailable,
        days_left_on_balance:
          primary?.hours === null || primary?.hours === undefined ? null : Math.round((primary.hours / 24) * 10) / 10,
        balance_lasts: prediction,
        ...(hiddenByAllowlist ? { note: `${hiddenByAllowlist} rows of projects outside SELECTEL_ALLOWED_PROJECTS were excluded` } : {}),
      };
    },
  }),
];
