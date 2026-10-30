import { z } from 'zod';

/** CLI strings and native MCP values share one validation path. */
export const stringArray = z.union([z.array(z.string()), z.string()])
  .transform((value, ctx) => {
    if (Array.isArray(value)) return value;
    let parsed: unknown;
    try { parsed = JSON.parse(value); }
    catch { parsed = value.split(',').map((item) => item.trim()); }
    const result = z.array(z.string()).safeParse(parsed);
    if (result.success) return result.data;
    ctx.addIssue({ code: 'custom', message: 'Expected a comma-separated list or JSON array of strings' });
    return z.NEVER;
  });

export function jsonObject<T extends z.ZodType>(schema: T) {
  return z.union([schema, z.string()]).transform((value, ctx) => {
    let parsed: unknown = value;
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value); }
      catch {
        ctx.addIssue({ code: 'custom', message: 'Expected a valid JSON object' });
        return z.NEVER;
      }
    }
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    ctx.addIssue({ code: 'custom', message: result.error.message });
    return z.NEVER;
  });
}
