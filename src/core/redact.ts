/**
 * Credential redaction for errors, logs and MCP results.
 * Known active secrets are removed verbatim; credential-shaped text and field names are masked.
 */
export const REDACTED = '[REDACTED]';

const SENSITIVE_FIELD = /passw(?:or)?d|(?:^|[_-])pass(?:$|[_-])|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|\btoken\b|authorization|cookie|credential|private[_-]?key|smtp_pass|imap_pass/i;
const BEARER = /\bBearer\s+[\w.~+/=-]{8,}/gi;
const AUTH_HEADER = /\b(authorization|x-org-auth|cookie|set-cookie)\s*[:=]\s*[^\s,;"']+/gi;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Remove known secrets (and their URL/base64 encodings) and credential-shaped substrings from text. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    const forms = new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]);
    for (const form of forms) out = out.replace(new RegExp(escapeRegExp(form), 'g'), REDACTED);
  }
  return out.replace(BEARER, `Bearer ${REDACTED}`).replace(AUTH_HEADER, `$1: ${REDACTED}`);
}

/** Deep copy with credential-named fields masked and every string leaf scrubbed of known secrets. */
export function redactValue(value: unknown, secrets: readonly string[] = [], key = ''): unknown {
  if (typeof value === 'string') return key && SENSITIVE_FIELD.test(key) && value ? REDACTED : redactText(value, secrets);
  if (Array.isArray(value)) return value.map(v => redactValue(v, secrets, key));
  if (value && typeof value === 'object') {
    if (key && SENSITIVE_FIELD.test(key)) return REDACTED;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, secrets, k)]));
  }
  return value;
}
