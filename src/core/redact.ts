/**
 * Field names whose values are secrets. Matched anywhere in the key, so vendor-specific fields such as Selectel's
 * `x_sel_server_password_hash` server metadata are caught too.
 */
const SENSITIVE_KEY_PART = /pass(word|wd|phrase)|secret|private[_-]?key|credential|api[_-]?key|adminpass|user[_-]?data/i;

/** Token fields (exact names, so pagination fields like `next_continuation_token` stay intact). */
const SENSITIVE_TOKEN_KEY = /^(x-)?(auth|access|refresh|subject|id|api|session|bearer)?[_-]?token$/i;

/** Values that are secrets whatever their field is called: crypt(3)-style password hashes and PEM private keys. */
const SENSITIVE_VALUE = [
  /^\$(1|2[abxy]?|5|6|7|y|gy|argon2(id|i|d)?|scrypt|pbkdf2[\w-]*|sha\d*)\$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PART.test(key) || SENSITIVE_TOKEN_KEY.test(key);
}

export function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE.some((re) => re.test(value));
}

/** Deep-copies a value replacing secret-looking fields and values with "[redacted]". */
export function redact<T>(value: T, depth = 0): T {
  if (typeof value === "string") return (isSensitiveValue(value) ? "[redacted]" : value) as T;
  if (depth > 20 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) && v != null && v !== "" ? "[redacted]" : redact(v, depth + 1);
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
