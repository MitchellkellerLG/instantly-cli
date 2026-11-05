import { z } from 'zod';
import { allCommands } from '../commands/index.js';
import type { CompactHost } from '../compact/surface.js';
import { toError } from '../compact/surface.js';
import type { CompactError } from '../compact/describe.js';
import type { Scope } from '../safe/dispatcher.js';
import { recommend, digestText } from './digest.js';
import { allPlaybooks } from './registry.js';
import { PlaybookRunner } from './runner.js';
import { TIER_POLICY, visibleTo } from './tiers.js';
import type { OfferProfile, PlaybookDefinition, Tier } from './types.js';

const NEXT: Record<string, string> = {
  UNKNOWN_PLAYBOOK: 'Call playbooks_list for valid slugs.',
  WRITE_POLICY_DENIED: 'This host or tier has not enabled these writes. The plan is preview-only. Ask the operator; do not retry.',
  SPEND_CEILING: 'The plan may spend more credits than this tier allows. Lower the count or ask the operator.',
  DEPENDENT_VALUE_INVALID: 'A step response did not carry the expected id. Nothing after it ran. Reconcile with the step reconcile read.',
  PLAYBOOK_FORBIDDEN_COMMAND: 'A playbook may never activate, send, pause, delete or reply.',
  TOO_MANY_READS: 'The playbook would read more than the per-run request budget.',
  UNKNOWN_TIER: 'Use vip, managed or internal.',
};
export const playbookError = (error: unknown): CompactError => {
  const out = toError(error);
  const code = out.error.code;
  return NEXT[code] && !out.error.next ? { error: { ...out.error, next: NEXT[code] } } : out;
};

export interface ServiceOptions { host: () => CompactHost; tier: Tier; playbooks?: PlaybookDefinition[]; now?: () => number }

/** One runner per scope so in-memory playbook tokens survive between preview and run in a single process. */
export class PlaybookService {
  private runners = new Map<string, PlaybookRunner>();
  private playbooks: PlaybookDefinition[];
  constructor(private options: ServiceOptions) { this.playbooks = options.playbooks ?? allPlaybooks; }
  get tier(): Tier { return this.options.tier; }
  visible(): PlaybookDefinition[] { return this.playbooks.filter(p => visibleTo(this.options.tier, p)); }
  private async runner(scope: Scope): Promise<PlaybookRunner> {
    const key = `${scope.profile}\0${scope.workspace}`;
    const host = this.options.host();
    const existing = this.runners.get(key);
    if (existing) return existing;
    const dispatcher = await host.dispatcher(() => {});
    const initialized = this.runners.get(key);
    if (initialized) return initialized;
    const created = new PlaybookRunner({ dispatcher, scope, tier: this.options.tier, commands: allCommands, playbooks: this.playbooks,
      hostAllowedWrites: host.allowedWrites, allowUnknownCost: host.allowUnknownCost, now: this.options.now });
    this.runners.set(key, created);
    return created;
  }
  async list(scope?: Scope) {
    try {
      let offer: OfferProfile | null = null;
      if (scope) {
        const preview = await (await this.runner(scope)).preview('offer_profile', {});
        offer = (preview.artifact as { offer_profile: OfferProfile }).offer_profile;
      }
      const visible = this.visible();
      const recs = recommend(offer, this.options.tier, visible);
      return { tier: this.options.tier, offer_profile: offer, playbooks: recs.map(r => {
        const p = visible.find(p => p.slug === r.slug)!;
        return { slug: p.slug, title: p.title, description: p.description, requires: p.requires, fit: r.fit, examples: p.examples };
      }), digest: digestText(offer, recs) };
    } catch (error) { return playbookError(error); }
  }
  describe(slug: string) {
    try {
      const p = this.visible().find(x => x.slug === slug);
      if (!p) throw new Error('UNKNOWN_PLAYBOOK: ' + slug);
      return { slug: p.slug, title: p.title, description: p.description, requires: p.requires, examples: p.examples,
        input_schema: z.toJSONSchema(p.inputSchema, { unrepresentable: 'any', io: 'input' }), tier: this.options.tier,
        tier_policy: { allowed_writes_max: TIER_POLICY[this.options.tier].allowedWrites, credit_ceiling: TIER_POLICY[this.options.tier].creditCeiling, credit_ceiling_enforcement: 'advisory' },
        note: 'Playbooks compile a plan of single registered commands. Browser steps are an attended checklist; this layer never clicks.' };
    } catch (error) { return playbookError(error); }
  }
  async preview(slug: string, input: unknown, scope: Scope) {
    try { return await (await this.runner(scope)).preview(slug, input); } catch (error) { return playbookError(error); }
  }
  async run(token: string, scope: Scope) {
    try { return await (await this.runner(scope)).run(token); } catch (error) { return playbookError(error); }
  }
  async execute(slug: string, input: unknown, confirmHash: string, scope: Scope) {
    try { return await (await this.runner(scope)).execute(slug, input, confirmHash); } catch (error) { return playbookError(error); }
  }
}

export function isPlaybookFailure(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const value = result as { status?: string; run?: unknown };
  return value.status === 'failed' || value.status === 'refused' || (!!value.run && isPlaybookFailure(value.run));
}
