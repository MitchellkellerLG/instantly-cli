import { describe, it, expect, vi, afterEach } from 'vitest';
import { allCommands } from '../../src/commands/index.js';
import { SafeDispatcher } from '../../src/safe/dispatcher.js';
import { MemoryPreviewStore } from '../../src/safe/preview-store.js';
import { clientFromRequest, type Request } from '../../src/safe/transport.js';
import { CompactSurface, type CompactHost } from '../../src/compact/surface.js';
import { createLiveHost, healthClient, prerequisiteAllowed } from '../../src/compact/host.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const other = '33333333-3333-4333-8333-333333333333';
const id = '22222222-2222-4222-8222-222222222222';
const identity = { profile: 'sandbox', workspace, workspaceName: 'Synthetic', credentialRef: 'ref' };
const scope = { profile: 'sandbox', workspace_id: workspace };

function setup(allowedWrites: string[] = []) {
  const requests: Request[] = [];
  let live = { ...identity };
  const client = clientFromRequest(async <T>(request: Request): Promise<T> => {
    requests.push(JSON.parse(JSON.stringify(request)));
    return (request.method === 'GET' && request.path === '/campaigns' ? { items: [{ id }] } : { ok: true }) as T;
  });
  const store = new MemoryPreviewStore();
  const makeDispatcher = (count: () => void) => new SafeDispatcher({ commands: allCommands, bound: identity, identity: async () => live, client,
    store, registryRevision: 'r', contextRevision: 'c', allowedWrites, authorizeWrite: async c => allowedWrites.includes(c),
    prerequisiteAllowed, event: e => { if (e.type === 'request') count(); } });
  const host: CompactHost = { dispatcher: async count => makeDispatcher(count), allowedWrites, allowUnknownCost: false,
    status: async s => ({ authenticated: true, profile: identity.profile, workspace_id: live.workspace, matches_expected: s.workspace === live.workspace }),
    health: async () => ({ ok: true }) };
  return { surface: new CompactSurface(undefined, () => host), requests, setLive: (w: string) => { live = { ...identity, workspace: w }; } };
}
const mutations = (r: Request[]) => r.filter(x => x.method !== 'GET');

describe('compact preview and run', () => {
  it('runs an approved read and reports an audit envelope', async () => {
    const s = setup();
    const r: any = await s.surface.run({ mode: 'read', command_id: 'campaigns_list', arguments: { limit: 5 }, ...scope });
    expect(r.result).toEqual({ items: [{ id }] });
    expect(r.audit).toMatchObject({ profile: 'sandbox', workspace_id: workspace, effect: 'read', requests: 1 });
  });
  it('previews a write with zero requests and a plan that names the exact request', async () => {
    const s = setup();
    const p: any = await s.surface.preview({ command_id: 'campaigns_update', arguments: { id, name: 'Renamed' }, ...scope });
    expect(s.requests).toEqual([]);
    expect(p.preview_token).toMatch(/^[a-f0-9]{64}$/);
    expect(p.requests).toEqual([{ method: 'PATCH', path: `/campaigns/${id}`, body: expect.objectContaining({ name: 'Renamed' }) }]);
    expect(p.warnings.join(' ')).toMatch(/not enabled/);
    expect(p.next.arguments).toEqual({ mode: 'write', preview_token: p.preview_token, ...scope });
    expect(JSON.stringify(p)).not.toContain('credentialRef');
  });
  it('refuses a write the host did not enable and sends nothing', async () => {
    const s = setup();
    const p: any = await s.surface.preview({ command_id: 'campaigns_update', arguments: { id, name: 'A' }, ...scope });
    const r: any = await s.surface.run({ mode: 'write', preview_token: p.preview_token, ...scope });
    expect(r.error.code).toBe('WRITE_POLICY_DENIED');
    expect(mutations(s.requests)).toHaveLength(0);
  });
  it('executes an enabled write exactly once and refuses replay', async () => {
    const s = setup(['campaigns_update']);
    const p: any = await s.surface.preview({ command_id: 'campaigns_update', arguments: { id, name: 'A' }, ...scope });
    expect(p.warnings.join(' ')).not.toMatch(/not enabled/);
    const r: any = await s.surface.run({ mode: 'write', preview_token: p.preview_token, ...scope });
    expect(r.mode).toBe('write');
    expect(mutations(s.requests)).toHaveLength(1);
    const again: any = await s.surface.run({ mode: 'write', preview_token: p.preview_token, ...scope });
    expect(again.error.code).toBe('INVALID_PREVIEW');
    expect(mutations(s.requests)).toHaveLength(1);
  });
  it('rejects a read run of a write command and a write run that carries new arguments', async () => {
    const s = setup(['campaigns_update']);
    expect(((await s.surface.run({ mode: 'read', command_id: 'campaigns_update', arguments: { id, name: 'A' }, ...scope })) as any).error.code).toBe('READ_POLICY_DENIED');
    const p: any = await s.surface.preview({ command_id: 'campaigns_update', arguments: { id, name: 'A' }, ...scope });
    for (const extra of [{ arguments: { name: 'B' } }, { command_id: 'campaigns_delete' }]) {
      expect(((await s.surface.run({ mode: 'write', preview_token: p.preview_token, ...scope, ...extra })) as any).error.code).toBe('INVALID_ARGUMENTS');
    }
    expect(mutations(s.requests)).toHaveLength(0);
  });
  it('names a missing preview and refuses without sending', async () => {
    const s = setup(['campaigns_update']);
    const r: any = await s.surface.run({ mode: 'write', ...scope });
    expect(r.error).toMatchObject({ code: 'MISSING_PREVIEW' });
    expect(r.error.next).toMatch(/instantly_preview/);
    expect(s.requests).toEqual([]);
  });
  it('sends nothing on workspace or profile mismatch, including status that reports the mismatch', async () => {
    const s = setup(['campaigns_update']);
    for (const bad of [{ ...scope, workspace_id: other }, { profile: 'another', workspace_id: workspace }]) {
      expect(((await s.surface.preview({ command_id: 'campaigns_update', arguments: { id, name: 'A' }, ...bad })) as any).error.code).toBe('WORKSPACE_MISMATCH');
      expect(((await s.surface.run({ mode: 'read', command_id: 'campaigns_list', arguments: {}, ...bad })) as any).error.code).toBe('WORKSPACE_MISMATCH');
    }
    const status: any = await s.surface.run({ mode: 'read', command_id: 'status', arguments: {}, profile: 'sandbox', workspace_id: other });
    expect(status.result.matches_expected).toBe(false);
    expect(s.requests).toEqual([]);
  });
  it('invalidates a preview when the live workspace changes', async () => {
    const s = setup(['campaigns_update']);
    const p: any = await s.surface.preview({ command_id: 'campaigns_update', arguments: { id, name: 'A' }, ...scope });
    s.setLive(other);
    expect(((await s.surface.run({ mode: 'write', preview_token: p.preview_token, ...scope })) as any).error.code).toBe('WORKSPACE_MISMATCH');
    expect(mutations(s.requests)).toHaveLength(0);
  });
  it('rejects unknown keys and command IDs, unavailable features and unclassified commands', async () => {
    const s = setup();
    expect(((await s.surface.preview({ command_id: 'campaigns_update', arguments: { id, nope: 1 }, ...scope })) as any).error.code).toBe('UNKNOWN_ARGUMENTS');
    expect(((await s.surface.run({ mode: 'read', command_id: 'nope', arguments: {}, ...scope })) as any).error.code).toBe('UNKNOWN_COMMAND');
    expect(((await s.surface.run({ mode: 'read', command_id: 'voice_agent', arguments: {}, ...scope })) as any).error.code).toBe('UNAVAILABLE_FEATURE');
    expect(((await s.surface.run({ mode: 'read', command_id: 'accounts_test_vitals', arguments: { email: 'a@b.co' }, ...scope })) as any).error.code).toBe('READ_POLICY_DENIED');
    expect(((await s.surface.run({ mode: 'read', command_id: 'status', arguments: { x: 1 }, ...scope })) as any).error.code).toBe('UNKNOWN_ARGUMENTS');
    expect(((await s.surface.preview({ command_id: 'status', arguments: {}, ...scope })) as any).error.code).toBe('NOT_A_WRITE');
    expect(s.requests).toEqual([]);
  });
  it('requires an execution host and never invents one for find or describe', async () => {
    const bare = new CompactSurface();
    expect((bare.find({ intent: 'list campaigns' }) as any).hits.length).toBeGreaterThan(0);
    expect(((await bare.run({ mode: 'read', command_id: 'campaigns_list', arguments: {}, ...scope })) as any).error.code).toBe('NO_EXECUTION_HOST');
  });
});

describe('health is read only', () => {
  it('reaches only its three fixed GET paths', async () => {
    const seen: string[] = [];
    const real = clientFromRequest(async () => ({ items: [] }) as never);
    const client = healthClient({ ...real, get: async (path: string) => { seen.push(path); return { items: [] } as never; } }, () => {});
    await client.get('/accounts');
    await expect(client.get('/leads')).rejects.toThrow('READ_POLICY_DENIED');
    expect(() => client.post('/campaigns', {})).toThrow('READ_POLICY_DENIED');
    expect(seen).toEqual(['/accounts']);
  });
});

describe('concurrent live-host audits', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it.each([
    ['read', 'read', 1, 1],
    ['read', 'write', 1, 1],
    ['write', 'write', 1, 1],
    ['health', 'read', 3, 1],
    ['health', 'write', 3, 1],
    ['health', 'health', 3, 3],
    ['status', 'health', 0, 3],
  ] as const)('attributes overlapping %s and %s requests independently', async (first, second, firstCount, secondCount) => {
    let dispatched = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname.replace('/api/v2', '');
      if (path === '/workspaces/current') return new Response(JSON.stringify({ id: workspace, name: 'Synthetic' }));
      dispatched++;
      if (dispatched === firstCount + secondCount) release();
      await barrier;
      const result = path === '/accounts' || path === '/campaigns' ? { items: [] } : { id };
      return new Response(JSON.stringify(result));
    });
    const host = createLiveHost({ profile: 'default', apiKey: 'synthetic-concurrency-test-key',
      store: new MemoryPreviewStore(), allowedWrites: ['campaigns_update'] });
    const surface = new CompactSurface(undefined, () => host);
    const invocation = async (kind: typeof first | typeof second) => {
      const liveScope = { profile: 'default', workspace_id: workspace };
      if (kind === 'write') {
        const preview: any = await surface.preview({ command_id: 'campaigns_update', arguments: { id, name: 'Renamed' }, ...liveScope });
        expect(preview.preview_token).toMatch(/^[a-f0-9]{64}$/);
        return { mode: 'write', preview_token: preview.preview_token, ...liveScope };
      }
      return { mode: 'read', command_id: kind === 'read' ? 'campaigns_get' : kind,
        arguments: kind === 'read' ? { id } : {}, ...liveScope };
    };
    const a = await invocation(first), b = await invocation(second);
    const results: any[] = await Promise.all([surface.run(a), surface.run(b)]);
    expect(dispatched).toBe(firstCount + secondCount);
    expect(results.map(result => result.audit?.requests)).toEqual([firstCount, secondCount]);
    const ordinary: any = await surface.run(a.mode === 'write' ? await invocation('write') : a);
    expect(ordinary.audit?.requests).toBe(firstCount);
  });
});
