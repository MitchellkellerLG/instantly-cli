import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { webReadCommands as webCommands } from '../../src/commands/web/index.js';
import { SafeDispatcher } from '../../src/safe/dispatcher.js';
import { MemoryPreviewStore } from '../../src/safe/preview-store.js';
import { clientFromRequest } from '../../src/safe/transport.js';
import { createWebClient } from '../../src/web/client.js';
import { leaks } from '../../src/web/redact.js';
import type { WebCall, WebTransport } from '../../src/web/transport.js';
import { SAMPLE_ARGS } from './samples.js';

const dir = 'tests/fixtures/web/';
const fixtures = readdirSync(dir).filter(f => f.startsWith('web_')).map(f => JSON.parse(readFileSync(dir + f, 'utf8')) as { id: string; args: Record<string, unknown>; body: unknown });
const workspace = '11111111-1111-4111-8111-111111111111';
const identity = { profile: 'sandbox', workspace, workspaceName: 'Synthetic sandbox', credentialRef: 'fake-ref' };
const scope = { profile: identity.profile, workspace };
const apiClient = clientFromRequest(async () => { throw new Error('the public API must never be called for a web command'); });

function dispatcher(transport: WebTransport | undefined, mismatch = false) {
  return new SafeDispatcher({ commands: webCommands, bound: identity, identity: async () => mismatch ? { ...identity, workspace: '22222222-2222-4222-8222-222222222222' } : identity,
    client: apiClient, webClient: transport ? createWebClient(transport, workspace) : undefined,
    store: new MemoryPreviewStore(), registryRevision: 'web-v1', contextRevision: 'web-v1' });
}

describe('recorded test-workspace fixtures replay through the safe dispatcher', () => {
  it('has a recorded fixture for every web command and none are secret-shaped', () => {
    expect(fixtures.map(f => f.id).sort()).toEqual(webCommands.map(c => c.name).sort());
    for (const f of fixtures) expect(leaks(JSON.stringify(f))).toBe(false);
  });
  it.each(fixtures.map(f => [f.id, f] as const))('%s: one GET, bound workspace, response returned untouched', async (_id, fixture) => {
    const calls: WebCall[] = [];
    const transport: WebTransport = { async call(c) { calls.push(c); return { status: 200, json: structuredClone(fixture.body) }; } };
    const command = webCommands.find(c => c.name === fixture.id)!;
    expect(fixture.args).toEqual(command.inputSchema.parse(SAMPLE_ARGS[fixture.id] ?? {}));
    const result = await dispatcher(transport).read(fixture.id, SAMPLE_ARGS[fixture.id] ?? {}, scope);
    expect(result).toEqual(fixture.body);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].workspace).toBe(workspace);
    expect(calls[0].url.split('?')[0]).toBe(command.endpoint.path);
  });
  it('a preview of a web read plans exactly one GET and sends nothing', async () => {
    const calls: WebCall[] = [];
    const d = dispatcher({ async call(c) { calls.push(c); return { status: 200, json: {} }; } });
    const { plan } = await d.preview('web_credits_get', {}, scope);
    expect(plan.effect).toEqual({ effect: 'read', cost: 'none', notifications: false });
    expect(plan.requests).toEqual([{ method: 'GET', path: '/backend-alt/api/v2/workspaces/current/instantly-credits' }]);
    expect(calls).toEqual([]);
  });
  it('refuses when no attended browser is configured and never falls back to the public API', async () => {
    await expect(dispatcher(undefined).read('web_credits_get', {}, scope)).rejects.toThrow('WEB_BROWSER_UNAVAILABLE');
  });
  it('a workspace mismatch on the API identity stops the read before the browser is touched', async () => {
    const calls: WebCall[] = [];
    await expect(dispatcher({ async call(c) { calls.push(c); return { status: 200, json: {} }; } }, true).read('web_credits_get', {}, scope)).rejects.toThrow('WORKSPACE_MISMATCH');
    expect(calls).toEqual([]);
  });
  it('a drifted private route fails closed through the dispatcher', async () => {
    await expect(dispatcher({ async call() { return { status: 200, json: { balance_usd: 1 } }; } }).read('web_credits_get', {}, scope)).rejects.toThrow('WEB_SHAPE_DRIFT');
  });
  it('web commands cannot be written: no write path exists for them', async () => {
    const d = dispatcher({ async call() { return { status: 200, json: {} }; } });
    const { token } = await d.preview('web_credits_get', {}, scope);
    await expect(d.write(token, scope)).rejects.toThrow('WRITE_POLICY_DENIED');
  });
});
