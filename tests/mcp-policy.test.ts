import { it, expect, vi, beforeEach, afterEach } from 'vitest';
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const handlers = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(name: string, _config: unknown, handler: unknown) { handlers.set(name, handler); }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
const PINNED = 'synthetic-pinned-0001';
vi.mock('../src/core/auth.js', () => ({
  resolveCredentials: async (o: { profile?: string } = {}) => o.profile
    ? { apiKey: PINNED, source: `profile (${o.profile})`, profile: { slug: o.profile, workspace_id: 'ws-a', workspace_name: 'A', api_key: PINNED }, boundWorkspace: { id: 'ws-a', name: 'A' } }
    : { apiKey: PINNED, source: 'env' },
  boundWorkspaceOf: (c: any) => c.boundWorkspace,
  displayProfileSlug: (c: any) => c.profile?.slug ?? 'default',
}));
import { startMcpServer } from '../src/mcp/server.js';

const calls: string[] = [];
beforeEach(() => {
  handlers.clear(); calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init: any = {}) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    if (path.endsWith('/workspaces/current')) return Response.json({ id: 'ws-a', name: 'A' });
    if (path.includes('/dfy-email-account-orders/accounts')) return Response.json({ items: [{ password: 'pw-marker' }] });
    if (path.endsWith('/campaigns/c1/activate')) return Response.json({ id: 'c1' });
    if (path.endsWith('/campaigns')) return Response.json({ items: [], echoed: PINNED });
    return Response.json({ message: `bad ${PINNED}` }, { status: 400 });
  });
});
afterEach(() => vi.unstubAllGlobals());
const call = (name: string, args: Record<string, unknown> = {}) => (handlers.get(name) as Handler)(args);

it('F2: refuses a per-call profile that differs from the pinned one', async () => {
  await startMcpServer({ profile: 'client-a' });
  const denied = await call('campaigns_list', { profile: 'client-b' });
  expect(denied.isError).toBe(true);
  expect(denied.content[0].text).toContain("bound to profile 'client-a'");
  expect(calls).toEqual([]);
  expect((await call('status', { profile: 'client-b' })).isError).toBe(true);
  expect((await call('health', { profile: 'client-b' })).isError).toBe(true);
  expect((await call('campaigns_list', { profile: 'client-a' })).isError).toBeUndefined();
});

it('F2: the default key path refuses any named profile', async () => {
  await startMcpServer();
  expect((await call('campaigns_list', { profile: 'client-b' })).isError).toBe(true);
});

it('F3: unapproved mutations and password reads are not available, and approved ones still need workspace_id', async () => {
  await startMcpServer();
  expect(handlers.has('campaigns_activate')).toBe(false);
  const pw = await call('dfy_orders_list_accounts', { with_passwords: true });
  expect(pw.isError).toBe(true);
  expect(JSON.stringify(pw)).not.toContain('pw-marker');
  expect(calls).toEqual([]);

  handlers.clear();
  await startMcpServer({ allowWrites: ['campaigns_activate'] });
  const noWs = await call('campaigns_activate', { id: 'c1' });
  expect(noWs.isError).toBe(true);
  expect(calls).not.toContain('POST /api/v2/campaigns/c1/activate');
  const ok = await call('campaigns_activate', { id: 'c1', workspace_id: 'ws-a' });
  expect(ok.isError).toBeUndefined();
  expect(calls).toContain('POST /api/v2/campaigns/c1/activate');
  const wrong = await call('campaigns_activate', { id: 'c1', workspace_id: 'ws-other' });
  expect(wrong.isError).toBe(true);
});

it('F3/F8: operator-approved sensitive reads return credentials; otherwise results are masked', async () => {
  await startMcpServer({ allowSensitive: ['dfy_orders_list_accounts'] });
  expect(JSON.stringify(await call('dfy_orders_list_accounts', { with_passwords: true }))).toContain('pw-marker');
  handlers.clear();
  await startMcpServer();
  const masked = JSON.stringify(await call('dfy_orders_list_accounts', {}));
  expect(masked).not.toContain('pw-marker');
  expect(masked).toContain('[REDACTED]');
});

it('F8: the active key never appears in results or errors', async () => {
  await startMcpServer();
  expect(JSON.stringify(await call('campaigns_list'))).not.toContain(PINNED);
  expect(JSON.stringify(await call('campaigns_get', { id: 'nope' }))).not.toContain(PINNED);
});
