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
import baseline from '../../evals/v1/baseline/registry.json';

// Independent wire/argument and policy oracles reviewed against the pinned public spec.
// These are synthetic responses, not captures or evidence of account entitlement.
const manifest = JSON.parse(readFileSync('evals/public-delta-v1/fixtures.json', 'utf8'));
const fixtures: (Fixture & { effect: EffectPolicy })[] = manifest.fixtures;
const workspace = '11111111-1111-4111-8111-111111111111';
const identity = { profile: 'sandbox', workspace, workspaceName: 'Synthetic sandbox', credentialRef: 'fake-ref' };
const scope = { profile: identity.profile, workspace };

function setup(fixture: Fixture, options: Record<string, unknown> = {}) {
  const transport = new FakeTransport(fixture.context, [fixture]);
  let now = 0;
  const dispatcher = new SafeDispatcher({ commands: allCommands, bound: identity, identity: async () => identity,
    client: transport.client, store: new MemoryPreviewStore(), registryRevision: 'public-delta-v1',
    contextRevision: 'public-delta-v1', now: () => now, ...options });
  return { transport, dispatcher, expire: () => { now = 300_000; } };
}
afterEach(() => vi.unstubAllGlobals());

describe('13-operation public API delta, fake transport only', () => {
  it.each(fixtures)('$context.command response conforms to the pinned public schema', fixture => {
    const spec = JSON.parse(readFileSync('spec/api_v2.json', 'utf8'));
    const command = allCommands.find(c => c.name === fixture.context.command)!;
    const operation = operations(spec).find(op => operationKey(op.method, op.path) ===
      operationKey(command.endpoint.method, command.endpoint.path))!;
    const schema = resolve(spec, operation.responses['200'].content['application/json'].schema);
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(fixture.response), JSON.stringify(validate.errors)).toBe(true);
    expect(fixture.responseHash).toBe(digest({ response: fixture.response, error: fixture.error }));
    for (const key of schema.required) {
      const incomplete = { ...fixture.response as Record<string, unknown> };
      delete incomplete[key];
      expect(validate(incomplete)).toBe(false);
    }
  });
  it('covers every newly registered operation exactly once', () => {
    const original = new Set(baseline.map(c => c.id));
    const added = allCommands.filter(c => !original.has(c.name)).map(c => c.name).sort();
    expect(added).toHaveLength(13);
    expect(fixtures.map(f => f.context.command).sort()).toEqual(added);
  });
  it.each(fixtures)('$context.command matches its independent wire and effect oracle', async fixture => {
    const fetch = vi.fn(() => { throw new Error('OFFLINE_EGRESS_DENIED'); });
    vi.stubGlobal('fetch', fetch);
    const command = allCommands.find(c => c.name === fixture.context.command)!;
    expect(command.generated).toBe(true);
    expect(effectPolicy(command)).toEqual(fixture.effect);
    const args = validateArguments(command, fixture.context.arguments);
    const legacy = new FakeTransport(fixture.context, [fixture]);
    expect(await command.handler(args, legacy.client)).toEqual(fixture.response);
    legacy.assertComplete();
    expect(legacy.events).toEqual([{ request: fixture.request, matched: true }]);

    const s = setup(fixture);
    const preview = await s.dispatcher.preview(command.name, fixture.context.arguments, scope);
    expect(preview.plan.requests).toEqual([fixture.request]);
    expect(preview.plan.effect).toEqual(fixture.effect);
    expect(s.transport.events).toEqual([]);
    if (fixture.effect.effect === 'read') {
      expect(await s.dispatcher.read(command.name, fixture.context.arguments, scope)).toEqual(fixture.response);
      s.transport.assertComplete();
      await expect(s.dispatcher.write(preview.token, scope)).rejects.toThrow('WRITE_POLICY_DENIED');
    } else {
      await expect(s.dispatcher.read(command.name, fixture.context.arguments, scope)).rejects.toThrow('READ_POLICY_DENIED');
      await expect(s.dispatcher.write(preview.token, scope)).rejects.toThrow('WRITE_POLICY_DENIED');
      expect(s.transport.events).toEqual([]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(fixtures)('$context.command refuses changed workspace before any request', async fixture => {
    const s = setup(fixture);
    await expect(s.dispatcher.preview(fixture.context.command, fixture.context.arguments,
      { ...scope, workspace: '22222222-2222-4222-8222-222222222222' })).rejects.toThrow('WORKSPACE_MISMATCH');
    expect(s.transport.events).toEqual([]);
  });

  it.each(fixtures.filter(f => f.effect.effect === 'write'))(
    '$context.command requires cost authorization and an unchanged one-use preview', async fixture => {
      const command = fixture.context.command;
      const denied = setup(fixture, { allowedWrites: [command], authorizeWrite: async () => true });
      const preview = await denied.dispatcher.preview(command, fixture.context.arguments, scope);
      await expect(denied.dispatcher.write(preview.token, scope)).rejects.toThrow('COST_POLICY_DENIED');
      expect(denied.transport.events).toEqual([]);
      for (const reason of ['missing', 'wrong', 'expired', 'changed-arguments', 'workspace']) {
        const s = setup(fixture, { allowedWrites: [command], allowUnknownCost: true, authorizeWrite: async () => true });
        const { token } = await s.dispatcher.preview(command, fixture.context.arguments, scope);
        if (reason === 'expired') s.expire();
        await expect(s.dispatcher.write(reason === 'missing' ? '' : reason === 'wrong' ? 'a'.repeat(64) : token,
          reason === 'workspace' ? { ...scope, workspace: '22222222-2222-4222-8222-222222222222' } : scope,
          reason === 'changed-arguments' ? { body: {} } as never : undefined)).rejects.toThrow();
        expect(s.transport.events).toEqual([]);
      }
      const allowed = setup(fixture, { allowedWrites: [command], allowUnknownCost: true, authorizeWrite: async () => true });
      const { token } = await allowed.dispatcher.preview(command, fixture.context.arguments, scope);
      expect(await allowed.dispatcher.write(token, scope)).toEqual(fixture.response);
      await expect(allowed.dispatcher.write(token, scope)).rejects.toThrow('INVALID_PREVIEW');
      expect(allowed.transport.events).toEqual([{ request: fixture.request, matched: true }]);
      allowed.transport.assertComplete();
    },
  );

  it.each([
    ['creator_search_search_creators', { body: { platform: 'invalid', kind: 'structured', idempotency_key: workspace } }],
    ['creator_search_create_creator_outreach_batch', { body: { platform: 'instagram' } }],
    ['local_business_search_convert_local_businesses', { body: { filters: {}, count: 0, idempotency_key: 'synthetic-key' } }],
    ['local_business_search_generate_local_business_filters', { body: { input: '' } }],
    ['custom_tags_search_custom_tags_by_resources', { body: { resource_ids: [] } }],
  ])('%s rejects invalid public-schema arguments without transport', async (command, args) => {
    const fixture = fixtures.find(f => f.context.command === command)!;
    const s = setup(fixture);
    await expect(s.dispatcher.preview(command as string, args as Record<string, unknown>, scope)).rejects.toThrow();
    expect(s.transport.events).toEqual([]);
  });
});
