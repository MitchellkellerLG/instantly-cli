import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { verifyLookalikeCampaign } from '../../scripts/playbooks/proof-checks.js';
import { clientFromRequest } from '../../src/safe/transport.js';
import { uuid } from '../../scripts/playbooks/world.js';
import { canonical } from '../../src/safe/canonical.js';
import { allPlaybooks } from '../../src/playbooks/registry.js';
import { DIRECTORY, loadRecordings, replay } from '../../scripts/playbooks/replay.js';
import { leaks, mapUuids, redact, redactPath, synthUuid } from '../../scripts/playbooks/redact.js';

const MUTATION_FREE = (path: string) => ['/leads/list', '/local-business-search/search', '/supersearch-enrichment/count-leads-from-supersearch'].includes(path);

describe('recorded workspace shapes replay deterministically', () => {
  const recordings = loadRecordings();
  it('covers every playbook at least once', () => {
    expect(new Set(recordings.map(r => r.playbook))).toEqual(new Set(allPlaybooks.map(p => p.slug)));
  });
  it.each(recordings.map(r => [r.id, r] as const))('%s: strict sequential replay matches the golden plan, with zero mutations and zero extra requests', async (_id, rec) => {
    const r = await replay(rec);
    expect(r.remaining).toBe(0);
    expect(canonical(r.got)).toBe(canonical(rec.expect));
    expect(r.seen.filter(x => x.method !== 'GET' && !MUTATION_FREE(x.path))).toEqual([]);
  });
  it.each(recordings.map(r => [r.id, r] as const))('%s: any deviation in the request stream fails closed', async (_id, rec) => {
    const tampered = structuredClone(rec);
    tampered.exchanges[1].request.path = tampered.exchanges[1].request.path + '/x';
    await expect(replay(tampered)).rejects.toThrow('REPLAY_MISMATCH');
    const short = structuredClone(rec);
    short.exchanges = short.exchanges.slice(0, 1);
    await expect(replay(short)).rejects.toThrow(/REPLAY_EXTRA_REQUEST|REPLAY_MISMATCH/);
  });
  it('the offer-profile recording carries live response shapes (real keys survive redaction)', () => {
    const rec = recordings.find(r => r.id === 'offer-profile')!;
    const agents = rec.exchanges.find(e => e.request.path === '/ai-agents/sales')!.response as any;
    expect(agents.items[0].config.memory).toHaveProperty('icps');
    const billing = rec.exchanges.find(e => e.request.path === '/workspace-billing/plan-details')!.response as any;
    expect(billing.subscriptions).toHaveProperty('website_visitors');
  });
  it('the visitor recording refuses staging without an entitlement', async () => {
    const rec = recordings.find(r => r.id === 'visitors-not-entitled')!;
    const result = await replay(rec);
    expect(result.got.refusals).toEqual(['NOT_ENTITLED']);
    expect(result.got.steps).toEqual([]);
    expect(result.got.token_issued).toBe(false);
  });
});

describe('redaction', () => {
  it('maps uuids and emails deterministically and drops free text', () => {
    const uuid = '019fafae-0220-7de8-82b0-45885e1ae13f';
    const a = redact({ id: uuid, email: 'Someone@Client.com', name: 'Acme Corp', status: 'active', plan_name: 'Hyper Growth', n: 4, when: '2026-01-01T00:00:00.000Z', url: 'https://x.com/a?b=1' }) as any;
    expect(a.id).toBe(synthUuid(uuid));
    expect(a.id).toBe((redact({ id: uuid }) as any).id);
    expect(a.email).toMatch(/^u[a-f0-9]{8}@example\.com$/);
    expect(a.name).toBe('text-9');
    expect(a.plan_name).toBe('Hyper Growth');
    expect(a.n).toBe(4);
    expect(a.url).toMatch(/^https:\/\/example\.invalid\//);
  });
  it('caps arrays and maps paths and inputs without touching their other strings', () => {
    expect((redact({ items: Array.from({ length: 20 }, (_, i) => i) }) as any).items).toHaveLength(5);
    expect(redactPath('/campaigns/019fafae-0220-7de8-82b0-45885e1ae13f')).toBe('/campaigns/' + synthUuid('019fafae-0220-7de8-82b0-45885e1ae13f'));
    expect(mapUuids({ domain: 'example.com', list_id: '019fafae-0220-7de8-82b0-45885e1ae13f' })).toEqual({ domain: 'example.com', list_id: synthUuid('019fafae-0220-7de8-82b0-45885e1ae13f') });
  });
  it('the leak scanner catches emails, real uuids, tokens and em dashes and passes synthetic values', () => {
    expect(leaks('a@b.com')).toEqual(['email:a@b.com']);
    expect(leaks('019fafae-0220-7de8-82b0-45885e1ae13f')[0]).toMatch(/^uuid:/);
    expect(leaks('a1'.repeat(20))[0]).toMatch(/^long-token/);
    expect(leaks('a \u2014 b')).toEqual(['em-dash']);
    expect(leaks(`u12345678@example.com ${synthUuid('x')} ${'a'.repeat(64)}`)).toEqual([]);
  });
});

describe('lookalike campaign proof oracle', () => {
  const job = { status: 'done', campaign_id: uuid(1), created: 2 };
  const campaign = { id: uuid(1), status: 0 };
  const leads = { items: [{ id: uuid(2), campaign: uuid(1) }, { id: uuid(3), campaign: uuid(1) }] };
  const check = async (conversion: any, draft = campaign, members = leads) => {
    const requests: any[] = [];
    const client = clientFromRequest(async <T>(request: any): Promise<T> => {
      requests.push(request);
      if (request.method === 'GET' && request.path === `/campaigns/${uuid(1)}`) return draft as T;
      if (request.method === 'POST' && request.path === '/leads/list') return members as T;
      throw new Error('Unexpected proof read');
    });
    return { evidence: await verifyLookalikeCampaign(client, conversion), requests };
  };
  it('reads the returned campaign and verifies draft status and converted lead membership', async () => {
    const { evidence, requests } = await check(job);
    expect(evidence).toMatchObject({ campaign_id_valid: true, campaign_draft_verified: true, campaign_leads_verified: true, campaign_status: 0, campaign_lead_count: 2 });
    expect(requests).toEqual([{ method: 'GET', path: `/campaigns/${uuid(1)}`, query: undefined }, { method: 'POST', path: '/leads/list', body: { campaign: uuid(1), limit: 100 }, query: undefined }]);
  });
  it.each([null, 'invalid'])('rejects a completed list-only conversion without a valid campaign id (%s)', async campaign_id => {
    const { evidence, requests } = await check({ ...job, campaign_id });
    expect(evidence.campaign_id_valid).toBe(false);
    expect(evidence.campaign_draft_verified).toBe(false);
    expect(evidence.campaign_leads_verified).toBe(false);
    expect(requests).toEqual([]);
  });
  it.each([{ id: uuid(1), status: 1 }, { id: uuid(9), status: 0 }])('rejects an active or mismatched campaign', async draft => {
    expect((await check(job, draft)).evidence.campaign_draft_verified).toBe(false);
  });
  it.each([
    { items: [] },
    { items: [{ id: uuid(2), campaign: uuid(1) }] },
    { items: [{ id: uuid(2), campaign: uuid(9) }, { id: uuid(3), campaign: uuid(9) }] },
    { items: [{ id: uuid(2), campaign: uuid(1) }, { id: uuid(2), campaign: uuid(1) }] },
  ])('rejects missing, foreign or duplicate lead memberships', async members => {
    expect((await check(job, campaign, members)).evidence.campaign_leads_verified).toBe(false);
  });
  it('rejects a conversion that created no leads', async () => {
    expect((await check({ ...job, created: 0 }, campaign, { items: [] })).evidence.campaign_leads_verified).toBe(false);
  });
});

describe('committed proof artifacts are clean', () => {
  const files = [...readdirSync(DIRECTORY).map(f => join(DIRECTORY, f)), 'evals/playbooks-v1/live-proof.json'];
  it.each(files)('%s has no email, real uuid, secret-shaped token or em dash', file => {
    expect(leaks(readFileSync(file, 'utf8'))).toEqual([]);
  });
  it('the live proof records the test workspace, a credit delta within the 50 credit ceiling and full cleanup', () => {
    const proof = JSON.parse(readFileSync('evals/playbooks-v1/live-proof.json', 'utf8'));
    expect(proof.workspace).toMatch(/^Keagans Space \(a36a2911\.\.\.\)$/);
    expect(proof.ceiling_credits).toBe(50);
    expect(proof.credits_delta_all).toBeGreaterThanOrEqual(0);
    expect(proof.credits_delta_all).toBeLessThanOrEqual(50);
    expect(proof.steps.every((s: any) => s.ok === true)).toBe(true);
    expect(proof.failure).toBeNull();
    expect(proof.cleanup_failures).toEqual([]);
    expect(proof.steps.filter((s: any) => String(s.step).startsWith('read:')).every((s: any) => s.mutations === 0)).toBe(true);
    const names = proof.steps.map((s: any) => s.step);
    for (const expected of ['read:offer-profile', 'read:campaign-ideas', 'read:segments-preview', 'read:visitors-not-entitled', 'read:local-lookalike-preview',
      'write:campaign-ideas-draft', 'write:fills-smoke', 'write:segments-lists-idempotent', 'write:local-lookalike-convert']) expect(names).toContain(expected);
    expect(proof.steps.find((s: any) => s.step === 'write:campaign-ideas-draft')).toMatchObject({ draft_status: 0, draft_has_senders: false });
    const lookalike = proof.steps.find((s: any) => s.step === 'write:local-lookalike-convert');
    expect(lookalike).toMatchObject({ campaign_id_valid: true, campaign_draft_verified: true, campaign_leads_verified: true, campaign_status: 0 });
    expect(lookalike.campaign_lead_count).toBeGreaterThan(0);
    expect(lookalike.campaign_lead_count).toBe(lookalike.created);
    expect(proof.cleaned_up.campaigns).toBeGreaterThan(0);
  });
});
