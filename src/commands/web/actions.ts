import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { SCREENS, WEB_ACTIONS, actionPath, type WebAction } from '../../web/actions.js';

function define(action: WebAction): CommandDefinition {
  const shape: Record<string, z.ZodType> = {};
  if (action.screenField) shape[action.screenField] = z.enum(Object.keys(SCREENS) as [string, ...string[]]).describe('Screen to open');
  for (const f of action.fills) shape[f.field] = z.string().min(1).max(f.max).describe(f.description);
  const fields = Object.keys(shape);
  const def: CommandDefinition = {
    name: action.id, group: 'web-browser', subcommand: action.sub, origin: 'web', mutating: true,
    description: `[Browser action, attended] ${action.description} Runs in the signed-in browser; needs preview, then a host-enabled write, and the user finishes in the browser.`,
    examples: [
      `instantly --profile <slug> --workspace <uuid> preview ${action.id} --args '${JSON.stringify(Object.fromEntries(fields.map(f => [f, `<${f}>`])))}' --allow-write ${action.id}`,
      `instantly --profile <slug> --workspace <uuid> run --mode write --preview-token <token> --allow-write ${action.id}`,
    ],
    inputSchema: z.object(shape),
    cliMappings: { options: fields.map(f => ({ field: f, flags: `--${f.replace(/_/g, '-')} <${f}>`, description: shape[f].description ?? f })) },
    endpoint: { method: 'POST', path: actionPath(action.id) },
    fieldMappings: Object.fromEntries(fields.map(f => [f, 'body' as const])),
    handler: (input, client) => client.post(actionPath(action.id), Object.fromEntries(fields.map(f => [f, input[f]]))),
  };
  return def;
}
export const webActionCommands: CommandDefinition[] = WEB_ACTIONS.map(define);
