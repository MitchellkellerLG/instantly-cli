import { z } from 'zod';
import type { Computed, Evidence, OfferAngle, OfferCategory, OfferProfile, PlaybookDefinition, ReadResults, ReadStep } from '../types.js';

/** Shared by every playbook that needs to know what the workspace sells. Reads only, all frozen allowlist entries. */
export const OFFER_READS: ReadStep[] = [
  { id: 'workspace', command: 'workspace_get', args: {} },
  { id: 'billing', command: 'workspace_billing_plan-details', args: {}, optional: true },
  { id: 'agents', command: 'ai_agents_list_sales_agents', args: { limit: 10 }, optional: true },
  { id: 'campaigns', command: 'campaigns_list', args: { limit: 100 }, pages: 10, requireComplete: true },
  { id: 'leads', command: 'leads_list', args: { limit: 50 }, optional: true },
];

const AGENT_TYPE: Record<number, OfferCategory> = { 4: 'creator_partnership', 7: 'recruiting', 8: 'investment', 10: 'creator_partnership' };

type Rule = [OfferCategory, RegExp];
const CATEGORY_RULES: Rule[] = [
  ['recruiting', /\b(recruit\w*|staffing|talent|candidates?|headhunt\w*|hiring)\b/gi],
  ['investment', /\b(investors?|fund(?:raising)?|venture|capital|portfolio|lp\b|limited partners?)\b/gi],
  ['agency', /\b(agency|white[- ]?label|done[- ]for[- ]you|clients? campaigns?|lead gen(?:eration)? (?:agency|service))\b/gi],
  ['local_service', /\b(plumb\w*|hvac|roofing|dentist\w*|clinic|restaurant|salon|landscap\w*|local (?:business|service)s?|contractors?|storefront)\b/gi],
  ['creator_partnership', /\b(creators?|influencers?|youtube|tiktok|sponsorship|affiliates?|partnerships?)\b/gi],
  ['saas', /\b(saas|software|platform|app\b|api\b|integration|dashboard|subscription|free trial|demo)\b/gi],
  ['service', /\b(consult\w*|services?|audit|implementation|managed|coaching|design|development)\b/gi],
];
const ANGLE_RULES: [OfferAngle, RegExp][] = [
  ['make_money', /\b(revenue|pipeline|grow(?:th)?|more (?:leads|customers|sales|clients)|roi|close|book(?:ed)? meetings?|sales|increase)\b/gi],
  ['save_time', /\b(automat\w*|save (?:\d+ )?hours?|manual|workflow|faster|streamline|time[- ]consuming|hands[- ]off)\b/gi],
  ['save_money', /\b(cost|cheaper|afford\w*|reduce (?:spend|costs?)|savings?|budget|discount|overpay\w*)\b/gi],
  ['mitigate_risk', /\b(compliance|security|risk|audit|protect\w*|insurance|liabilit\w*|deliverability|safe(?:ty)?|regulat\w*)\b/gi],
];
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

const val = (reads: ReadResults, id: string): any => { const r = reads[id]; return r && r.ok ? r.value : undefined; };
const items = (v: any): any[] => Array.isArray(v?.items) ? v.items : [];
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const clip = (s: string, n = 80) => s.length > n ? s.slice(0, n - 3) + '...' : s;

export function activeEntries(memory: any, key: 'business_offers' | 'icps'): any[] {
  const entries = Array.isArray(memory?.[key]) ? memory[key] : [];
  const indexes = memory?.[`active_${key}_indexes`];
  return Array.isArray(indexes) ? entries.filter((_: unknown, index: number) => indexes.includes(index)) : entries;
}

interface Corpus { text: string; source: string; weight: number; field: string }

export function buildOfferProfile(reads: ReadResults): OfferProfile {
  const evidence: Evidence[] = [];
  const corpora: Corpus[] = [];
  const agents = items(val(reads, 'agents'));
  const campaigns = items(val(reads, 'campaigns'));
  const leads = items(val(reads, 'leads'));

  const categoryVotes = new Map<OfferCategory, number>();
  const vote = (c: OfferCategory, n: number) => categoryVotes.set(c, (categoryVotes.get(c) ?? 0) + n);

  // 1. AI Sales Agent memory is the client's own statement of what they sell.
  for (const agent of agents) {
    const memory = agent?.config?.memory ?? {};
    const offers = activeEntries(memory, 'business_offers').map((o: any) => typeof o === 'string' ? o : [o?.name, o?.description].filter(Boolean).join(' ')).join(' ');
    const icps = activeEntries(memory, 'icps').map((i: any) => [i?.name, i?.usp, ...(i?.problems_solved ?? []), ...(i?.benefits ?? [])].filter(Boolean).join(' ')).join(' ');
    const text = [str(memory.business_description), offers, icps].join(' ').trim();
    if (text) corpora.push({ text, source: 'ai_agents_list_sales_agents', weight: 3, field: 'items[].config.memory' });
    if (typeof agent?.agent_type === 'number' && AGENT_TYPE[agent.agent_type]) {
      vote(AGENT_TYPE[agent.agent_type], 50); // the client's own preset outranks keyword text
      evidence.push({ field: 'items[].agent_type', source: 'ai_agents_list_sales_agents', signal: `agent_type ${agent.agent_type} -> ${AGENT_TYPE[agent.agent_type]}` });
    }
  }
  // 2. Campaign copy and names.
  const copy = campaigns.map(c => [str(c?.name), ...(Array.isArray(c?.sequences) ? c.sequences.flatMap((s: any) => (s?.steps ?? []).flatMap((st: any) => (st?.variants ?? []).map((v: any) => `${str(v?.subject)} ${str(v?.body)}`))) : [])].join(' ')).join(' ').trim();
  if (copy) corpora.push({ text: copy, source: 'campaigns_list', weight: 2, field: 'items[].name,sequences' });
  // 3. Lead sample: titles and domains hint at the audience, not the offer, so weight lowest.
  const titles = leads.map(l => str(l?.job_title)).filter(Boolean).join(' ');
  if (titles) corpora.push({ text: titles, source: 'leads_list', weight: 1, field: 'items[].job_title' });

  for (const corpus of corpora) {
    for (const [category, re] of CATEGORY_RULES) {
      const n = count(corpus.text, new RegExp(re.source, re.flags));
      if (n > 0) {
        vote(category, n * corpus.weight);
        evidence.push({ field: corpus.field, source: corpus.source, signal: `${n} ${category} keyword(s)` });
      }
    }
  }
  const ranked = [...categoryVotes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topCategory = ranked[0];
  const tied = ranked.length > 1 && ranked[0][1] === ranked[1][1];

  const angleVotes = new Map<OfferAngle, number>();
  for (const corpus of corpora.filter(c => c.weight >= 2)) {
    for (const [angle, re] of ANGLE_RULES) {
      const n = count(corpus.text, new RegExp(re.source, re.flags));
      if (n > 0) { angleVotes.set(angle, (angleVotes.get(angle) ?? 0) + n * corpus.weight); evidence.push({ field: corpus.field, source: corpus.source, signal: `${n} ${angle} keyword(s)` }); }
    }
  }
  const angles = [...angleVotes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const angleTied = angles.length > 1 && angles[0][1] === angles[1][1];

  const billing = val(reads, 'billing');
  const subs = billing?.subscriptions ?? {};
  const plan = (key: string) => typeof subs?.[key]?.plan_name === 'string' && subs[key].plan_name !== '';
  const entitlements = {
    outreach: plan('outreach'),
    credits_available: typeof subs?.credits?.available_credits === 'number' ? subs.credits.available_credits : null,
    crm: plan('crm'), website_visitors: plan('website_visitors'), inbox_placement: plan('inbox_placement'),
  };
  if (billing) evidence.push({ field: 'subscriptions', source: 'workspace_billing_plan-details', signal: `outreach=${entitlements.outreach} website_visitors=${entitlements.website_visitors} crm=${entitlements.crm}` });
  const visitorShare = leads.length ? leads.filter(l => l?.is_website_visitor === true).length / leads.length : 0;
  if (visitorShare > 0) evidence.push({ field: 'items[].is_website_visitor', source: 'leads_list', signal: `${Math.round(visitorShare * 100)}% of sampled leads are website visitors` });
  const motion: OfferProfile['motion'] = entitlements.website_visitors || visitorShare >= 0.2 ? 'demand_gen' : (campaigns.length || leads.length ? 'outbound' : 'unknown');

  // Confidence rises only with the client's own statement, never with volume of weak signals.
  const hasAgentText = corpora.some(c => c.source === 'ai_agents_list_sales_agents');
  const hasCopy = corpora.some(c => c.source === 'campaigns_list');
  const category: OfferCategory = !topCategory || tied ? 'unknown' : topCategory[0];
  let confidence: OfferProfile['confidence'] = 'low';
  if (category !== 'unknown') {
    if (hasAgentText && hasCopy) confidence = 'high';
    else if (hasAgentText || hasCopy) confidence = 'medium';
  }
  const angle = angles.length && !angleTied ? angles[0][0] : null;
  if (angle === null) confidence = confidence === 'high' ? 'medium' : confidence;
  evidence.unshift(...(category === 'unknown' ? [] : [{ field: 'offer_category', source: 'derived', signal: `${category} with ${Math.round(((topCategory?.[1] ?? 0) / Math.max(1, [...categoryVotes.values()].reduce((a, b) => a + b, 0))) * 100)}% of votes` }]));
  for (const e of evidence) e.signal = clip(e.signal);
  return {
    offer_angle: angle, offer_category: category, motion, entitlements,
    scale: { campaigns: campaigns.length, sampled_leads: leads.length, sales_agents: agents.length },
    confidence, needs_confirmation: confidence === 'low' || angle === null, evidence,
  };
}

export const offerProfile: PlaybookDefinition = {
  slug: 'offer_profile',
  title: 'Offer-type profile',
  description: 'Detect what this workspace sells and how: offer angle (make_money, save_time, save_money, mitigate_risk), offer category, motion and entitlements. Read-only. Every field carries the command and field it came from. Low confidence asks the operator to confirm instead of guessing.',
  requires: ['api_read'],
  examples: ['instantly playbooks run offer_profile --profile client-a --workspace <uuid>'],
  inputSchema: z.object({}).strict(),
  reads: () => OFFER_READS,
  compute(_input, reads): Computed {
    const profile = buildOfferProfile(reads);
    return { artifact: { offer_profile: profile }, writes: [], browser: [], refusals: profile.needs_confirmation ? [{ code: 'NEEDS_CONFIRMATION', message: 'Confidence is low or the offer category or angle is ambiguous. Confirm with the operator before using this profile to rank playbooks.' }] : [],
      cost: { credits: 'none', max_credits: 0, notes: 'Reads only.' } };
  },
};
