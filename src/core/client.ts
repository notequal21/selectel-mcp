import type { Config } from "./config.js";
import { scrubText } from "./redact.js";

export type Scope = { kind: "account" } | { kind: "project"; projectId: string };

interface CatalogEndpoint {
  interface: string;
  region?: string;
  region_id?: string;
  url: string;
}
interface CatalogEntry {
  type: string;
  name?: string;
  endpoints: CatalogEndpoint[];
}

interface CachedToken {
  token: string;
  expiresAt: number;
  catalog: CatalogEntry[];
}

export class SelectelApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly url: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | (string | number)[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Return raw text instead of parsing JSON. */
  raw?: boolean;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function extractErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as unknown;
    if (j && typeof j === "object") {
      const o = j as Record<string, unknown>;
      // OpenStack style: {"itemNotFound": {"message": "...", "code": 404}}
      for (const v of Object.values(o)) {
        if (v && typeof v === "object" && "message" in v) {
          return String((v as { message: unknown }).message);
        }
      }
      for (const key of ["message", "error", "detail", "error_description", "title"]) {
        const v = o[key];
        if (typeof v === "string") return v;
        if (v && typeof v === "object") return JSON.stringify(v);
      }
      if (Array.isArray(o.errors)) return JSON.stringify(o.errors);
    }
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

/**
 * Selectel API client: Keystone auth for a service user (account- and project-scoped IAM tokens),
 * service catalog lookup, and JSON requests with one automatic re-auth on 401.
 */
export class SelectelClient {
  private tokens = new Map<string, Promise<CachedToken>>();

  constructor(
    readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private key(scope: Scope): string {
    return scope.kind === "account" ? "account" : `project:${scope.projectId}`;
  }

  private async issueToken(scope: Scope): Promise<CachedToken> {
    const c = this.config;
    const body = {
      auth: {
        identity: {
          methods: ["password"],
          password: {
            user: { name: c.username, domain: { name: c.userDomainName }, password: c.password },
          },
        },
        scope: scope.kind === "account" ? { domain: { name: c.accountId } } : { project: { id: scope.projectId } },
      },
    };
    const url = `${c.authUrl}/auth/tokens`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(c.httpTimeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      const msg = scrubText(extractErrorMessage(text), [c.password]);
      const hint =
        res.status === 401
          ? " — check SELECTEL_ACCOUNT_ID / SELECTEL_USERNAME / password"
          : res.status === 403 && scope.kind === "project"
            ? ` — service user has no role in project ${scope.projectId}`
            : "";
      throw new SelectelApiError(`Auth failed (${res.status}): ${msg}${hint}`, res.status, "POST", url);
    }
    const token = res.headers.get("x-subject-token");
    if (!token) throw new SelectelApiError("Auth response has no X-Subject-Token header", res.status, "POST", url);
    const parsed = JSON.parse(text) as { token?: { expires_at?: string; catalog?: CatalogEntry[] } };
    const expiresAt = parsed.token?.expires_at ? Date.parse(parsed.token.expires_at) : Date.now() + 60 * 60 * 1000;
    return { token, expiresAt, catalog: parsed.token?.catalog ?? [] };
  }

  async getToken(scope: Scope, forceRefresh = false): Promise<CachedToken> {
    const k = this.key(scope);
    const existing = this.tokens.get(k);
    if (existing && !forceRefresh) {
      try {
        const t = await existing;
        if (t.expiresAt - REFRESH_MARGIN_MS > Date.now()) return t;
      } catch {
        /* fall through and retry */
      }
    }
    const p = this.issueToken(scope);
    this.tokens.set(k, p);
    p.catch(() => {
      if (this.tokens.get(k) === p) this.tokens.delete(k);
    });
    return p;
  }

  /** Lists the regions where a service type is available (from the catalog). */
  async regionsFor(serviceType: string, scope: Scope): Promise<string[]> {
    const { catalog } = await this.getToken(scope);
    const entry = catalog.find((e) => e.type === serviceType);
    if (!entry) return [];
    const regions = entry.endpoints
      .filter((e) => e.interface === "public")
      .map((e) => e.region_id ?? e.region ?? "")
      .filter(Boolean);
    return [...new Set(regions)].sort();
  }

  /** Public endpoint URL for a service type. `region` may be omitted for global services. */
  async endpoint(serviceType: string, scope: Scope, region?: string): Promise<string> {
    const { catalog } = await this.getToken(scope);
    const entry = catalog.find((e) => e.type === serviceType);
    if (!entry) {
      const known = [...new Set(catalog.map((e) => e.type))].sort().join(", ");
      throw new Error(`Service "${serviceType}" is not in the Selectel catalog. Available: ${known}`);
    }
    const pub = entry.endpoints.filter((e) => e.interface === "public");
    const match = region ? pub.find((e) => (e.region_id ?? e.region) === region) : pub[0];
    if (!match) {
      const regions = pub.map((e) => e.region_id ?? e.region).join(", ");
      throw new Error(`Service "${serviceType}" is not available in region "${region}". Available regions: ${regions}`);
    }
    return match.url.replace(/\/+$/, "");
  }

  /** Request to an absolute URL with the token for `scope`. */
  async requestUrl<T = unknown>(scope: Scope, url: string, opts: RequestOptions = {}): Promise<T> {
    const method = (opts.method ?? "GET").toUpperCase();
    const u = new URL(url);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item));
      else u.searchParams.set(k, String(v));
    }
    const doFetch = async (token: string) =>
      this.fetchImpl(u, {
        method,
        headers: {
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...opts.headers,
          "X-Auth-Token": token,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
      });

    let res = await doFetch((await this.getToken(scope)).token);
    if (res.status === 401) {
      res = await doFetch((await this.getToken(scope, true)).token);
    }
    // Requested API microversion not supported by this region: retry once with the service default.
    if (res.status === 406 && opts.headers && Object.keys(opts.headers).some((h) => /api-version/i.test(h))) {
      const headers = Object.fromEntries(Object.entries(opts.headers).filter(([h]) => !/api-version/i.test(h)));
      return this.requestUrl<T>(scope, url, { ...opts, headers });
    }
    const text = await res.text();
    if (!res.ok) {
      const msg = scrubText(extractErrorMessage(text), [this.config.password]);
      throw new SelectelApiError(`${method} ${u.pathname} failed (${res.status}): ${msg}`, res.status, method, u.toString());
    }
    if (opts.raw) return text as T;
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  /** Request to a catalog service: `path` is appended to the service endpoint. */
  async request<T = unknown>(
    serviceType: string,
    scope: Scope,
    region: string | undefined,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const base = await this.endpoint(serviceType, scope, region);
    return this.requestUrl<T>(scope, `${base}${path.startsWith("/") ? "" : "/"}${path}`, opts);
  }
}
