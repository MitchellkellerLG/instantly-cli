import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { executeCommand } from '../../core/handler.js';
import { FIXED_QUERY, WEB_ROUTES, type Param, type WebRoute } from '../../web/table.js';

const kebab = (s: string) => s.replace(/_/g, '-');
function field(p: Param): z.ZodType {
  let base: z.ZodType;
  if (p.type === 'number') base = z.coerce.number().int().min(0).max(p.max ?? Number.MAX_SAFE_INTEGER);
  else if (p.type === 'cursor') base = z.string().min(1);
  else if (p.type === 'boolean') base = z.boolean();
  else if (p.type === 'enum') base = z.enum(p.values as [string, ...string[]]);
  else base = z.string().min(1).max(100).regex(/^[\w:.+\-]+$/, 'letters, digits and : . + - _ only');
  return (p.required ? base : base.optional()).describe(p.description);
}

/** Table-driven on purpose: the read-only private routes share one shape, one policy and one drift guard. */
function define(route: WebRoute): CommandDefinition {
  const params = route.params ?? [];
  const fixed = FIXED_QUERY[route.id] ?? {};
  const def: CommandDefinition = {
    name: route.id,
    group: route.group,
    subcommand: route.sub,
    origin: 'web',
    mutating: false,
    description: `[Web app, private route] ${route.description} Runs through the attended signed-in browser (set INSTANTLY_WEB_BROWSER_URL); no API key route exists for this.`,
    examples: [`instantly ${route.group} ${route.sub}`],
    inputSchema: z.object(Object.fromEntries(params.map(p => [p.name, field(p)]))),
    cliMappings: { options: params.map(p => ({ field: p.name, flags: p.type === 'boolean' ? `--${kebab(p.name)}` : `--${kebab(p.name)} <${p.name}>`, description: p.description })) },
    endpoint: { method: 'GET', path: route.path },
    fieldMappings: { ...Object.fromEntries(params.map(p => [p.name, 'query' as const])), ...Object.fromEntries(Object.keys(fixed).map(k => [k, 'query' as const])) },
    handler: (input, client) => executeCommand(def, { ...input, ...fixed }, client),
  };
  return def;
}
import { webActionCommands } from './actions.js';
export const webReadCommands: CommandDefinition[] = WEB_ROUTES.map(define);
export const webCommands: CommandDefinition[] = [...webReadCommands, ...webActionCommands];
