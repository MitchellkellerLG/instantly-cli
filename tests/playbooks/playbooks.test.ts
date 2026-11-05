import { describe, it, expect } from 'vitest';
import { OFFER_ANGLES } from '../../src/playbooks/types.js';
import { buildOfferProfile } from '../../src/playbooks/book/offer.js';
import { makeIdeas, seedFrom, type Idea, type IdeaSeed } from '../../src/playbooks/book/ideas.js';
import { classify, segmentLeads } from '../../src/playbooks/book/segments.js';
import { filtersFrom } from '../../src/playbooks/book/lookalike.js';
import { agent, makeWorld, uuid } from '../../scripts/playbooks/world.js';

const ok = (value: unknown) => ({ ok: true as const, value });
const WRITES = ['campaigns_create', 'lead_lists_create', 'webhooks_create', 'local_business_search_convert_local_businesses'];

describe('offer profile (S2)', () => {
  it('classifies a SaaS sales-automation workspace with evidence for every claim', () => {
    const p = buildOfferProfile({ agents: ok({ items: [agent()] }), campaigns: ok({ items: [{ name: 'Founders outreach' }] }), leads: ok({ items: [{ job_title: 'VP Sales' }] }),
      billing: ok({ subscriptions: { outreach: { plan_name: 'Growth' }, website_visitors: { plan_name: null }, credits: { available_credits: 500 } } }) });
    expect(p.offer_category).toBe('saas');
    expect(p.offer_angle).toBe('make_money');
    expect(p.confidence).toBe('high');
    expect(p.entitlements).toMatchObject({ outreach: true, website_visitors: false, credits_available: 500 });
    expect(p.evidence.length).toBeGreaterThan(2);
    for (const e of p.evidence) { expect(e.source).toBeTruthy(); expect(e.field).toBeTruthy(); expect(e.signal).toBeTruthy(); }
  });
  it('maps agent presets (recruiting, investment) with priority over text', () => {
    expect(buildOfferProfile({ agents: ok({ items: [agent({ agent_type: 7 })] }) }).offer_category).toBe('recruiting');
    expect(buildOfferProfile({ agents: ok({ items: [agent({ agent_type: 8, config: { memory: {} } })] }) }).offer_category).toBe('investment');
  });
  it('asks to confirm instead of guessing when only a thin lead sample exists', () => {
    const p = buildOfferProfile({ leads: ok({ items: [{ job_title: 'Director' }, { job_title: 'Manager' }] }), campaigns: ok({ items: [] }) });
    expect(p.offer_category).toBe('unknown');
    expect(p.offer_angle).toBeNull();
    expect(p.confidence).toBe('low');
    expect(p.needs_confirmation).toBe(true);
  });
  it('requires confirmation and caps confidence when the top offer categories tie', async () => {
    const agents = { items: [agent({ config: { memory: { business_description: 'software services to grow revenue' } } })] };
    const campaigns = { items: [{ name: 'Q1 outreach' }] };
    const profile = buildOfferProfile({ agents: ok(agents), campaigns: ok(campaigns) });
    expect(profile.needs_confirmation).toBe(true);
    expect(profile.confidence).toBe('low');
    expect(profile.offer_category).toBe('unknown');
    expect(profile.offer_angle).toBe('make_money');
    const w = makeWorld({ responses: { 'GET /ai-agents/sales': agents, 'GET /campaigns': campaigns, 'POST /leads/list': { items: [] } } });
    const preview = await w.runner.preview('offer_profile', {});
    expect((preview.artifact as any).offer_profile).toMatchObject({ needs_confirmation: true, confidence: 'low', offer_category: 'unknown' });
    expect(preview.refusals.map(r => r.code)).toContain('NEEDS_CONFIRMATION');
    const ideas = await w.runner.preview('campaign_ideas', {});
    expect((ideas.artifact as any).offer_profile).toMatchObject({ needs_confirmation: true, confidence: 'low', offer_category: 'unknown' });
  });
  it('uses only active offers and ICP fields for classification and campaign seeds', async () => {
    const retired = { name: 'recruiting staffing talent candidates hiring', usp: 'recruiting staffing talent candidates hiring',
      problems_solved: ['recruiting staffing talent candidates hiring'], benefits: ['recruiting staffing talent candidates hiring'],
      job_title: { include: ['Recruiter'] }, industry: ['Staffing'] };
    const memory = { business_offers: ['recruiting staffing talent candidates hiring', 'software platform'], active_business_offers_indexes: [1],
      icps: [retired, { name: 'software', usp: 'platform', problems_solved: ['grow revenue'], benefits: ['save time'], job_title: { include: ['VP Sales'] }, industry: ['B2B software'] }], active_icps_indexes: [1] };
    const reads = { agents: ok({ items: [agent({ config: { memory } })] }), campaigns: ok({ items: [{ name: 'Q1 outreach' }] }) };
    const profile = buildOfferProfile(reads);
    expect(profile.offer_category).toBe('saas');
    expect(seedFrom(reads, profile, 15)).toMatchObject({ personas: ['VP Sales'], industries: ['B2B software'], problems: ['grow revenue'] });
    const w = makeWorld({ responses: { 'GET /ai-agents/sales': { items: [agent({ config: { memory } })] }, 'POST /leads/list': { items: [] } } });
    const preview = await w.runner.preview('campaign_ideas', {});
    expect((preview.artifact as any).offer_profile.offer_category).toBe('saas');
    expect((preview.artifact as any).ideas.every((idea: Idea) => !idea.audience.personas.includes('Recruiter') && !idea.audience.industries.includes('Staffing'))).toBe(true);
  });
  it('honors empty active selections while retaining memories without selection fields', () => {
    const memory = { business_offers: [{ name: 'software', description: 'platform' }], icps: [{ name: 'software', job_title: { include: ['VP Sales'] }, industry: ['B2B software'], problems_solved: ['grow revenue'] }] };
    const reads = (selected: any) => ({ agents: ok({ items: [agent({ config: { memory: selected } })] }) });
    expect(buildOfferProfile(reads(memory)).offer_category).toBe('saas');
    const inactive = reads({ ...memory, active_business_offers_indexes: [], active_icps_indexes: [] });
    const profile = buildOfferProfile(inactive);
    expect(profile.offer_category).toBe('unknown');
    expect(seedFrom(inactive, profile, 15)).toMatchObject({ personas: [], industries: [], problems: [] });
  });
  it('an empty workspace is low confidence, not an error', () => {
    const p = buildOfferProfile({});
    expect(p).toMatchObject({ offer_category: 'unknown', motion: 'unknown', confidence: 'low', needs_confirmation: true });
  });
  it('detects demand-gen motion from the entitlement or a visitor-heavy sample', () => {
    expect(buildOfferProfile({ billing: ok({ subscriptions: { website_visitors: { plan_name: 'V' } } }) }).motion).toBe('demand_gen');
    expect(buildOfferProfile({ leads: ok({ items: [{ is_website_visitor: true }, { is_website_visitor: false }] }) }).motion).toBe('demand_gen');
  });
  it('is deterministic', () => {
    const reads = { agents: ok({ items: [agent()] }) };
    expect(JSON.stringify(buildOfferProfile(reads))).toBe(JSON.stringify(buildOfferProfile(reads)));
  });
  it('runs end to end through the runner and returns the profile artifact', async () => {
    const w = makeWorld();
    const preview = await w.runner.preview('offer_profile', {});
    expect((preview.artifact as any).offer_profile.offer_category).toBe('saas');
  });
});

describe('campaign ideas (S3)', () => {
  const run = async (input: Record<string, unknown> = {}, responses: Record<string, unknown> = {}) => {
    const w = makeWorld({ responses });
    return (await w.runner.preview('campaign_ideas', input)).artifact as any;
  };
  it('produces at least 15 ideas with broad, focused and niche present and offer angles inside the enum', async () => {
    const a = await run();
    expect(a.ideas.length).toBeGreaterThanOrEqual(15);
    expect(new Set(a.ideas.map((i: any) => i.scope))).toEqual(new Set(['broad', 'focused', 'niche']));
    for (const i of a.ideas) expect(OFFER_ANGLES).toContain(i.offer_angle);
  });
  it('every focused or niche idea carries exactly one signal and broad ideas none', async () => {
    const a = await run();
    for (const i of a.ideas) {
      if (i.scope === 'broad') expect(i.skin_in_the_game).toBeUndefined();
      else { expect(Object.keys(i.skin_in_the_game).sort()).toEqual(['adjacency', 'persona_kpi', 'signal', 'source']); expect(i.skin_in_the_game.signal).toBeTruthy(); }
    }
  });
  it('honours count bounds and the offer angle filter', async () => {
    expect((await run({ count: 25 })).ideas.length).toBe(25);
    expect((await run({ count: 15 })).ideas.length).toBe(15);
    const only = await run({ offer_angle: 'mitigate_risk' });
    for (const i of only.ideas) expect(i.offer_angle).toBe('mitigate_risk');
    const w = makeWorld();
    await expect(w.runner.preview('campaign_ideas', { count: 5 })).rejects.toThrow();
    await expect(w.runner.preview('campaign_ideas', { count: 40 })).rejects.toThrow();
  });
  it('ids are stable and unique, and the run is byte-identical on the same workspace state', async () => {
    const a = await run(); const b = await run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(new Set(a.ideas.map((i: any) => i.id)).size).toBe(a.ideas.length);
  });
  it('does not repeat an existing campaign name (novelty)', async () => {
    const a = await run({}, { 'GET /campaigns': { items: [{ name: 'Revenue leaders VP Sales teams that want to win more revenue' }] } });
    expect(a.ideas.some((i: any) => i.title === 'VP Sales teams that want to win more revenue')).toBe(false);
  });
  it('uses the workspace ICP personas and industries, not generic defaults', async () => {
    const a = await run();
    expect(a.ideas.some((i: any) => i.audience.industries.includes('B2B software'))).toBe(true);
    expect(a.ideas.some((i: any) => i.audience.personas.includes('VP Sales'))).toBe(true);
  });
  it('excludes an existing campaign found beyond the first page', async () => {
    const w = makeWorld({ responses: { 'GET /campaigns': (r: any) => r.query?.starting_after
      ? { items: [{ name: 'VP Sales teams that want to win more revenue' }], next_starting_after: null }
      : { items: Array.from({ length: 100 }, (_, i) => ({ name: `Unrelated ${i}` })), next_starting_after: uuid(100) } } });
    const preview = await w.runner.preview('campaign_ideas', {});
    expect((preview.artifact as any).ideas.some((idea: any) => idea.title === 'VP Sales teams that want to win more revenue')).toBe(false);
    expect(w.requests.filter(r => r.path === '/campaigns').map(r => r.query?.starting_after)).toEqual([undefined, uuid(100)]);
  });
  it.each(['campaign_ideas', 'offer_profile'])('refuses %s when its campaign inventory fails or exceeds the bound', async slug => {
    for (const response of [() => { throw new Error('campaign lookup failed'); }, { items: [], next_starting_after: uuid(1) }]) {
      const w = makeWorld({ responses: { 'GET /campaigns': response } });
      await expect(w.runner.preview(slug, {})).rejects.toThrow();
      expect(w.mutations()).toEqual([]);
    }
  });
  it('rejects the removed website option before making a request', async () => {
    const w = makeWorld();
    await expect(w.runner.preview('campaign_ideas', { website: 'https://example.com' })).rejects.toThrow('UNKNOWN_ARGUMENTS');
    expect(w.requests).toEqual([]);
  });
  it('previews ideas without requesting unused analytics', async () => {
    const w = makeWorld();
    await w.runner.preview('campaign_ideas', {});
    expect(w.requests.some(r => r.path === '/campaigns/analytics/overview')).toBe(false);
  });
  it('emits the injected engine artifact and supplies workspace seed context', () => {
    const sentinel: Idea = { id: 'idea-01', title: 'Sentinel idea', scope: 'broad', offer_angle: 'save_time', ai_strategy: 'sentinel', value_prop: 'sentinel value', campaign_overview: 'sentinel overview', audience: { personas: ['Test buyer'], industries: ['Test industry'] } };
    const calls: IdeaSeed[] = [];
    const definition = makeIdeas({ generate: seed => { calls.push(seed); return [sentinel]; } });
    const input = definition.inputSchema.parse({ count: 15, offer_angle: 'save_time' });
    const result = definition.compute(input, { agents: ok({ items: [agent()] }), campaigns: ok({ items: [{ name: 'Existing outreach' }] }) }, { now: '2026-01-01' });
    expect((result.artifact as any).ideas).toEqual([sentinel]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ count: 15, angle: 'save_time', personas: ['VP Sales', 'Head of Growth'], industries: ['B2B software', 'Fintech'], existing: ['Existing outreach'], offer: { offer_category: 'saas' } });
  });
  it('an unknown draft idea id refuses with no writes', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES });
    const preview = await w.runner.preview('campaign_ideas', { draft_idea: 'idea-99' });
    expect(preview.steps).toEqual([]);
    expect(preview.refusals[0].code).toBe('INSUFFICIENT_DATA');
  });
});

describe('segments (S6, S7)', () => {
  it('assigns the strongest signal in a fixed order and abstains rather than guessing', () => {
    const imported = { 'alpha.example': 'ad spend up' };
    expect(classify({ company_domain: 'alpha.example', is_website_visitor: true }, imported)).toBe('imported');
    expect(classify({ is_website_visitor: true, email_reply_count: 3 }, {})).toBe('visitor');
    expect(classify({ email_click_count: 1, job_title: 'Head of Growth' }, {})).toBe('replied');
    expect(classify({ job_title: 'Head of Growth' }, {})).toBe('growth_title');
    expect(classify({ job_title: 'COO' }, {})).toBe('ops_title');
    expect(classify({ job_title: 'Founder' }, {})).toBe('exec_title');
    expect(classify({ job_title: 'Intern' }, {})).toBeNull();
    expect(classify({}, {})).toBeNull();
  });
  it('sizes segments, names persona KPI and ladder rung, and keeps abstained rows separate', async () => {
    const w = makeWorld();
    const a = (await w.runner.preview('skin_in_the_game_segments', { campaign_id: uuid(10) })).artifact as any;
    const total = a.segments.reduce((n: number, s: any) => n + s.size, 0);
    expect(total).toBe(5);
    const abstain = a.segments.find((s: any) => s.abstained);
    expect(abstain).toMatchObject({ signal: null, persona_kpi: null, ladder_rung: null, size: 1 });
    for (const s of a.segments.filter((s: any) => !s.abstained)) { expect(s.signal).toBeTruthy(); expect(s.persona_kpi).toBeTruthy(); expect(a.ladder).toContain(s.ladder_rung); }
    expect(a.segments[a.segments.length - 1].abstained).toBe(true);
  });
  it('requires exactly one of campaign_id or list_id', async () => {
    const w = makeWorld();
    await expect(w.runner.preview('skin_in_the_game_segments', {})).rejects.toThrow();
    await expect(w.runner.preview('skin_in_the_game_segments', { campaign_id: uuid(1), list_id: uuid(2) })).rejects.toThrow();
    expect(w.requests).toEqual([]);
  });
  it('imports external signals by company domain', () => {
    const segs = segmentLeads([{ id: 'a', company_domain: 'x.example' }, { id: 'b', company_domain: 'y.example' }], { 'x.example': 'hiring SDRs' });
    expect(segs.find(s => s.segment_id === 'imported:hiring SDRs')).toMatchObject({ size: 1, signal: 'imported external signal: hiring SDRs' });
  });
  it('stages one holding list per non-abstained segment', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES });
    const preview = await w.runner.preview('skin_in_the_game_segments', { campaign_id: uuid(10), apply: 'lists' });
    expect(preview.steps.length).toBeGreaterThan(0);
    expect(preview.steps.every(s => s.command === 'lead_lists_create')).toBe(true);
    expect(w.mutations()).toEqual([]);
  });
  it('plans all six imported segments and retries only the missing list after partial execution', async () => {
    const leads = Array.from({ length: 6 }, (_, i) => ({ id: uuid(i + 100), company_domain: `${i}.example` }));
    const signals = Object.fromEntries(leads.map((lead, i) => [lead.company_domain, `Signal ${i}`]));
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: { 'POST /leads/list': { items: leads } } });
    const input = { campaign_id: uuid(10), apply: 'lists', signals };
    const first = await w.runner.preview('skin_in_the_game_segments', input);
    expect(first.steps).toHaveLength(6);
    expect(first.steps.every(step => step.command === 'lead_lists_create')).toBe(true);
    w.failWriteNumber(6);
    const partial = await w.runner.run(first.playbook_token!);
    expect(partial.status).toBe('failed');
    expect(partial.receipts).toHaveLength(5);
    w.table['GET /lead-lists'] = { items: first.steps.slice(0, 5).map(step => ({ name: step.arguments.name })) };
    const rerun = await w.runner.preview('skin_in_the_game_segments', input);
    expect(rerun.steps).toHaveLength(1);
    expect(rerun.steps[0].arguments).toEqual(first.steps[5].arguments);
    expect((await w.runner.run(rerun.playbook_token!)).status).toBe('completed');
  });
  it('idempotent re-run: an existing segment list is not planned again', async () => {
    const first = makeWorld({ hostAllowedWrites: WRITES });
    const preview = await first.runner.preview('skin_in_the_game_segments', { campaign_id: uuid(10), apply: 'lists' });
    const names = preview.steps.map(s => (s.arguments as any).name as string);
    const again = makeWorld({ hostAllowedWrites: WRITES, responses: { 'GET /lead-lists': { items: names.map(name => ({ name })) } } });
    const second = await again.runner.preview('skin_in_the_game_segments', { campaign_id: uuid(10), apply: 'lists' });
    expect(second.steps).toEqual([]);
  });
  it('keeps punctuation and truncated imported signals distinct in names and step ids', async () => {
    const labels = ['Series A', 'Series-A', 'x'.repeat(60) + 'a', 'x'.repeat(60) + 'b'];
    const leads = labels.map((_, i) => ({ id: uuid(i), company_domain: `${i}.example` }));
    const signals = Object.fromEntries(labels.map((label, i) => [`${i}.example`, label]));
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: { 'POST /leads/list': { items: leads } } });
    const preview = await w.runner.preview('skin_in_the_game_segments', { campaign_id: uuid(10), apply: 'lists', signals });
    expect(preview.steps).toHaveLength(4);
    expect(new Set(preview.steps.map(s => s.id)).size).toBe(4);
    expect(new Set(preview.steps.map(s => s.arguments.name)).size).toBe(4);
  });
  it('finds a segment list on a later page and refuses incomplete or failed lookups', async () => {
    const input = { campaign_id: uuid(10), apply: 'lists' };
    const responses = { 'GET /lead-lists': (r: any) => r.query?.starting_after
      ? { items: [{ name: 'Segment growth-title' }, { name: 'Segment replied' }, { name: 'Segment ops-title' }, { name: 'Segment exec-title' }], next_starting_after: null }
      : { items: Array.from({ length: 100 }, (_, i) => ({ name: `Other ${i}` })), next_starting_after: uuid(1) } };
    const w = makeWorld({ responses });
    expect((await w.runner.preview('skin_in_the_game_segments', input)).steps).toEqual([]);
    for (const value of [() => { throw new Error('lookup failed'); }, { items: [], next_starting_after: uuid(1) }, {}]) {
      const broken = makeWorld({ responses: { 'GET /lead-lists': value } });
      await expect(broken.runner.preview('skin_in_the_game_segments', input)).rejects.toThrow();
      expect(broken.mutations()).toEqual([]);
    }
  });
  it('sizing runs the free count read and rejects more than three filters', async () => {
    const w = makeWorld({ responses: { 'POST /supersearch-enrichment/count-leads-from-supersearch': { number_of_leads: 1234 } } });
    const a = (await w.runner.preview('skin_in_the_game_segments', { campaign_id: uuid(10), size_filters: [{ keywords: ['x'] }] })).artifact as any;
    expect(a.sizing[0].count).toEqual({ number_of_leads: 1234 });
    expect(w.mutations()).toEqual([]);
    await expect(w.runner.preview('skin_in_the_game_segments', { campaign_id: uuid(10), size_filters: [{}, {}, {}, {}] })).rejects.toThrow();
  });
  it('sizing does not consume the injected write-failure position', async () => {
    const w = makeWorld({ hostAllowedWrites: ['lead_lists_create'], responses: {
      'POST /supersearch-enrichment/count-leads-from-supersearch': { number_of_leads: 1234 },
    } });
    w.failWriteNumber(1);
    const preview = await w.runner.preview('skin_in_the_game_segments', { campaign_id: uuid(10), apply: 'lists', size_filters: [{}] });
    expect(w.mutations()).toEqual([]);
    expect(preview.steps.length).toBeGreaterThan(0);
    const result = await w.runner.run(preview.playbook_token!);
    expect(result.status).toBe('failed');
    expect(w.mutations()).toHaveLength(1);
    expect(w.mutations()[0].path).toBe('/lead-lists');
  });
  it('pages are bounded by max_leads', async () => {
    const w = makeWorld({ responses: { 'POST /leads/list': () => ({ items: Array.from({ length: 50 }, (_, i) => ({ id: uuid(i + 1000), job_title: 'CEO' })), next_starting_after: uuid(7) }) } });
    await w.runner.preview('skin_in_the_game_segments', { campaign_id: uuid(10), max_leads: 100 });
    expect(w.requests.filter(r => r.path === '/leads/list').length).toBe(2);
  });
});

describe('website visitors setup (S8)', () => {
  const entitled = { 'GET /workspace-billing/plan-details': { subscriptions: { website_visitors: { plan_name: 'Visitors Pro' } } } };
  it('returns NOT_ENTITLED with the subscription route and zero writes when there is no plan', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES });
    const preview = await w.runner.preview('website_visitors_setup', { domain: 'example.com' });
    expect(preview.refusals).toEqual([expect.objectContaining({ code: 'NOT_ENTITLED', route: expect.stringContaining('Website Visitors') })]);
    expect(preview.steps).toEqual([]);
    expect(preview.browser).toEqual([]);
    expect(w.mutations()).toEqual([]);
  });
  it('entitled: returns staged writes and an attended browser checklist with no unattended submit', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: entitled });
    const preview = await w.runner.preview('website_visitors_setup', { domain: 'example.com' });
    expect(preview.steps.map(s => s.command)).toEqual(['lead_lists_create', 'campaigns_create']);
    expect(preview.browser.map(b => b.id)).toEqual(['legal', 'setup', 'install', 'verify', 'view']);
    expect(preview.browser.every(b => b.attended === true)).toBe(true);
    expect(preview.browser.filter(b => b.action === 'attended-submit').length).toBe(2);
    expect(preview.cost.credits).toBe('metered');
    expect(preview.cost.max_credits).toBe(0);
  });
  it('reads visitors with a bounded page loop and filters client-side', async () => {
    const w = makeWorld({ responses: { ...entitled, 'POST /leads/list': () => ({ items: [{ id: uuid(1), is_website_visitor: true }, { id: uuid(2) }], next_starting_after: uuid(9) }) } });
    const preview = await w.runner.preview('website_visitors_setup', { domain: 'example.com', max_pages: 2 });
    expect(w.requests.filter(r => r.path === '/leads/list').length).toBe(2);
    expect((preview.artifact as any).visitors.identified).toBe(2);
  });
  it('rejects non-hostnames, paths and non-https webhooks before any request', async () => {
    const w = makeWorld();
    for (const bad of [{ domain: 'https://example.com' }, { domain: 'example.com/x' }, { domain: 'a b.com' }, { domain: 'example.com', webhook_url: 'http://x.example/h' }]) {
      await expect(w.runner.preview('website_visitors_setup', bad)).rejects.toThrow();
    }
    expect(w.requests).toEqual([]);
  });
  it('repairs a failed webhook on rerun without recreating the campaign', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: { ...entitled } });
    w.failWriteNumber(3);
    const input = { domain: 'example.com', webhook_url: 'https://hooks.example.com/x' };
    const first = await w.runner.preview('website_visitors_setup', input);
    const result = await w.runner.run(first.playbook_token!);
    expect(result.status).toBe('failed');
    const campaign = w.mutations().find(r => r.path === '/campaigns')!;
    w.table['GET /campaigns'] = { items: [{ ...(campaign.body as object), id: uuid(602) }] };
    w.table['GET /lead-lists'] = { items: [{ name: 'Website visitors - example.com' }] };
    const second = await w.runner.preview('website_visitors_setup', input);
    expect(second.steps.map(s => s.command)).toEqual(['webhooks_create']);
    expect(second.steps[0].arguments.campaign).toBe(uuid(602));
    expect((await w.runner.run(second.playbook_token!)).status).toBe('completed');
    expect(w.mutations().filter(r => r.path === '/campaigns')).toHaveLength(1);
  });
  it('is idempotent: an existing list and draft campaign are not planned again', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: { ...entitled, 'GET /lead-lists': { items: [{ name: 'Website visitors - example.com' }] }, 'GET /campaigns': { items: [{ id: uuid(10), name: '[DRAFT] Website visitors - example.com' }] }, 'GET /webhooks': { items: [{ campaign: uuid(10), event_type: 'reply_received', target_hook_url: 'https://hooks.example.com/x' }] } } });
    const preview = await w.runner.preview('website_visitors_setup', { domain: 'example.com', webhook_url: 'https://hooks.example.com/x' });
    expect(preview.steps).toEqual([]);
  });
});

describe('existence lookup failures', () => {
  it.each([
    ['website_visitors_setup', { domain: 'example.com' }, '/campaigns'],
    ['website_visitors_setup', { domain: 'example.com', webhook_url: 'https://hooks.example.com/x' }, '/webhooks'],
    ['local_lookalike', { category: 'dentist', place: 'Austin, TX' }, '/campaigns'],
  ] as const)('refuses %s when %s cannot be read completely', async (slug, input, path) => {
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: {
      'GET /workspace-billing/plan-details': { subscriptions: { website_visitors: { plan_name: 'Visitors' } } },
      'GET /local-business-search/places': { items: [{ label: 'Austin', city: 'Austin' }] },
      'POST /local-business-search/search': { items: [] },
      [`GET ${path}`]: () => { throw new Error('lookup failed'); },
    } });
    await expect(w.runner.preview(slug, input)).rejects.toThrow('lookup failed');
    expect(w.mutations()).toEqual([]);
  });
});

describe('local lookalike (S10)', () => {
  const places = { 'GET /local-business-search/places': { items: [{ label: 'Austin, TX', city: 'Austin', state: 'TX', country: 'US', lat: 30.2, long: -97.7 }] } };
  const search = { 'POST /local-business-search/search': { items: [{ name: 'A Dental', city: 'Austin', state: 'Texas', has_email: true, rating: 4.8, domain: 'a.example' }], total: 120, next_cursor: null } };
  it('builds search filters from the first place and never sends lat/long into the filters', () => {
    expect(filtersFrom('dentist', { label: 'Austin, TX', city: 'Austin', state: 'TX', country: 'US', lat: 1, long: 2 })).toEqual({ categories: ['dentist'], location: { label: 'Austin, TX', country: 'US', state: 'TX', city: 'Austin' } });
  });
  it('the free search runs before and without any convert, and preview contacts no convert endpoint', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: { ...places, ...search } });
    const preview = await w.runner.preview('local_lookalike', { category: 'dentist', place: 'Austin, TX', count: 5 });
    expect(w.requests.map(r => r.path)).toContain('/local-business-search/search');
    expect(w.requests.some(r => r.path === '/local-business-search/convert')).toBe(false);
    expect(preview.steps[0]).toMatchObject({ command: 'local_business_search_convert_local_businesses', credits: 10, executable: true });
    expect((preview.artifact as any).convert).toMatchObject({ count: 5, max_credits: 10, idempotency_key: expect.stringMatching(/^pb-[a-f0-9]{40}$/) });
  });
  it('the idempotency key is deterministic for the same inputs and differs when the count changes', async () => {
    const key = async (count: number) => { const w = makeWorld({ responses: { ...places, ...search } }); return ((await w.runner.preview('local_lookalike', { category: 'dentist', place: 'Austin, TX', count })).artifact as any).convert.idempotency_key; };
    expect(await key(5)).toBe(await key(5));
    expect(await key(5)).not.toBe(await key(6));
  });
  it('uses a custom campaign as the only destination and binds it into the idempotency key', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: { ...places, ...search,
      'GET /lead-lists': () => { throw new Error('lookalike must not read lists'); },
    } });
    const input = { category: 'dentist', place: 'Austin, TX', count: 2 };
    const initial = await w.runner.preview('local_lookalike', input);
    const custom = await w.runner.preview('local_lookalike', { ...input, campaign_name: '[DRAFT] Custom dentists' });
    expect((custom.artifact as any).convert.campaign_name).toBe('[DRAFT] Custom dentists');
    expect((custom.artifact as any).convert.idempotency_key).not.toBe((initial.artifact as any).convert.idempotency_key);
    expect(w.requests.filter(r => r.path === '/campaigns').map(r => r.query?.search)).toEqual(['[DRAFT] Local dentist - Austin, TX', '[DRAFT] Custom dentists']);
    expect((await w.runner.run(custom.playbook_token!)).status).toBe('completed');
    expect(w.mutations()[0].body).toMatchObject({ campaign_name: '[DRAFT] Custom dentists' });
    expect(w.mutations()[0].body).not.toHaveProperty('list_name');
    expect(w.requests.some(r => r.path === '/lead-lists')).toBe(false);
  });
  it('managed tier cannot convert and the credit ceiling refuses oversize plans', async () => {
    const managed = makeWorld({ hostAllowedWrites: WRITES, tier: 'managed', responses: { ...places, ...search } });
    const m = await managed.runner.preview('local_lookalike', { category: 'dentist', place: 'Austin, TX', count: 5 });
    expect(m.steps[0].not_executable_reason).toBe('WRITE_POLICY_DENIED');
    expect(m.refusals.map(r => r.code)).toEqual(expect.arrayContaining(['SPEND_CEILING', 'WRITE_POLICY_DENIED']));
    expect(m.playbook_token).toBeNull();
    const internal = makeWorld({ hostAllowedWrites: WRITES, responses: { ...places, ...search } });
    const big = await internal.runner.preview('local_lookalike', { category: 'dentist', place: 'Austin, TX', count: 30 });
    expect(big.refusals.map(r => r.code)).toContain('SPEND_CEILING');
    expect(big.playbook_token).toBeNull();
    expect(internal.mutations()).toEqual([]);
  });
  it('runs one convert with the previewed body and exposes the job id in the receipt', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: { ...places, ...search } });
    const preview = await w.runner.preview('local_lookalike', { category: 'dentist', place: 'Austin, TX', count: 3 });
    const result = await w.runner.run(preview.playbook_token!);
    expect(result.status).toBe('completed');
    expect(result.credits_spent_max).toBe(6);
    expect((result.receipts[0].response as any).job.id).toBe(uuid(800));
    expect(w.mutations().map(r => r.path)).toEqual(['/local-business-search/convert']);
    expect(w.mutations()[0].body).toEqual({ filters: { categories: ['dentist'], location: { label: 'Austin, TX', country: 'US', state: 'TX', city: 'Austin' } }, count: 3,
      campaign_name: '[DRAFT] Local dentist - Austin, TX', idempotency_key: 'pb-bafdd0ed8fd672918af6a193e484f855110eeb15' });
  });
  it.each([
    ['/campaigns', '[DRAFT] Local dentist - Austin, TX'],
  ])('skips conversion when the destination exists on a later %s page', async (path, name) => {
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: { ...places, ...search,
      [`GET ${path}`]: (r: any) => r.query?.starting_after
        ? { items: [{ name }], next_starting_after: null }
        : { items: [{ name: 'Another destination' }], next_starting_after: uuid(1) },
    } });
    const preview = await w.runner.preview('local_lookalike', { category: 'dentist', place: 'Austin, TX' });
    expect(preview.steps).toEqual([]);
    expect(preview.playbook_token).toBeNull();
    expect((preview.artifact as any).convert.skipped).toBeTruthy();
    expect(w.requests.filter(r => r.path === path).every(r => r.query?.search === name)).toBe(true);
    expect(w.mutations()).toEqual([]);
  });
  it('caps destination names at 80 characters', async () => {
    const w = makeWorld({ responses: { ...places, ...search } });
    const preview = await w.runner.preview('local_lookalike', { category: 'x'.repeat(60), place: 'Austin, TX' });
    expect((preview.artifact as any).convert.campaign_name).toHaveLength(80);
  });
  it.each([undefined, 'Custom targets'])('no matching place refuses without dependent reads (campaign_name=%s)', async campaign_name => {
    const unexpected = () => { throw new Error('dependent read must not run'); };
    const w = makeWorld({ responses: {
      'GET /local-business-search/places': { items: [] },
      'POST /local-business-search/search': unexpected,
      'GET /lead-lists': unexpected,
      'GET /campaigns': unexpected,
    } });
    const preview = await w.runner.preview('local_lookalike', { category: 'dentist', place: 'Nowhereville', ...(campaign_name ? { campaign_name } : {}) });
    expect(preview.refusals[0].code).toBe('INSUFFICIENT_DATA');
    expect(preview.steps).toEqual([]);
    expect(preview.playbook_token).toBeNull();
    expect(preview.cost.credits).toBe('none');
    expect(w.requests.map(r => r.path)).toEqual(['/local-business-search/places']);
    expect(w.mutations()).toEqual([]);
  });
});
