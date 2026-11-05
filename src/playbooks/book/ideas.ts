import { z } from 'zod';
import { digest } from '../../safe/canonical.js';
import { OFFER_ANGLES, type Computed, type OfferAngle, type OfferCategory, type OfferProfile, type PlaybookDefinition, type ReadResults, type WriteStep } from '../types.js';
import { OFFER_READS, buildOfferProfile, activeEntries } from './offer.js';

export type Scope3 = 'broad' | 'focused' | 'niche';
export interface Signal { id: string; label: string; adjacency: string; persona_kpi: string; source: string }
export interface Idea {
  id: string;
  title: string;
  scope: Scope3;
  offer_angle: OfferAngle;
  ai_strategy: string;
  value_prop: string;
  campaign_overview: string;
  audience: { personas: string[]; industries: string[] };
  /** Focused and niche ideas carry exactly one signal. Broad ideas carry none. */
  skin_in_the_game?: { signal: string; adjacency: string; persona_kpi: string; source: string };
}

/** The model boundary. The default is a deterministic rule engine; a host may inject a model-backed one. */
export interface IdeaSeed {
  offer: OfferProfile;
  personas: string[];
  industries: string[];
  problems: string[];
  existing: string[];
  count: number;
  angle?: OfferAngle;
}
export interface IdeaEngine { generate(seed: IdeaSeed): Idea[] }

// Free, cheap-to-capture signals only (job posts, ad libraries, site changes, DNS/tech fingerprints).
// Each signal is "growing or spending" evidence adjacent to the offer, never the offer's exact buyer.
const SIGNALS: Record<OfferCategory, Signal[]> = (() => {
  const s = (id: string, label: string, adjacency: string, persona_kpi: string, source: string): Signal => ({ id, label, adjacency, persona_kpi, source });
  const common = [
    s('hiring_sdr', 'is hiring sales development reps', 'investing in outbound capacity', 'pipeline per rep', 'public job posts'),
    s('running_ads', 'is running paid ads', 'already paying for attention', 'cost per acquired customer', 'ad library'),
    s('new_funding', 'announced new funding', 'has budget and a growth mandate', 'time to hit the next milestone', 'funding news'),
    s('site_rebuild', 'recently rebuilt its website', 'investing in conversion', 'visitor to lead rate', 'site archive diff'),
  ];
  return {
    saas: [...common, s('new_integration', 'shipped a new integration', 'expanding the ecosystem', 'activation rate', 'changelog'), s('pricing_change', 'changed its pricing page', 'testing monetisation', 'average contract value', 'site archive diff')],
    service: [...common, s('new_case_study', 'published a new case study', 'investing in proof', 'close rate', 'site archive diff'), s('hiring_ops', 'is hiring operations staff', 'scaling delivery', 'utilisation', 'public job posts')],
    local_service: [s('new_location', 'opened a new location', 'expanding footprint', 'booked jobs per week', 'maps listing'), s('review_growth', 'is gaining reviews quickly', 'demand is rising', 'booked jobs per week', 'maps listing'), s('running_ads', 'is running local ads', 'already paying for leads', 'cost per booked job', 'ad library'), s('hiring_field', 'is hiring field staff', 'capacity to take more work', 'jobs per crew', 'public job posts')],
    agency: [...common, s('new_client_logo', 'added new client logos', 'winning business', 'retainer count', 'site archive diff'), s('hiring_account', 'is hiring account managers', 'scaling delivery', 'clients per manager', 'public job posts')],
    recruiting: [s('open_roles', 'has many open roles', 'hiring is the bottleneck', 'time to fill', 'public job posts'), s('repost_roles', 'keeps reposting the same role', 'struggling to fill', 'time to fill', 'public job posts'), s('new_funding', 'announced new funding', 'has budget to hire', 'headcount plan', 'funding news')],
    creator_partnership: [s('new_channel', 'launched a new channel', 'investing in audience', 'qualified reach', 'platform profile'), s('sponsor_mentions', 'is running sponsor reads', 'already buys creator reach', 'cost per qualified view', 'platform profile')],
    investment: [s('new_fund', 'announced a new fund', 'deploying capital', 'deals reviewed per partner', 'funding news'), s('thesis_post', 'published a thesis post', 'actively sourcing', 'qualified deal flow', 'site archive diff')],
    unknown: common,
  };
})();
const DEFAULT_PERSONAS: Record<OfferCategory, string[]> = {
  saas: ['Head of Growth', 'VP Sales', 'Founder'], service: ['Founder', 'Managing Director', 'Head of Operations'],
  local_service: ['Owner', 'General Manager', 'Operations Manager'], agency: ['Agency Owner', 'Head of Growth', 'Head of Client Services'],
  recruiting: ['Head of Talent', 'VP People', 'Founder'], creator_partnership: ['Head of Partnerships', 'Brand Manager', 'Founder'],
  investment: ['Managing Partner', 'Principal', 'Head of Investor Relations'], unknown: ['Founder', 'Head of Growth', 'VP Sales'],
};
const DEFAULT_INDUSTRIES: Record<OfferCategory, string[]> = {
  saas: ['B2B software', 'Fintech', 'Healthcare technology', 'Developer tools'], service: ['Professional services', 'Manufacturing', 'Logistics', 'Construction'],
  local_service: ['Home services', 'Dental and medical practices', 'Fitness and wellness', 'Automotive services'], agency: ['Marketing agencies', 'Software companies', 'E-commerce brands', 'Consultancies'],
  recruiting: ['Technology', 'Healthcare', 'Financial services', 'Engineering'], creator_partnership: ['Consumer brands', 'Software', 'Education', 'Gaming'],
  investment: ['Seed-stage startups', 'Real estate', 'Climate technology', 'Consumer brands'], unknown: ['Software', 'Professional services', 'E-commerce', 'Healthcare'],
};
const ANGLE_PHRASE: Record<OfferAngle, string> = {
  make_money: 'win more revenue', save_time: 'take manual work off the team', save_money: 'cut a cost they already carry', mitigate_risk: 'remove a risk before it bites',
};
const ANGLE_STRATEGY: Record<OfferAngle, string> = {
  make_money: 'Lead with a specific revenue outcome and one proof point; ask for a short call.',
  save_time: 'Lead with the hours the manual process costs; offer a done-with-you first pass.',
  save_money: 'Lead with the current spend and a concrete saving; offer a side-by-side comparison.',
  mitigate_risk: 'Lead with the exposure and a recent example; offer a quick audit.',
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3));
const overlap = (a: string, b: string) => { const x = tokens(a), y = tokens(b); if (!x.size || !y.size) return 0; let n = 0; for (const t of x) if (y.has(t)) n++; return n / Math.min(x.size, y.size); };

export const ruleEngine: IdeaEngine = {
  generate(seed) {
    const category = seed.offer.offer_category;
    const signals = SIGNALS[category];
    const personas = (seed.personas.length ? seed.personas : DEFAULT_PERSONAS[category]).slice(0, 4);
    const industries = (seed.industries.length ? seed.industries : DEFAULT_INDUSTRIES[category]).slice(0, 5);
    const primary: OfferAngle = seed.angle ?? seed.offer.offer_angle ?? 'make_money';
    const angleOrder: OfferAngle[] = seed.angle ? [seed.angle] : [primary, ...OFFER_ANGLES.filter(a => a !== primary)];
    const pool: Idea[] = [];
    const add = (scope: Scope3, angle: OfferAngle, ps: string[], inds: string[], signal?: Signal) => {
      const lead = ps[0];
      const where = inds.length === 1 ? inds[0] : `${inds.length} industries`;
      const title = scope === 'broad' ? `${lead} teams that want to ${ANGLE_PHRASE[angle]}`
        : scope === 'focused' ? `${where}: ${lead}s whose company ${signal!.label}`
        : `${inds[0]} niche: ${lead}s when the company ${signal!.label}`;
      pool.push({
        id: '', title, scope, offer_angle: angle,
        ai_strategy: scope === 'broad' ? ANGLE_STRATEGY[angle] : `${ANGLE_STRATEGY[angle]} Open with the signal: the company ${signal!.label}.`,
        value_prop: `${ANGLE_PHRASE[angle][0].toUpperCase()}${ANGLE_PHRASE[angle].slice(1)} for ${lead}s${seed.problems[0] ? `, starting with: ${seed.problems[0]}` : ''}.`,
        campaign_overview: `${scope} campaign to ${ps.join(' / ')} in ${inds.join(', ')}${signal ? `; one signal: ${signal.label} (${signal.source})` : ''}.`,
        audience: { personas: ps, industries: inds },
        ...(signal ? { skin_in_the_game: { signal: signal.label, adjacency: signal.adjacency, persona_kpi: signal.persona_kpi, source: signal.source } } : {}),
      });
    };
    // Broad: one per angle and lead persona. Focused: industry x persona x signal. Niche: one industry, one signal, one persona.
    for (const angle of angleOrder) for (const p of personas.slice(0, 2)) add('broad', angle, [p], industries.slice(0, 3));
    let i = 0;
    for (const ind of industries) for (const sig of signals) {
      const angle = angleOrder[i % angleOrder.length];
      add('focused', angle, personas.slice(0, 2), [ind], sig);
      add('niche', angleOrder[(i + 1) % angleOrder.length], [personas[(i + 1) % personas.length]], [ind], signals[(i + 2) % signals.length]);
      i++;
    }
    const seen = new Set<string>();
    const unique = pool.filter(idea => { if (seen.has(idea.title)) return false; seen.add(idea.title); return true; });
    // Novelty: drop ideas that restate an existing campaign name.
    const novel = unique.filter(idea => !seed.existing.some(name => overlap(name, idea.title) >= 0.8));
    const byScope = (s: Scope3) => novel.filter(x => x.scope === s);
    const want: Record<Scope3, number> = { broad: Math.max(3, Math.round(seed.count * 0.2)), focused: Math.max(3, Math.round(seed.count * 0.45)), niche: 0 };
    want.niche = Math.max(3, seed.count - want.broad - want.focused);
    const picked: Idea[] = [];
    for (const scope of ['broad', 'focused', 'niche'] as Scope3[]) picked.push(...byScope(scope).slice(0, want[scope]));
    for (const idea of novel) { if (picked.length >= seed.count) break; if (!picked.includes(idea)) picked.push(idea); }
    return picked.slice(0, Math.max(seed.count, 0)).map((idea, n) => ({ ...idea, id: `idea-${String(n + 1).padStart(2, '0')}` }));
  },
};

const val = (reads: ReadResults, id: string): any => { const r = reads[id]; return r && r.ok ? r.value : undefined; };
const items = (v: any): any[] => Array.isArray(v?.items) ? v.items : [];
const uniq = (xs: string[]) => [...new Set(xs.map(x => x.trim()).filter(Boolean))];

export function seedFrom(reads: ReadResults, offer: OfferProfile, count: number, angle?: OfferAngle): IdeaSeed {
  const icps = items(val(reads, 'agents')).flatMap(a => activeEntries(a?.config?.memory, 'icps'));
  const leadTitles = items(val(reads, 'leads')).map(l => String(l?.job_title ?? ''));
  const personas = uniq([...icps.flatMap((i: any) => i?.job_title?.include ?? []), ...leadTitles]).slice(0, 4);
  const industries = uniq(icps.flatMap((i: any) => i?.industry ?? [])).slice(0, 5);
  const problems = uniq(icps.flatMap((i: any) => i?.problems_solved ?? [])).slice(0, 3);
  const existing = items(val(reads, 'campaigns')).map(c => String(c?.name ?? ''));
  return { offer, personas, industries, problems, existing, count, angle };
}

export function draftSequence(idea: Idea) {
  const signal = idea.skin_in_the_game?.signal;
  return [{ steps: [
    { type: 'email', delay: 4, delay_unit: 'days', variants: [{ subject: 'Quick question, {{firstName}}',
      body: `Hi {{firstName}},\n\n[DRAFT - rewrite with campaign-copywriting] ${signal ? `Noticed {{companyName}} ${signal}. ` : ''}${idea.value_prop}\n\nWorth a short call?` }] },
    { type: 'email', delay: 0, delay_unit: 'days', variants: [{ subject: 'Re: Quick question, {{firstName}}', body: 'Hi {{firstName}},\n\n[DRAFT - rewrite with campaign-copywriting] Following up in case this got buried.' }] },
  ] }];
}

export function makeIdeas(engine: IdeaEngine) {
  const def: PlaybookDefinition = {
    slug: 'campaign_ideas',
    title: 'One-click novel campaign ideas',
    description: 'Generate 15 to 25 campaign ideas (broad, focused, niche) from this workspace: offer profile, ICPs, existing campaigns and a lead sample. Each focused or niche idea carries one skin-in-the-game signal. Optionally stages a paused draft campaign with no senders plus a target lead list for one chosen idea; it can never send or activate.',
    requires: ['api_read', 'api_write'],
    examples: ["instantly --profile <slug> --workspace <uuid> playbooks run campaign_ideas --input '{\"count\":18}'", "instantly --profile <slug> --workspace <uuid> playbooks run campaign_ideas --input '{\"draft_idea\":\"idea-03\"}'"],
    inputSchema: z.object({
      count: z.coerce.number().int().min(15).max(25).default(18).describe('How many ideas (15 to 25)'),
      offer_angle: z.enum(OFFER_ANGLES).optional().describe('Only ideas with this offer angle'),
      draft_idea: z.string().regex(/^idea-\d{2}$/).optional().describe('Stage a paused draft campaign and list for this idea id'),
    }).strict(),
    reads: () => OFFER_READS,
    compute(input, reads): Computed {
      const offer = buildOfferProfile(reads);
      const ideas = engine.generate(seedFrom(reads, offer, input.count, input.offer_angle));
      const writes: WriteStep[] = [];
      const refusals: Computed['refusals'] = [];
      if (ideas.length < 15) refusals.push({ code: 'INSUFFICIENT_DATA', message: `Only ${ideas.length} novel ideas could be produced. Add ICP detail to the AI Sales Agent or widen the angle filter.` });
      if (input.draft_idea) {
        const idea = ideas.find(i => i.id === input.draft_idea);
        if (!idea) refusals.push({ code: 'INSUFFICIENT_DATA', message: `${input.draft_idea} is not in this run's ideas. Ids are stable for the same workspace state; list first.` });
        else {
          const stem = idea.title.slice(0, 60);
          writes.push({ id: 'list', stage: 1, command: 'lead_lists_create', summary: 'Create the target lead list', args: { name: `${stem} - targets` }, credits: 0,
            reconcile: { id: 'list_check', command: 'lead_lists_list', args: { search: `${stem} - targets`, limit: 5 } } });
          writes.push({ id: 'campaign', stage: 2, command: 'campaigns_create', summary: 'Create a paused draft campaign with no senders (cannot send)', credits: 0,
            args: { name: `[DRAFT] ${stem}`, text_only: true, stop_on_reply: true, sequences: draftSequence(idea) },
            reconcile: { id: 'campaign_check', command: 'campaigns_list', args: { search: `[DRAFT] ${stem}`, limit: 5 } } });
        }
      }
      return { artifact: { offer_profile: offer, ideas, idea_engine: 'rules-v1', ideas_hash: digest(ideas) }, writes, browser: [], refusals,
        cost: { credits: 'none', max_credits: 0, notes: 'Reads and organisational writes only. No enrichment, no lead-finder agent, no activation.' } };
    },
  };
  return def;
}
export const campaignIdeas = makeIdeas(ruleEngine);
