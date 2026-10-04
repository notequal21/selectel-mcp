const SENSITIVE_KEY =
  /^(password|adminpass|admin_pass|passwd|secret|secret_key|secretkey|secretaccesskey|token|auth_token|x-auth-token|x-subject-token|access_token|refresh_token|private_key|privatekey|user_data|userdata|credentials?)$/i;

/** Deep-copies a value replacing secret-looking fields with "[redacted]". */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 20 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) && v != null && v !== "" ? "[redacted]" : redact(v, depth + 1);
  }
  return out as T;
}

/** Removes known secret values from free text (e.g. error messages echoed by an API). */
export function scrubText(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out;
}
