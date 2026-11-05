import { it, expect, vi, afterEach } from 'vitest';
import { resolveCredentials } from '../../src/core/auth.js';
import { createLiveHost } from '../../src/compact/host.js';
import { MemoryPreviewStore } from '../../src/safe/preview-store.js';

vi.mock('../../src/core/auth.js', async original => ({
  ...(await original<typeof import('../../src/core/auth.js')>()),
  resolveCredentials: vi.fn(),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(resolveCredentials).mockReset(); });
const workspace = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

it.each(['status', 'read', 'health'])('pins credentials across %s and subsequent status, reads and health', async first => {
  const key = 'synthetic-original';
  vi.mocked(resolveCredentials).mockResolvedValueOnce({ apiKey: key, source: 'profile',
    profile: { slug: 'client-a', api_key: key, workspace_id: workspace, workspace_name: 'A' } });
  vi.mocked(resolveCredentials).mockResolvedValue({ apiKey: 'synthetic-rebound', source: 'profile',
    profile: { slug: 'client-a', api_key: 'synthetic-rebound', workspace_id: other, workspace_name: 'B' } });
  const keys: unknown[] = [];
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    keys.push(init.headers.Authorization);
    if (new URL(url).pathname.endsWith('/workspaces/current')) {
      return Response.json(init.headers.Authorization === `Bearer ${key}`
        ? { id: workspace, name: 'A', email: 'a@example.com' }
        : { id: other, name: 'B', email: 'b@example.com' });
    }
    return Response.json({ items: [] });
  });
  const host = createLiveHost({ profile: 'client-a', store: new MemoryPreviewStore() });
  const scope = { profile: 'client-a', workspace };
  const read = async () => (await host.dispatcher(() => {})).read('campaigns_list', {}, scope);
  await (first === 'status' ? host.status(scope) : first === 'health' ? host.health(scope, () => {}) : read());
  expect(await host.status(scope)).toMatchObject({ authenticated: true, matches_expected: true,
    workspace_id: workspace, workspace_name: 'A', workspace: { email: 'a@example.com' } });
  await read();
  expect(await host.health(scope, () => {})).toMatchObject({ workspace_id: workspace });
  expect(resolveCredentials).toHaveBeenCalledTimes(1);
  expect(keys.every(value => value === `Bearer ${key}`)).toBe(true);
});

it('status keeps the original default workspace binding when the live workspace changes', async () => {
  vi.mocked(resolveCredentials).mockResolvedValue({ apiKey: 'synthetic-default', source: 'env' });
  let current = { id: workspace, name: 'A', email: 'a@example.com' };
  vi.stubGlobal('fetch', async () => Response.json(current));
  const host = createLiveHost({ profile: 'default', store: new MemoryPreviewStore() });
  const scope = { profile: 'default', workspace };
  expect(await host.status(scope)).toMatchObject({ authenticated: true, matches_expected: true });
  current = { id: other, name: 'Private B', email: 'private-b@example.com' };
  const status = await host.status(scope);
  expect(status).toMatchObject({ authenticated: false, matches_expected: false, workspace_id: workspace, workspace_name: 'A' });
  expect(JSON.stringify(status)).not.toContain('Private B');
  expect(JSON.stringify(status)).not.toContain('private-b@example.com');
  await expect(host.health({ profile: 'default', workspace: other }, () => {})).rejects.toThrow('bound workspace');
  const dispatcher = await host.dispatcher(() => {});
  await expect(dispatcher.read('campaigns_list', {}, scope)).rejects.toThrow('bound workspace');
  expect(resolveCredentials).toHaveBeenCalledTimes(1);
});
