import { z } from 'zod';
import { digest } from '../../safe/canonical.js';
import type { Computed, PlaybookDefinition, ReadResults, ReadStep, WriteStep } from '../types.js';

const val = (reads: ReadResults, id: string): any => { const r = reads[id]; return r && r.ok ? r.value : undefined; };
export const CREDITS_PER_LEAD = 2;

export function filtersFrom(category: string, place: any) {
  const location: Record<string, unknown> = {};
  for (const key of ['label', 'country', 'state', 'city'] as const) if (typeof place?.[key] === 'string') location[key] = place[key];
  return { categories: [category], location };
}

function campaignName(input: Record<string, any>, place: any): string {
  return input.campaign_name ?? `[DRAFT] Local ${input.category} - ${place.label}`.slice(0, 80);
}

export const lookalike: PlaybookDefinition = {
  slug: 'local_lookalike',
  title: 'Local lookalike campaign',
  description: 'Find local businesses of one category near a place using the free local-business search (5 per page, 200 pages a day), then stage converting up to N of them into a draft campaign populated with the converted leads, using the default schedule. The API allows one destination, so there is no separate list. The playbook never activates the campaign. Converting costs 2 credits per lead created, is previewed with a deterministic idempotency key, and never runs without the host enabling the write and a credit ceiling.',
  requires: ['api_read', 'api_write', 'spend'],
  offerFit: offer => ['local_service', 'agency', 'service'].includes(offer.offer_category),
  examples: ["instantly --profile <slug> --workspace <uuid> playbooks run local_lookalike --input '{\"category\":\"dentist\",\"place\":\"Austin, TX\",\"count\":5}'"],
  inputSchema: z.object({
    category: z.string().min(2).max(60).describe('Exact business category, e.g. dentist'),
    place: z.string().min(2).max(80).describe('Place query, e.g. Austin, TX'),
    count: z.coerce.number().int().min(1).max(50).default(5).describe('Leads to convert (2 credits each)'),
    campaign_name: z.string().min(3).max(80).optional(),
  }).strict(),
  reads(input): ReadStep[] {
    return [
      { id: 'places', command: 'local_business_search_suggest_local_business_places', args: { q: input.place } },
      { id: 'search', command: 'local_business_search_search_local_businesses',
        args: (earlier: ReadResults) => {
          const place = (val(earlier, 'places')?.items ?? [])[0];
          return place ? { body: { filters: filtersFrom(input.category, place), page_size: 5 } } : null;
        } },
      { id: 'campaigns', command: 'campaigns_list', args: (earlier: ReadResults) => {
        const place = (val(earlier, 'places')?.items ?? [])[0];
        return place ? { limit: 100, search: campaignName(input, place) } : null;
      }, pages: 10, requireComplete: true },
    ];
  },
  compute(input, reads): Computed {
    const place = (val(reads, 'places')?.items ?? [])[0];
    if (!place) return { artifact: { found: 0 }, writes: [], browser: [], cost: { credits: 'none', max_credits: 0, notes: 'No place matched.' },
      refusals: [{ code: 'INSUFFICIENT_DATA', message: `No place matched '${input.place}'. Try a city and state.` }] };
    const filters = filtersFrom(input.category, place);
    const search = val(reads, 'search') ?? {};
    const sample = (search.items ?? []).map((b: any) => ({ name: b.name, city: b.city, state: b.state, has_email: b.has_email === true, rating: b.rating ?? null, domain: b.domain ?? null }));
    const campaign_name = campaignName(input, place);
    const idempotency_key = 'pb-' + digest({ filters, count: input.count, campaign_name }).slice(0, 40);
    const exists = ((val(reads, 'campaigns')?.items ?? []) as any[]).some(c => c?.name === campaign_name);
    const writes: WriteStep[] = exists ? [] : [{ id: 'convert', stage: 1, command: 'local_business_search_convert_local_businesses',
      summary: `Convert up to ${input.count} businesses into leads in a draft campaign (2 credits per lead created; businesses without an email cost nothing)`,
      args: { body: { filters, count: input.count, idempotency_key, campaign_name } }, credits: input.count * CREDITS_PER_LEAD, exposeResponse: true,
      reconcile: { id: 'convert_check', command: 'campaigns_list', args: { search: campaign_name, limit: 5 } } }];
    return { artifact: { place: place.label, filters, free_search: { total: search.total ?? null, page_size: sample.length, sample },
      convert: { campaign_name, ...(exists ? { skipped: 'A campaign with this name already exists.' } : { count: input.count, idempotency_key, max_credits: input.count * CREDITS_PER_LEAD,
        follow_up: 'After running, poll with command local_business_search_get_local_business_convert_job using the job id in the receipt.' }) } },
      writes, browser: [], refusals: [],
      cost: { credits: 'metered', max_credits: input.count * CREDITS_PER_LEAD, notes: 'Search is free. Convert costs 2 credits per lead created and is capped at count.' } };
  },
};
