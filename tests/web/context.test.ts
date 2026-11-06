import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { createCommandContext } from '../../src/core/command-context.js';
import { registerAllCommands } from '../../src/commands/index.js';
import { webClientFor } from '../../src/web/browser-client.js';
import { assertLoopback } from '../../src/web/cdp.js';
import { createWebClient } from '../../src/web/client.js';
import type { WebCall, WebTransport } from '../../src/web/transport.js';

const ws = '11111111-1111-4111-8111-111111111111';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('web command context', () => {
  it('binds the browser client to the workspace the API key proves, and sends nothing to the public API for the web route', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ id: ws, name: 'Synthetic' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    vi.stubEnv('INSTANTLY_WEB_BROWSER_URL', '');
    const { client, liveWorkspace } = await createCommandContext({ apiKey: 'test-key', mutating: false, origin: 'web' });
    expect(liveWorkspace?.id).toBe(ws);
    expect(urls.every(u => u.includes('/workspaces/current'))).toBe(true);
    await expect(client.get('/backend-alt/api/v2/workspaces/current/instantly-credits')).rejects.toThrow('WEB_BROWSER_UNAVAILABLE');
    expect(urls.some(u => u.includes('instantly-credits'))).toBe(false);
  });
  it('a malformed endpoint breaks only web calls, never client construction', async () => {
    const client = webClientFor(ws, 'file:///etc/passwd');
    await expect(client.get('/backend-alt/api/v2/workspaces/current/instantly-credits')).rejects.toThrow('WEB_BROWSER_URL_DENIED');
    expect(() => assertLoopback('http://[::1]:9222')).not.toThrow();
  });
  it('encodes repeated query values', async () => {
    const calls: WebCall[] = [];
    const transport: WebTransport = { async call(c) { calls.push(c); return { status: 200, json: { data: [] } }; } };
    await createWebClient(transport, ws).get('/backend-alt/api/v1/tasks', { status: ['A b', 'C&d'], limit: 2 });
    expect(calls[0].url).toBe('/backend-alt/api/v1/tasks?status=A%20b&status=C%26d&limit=2');
  });
  it('registers web groups on the CLI only when an attended browser is configured', () => {
    const groups = () => { const p = new Command(); registerAllCommands(p); return p.commands.map(c => c.name()); };
    vi.stubEnv('INSTANTLY_WEB_BROWSER_URL', '');
    expect(groups().some(g => g.startsWith('web-'))).toBe(false);
    vi.stubEnv('INSTANTLY_WEB_BROWSER_URL', 'http://127.0.0.1:9222');
    const on = groups();
    expect(on).toContain('web-crm');
    expect(on).not.toContain('web-browser');
  });
});
