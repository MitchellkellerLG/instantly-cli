import { z } from 'zod';
import type { CatalogEntry, FeatureEntry } from './catalog.js';
import { Finder } from './find.js';
import { registryRevision, contextRevision } from './catalog.js';

export interface CompactError { error: { code: string; message: string; next?: string; did_you_mean?: string[] } }

const VIRTUAL_INPUT = { type: 'object', properties: {}, additionalProperties: false } as const;

function cliUsage(entry: CatalogEntry): { command: string; usage: string; flags: { flag: string; field: string; description: string }[] } {
  if (!entry.definition) {
    return { command: `instantly ${entry.id}`, usage: `instantly --profile <slug> --workspace <uuid> run ${entry.id} --mode read`, flags: [] };
  }
  const d = entry.definition;
  const args = (d.cliMappings.args ?? []).map(a => ({ flag: a.required ? `<${a.name}>` : `[${a.name}]`, field: a.field, description: 'positional argument' }));
  const options = (d.cliMappings.options ?? []).map(o => ({ flag: o.flags, field: o.field, description: o.description ?? '' }));
  return { command: `instantly ${d.group} ${d.subcommand}`, usage: `instantly ${d.group} ${d.subcommand}${args.map(a => ' ' + a.flag).join('')} [options]`, flags: [...args, ...options] };
}

export function describeCommand(entry: CatalogEntry, finder: Finder, registry: string) {
  const inputSchema = entry.definition
    ? z.toJSONSchema(entry.definition.inputSchema, { io: 'input', unrepresentable: 'any' })
    : VIRTUAL_INPUT;
  const write = entry.effect.effect !== 'read';
  const cli = cliUsage(entry);
  return {
    id: entry.id,
    kind: 'command' as const,
    group: entry.group,
    subcommand: entry.subcommand,
    summary: entry.summary,
    description: entry.description,
    availability: entry.availability,
    effect: entry.effect,
    endpoint: entry.definition ? entry.definition.endpoint : { method: 'GET', path: entry.id === 'status' ? '/workspaces/current' : 'several read-only GET paths' },
    input_schema: inputSchema,
    required: (inputSchema as { required?: string[] }).required ?? [],
    examples: entry.definition?.examples ?? [],
    cli,
    side_effects: entry.effect.effect === 'read' ? 'None. Read only.'
      : entry.effect.effect === 'write'
        ? `Mutates the workspace. Cost: ${entry.effect.cost}. Notifications: ${String(entry.effect.notifications)}.`
        : 'Unknown. Execution is not permitted.',
    workspace_rules: 'Pass the bound profile and the workspace_id it is bound to on every preview and run. A mismatch sends nothing.',
    how_to_call: write
      ? 'instantly_preview with command_id, arguments, profile, workspace_id. Then instantly_run mode=write with only the preview_token. Writes are refused unless the host enabled them.'
      : 'instantly_run with mode=read, command_id, arguments, profile, workspace_id.',
    registry_revision: registry,
    context_revision: contextRevision(finder.context),
  };
}

export function describeFeature(entry: FeatureEntry, registry: string, finder: Finder) {
  return { id: entry.id, kind: 'feature' as const, available: false, title: entry.title, reason: entry.reason,
    next: 'There is no supported command. Say so; do not guess an endpoint, raw URL or browser workaround.',
    registry_revision: registry, context_revision: contextRevision(finder.context) };
}

export function unknownCommand(id: string, finder: Finder): CompactError {
  const suggestions = finder.find(id.replace(/[_-]+/g, ' '), 3).hits.filter(h => h.kind === 'command').map(h => h.id);
  return { error: { code: 'UNKNOWN_COMMAND', message: `No command with ID '${id}'.`, did_you_mean: suggestions,
    next: 'Call instantly_find with a plain-language intent to get valid command IDs.' } };
}
export { registryRevision };
