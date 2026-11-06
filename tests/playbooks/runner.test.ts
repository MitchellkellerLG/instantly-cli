import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { PlaybookRunner } from '../../src/playbooks/runner.js';
import { allPlaybooks } from '../../src/playbooks/registry.js';
import { allCommands } from '../../src/commands/index.js';
import type { PlaybookDefinition } from '../../src/playbooks/types.js';
import { makeWorld, scope, uuid } from '../../scripts/playbooks/world.js';

const WRITES = ['campaigns_create', 'lead_lists_create', 'webhooks_create'];
const ideaDraft = { draft_idea: 'idea-01' };
const mutationPaths = (w: ReturnType<typeof makeWorld>) => w.mutations().map(r => `${r.method} ${r.path}`);

describe('read-only runner', () => {
  it('runs a read-only playbook with zero mutations', async () => {
    const w = makeWorld();
    const preview = await w.runner.preview('offer_profile', {});
    expect(preview.steps).toEqual([]);
    expect(preview.playbook_token).toBeNull();
    expect(w.mutations()).toEqual([]);
    expect(w.requests.every(r => r.method === 'GET' || r.path === '/leads/list')).toBe(true);
  });
  it('fails closed with zero requests when a playbook declares a read outside the frozen allowlist', async () => {
    const w = makeWorld();
    const rogue: PlaybookDefinition = { slug: 'rogue', title: 'r', description: 'd', requires: ['api_read'], examples: [], inputSchema: z.object({}).strict(),
      reads: () => [{ id: 'a', command: 'workspace_get', args: {} }, { id: 'b', command: 'campaigns_activate', args: { id: uuid(1) } }],
      compute: () => ({ artifact: {}, writes: [], browser: [], refusals: [], cost: { credits: 'none', max_credits: 0, notes: '' } }) };
    const runner = new PlaybookRunner({ dispatcher: w.dispatcher, scope, tier: 'internal', commands: allCommands, playbooks: [...allPlaybooks, rogue] });
    await expect(runner.preview('rogue', {})).rejects.toThrow('READ_POLICY_DENIED');
    expect(w.requests).toEqual([]);
  });
  it('rejects unknown input keys and unknown playbooks before any request', async () => {
    const w = makeWorld();
    await expect(w.runner.preview('offer_profile', { sneaky: 1 })).rejects.toThrow('UNKNOWN_ARGUMENTS');
    await expect(w.runner.preview('nope', {})).rejects.toThrow('UNKNOWN_PLAYBOOK');
    expect(w.requests).toEqual([]);
  });
  it('a workspace mismatch is never tolerated even on optional reads', async () => {
    const w = makeWorld();
    const wrong = new PlaybookRunner({ dispatcher: w.dispatcher, scope: { profile: 'sandbox', workspace: uuid(9) }, tier: 'internal', commands: allCommands, playbooks: allPlaybooks });
    await expect(wrong.preview('offer_profile', {})).rejects.toThrow('WORKSPACE_MISMATCH');
    expect(w.requests).toEqual([]);
  });
  it('tolerates a data error on an optional read and records it', async () => {
    const w = makeWorld({ responses: { 'GET /ai-agents/sales': () => { throw new Error('HTTP_500'); } } });
    const preview = await w.runner.preview('offer_profile', {});
    expect(preview.reads.find(r => r.id === 'agents')).toMatchObject({ ok: false });
  });
});

describe('staged write execution', () => {
  it('previews with zero mutations, then runs exactly the planned single requests in order', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES });
    const preview = await w.runner.preview('campaign_ideas', ideaDraft);
    expect(w.mutations()).toEqual([]);
    expect(preview.steps.map(s => s.command)).toEqual(['lead_lists_create', 'campaigns_create']);
    expect(preview.playbook_token).toMatch(/^[a-f0-9]{64}$/);
    const result = await w.runner.run(preview.playbook_token!);
    expect(result.status).toBe('completed');
    expect(mutationPaths(w)).toEqual(['POST /lead-lists', 'POST /campaigns']);
    expect(result.receipts.map(r => r.step)).toEqual(['list', 'campaign']);
    expect(result.unexecuted).toEqual([]);
  });
  it('the draft campaign carries no senders and is never activated', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES });
    const preview = await w.runner.preview('campaign_ideas', ideaDraft);
    await w.runner.run(preview.playbook_token!);
    const body = w.mutations().find(r => r.path === '/campaigns')!.body as any;
    expect(body.email_list).toBeUndefined();
    expect(body.name).toMatch(/^\[DRAFT\]/);
    expect(w.requests.some(r => /activate|resume/.test(r.path))).toBe(false);
  });
  it('an empty host allowlist returns WRITE_POLICY_DENIED and sends zero mutations', async () => {
    const w = makeWorld({ hostAllowedWrites: [] });
    const preview = await w.runner.preview('campaign_ideas', ideaDraft);
    expect(preview.playbook_token).toBeNull();
    expect(preview.refusals.map(r => r.code)).toContain('WRITE_POLICY_DENIED');
    expect(preview.steps.every(s => !s.executable)).toBe(true);
    expect(w.mutations()).toEqual([]);
  });
  it('vip cannot run a write even when the host enabled it', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, tier: 'vip' });
    const preview = await w.runner.preview('campaign_ideas', ideaDraft);
    expect(preview.playbook_token).toBeNull();
    expect(w.mutations()).toEqual([]);
  });
  it('preview output carries no step tokens: only the playbook token and two content digests are 64-hex', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES });
    const preview = await w.runner.preview('campaign_ideas', ideaDraft);
    const hex = (JSON.stringify(preview).match(/[a-f0-9]{64}/g) ?? []).sort();
    expect(hex).toEqual([preview.playbook_token, preview.plan_hash, (preview.artifact as any).ideas_hash].sort());
    expect(JSON.stringify(preview)).not.toMatch(/preview_token/);
  });
  it('failure at step k leaves later steps unexecuted, returns the reconcile read and revokes the plan', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES });
    const preview = await w.runner.preview('campaign_ideas', ideaDraft);
    w.failWriteNumber(2); // the campaign create
    const result = await w.runner.run(preview.playbook_token!);
    expect(result.status).toBe('failed');
    expect(result.failed).toMatchObject({ step: 'campaign', code: 'UNKNOWN_EXECUTION_STATUS' });
    expect(result.receipts.map(r => r.step)).toEqual(['list']);
    expect(result.reconcile).toMatchObject({ command: 'campaigns_list' });
    expect(mutationPaths(w)).toEqual(['POST /lead-lists', 'POST /campaigns']);
    await expect(w.runner.run(preview.playbook_token!)).rejects.toThrow('INVALID_PREVIEW');
  });
  it('a failure on step 1 sends nothing after it', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES });
    const preview = await w.runner.preview('campaign_ideas', ideaDraft);
    w.failWriteNumber(1);
    const result = await w.runner.run(preview.playbook_token!);
    expect(result.unexecuted).toEqual(['list', 'campaign']);
    expect(mutationPaths(w)).toEqual(['POST /lead-lists']);
  });
  it('two concurrent runs of one token: exactly one proceeds', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES });
    const preview = await w.runner.preview('campaign_ideas', ideaDraft);
    const [a, b] = await Promise.allSettled([w.runner.run(preview.playbook_token!), w.runner.run(preview.playbook_token!)]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(mutationPaths(w)).toEqual(['POST /lead-lists', 'POST /campaigns']);
  });
  it.each(['', 'a'.repeat(64), 'not-hex'])('rejects the invalid token %j with zero requests', async token => {
    const w = makeWorld({ hostAllowedWrites: WRITES });
    await expect(w.runner.run(token)).rejects.toThrow();
    expect(w.requests).toEqual([]);
  });
  it('an expired token is refused with zero requests', async () => {
    let time = 0;
    const w = makeWorld({ hostAllowedWrites: WRITES, now: () => time });
    const preview = await w.runner.preview('campaign_ideas', ideaDraft);
    const before = w.requests.length;
    time = 301_000;
    await expect(w.runner.run(preview.playbook_token!)).rejects.toThrow('EXPIRED_PREVIEW');
    expect(w.requests.length).toBe(before);
  });
  it('a plan cannot run under a different scope or tier binding', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES });
    const preview = await w.runner.preview('campaign_ideas', ideaDraft);
    const other = new PlaybookRunner({ dispatcher: w.dispatcher, scope, tier: 'managed', commands: allCommands, playbooks: allPlaybooks, hostAllowedWrites: WRITES });
    await expect(other.run(preview.playbook_token!)).rejects.toThrow('INVALID_PREVIEW');
    expect(w.mutations()).toEqual([]);
  });
  it('execute() runs only when the reviewed plan hash still matches', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES });
    const reviewed = await w.runner.preview('campaign_ideas', ideaDraft);
    await expect(w.runner.execute('campaign_ideas', ideaDraft, 'f'.repeat(64))).rejects.toThrow('STALE_PREVIEW');
    expect(w.mutations()).toEqual([]);
    const done = await w.runner.execute('campaign_ideas', ideaDraft, reviewed.plan_hash);
    expect(done.run?.status).toBe('completed');
    expect(mutationPaths(w)).toEqual(['POST /lead-lists', 'POST /campaigns']);
  });
  it('the host authorizeWrite hook can still veto at execution time', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, authorize: false });
    const preview = await w.runner.preview('campaign_ideas', ideaDraft);
    const result = await w.runner.run(preview.playbook_token!);
    expect(result.status).toBe('failed');
    expect(result.failed?.code).toBe('ENTITLEMENT_DENIED');
    expect(w.mutations()).toEqual([]);
  });
});

describe('cost policy and limits', () => {
  it('without host allowUnknownCost a write plan is preview-only and sends nothing', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, allowUnknownCost: false });
    const preview = await w.runner.preview('campaign_ideas', ideaDraft);
    expect(preview.playbook_token).toBeNull();
    expect(preview.refusals.map(r => r.code)).toContain('COST_POLICY_DENIED');
    expect(preview.steps.every(s => s.not_executable_reason === 'COST_POLICY_DENIED')).toBe(true);
    expect(w.mutations()).toEqual([]);
  });
  it('the page clamp and request budget bound a runaway read loop', async () => {
    const w = makeWorld({ responses: { 'POST /leads/list': () => ({ items: [{ id: uuid(1) }], next_starting_after: uuid(7) }) } });
    await w.runner.preview('skin_in_the_game_segments', { campaign_id: uuid(10), max_leads: 500 });
    expect(w.requests.filter(r => r.path === '/leads/list').length).toBe(10);
  });
});

describe('dependent arguments (template plus typed fills)', () => {
  const visitorsWorld = {
    'GET /workspace-billing/plan-details': { subscriptions: { website_visitors: { plan_name: 'Visitors' } } },
  };
  const input = { domain: 'example.com', webhook_url: 'https://hooks.example.com/x' };
  it('fills only the declared uuid field from the earlier response', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: visitorsWorld });
    const preview = await w.runner.preview('website_visitors_setup', input);
    expect(preview.steps.map(s => [s.command, s.deferred])).toEqual([['lead_lists_create', false], ['campaigns_create', false], ['webhooks_create', true]]);
    await w.runner.run(preview.playbook_token!);
    const hook = w.mutations().find(r => r.path === '/webhooks')!;
    const campaign = w.mutations().find(r => r.path === '/campaigns')!;
    expect(hook.body).toEqual({ name: 'Website visitors - example.com replies', target_hook_url: 'https://hooks.example.com/x', event_type: 'reply_received', campaign: expect.stringMatching(/^00000000-0000-4000-8000-/) });
    expect(campaign.method).toBe('POST');
  });
  it('refuses a non-uuid dependent value with zero further requests', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: { ...visitorsWorld, 'POST /campaigns': { id: '../../campaigns/activate' } } });
    const preview = await w.runner.preview('website_visitors_setup', input);
    const result = await w.runner.run(preview.playbook_token!);
    expect(result.status).toBe('failed');
    expect(result.failed?.code).toBe('DEPENDENT_VALUE_INVALID');
    expect(w.mutations().map(r => r.path)).toEqual(['/lead-lists', '/campaigns']);
  });
  it('a response cannot change the command, path or any other field', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: { ...visitorsWorld, 'POST /campaigns': { id: uuid(42), event_type: 'all_events', target_hook_url: 'https://evil.example', path: '/x' } } });
    const preview = await w.runner.preview('website_visitors_setup', input);
    await w.runner.run(preview.playbook_token!);
    const hook = w.mutations().find(r => r.path === '/webhooks')!;
    expect(hook.body).toMatchObject({ event_type: 'reply_received', target_hook_url: 'https://hooks.example.com/x', campaign: uuid(42) });
  });
  it('allowedWrites narrowed between preview and run sends zero mutations', async () => {
    const w = makeWorld({ hostAllowedWrites: WRITES, responses: visitorsWorld });
    const preview = await w.runner.preview('website_visitors_setup', input);
    (w.runner as any).options.hostAllowedWrites = ['lead_lists_create'];
    await expect(w.runner.run(preview.playbook_token!)).rejects.toThrow('STALE_PREVIEW');
    expect(w.mutations()).toEqual([]);
  });
});
