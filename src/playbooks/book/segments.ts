import { z } from 'zod';
import { digest } from '../../safe/canonical.js';
import type { Computed, PlaybookDefinition, ReadResults, ReadStep, WriteStep } from '../types.js';
import { OFFER_READS, buildOfferProfile } from './offer.js';

/**
 * Skin-in-the-game segmentation. Instantly rows carry few signals, so the strongest one on each row decides its
 * segment, in this fixed order. A row with none is abstained, never guessed.
 */
const LADDER = ['asset', 'diagnostic', 'pilot', 'program'] as const;
type Rung = typeof LADDER[number];
interface SegmentRule { id: string; signal: string; adjacency: string; persona_kpi: string; rung: Rung }
const RULES: Record<string, SegmentRule> = {
  imported: { id: 'imported', signal: 'imported external signal', adjacency: 'caller-supplied evidence of growth or spend', persona_kpi: 'set by the signal', rung: 'diagnostic' },
  visitor: { id: 'visitor', signal: 'visited the website', adjacency: 'self-selected interest in the problem space', persona_kpi: 'pipeline from warm demand', rung: 'diagnostic' },
  replied: { id: 'replied', signal: 'replied or clicked in a prior campaign', adjacency: 'engaged with the offer category', persona_kpi: 'meetings booked', rung: 'pilot' },
  growth_title: { id: 'growth_title', signal: 'owns growth, sales or demand generation', adjacency: 'persona is measured on pipeline', persona_kpi: 'pipeline per rep', rung: 'pilot' },
  ops_title: { id: 'ops_title', signal: 'owns operations or delivery', adjacency: 'persona is measured on throughput', persona_kpi: 'hours saved per week', rung: 'asset' },
  exec_title: { id: 'exec_title', signal: 'founder or executive buyer', adjacency: 'decision maker with budget authority', persona_kpi: 'revenue growth', rung: 'diagnostic' },
};
const GROWTH = /\b(growth|sales|revenue|demand|marketing|business development|bdr|sdr|cro|cmo)\b/i;
const OPS = /\b(operations?|ops|delivery|logistics|supply|production|coo|process)\b/i;
const EXEC = /\b(founder|owner|ceo|president|managing director|partner|principal)\b/i;

export interface SegmentedLead { id: string; email?: string; job_title?: string; company_domain?: string }
export interface Segment {
  segment_id: string;
  signal: string | null;
  adjacency: string | null;
  persona_kpi: string | null;
  ladder_rung: Rung | null;
  size: number;
  abstained: boolean;
  lead_ids: string[];
}

export function classify(lead: any, imported: Record<string, string>): string | null {
  const domain = String(lead?.company_domain ?? '').toLowerCase();
  if (domain && imported[domain]) return 'imported';
  if (lead?.is_website_visitor === true) return 'visitor';
  if ((Number(lead?.email_reply_count) || 0) > 0 || (Number(lead?.email_click_count) || 0) > 0) return 'replied';
  const title = String(lead?.job_title ?? '');
  if (GROWTH.test(title)) return 'growth_title';
  if (OPS.test(title)) return 'ops_title';
  if (EXEC.test(title)) return 'exec_title';
  return null;
}
export function segmentLeads(leads: any[], imported: Record<string, string> = {}): Segment[] {
  const groups = new Map<string, { rule: SegmentRule | null; label?: string; ids: string[] }>();
  for (const lead of leads) {
    const key = classify(lead, imported);
    let group: string;
    let label: string | undefined;
    if (key === 'imported') { label = imported[String(lead.company_domain).toLowerCase()]; group = `imported:${label}`; } else group = key ?? 'abstain';
    const entry = groups.get(group) ?? { rule: key ? RULES[key] : null, label, ids: [] };
    entry.ids.push(String(lead.id)); groups.set(group, entry);
  }
  return [...groups.entries()].map(([id, g]) => ({
    segment_id: id, signal: g.rule ? (g.label ? `${g.rule.signal}: ${g.label}` : g.rule.signal) : null,
    adjacency: g.rule?.adjacency ?? null, persona_kpi: g.rule?.persona_kpi ?? null, ladder_rung: g.rule?.rung ?? null,
    size: g.ids.length, abstained: !g.rule, lead_ids: g.ids,
  })).sort((a, b) => Number(a.abstained) - Number(b.abstained) || b.size - a.size || a.segment_id.localeCompare(b.segment_id));
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const val = (reads: ReadResults, id: string): any => { const r = reads[id]; return r && r.ok ? r.value : undefined; };
const items = (v: any): any[] => Array.isArray(v?.items) ? v.items : [];
const UUID_RE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export const segments: PlaybookDefinition = {
  slug: 'skin_in_the_game_segments',
  title: 'Skin-in-the-game segmentation',
  description: 'Group the leads of one campaign or list by the single strongest signal on each row (imported signal, website visit, prior engagement, buyer title), name the persona KPI it hits, size each segment and attach an offer ladder rung. Rows with no signal are abstained, never guessed. Optionally stages one holding lead list per segment (idempotent). Leads cannot be tagged through the API, so segments are applied as lists.',
  requires: ['api_read', 'api_write'],
  offerFit: offer => offer.scale.sampled_leads > 0 || offer.scale.campaigns > 0,
  examples: ["instantly --profile <slug> --workspace <uuid> playbooks run skin_in_the_game_segments --input '{\"campaign_id\":\"00000000-0000-4000-8000-000000000001\"}'", "instantly --profile <slug> --workspace <uuid> playbooks run skin_in_the_game_segments --input '{\"list_id\":\"00000000-0000-4000-8000-000000000001\",\"apply\":\"lists\"}'"],
  inputSchema: z.object({
    campaign_id: z.string().regex(new RegExp(`^${UUID_RE}$`)).optional(),
    list_id: z.string().regex(new RegExp(`^${UUID_RE}$`)).optional(),
    max_leads: z.coerce.number().int().min(1).max(500).default(100),
    signals: z.record(z.string().max(60), z.string().min(1).max(80)).refine(o => Object.keys(o).length <= 200, 'at most 200 signals').optional()
      .describe('Optional imported signals: company domain -> short signal text, e.g. from a free signal source'),
    size_filters: z.array(z.record(z.string(), z.unknown())).max(3).optional().describe('Up to 3 SuperSearch filter objects to size for free via enrichment_count'),
    apply: z.enum(['lists']).optional().describe('Stage one holding lead list per segment'),
  }).strict().refine(i => !!i.campaign_id !== !!i.list_id, 'Provide exactly one of campaign_id or list_id'),
  reads(input): ReadStep[] {
    const per = 50;
    const source: ReadStep = { id: 'leads', command: 'leads_list', pages: Math.ceil(input.max_leads / per),
      args: { ...(input.campaign_id ? { campaign_id: input.campaign_id } : { list_id: input.list_id }), limit: per } };
    const sizing: ReadStep[] = (input.size_filters ?? []).map((f: Record<string, unknown>, n: number) => ({ id: `size_${n}`, command: 'enrichment_count', args: { search_filters: f }, optional: true }));
    const existing: ReadStep[] = input.apply ? [{ id: 'lists', command: 'lead_lists_list', args: { limit: 100 }, pages: 10, requireComplete: true }] : [];
    return [source, ...OFFER_READS.filter(r => r.id === 'agents' || r.id === 'billing'), ...sizing, ...existing];
  },
  compute(input, reads): Computed {
    const all = items(val(reads, 'leads')).slice(0, input.max_leads);
    const result = segmentLeads(all, input.signals ?? {});
    const offer = buildOfferProfile(reads);
    const sizing = (input.size_filters ?? []).map((f: unknown, n: number) => ({ filters_index: n, count: reads[`size_${n}`]?.ok ? (reads[`size_${n}`] as any).value : null }));
    const writes: WriteStep[] = [];
    const refusals: Computed['refusals'] = [];
    if (!all.length) refusals.push({ code: 'INSUFFICIENT_DATA', message: 'The source has no leads, so there is nothing to segment.' });
    if (input.apply === 'lists') {
      const existing = new Set(items(val(reads, 'lists')).map(l => String(l?.name ?? '')));
      let stage = 1;
      for (const seg of result.filter(s => !s.abstained && s.size > 0)) {
        const identity = slug(seg.segment_id) + (seg.segment_id.startsWith('imported:') ? '-' + digest(seg.segment_id).slice(0, 16) : '');
        const name = `Segment ${identity}`;
        if (existing.has(name)) continue; // idempotent re-run: no duplicate list
        writes.push({ id: `list_${identity}`, stage: stage++, command: 'lead_lists_create', summary: `Create holding list for segment ${seg.segment_id} (${seg.size} leads)`, args: { name }, credits: 0,
          reconcile: { id: 'lists_check', command: 'lead_lists_list', args: { search: name, limit: 5 } } });
      }
    }
    return { artifact: { offer_profile_summary: { offer_category: offer.offer_category, offer_angle: offer.offer_angle, confidence: offer.confidence },
      source: input.campaign_id ? { campaign_id: input.campaign_id } : { list_id: input.list_id }, sampled: all.length,
      segments: result, abstained: result.filter(s => s.abstained).reduce((n, s) => n + s.size, 0), sizing,
      ladder: [...LADDER], applied_as: input.apply ?? null },
      writes, browser: [], refusals, cost: { credits: 'none', max_credits: 0, notes: 'enrichment_count sizing is free. No enrichment is run.' } };
  },
};
