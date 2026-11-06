import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const URLISH = /^https?:\/\//i;
const h = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);
/** Plan names, enums and statuses carry logic and no identity. Everything else textual is replaced. */
const KEEP = new Set(['plan_name', 'status', 'verification_status', 'event_type', 'interval', 'type', 'next_starting_after', 'next_cursor', 'resource_type', 'agent_type']);
const MAX_ITEMS = 5;

export const synthUuid = (u: string) => `00000000-0000-4000-8000-${h(u.toLowerCase(), 12)}`;

/** Deterministic and pure: the same input always maps to the same output, so cross references survive. */
export function redact(value: unknown, key = ''): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (UUID.test(value)) return synthUuid(value);
    if (EMAIL.test(value)) return `u${h(value, 8)}@example.com`;
    if (ISO.test(value)) return value;
    if (URLISH.test(value)) return `https://example.invalid/${h(value, 8)}`;
    if (KEEP.has(key) && value.length <= 40) return value;
    return value.length <= 2 ? value : `text-${value.length}`;
  }
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(v => redact(v, key));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]));
  return null;
}
/** Findings are empty when nothing identifying survived. Used by the live proof writer and by tests over every committed file. */
export function leaks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!/@example\.com$/.test(m[0])) out.push('email:' + m[0]);
  for (const m of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) if (!/^00000000-0000-4000-8000-[0-9a-f]{12}$/.test(m[0])) out.push('uuid:' + m[0]);
  for (const m of text.matchAll(/\b(?=[A-Za-z0-9_=-]*\d)(?=[A-Za-z0-9_=-]*[A-Za-z])[A-Za-z0-9_=-]{32,}\b/g)) if (!/^[a-f0-9]{64}$/.test(m[0]) && !/^pb-[a-f0-9]{40}$/.test(m[0]) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m[0])) out.push('long-token:' + m[0].slice(0, 6));
  if (/\u2014/.test(text)) out.push('em-dash');
  return out;
}

/** Inputs are operator-supplied, not workspace data. Only identifiers are mapped, so inputs stay valid. */
export function mapUuids(value: unknown): unknown {
  if (typeof value === 'string') return UUID.test(value) ? synthUuid(value) : value;
  if (Array.isArray(value)) return value.map(mapUuids);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mapUuids(v)]));
  return value;
}
export const redactPath = (path: string) => path.split('/').map(seg => (UUID.test(seg) ? synthUuid(seg) : seg)).join('/');
