import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { operations, operationKey, resolve } from '../../scripts/openapi.js';
import { digest } from '../../src/safe/canonical.js';
import { allCommands } from '../../src/commands/index.js';
import { FakeTransport, type Fixture } from '../../src/eval/offline.js';
import { effectPolicy, type EffectPolicy } from '../../src/safe/policy.js';
import { SafeDispatcher, validateArguments } from '../../src/safe/dispatcher.js';
import { MemoryPreviewStore } from '../../src/safe/preview-store.js';

// Three GET commands audited as read/no-cost and moved from "unknown" to "read" (advisor-1, 2026-11-05). ctd-status is a DNS/SSL check of a caller-supplied host that reads no workspace data and uses no mailbox credentials; accounts_test_vitals probes the customer's mailbox servers and stays refused. The blocklist download is an unpaginated export (optional search/domains_only filters)..
// Synthetic responses; no network.
const manifest = JSON.parse(readFileSync('evals/read-allowlist-v1/fixtures.json', 'utf8'));
const fixtures: (Fixture & { effect: EffectPolicy })[] = manifest.fixtures;
const workspace = '11111111-1111-4111-8111-111111111111';
const identity = { profile: 'sandbox', workspace, workspaceName: 'Synthetic sandbox', credentialRef: 'fake-ref' };
const scope = { profile: identity.profile, workspace };
const READ = { effect: 'read', cost: 'none', notifications: false };

function setup(fixture: Fixture, options: Record<string, unknown> = {}) {
  const transport = new FakeTransport(fixture.context, [fixture]);
  const dispatcher = new SafeDispatcher({ commands: allCommands, bound: identity, identity: async () => identity,
    client: transport.client, store: new MemoryPreviewStore(), registryRevision: 'read-allowlist-v1',
    contextRevision: 'read-allowlist-v1', ...options });
  return { transport, dispatcher };
}
afterEach(() => vi.unstubAllGlobals());

describe('audited read allowlist, fake transport only', () => {
  it('covers exactly the three newly allowlisted commands', () => {
    expect([...new Set(fixtures.map(f => f.context.command))].sort()).toEqual(
      ['accounts_ctd-status', 'blocklist_download_block_list_entry', 'oauth_get_oauth_session_status']);
  });
  it.each(fixtures)('$context.command is read/no-cost and its response matches the pinned spec', fixture => {
    const command = allCommands.find(c => c.name === fixture.context.command)!;
    expect(effectPolicy(command)).toEqual(READ);
    expect(fixture.effect).toEqual(READ);
    expect(fixture.responseHash).toBe(digest({ response: fixture.response, error: fixture.error }));
    const spec = JSON.parse(readFileSync('spec/api_v2.json', 'utf8'));
    const op = operations(spec).find(o => operationKey(o.method, o.path) === operationKey(command.endpoint.method, command.endpoint.path))!;
    const content = op.responses['200'].content;
    if (content['application/json']) {
      const ajv = new Ajv({ strict: false, allErrors: true });
      addFormats(ajv);
      const validate = ajv.compile(resolve(spec, content['application/json'].schema));
      expect(validate(fixture.response), JSON.stringify(validate.errors)).toBe(true);
      // The spec declares no required fields, so pin the shapes the audit relied on.
      expect(fixture.response).not.toEqual({});
      expect(Object.keys(fixture.response as object).every(k => k in resolve(spec, content['application/json'].schema).properties)).toBe(true);
    } else {
      expect(Object.keys(content)).toContain('text/csv');
      expect(fixture.response).toMatch(/^Blocked Email,Date\r\n/);
    }
  });
  it.each(fixtures)('$context.command previews and reads exactly one pinned request and is never writable', async fixture => {
    const fetch = vi.fn(() => { throw new Error('OFFLINE_EGRESS_DENIED'); });
    vi.stubGlobal('fetch', fetch);
    // Even with the command named as an allowed write, cost authorized and entitlement granted, a read-effect command cannot be written.
    const s = setup(fixture, { allowedWrites: [fixture.context.command], allowUnknownCost: true, authorizeWrite: async () => true });
    const preview = await s.dispatcher.preview(fixture.context.command, fixture.context.arguments, scope);
    expect(preview.plan.requests).toEqual([fixture.request]);
    expect(s.transport.events).toEqual([]);
    expect(await s.dispatcher.read(fixture.context.command, fixture.context.arguments, scope)).toEqual(fixture.response);
    s.transport.assertComplete();
    await expect(s.dispatcher.write(preview.token, scope)).rejects.toThrow('WRITE_POLICY_DENIED');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(fixtures)('$context.command refuses a changed workspace before any request', async fixture => {
    const s = setup(fixture);
    await expect(s.dispatcher.read(fixture.context.command, fixture.context.arguments,
      { ...scope, workspace: '22222222-2222-4222-8222-222222222222' })).rejects.toThrow('WORKSPACE_MISMATCH');
    expect(s.transport.events).toEqual([]);
  });
  it('keeps api_keys_list (returns key material) and accounts_test_vitals (live probe) refused', async () => {
    for (const name of ['api_keys_list', 'accounts_test_vitals']) {
      expect(effectPolicy(allCommands.find(c => c.name === name)!).effect).not.toBe('read');
    }
    const fixture = fixtures[0];
    const s = setup(fixture);
    await expect(s.dispatcher.read('api_keys_list', {}, scope)).rejects.toThrow('READ_POLICY_DENIED');
    await expect(s.dispatcher.preview('api_keys_list', {}, scope)).rejects.toThrow('UNKNOWN_EFFECT');
    await expect(s.dispatcher.preview('accounts_test_vitals', { email: 'a@example.com' }, scope)).rejects.toThrow('UNKNOWN_EFFECT');
    expect(s.transport.events).toEqual([]);
  });
  it('rejects unknown arguments before identity or request', () => {
    const command = allCommands.find(c => c.name === 'accounts_ctd-status')!;
    expect(() => validateArguments(command, { host: 'a.example.com', extra: 1 })).toThrow('UNKNOWN_ARGUMENTS');
    expect(() => validateArguments(command, {})).toThrow(/host/);
  });
});
