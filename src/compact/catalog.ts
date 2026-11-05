import type { CommandDefinition } from '../core/types.js';
import { activeCommands } from '../commands/active.js';
import { effectPolicy, type EffectPolicy } from '../safe/policy.js';
import { digest } from '../safe/canonical.js';
import { foldedWords } from './text.js';
import context from './context.json';

export interface Context {
  version: string;
  instructions: string;
  tools: { find: string; describe: string; preview: string; run: string };
  groupAliases: Record<string, string[]>;
  synonyms: Record<string, string[]>;
  aliases: Record<string, string[]>;
  features: { id: string; title: string; keywords: string[]; reason: string }[];
}
export const defaultContext: Context = context as Context;
export const contextRevision = (ctx: Context = defaultContext): string => digest(ctx);

export type Availability = 'public' | 'undocumented' | 'virtual' | 'web';
export interface CatalogEntry {
  kind: 'command';
  id: string;
  group: string;
  subcommand: string;
  summary: string;
  description: string;
  effect: EffectPolicy;
  availability: Availability;
  /** Present for registry commands. Virtual commands have no definition. */
  definition?: CommandDefinition;
  idTokens: string[];
  groupTokens: string[];
  subTokens: string[];
  descTokens: string[];
  needsId: boolean;
}
export interface FeatureEntry { kind: 'feature'; id: string; title: string; reason: string; keywords: string[] }

export const VIRTUAL_IDS = ['status', 'health'] as const;
const VIRTUAL: Record<string, { group: string; description: string }> = {
  status: {
    group: 'workspace',
    description: 'Confirm which profile and workspace this process is bound to, and whether it matches the expected workspace. Read-only. Run this first.',
  },
  health: {
    group: 'workspace',
    description: 'Read-only rollup of disconnected accounts, bounce totals, warmup status and campaign sending status for the bound workspace.',
  },
};
const READ_NO_COST: EffectPolicy = { effect: 'read', cost: 'none', notifications: false };

export function summarize(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const sentence = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat;
  return sentence.length > 160 ? sentence.slice(0, 157).trimEnd() + '...' : sentence;
}
function needsIdField(definition: CommandDefinition): boolean {
  const required = (definition.cliMappings.args ?? []).filter(a => a.required).map(a => a.field);
  return required.some(f => f === 'id' || f.endsWith('_id') || f.endsWith('_uuid') || f === 'email' || f === 'uuid');
}

export function buildCatalog(commands: CommandDefinition[] = activeCommands()): CatalogEntry[] {
  const entries: CatalogEntry[] = commands.map(definition => ({
    kind: 'command',
    id: definition.name,
    group: definition.group,
    subcommand: definition.subcommand,
    summary: summarize(definition.description),
    description: definition.description,
    effect: effectPolicy(definition),
    availability: definition.origin === 'web' ? 'web' : definition.description.includes('[Undocumented API]') ? 'undocumented' : 'public',
    definition,
    idTokens: foldedWords(definition.name),
    groupTokens: foldedWords(definition.group),
    subTokens: foldedWords(definition.subcommand),
    descTokens: [...new Set(foldedWords(definition.description.slice(0, 300)))],
    needsId: needsIdField(definition),
  }));
  for (const id of VIRTUAL_IDS) {
    const v = VIRTUAL[id];
    entries.push({
      kind: 'command', id, group: v.group, subcommand: id, summary: summarize(v.description), description: v.description,
      effect: READ_NO_COST, availability: 'virtual', idTokens: foldedWords(id), groupTokens: foldedWords(v.group),
      subTokens: foldedWords(id), descTokens: [...new Set(foldedWords(v.description))], needsId: false,
    });
  }
  return entries;
}

export function buildFeatures(ctx: Context = defaultContext): FeatureEntry[] {
  return ctx.features.map(f => ({ kind: 'feature', id: f.id, title: f.title, reason: f.reason, keywords: [...new Set(f.keywords.flatMap(foldedWords))] }));
}

/** Content hash of the executable registry, matching the frozen evals registry hash. */
export function registryRevision(commands: CommandDefinition[] = activeCommands()): string {
  return digest(commands.map(c => ({ id: c.name, group: c.group, subcommand: c.subcommand,
    endpoint: c.endpoint, fieldMappings: c.fieldMappings, generated: !!c.generated })));
}
