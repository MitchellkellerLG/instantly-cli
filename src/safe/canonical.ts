import { createHash } from 'node:crypto';

/** JSON wire normalization: omitted values and object key order do not change a plan. */
export function canonical(value: unknown): string {
  function sort(v: any): any {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(
      Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, sort(v[k])]),
    );
    return v;
  }
  return JSON.stringify(sort(value));
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const clone = <T>(value: T): T => JSON.parse(canonical(value));
