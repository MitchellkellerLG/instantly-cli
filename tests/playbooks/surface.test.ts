import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const resolver = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/core/auth.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/auth.js')>()),
  resolveCredentials: async () => { resolver.count++; throw new Error('key resolution must not happen here'); },
}));
import { createCompactServer, mcpOptionsFrom } from '../../src/mcp/compact.js';
import { PLAYBOOK_TOOLS, promptText, registerPlaybooks } from '../../src/mcp/playbooks.js';
import { PlaybookService } from '../../src/playbooks/service.js';
import { recommend, digestText } from '../../src/playbooks/digest.js';
import { allPlaybooks } from '../../src/playbooks/registry.js';
import { buildOfferProfile } from '../../src/playbooks/book/offer.js';
import { createProgram } from '../../src/program.js';
import { identity, makeWorld, scope, workspace } from '../../scripts/playbooks/world.js';

const text = (r: any) => JSON.parse(r.content[0].text);
async function connect(server: McpServer): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}
function fakeService(tier: 'vip' | 'managed' | 'internal', writes: string[]) {
  const w = makeWorld({ hostAllowedWrites: writes });
  const host = { dispatcher: async () => w.dispatcher, status: async () => ({}), health: async () => ({}), allowedWrites: writes, allowUnknownCost: true };
  return { w, service: new PlaybookService({ host: () => host as never, tier }) };
}
const args = { profile: scope.profile, workspace_id: workspace };
beforeEach(() => { resolver.count = 0; });

describe('opt-in registration', () => {
  it('default compact server registers exactly four tools and advertises no prompts', async () => {
    const client = await connect(createCompactServer({}));
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['instantly_find', 'instantly_describe', 'instantly_preview', 'instantly_run']);
    await expect(client.listPrompts()).rejects.toThrow('Method not found'); // the prompts capability is not even advertised
  });
  it('--playbooks adds the four playbook tools and one prompt per visible playbook, resolving no key at startup', async () => {
    const client = await connect(createCompactServer({ playbooks: true, tier: 'managed' }));
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(['instantly_find', 'instantly_describe', 'instantly_preview', 'instantly_run', ...PLAYBOOK_TOOLS]);
    const prompts = (await client.listPrompts()).prompts.map(p => p.name);
    expect(prompts).toEqual(allPlaybooks.map(p => `playbooks/${p.slug}`));
    expect(resolver.count).toBe(0);
  });
  it('discovery advertises registered tools and executable canonical slugs', async () => {
    const { w, service } = fakeService('internal', []);
    w.table['GET /local-business-search/places'] = { items: [] };
    const server = new McpServer({ name: 'discovery', version: '1' });
    registerPlaybooks(server, service);
    const client = await connect(server);
    const tools = new Set((await client.listTools()).tools.map(t => t.name));
    const list = text(await client.callTool({ name: 'playbooks_list', arguments: {} }));
    const slugs = new Set<string>();
    for (const row of list.playbooks) {
      expect(row).not.toHaveProperty('tool');
      const described = text(await client.callTool({ name: 'playbooks_describe', arguments: { slug: row.slug } }));
      expect(described).not.toHaveProperty('tool');
      expect(described.slug).toBe(row.slug);
      slugs.add(described.slug);
    }
    const samples: Record<string, object> = {
      skin_in_the_game_segments: { campaign_id: workspace },
      website_visitors_setup: { domain: 'example.com' },
      local_lookalike: { category: 'dentist', place: 'Austin, TX' },
    };
    for (const slug of slugs) {
      const result: any = await client.callTool({ name: 'playbooks_preview', arguments: { slug, input: samples[slug] ?? {}, ...args } });
      expect(result.isError).not.toBe(true);
      expect(text(result).playbook).toBe(slug);
      const alias = `playbook_${slug}`;
      expect(text(await client.callTool({ name: 'playbooks_describe', arguments: { slug: alias } }))).toMatchObject({ error: { code: 'UNKNOWN_PLAYBOOK' } });
      expect(text(await client.callTool({ name: 'playbooks_preview', arguments: { slug: alias, input: samples[slug] ?? {}, ...args } }))).toMatchObject({ error: { code: 'UNKNOWN_PLAYBOOK' } });
      await expect(w.runner.preview(alias, samples[slug] ?? {})).rejects.toThrow('UNKNOWN_PLAYBOOK');
    }
    const advertised = new Set<string>();
    for (const prompt of (await client.listPrompts()).prompts) {
      const result: any = await client.getPrompt({ name: prompt.name });
      const body = result.messages[0].content.text as string;
      for (const match of body.matchAll(/call (playbooks?_\w+)/gi)) advertised.add(match[1]);
      for (const match of body.matchAll(/with slug "([^"]+)"/g)) advertised.add(match[1]);
    }
    expect(advertised.size).toBeGreaterThan(5);
    for (const name of advertised) expect(tools.has(name) || slugs.has(name), name).toBe(true);
  });
  it('flags and environment select playbooks and tier, and typos fail at startup', () => {
    expect(mcpOptionsFrom({}, {})).not.toHaveProperty('playbooks');
    expect(mcpOptionsFrom({ playbooks: true, tier: 'managed' }, {})).toMatchObject({ playbooks: true, tier: 'managed' });
    expect(mcpOptionsFrom({}, { INSTANTLY_MCP_PLAYBOOKS: '1', INSTANTLY_TIER: 'internal' })).toMatchObject({ playbooks: true, tier: 'internal' });
    expect(() => mcpOptionsFrom({ playbooks: true, tier: 'root' }, {})).toThrow('UNKNOWN_TIER');
    expect(() => mcpOptionsFrom({ allowUnknownCost: true }, {})).toThrow('--playbooks');
    expect(mcpOptionsFrom({ allowWrite: 'campaigns_create', playbooks: true }, {}).allowWrites).toEqual(['campaigns_create']);
  });
  it('prompts render the exact preview command and the safety rules', async () => {
    const { service } = fakeService('internal', []);
    const server = new McpServer({ name: 't', version: '1' });
    registerPlaybooks(server, service);
    const client = await connect(server);
    const got: any = await client.getPrompt({ name: 'playbooks/offer_profile', arguments: { profile: 'acme', workspace_id: workspace } });
    const body = got.messages[0].content.text as string;
    expect(body).toBe(promptText('offer_profile', 'Offer-type profile', allPlaybooks.find(p => p.slug === 'offer_profile')!.description, ['api_read'], 'acme', workspace));
    expect(body).toContain(`instantly --profile acme --workspace ${workspace} playbooks run offer_profile`);
    expect(body).toMatch(/Never click Save/);
    expect(body).not.toMatch(/\u2014/);
  });
  it('retrieves prompts with omitted, empty and partial optional workspace arguments', async () => {
    const client = await connect(createCompactServer({ playbooks: true, tier: 'managed' }));
    try {
      // MCP permits omitting arguments when all advertised arguments are optional.
      // These independent commands reject dropped supplied values and missing defaults.
      const cases = [
        { arguments: undefined, profile: '<slug>', workspace: '<uuid>' },
        { arguments: {}, profile: '<slug>', workspace: '<uuid>' },
        { arguments: { profile: 'acme' }, profile: 'acme', workspace: '<uuid>' },
        { arguments: { workspace_id: workspace }, profile: '<slug>', workspace },
        { arguments: { profile: 'acme', workspace_id: workspace }, profile: 'acme', workspace },
      ];
      for (const prompt of (await client.listPrompts()).prompts) {
        expect(prompt.arguments?.every(arg => !arg.required)).toBe(true);
        for (const sample of cases) {
          const result = await client.getPrompt({ name: prompt.name, arguments: sample.arguments });
          expect(result.messages[0].content).toMatchObject({
            type: 'text',
            text: expect.stringContaining(`instantly --profile ${sample.profile} --workspace ${sample.workspace} playbooks run ${prompt.name.slice('playbooks/'.length)}`),
          });
        }
      }
      await expect(client.getPrompt({ name: 'playbooks/unknown' })).rejects.toThrow('not found');
      expect(resolver.count).toBe(0);
    } finally {
      await client.close();
    }
  });
});

describe('playbook tools over MCP', () => {
  it('lists, describes, previews and runs through one in-process runner', async () => {
    const { w, service } = fakeService('internal', ['campaigns_create', 'lead_lists_create']);
    const server = new McpServer({ name: 't', version: '1' });
    registerPlaybooks(server, service);
    const client = await connect(server);
    const list = text(await client.callTool({ name: 'playbooks_list', arguments: args }));
    expect(list.playbooks.map((p: any) => p.slug)).toEqual(['campaign_ideas', 'skin_in_the_game_segments', 'offer_profile', 'website_visitors_setup', 'local_lookalike']);
    expect(list.offer_profile.offer_category).toBe('saas');
    expect(list.digest).toMatch(/Recommendations and aggregates only/);
    const d = text(await client.callTool({ name: 'playbooks_describe', arguments: { slug: 'campaign_ideas' } }));
    expect(d.input_schema.properties.count).toBeTruthy();
    const preview = text(await client.callTool({ name: 'playbooks_preview', arguments: { slug: 'campaign_ideas', input: { draft_idea: 'idea-01' }, ...args } }));
    expect(w.mutations()).toEqual([]);
    const run = text(await client.callTool({ name: 'playbooks_run', arguments: { playbook_token: preview.playbook_token, ...args } }));
    expect(run.status).toBe('completed');
    expect(w.mutations().map(r => r.path)).toEqual(['/lead-lists', '/campaigns']);
  });
  it('returns typed errors with next steps and isError, never a crash', async () => {
    const { service } = fakeService('vip', []);
    const server = new McpServer({ name: 't', version: '1' });
    registerPlaybooks(server, service);
    const client = await connect(server);
    const unknown: any = await client.callTool({ name: 'playbooks_describe', arguments: { slug: 'nope' } });
    expect(unknown.isError).toBe(true);
    expect(text(unknown).error).toMatchObject({ code: 'UNKNOWN_PLAYBOOK', next: expect.any(String) });
    const bad: any = await client.callTool({ name: 'playbooks_run', arguments: { playbook_token: 'zz', ...args } });
    expect(bad.isError).toBe(true);
    const wrongWs: any = await client.callTool({ name: 'playbooks_preview', arguments: { slug: 'offer_profile', input: {}, profile: 'sandbox', workspace_id: '99999999-9999-4999-8999-999999999999' } });
    expect(text(wrongWs).error.code).toBe('WORKSPACE_MISMATCH');
    const extra: any = await client.callTool({ name: 'playbooks_preview', arguments: { slug: 'offer_profile', input: {}, ...args, sneaky: 1 } });
    expect(extra.isError).toBe(true);
  });
  it.each(['failed', 'refused'] as const)('marks %s runs as MCP errors and preserves receipts', async status => {
    const { service } = fakeService('internal', []);
    const result = { playbook: 'campaign_ideas', status, receipts: [{ step: 'list', command: 'lead_lists_create', plan_hash: 'p', response_hash: 'r' }], unexecuted: ['campaign'], credits_spent_max: 0 };
    vi.spyOn(service, 'run').mockResolvedValue(result);
    const server = new McpServer({ name: 't', version: '1' });
    registerPlaybooks(server, service);
    const client = await connect(server);
    const response = await client.callTool({ name: 'playbooks_run', arguments: { playbook_token: 'a'.repeat(64), ...args } });
    expect(response.isError).toBe(true);
    expect(text(response)).toEqual(result);
  });
  it('keeps both concurrent initial preview tokens in the same scoped runner', async () => {
    const { service } = fakeService('internal', ['campaigns_create', 'lead_lists_create']);
    const previews = await Promise.all([service.preview('campaign_ideas', { draft_idea: 'idea-01' }, scope), service.preview('campaign_ideas', { draft_idea: 'idea-02' }, scope)]);
    for (const preview of previews) {
      expect(await service.run((preview as any).playbook_token, scope)).toMatchObject({ status: 'completed' });
    }
  });
  it('a vip server previews write playbooks but cannot be tricked into running them', async () => {
    const { w, service } = fakeService('vip', ['campaigns_create', 'lead_lists_create']);
    const server = new McpServer({ name: 't', version: '1' });
    registerPlaybooks(server, service);
    const client = await connect(server);
    const preview = text(await client.callTool({ name: 'playbooks_preview', arguments: { slug: 'campaign_ideas', input: { draft_idea: 'idea-01' }, ...args } }));
    expect(preview.playbook_token).toBeNull();
    expect(preview.refusals.map((r: any) => r.code)).toContain('WRITE_POLICY_DENIED');
    expect(w.mutations()).toEqual([]);
  });
});

describe('digest (S9)', () => {
  const saas = buildOfferProfile({ agents: { ok: true, value: { items: [{ agent_type: 2, config: { memory: { business_description: 'software platform to grow revenue' } } }] } } });
  it('ranks recommended playbooks first and marks non-fits', () => {
    const recs = recommend(saas, 'internal', allPlaybooks);
    expect(recs.find(r => r.slug === 'local_lookalike')?.fit).toBe('not_a_fit');
    expect(recs.find(r => r.slug === 'website_visitors_setup')?.fit).toBe('not_a_fit');
    expect(recs.find(r => r.slug === 'campaign_ideas')?.fit).toBe('recommended');
    expect(recs[recs.length - 1].fit).toBe('not_a_fit');
  });
  it('keeps uncertain profiles first and defers every other fit verdict', async () => {
    const agents = { items: [{ agent_type: 2, config: { memory: { business_description: 'software services to grow revenue' } } }] };
    const campaigns = { items: [{ name: 'Q1 outreach' }] };
    const offer = buildOfferProfile({ agents: { ok: true, value: agents }, campaigns: { ok: true, value: campaigns } });
    expect(offer.needs_confirmation).toBe(true);
    const recs = recommend(offer, 'internal', allPlaybooks);
    expect(recs[0]).toMatchObject({ slug: 'offer_profile', fit: 'recommended' });
    expect(recs.slice(1).every(r => r.fit === 'available')).toBe(true);
    const rendered = digestText(offer, recs);
    expect(rendered.split('\n').filter(line => line.startsWith('* '))).toEqual([expect.stringContaining('[offer_profile]')]);
    const { w, service } = fakeService('internal', []);
    w.table['GET /ai-agents/sales'] = agents;
    w.table['GET /campaigns'] = campaigns;
    w.table['POST /leads/list'] = { items: [] };
    const listed = await service.list(scope) as any;
    expect(listed.playbooks[0]).toMatchObject({ slug: 'offer_profile', fit: 'recommended' });
    expect(listed.playbooks.find((p: any) => p.slug === 'campaign_ideas').fit).toBe('available');
    expect(listed.playbooks.find((p: any) => p.slug === 'local_lookalike').fit).toBe('available');
    expect(listed.digest).toBe(rendered);
  });
  it('without a profile nothing is claimed as a fit', () => {
    expect(recommend(null, 'vip', allPlaybooks).every(r => r.fit === 'available')).toBe(true);
  });
  it('is deterministic and carries no lead data or email', () => {
    const a = digestText(saas, recommend(saas, 'vip', allPlaybooks));
    expect(a).toBe(digestText(saas, recommend(saas, 'vip', allPlaybooks)));
    expect(a).not.toMatch(/@/);
    expect(a).not.toMatch(/\u2014/);
  });
  it('visitor and local fits follow the detected offer', () => {
    const demand = { ...saas, entitlements: { ...saas.entitlements, website_visitors: true }, motion: 'demand_gen' as const };
    expect(demand.needs_confirmation).toBe(false);
    expect(recommend(demand, 'internal', allPlaybooks).find(r => r.slug === 'website_visitors_setup')?.fit).toBe('recommended');
    const local = buildOfferProfile({ agents: { ok: true, value: { items: [{ config: { memory: { business_description: 'We run plumbing and hvac for local businesses to grow revenue' } } }] } } });
    expect(local.needs_confirmation).toBe(false);
    expect(recommend(local, 'internal', allPlaybooks).find(r => r.slug === 'local_lookalike')?.fit).toBe('recommended');
  });
});

describe('CLI group', () => {
  let out: string[]; let err: string[];
  beforeEach(() => {
    out = []; err = []; process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });
  const cli = (...a: string[]) => createProgram().parseAsync(['node', 'instantly', ...a]);
  it('list and describe work offline with no key and print JSON', async () => {
    await cli('playbooks', 'list');
    expect(JSON.parse(out[0]).playbooks).toHaveLength(5);
    out.length = 0;
    await cli('playbooks', 'describe', 'local_lookalike');
    expect(JSON.parse(out[0])).toMatchObject({ slug: 'local_lookalike', requires: ['api_read', 'api_write', 'spend'] });
    expect(resolver.count).toBe(0);
  });
  it('run needs an explicit profile and workspace, and a typo tier is a JSON error with exit code 1', async () => {
    await cli('playbooks', 'run', 'offer_profile');
    expect(JSON.parse(err[0]).error.code).toBe('PROFILE_REQUIRED');
    expect(process.exitCode).toBe(1);
    err.length = 0; process.exitCode = undefined;
    await cli('--profile', 'p', '--workspace', workspace, 'playbooks', '--tier', 'root', 'run', 'offer_profile');
    expect(JSON.parse(err[0]).error.code).toBe('UNKNOWN_TIER');
  });
  it('rejects malformed input JSON before any network', async () => {
    await cli('--profile', 'p', '--workspace', workspace, 'playbooks', 'run', 'offer_profile', '--input', '[1]');
    expect(JSON.parse(err[0]).error.code).toBe('INVALID_ARGUMENTS');
    expect(resolver.count).toBe(0);
  });
  it.each(['failed', 'refused'] as const)('exits nonzero for nested %s execution and retains receipts', async status => {
    const result = { preview: {} as any, run: { playbook: 'campaign_ideas', status, receipts: [{ step: 'list', command: 'lead_lists_create', plan_hash: 'p', response_hash: 'r' }], unexecuted: ['campaign'], credits_spent_max: 0 } };
    vi.spyOn(PlaybookService.prototype, 'execute').mockResolvedValue(result);
    await cli('--profile', 'p', '--workspace', workspace, 'playbooks', 'run', 'campaign_ideas', '--confirm', 'a'.repeat(64));
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out[0])).toEqual(result);
  });
  it('published examples parse and reach credential resolution', async () => {
    for (const playbook of allPlaybooks) for (const example of playbook.examples) {
      const argv = example.replace('<slug>', 'sandbox').replace('<uuid>', workspace).match(/'[^']*'|[^\s]+/g)!.slice(1).map(t => t.startsWith("'") ? t.slice(1, -1) : t);
      const previous = resolver.count;
      await cli(...argv);
      expect(resolver.count, example).toBe(previous + 1);
    }
  });
  it('the mcp command exposes the opt-in flags', () => {
    const mcp = createProgram().commands.find(c => c.name() === 'mcp')!;
    expect(mcp.options.map(o => o.long)).toEqual(expect.arrayContaining(['--playbooks', '--tier']));
  });
  it('identity helper is wired', () => { expect(identity.workspace).toBe(workspace); });
});
