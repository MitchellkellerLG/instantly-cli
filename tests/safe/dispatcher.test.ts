import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allCommands } from '../../src/commands/index.js';
import { SafeDispatcher, validateArguments } from '../../src/safe/dispatcher.js';
import { MemoryPreviewStore, FilePreviewStore } from '../../src/safe/preview-store.js';
import { clientFromRequest, type Request } from '../../src/safe/transport.js';
import type { CommandDefinition } from '../../src/core/types.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const identity = { profile: 'sandbox', workspace, workspaceName: 'Synthetic sandbox', credentialRef: 'fake-ref' };
const scope = { profile: identity.profile, workspace };
const id = '22222222-2222-4222-8222-222222222222';
function setup(options: Record<string, any> = {}) {
  const requests: Request[] = [];
  let time = 0;
  let live = { ...identity };
  let response: any = { from_address_email: 'lead@example.com', lead_email: 'lead@example.com' };
  let failWrite = false;
  const client = clientFromRequest(async <T>(request: Request): Promise<T> => {
    requests.push(JSON.parse(JSON.stringify(request)));
    if (failWrite && request.method !== 'GET') throw new Error('timeout');
    return structuredClone(response) as T;
  });
  const dispatcher = new SafeDispatcher({ commands: allCommands, bound: identity, identity: async () => live,
    client, store: new MemoryPreviewStore(), registryRevision: 'registry-v1', contextRevision: 'context-v1',
    authorizeWrite: async () => true,
    allowedWrites: ['campaigns_update', 'email_reply', 'email_forward', 'campaigns_bulk-activate'], now: () => time,
    prerequisiteAllowed: (command, request) => ['email_reply', 'email_forward'].includes(command) &&
      request.method === 'GET' && request.path === `/emails/${id}`, ...options });
  return { dispatcher, requests, client, advance: () => { time += 300_000; },
    live: (value: typeof live) => { live = value; }, response: (value: any) => { response = value; },
    failWrite: () => { failWrite = true; } };
}
const args = { id, name: 'Renamed' };
const mutations = (requests: Request[]) => requests.filter(r => r.method !== 'GET');
describe('safe shared dispatcher', () => {
  it('previews with no mutation, consumes once before executing unchanged request', async () => {
    const s = setup();
    const preview = await s.dispatcher.preview('campaigns_update', args, scope);
    expect(s.requests).toEqual([]);
    await s.dispatcher.write(preview.token, scope);
    expect(mutations(s.requests)).toEqual(preview.plan.requests.map(request => ({ ...request, retry: 'never' })));
    await expect(s.dispatcher.write(preview.token, scope)).rejects.toThrow('INVALID_PREVIEW');
    expect(mutations(s.requests)).toHaveLength(1);
  });
  it.each(['wrong', 'missing', 'expired', 'workspace', 'profile', 'credential', 'changed-arguments'])(
    'sends zero mutations for %s tokens', async reason => {
      const s = setup();
      const { token } = await s.dispatcher.preview('campaigns_update', args, scope);
      if (reason === 'expired') s.advance();
      if (reason === 'credential') s.live({ ...identity, credentialRef: 'another-key' });
      const target = reason === 'workspace' ? { ...scope, workspace: id } :
        reason === 'profile' ? { ...scope, profile: 'other' } : scope;
      await expect(s.dispatcher.write(reason === 'wrong' ? 'a'.repeat(64) : reason === 'missing' ? '' : token,
        target, reason === 'changed-arguments' ? { name: 'Other' } as never : undefined)).rejects.toThrow();
      expect(mutations(s.requests)).toHaveLength(0);
    },
  );
  it('rejects workspace mismatch during preview and live identity mismatch during read', async () => {
    const s = setup();
    await expect(s.dispatcher.preview('campaigns_update', args, { ...scope, workspace: id })).rejects.toThrow('WORKSPACE_MISMATCH');
    s.live({ ...identity, workspace: id });
    await expect(s.dispatcher.read('campaigns_get', { id }, scope)).rejects.toThrow('WORKSPACE_MISMATCH');
    expect(s.requests).toEqual([]);
  });
  it('validates unknown keys and generated AJV refinements before identity', async () => {
    let identities = 0;
    const s = setup({ identity: async () => { identities++; return identity; } });
    await expect(s.dispatcher.preview('campaigns_update', { ...args, unexpected: true }, scope)).rejects.toThrow('UNKNOWN_ARGUMENTS');
    const generated = allCommands.find(c => c.generated && c.name === 'company_lists_get_company_list')!;
    expect(() => validateArguments(generated, {})).toThrow();
    expect(identities).toBe(0);
  });
  it('denies unknown IDs, write reads, unknown effects, and default write authority', async () => {
    const s = setup({ allowedWrites: [] });
    await expect(s.dispatcher.read('not_registered', {}, scope)).rejects.toThrow('UNSUPPORTED_COMMAND');
    await expect(s.dispatcher.read('campaigns_update', args, scope)).rejects.toThrow('READ_POLICY_DENIED');
    await expect(s.dispatcher.preview('accounts_test_vitals', { email: 'sender@example.com' }, scope)).rejects.toThrow('UNKNOWN_EFFECT');
    const preview = await s.dispatcher.preview('campaigns_update', args, scope);
    await expect(s.dispatcher.write(preview.token, scope)).rejects.toThrow('WRITE_POLICY_DENIED');
    expect(s.requests).toEqual([]);
  });
  it('rechecks prerequisite response version, including recipient changes', async () => {
    const s = setup();
    const input = { reply_to_uuid: id, eaccount: 'sender@example.com', to: 'lead@example.com', subject: 'Hello', body_text: 'Hi\n\nJane' };
    const preview = await s.dispatcher.preview('email_reply', input, scope);
    expect(mutations(s.requests)).toEqual([]);
    expect((preview.plan.requests[0].body as any).body.html).toContain('<br />');
    s.response({ lead_email: 'lead@example.com', version: 2 });
    await expect(s.dispatcher.write(preview.token, scope)).rejects.toThrow('STALE_PREVIEW');
    s.response({ lead_email: 'someone-else@example.com' });
    await expect(s.dispatcher.write(preview.token, scope)).rejects.toThrow('Recipient mismatch');
    expect(mutations(s.requests)).toEqual([]);
  });
  it('matches effective normalized handler requests for every corpus write', async () => {
    const { readFileSync } = await import('node:fs');
    const jobs = readFileSync('evals/v1/jobs.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
    for (const job of jobs.filter(j => j.expected.outcome === 'preview_only')) {
      const s = setup();
      const command = allCommands.find(c => c.name === job.expected.tool)!;
      if (job.id === 'instantly-029') {
        await expect(s.dispatcher.preview(command.name, job.expected.key_arguments, scope)).rejects.toThrow('At least one enrichment type');
        expect(s.requests).toEqual([]);
        continue;
      }
      const preview = await s.dispatcher.preview(command.name, job.expected.key_arguments, scope);
      const recorded: Request[] = [];
      await command.handler(validateArguments(command, job.expected.key_arguments), clientFromRequest(async <T>(request: Request): Promise<T> => {
        if (request.method !== 'GET') recorded.push(JSON.parse(JSON.stringify(request)));
        return { lead_email: 'lead@example.com', from_address_email: 'lead@example.com' } as T;
      }));
      expect(preview.plan.requests, job.id).toEqual(recorded);
      expect(mutations(s.requests), job.id).toEqual([]);
    }
  });
  it('rejects swallowed multi-request failures without sending the first mutation', async () => {
    const s = setup();
    await expect(s.dispatcher.preview('campaigns_bulk-activate', { ids: [id, workspace] }, scope)).rejects.toThrow('UNSUPPORTED_MULTI_REQUEST');
    expect(s.requests).toEqual([]);
  });
  it('consumes before ambiguous failure, with no retry or replay', async () => {
    const s = setup();
    const preview = await s.dispatcher.preview('campaigns_update', args, scope);
    s.failWrite();
    await expect(s.dispatcher.write(preview.token, scope)).rejects.toThrow('UNKNOWN_EXECUTION_STATUS');
    await expect(s.dispatcher.write(preview.token, scope)).rejects.toThrow('INVALID_PREVIEW');
    expect(mutations(s.requests)).toHaveLength(1);
  });
  it.each(['read', 'preview'] as const)('refuses password export before any %s request', async method => {
    let identities = 0;
    const s = setup({ identity: async () => { identities++; return identity; } });
    await expect(s.dispatcher[method]('dfy_orders_list_accounts', { with_passwords: true }, scope))
      .rejects.toThrow('UNSUPPORTED_PASSWORD_EXPORT');
    expect(identities).toBe(0);
    expect(s.requests).toEqual([]);
    s.response({ items: [] });
    await expect(s.dispatcher.read('dfy_orders_list_accounts', { with_passwords: false }, scope))
      .resolves.toEqual({ items: [] });
    expect(s.requests).toHaveLength(1);
  });
  it.each(['campaigns_create', 'campaigns_update', 'subsequences_create'])(
    'preserves the sequence timeline and API output for %s', async command => {
      const sequences = [{ steps: [{ type: 'email', delay: 0, delay_unit: 'days', variants: [{ subject: 'Hello', body: 'Hi' }] }] }];
      const input = command === 'subsequences_create'
        ? { parent_campaign: id, name: 'Follow up', conditions: '{}', subsequence_schedule: '{}', sequences: JSON.stringify(sequences) }
        : { ...(command === 'campaigns_update' ? { id } : {}), name: 'Draft', sequences };
      const s = setup({ allowedWrites: [command], allowUnknownCost: true });
      s.response({ id, name: 'Draft' });
      const preview = await s.dispatcher.preview(command, input, scope);
      expect(s.requests).toEqual([]);
      const result = await s.dispatcher.write(preview.token, scope) as any;
      expect(result.id).toBe(id);
      expect(result.sequence_timeline.emails[0].when).toBe(
        command === 'subsequences_create' ? 'on subsequence trigger' : 'on campaign schedule');
      expect(mutations(s.requests)).toHaveLength(1);
    },
  );
  it.each([['campaigns_bulk-activate', 'activated'], ['campaigns_bulk-pause', 'paused']])(
    'preserves the single campaign result array for %s', async (command, status) => {
      const s = setup({ allowedWrites: [command], allowUnknownCost: true });
      const { token } = await s.dispatcher.preview(command, { ids: [id] }, scope);
      await expect(s.dispatcher.write(token, scope)).resolves.toEqual([{ id, status }]);
      expect(mutations(s.requests)).toHaveLength(1);
    },
  );
  it('reports ambiguous bulk mutation failure even when the handler catches it', async () => {
    const s = setup({ allowedWrites: ['campaigns_bulk-activate'], allowUnknownCost: true });
    const { token } = await s.dispatcher.preview('campaigns_bulk-activate', { ids: [id] }, scope);
    s.failWrite();
    await expect(s.dispatcher.write(token, scope)).rejects.toThrow('UNKNOWN_EXECUTION_STATUS');
    await expect(s.dispatcher.write(token, scope)).rejects.toThrow('INVALID_PREVIEW');
    expect(mutations(s.requests)).toHaveLength(1);
  });
  it('preserves recipient confirmation without repeating the execution prerequisite', async () => {
    const s = setup();
    const input = { reply_to_uuid: id, eaccount: 'sender@example.com', to: 'lead@example.com', subject: 'Hello' };
    const { token } = await s.dispatcher.preview('email_reply', input, scope);
    const result = await s.dispatcher.write(token, scope) as any;
    expect(result.__confirmed_recipient).toBe('lead@example.com');
    expect(s.requests.filter(r => r.method === 'GET')).toHaveLength(2);
    expect(mutations(s.requests)).toHaveLength(1);
  });
  it('preserves the missing enrichment configuration explanation', async () => {
    const s = setup();
    s.response({ exists: false });
    const result = await s.dispatcher.read('enrichment_get', { resource_id: id }, scope) as any;
    expect(result.exists).toBe(false);
    expect(result._cli_note).toBe('This resource exists but has no enrichment configuration. ' +
      'Use "instantly enrichment create --resource-id <id> --type <type>" to set one up.');
    expect(s.requests).toHaveLength(1);
  });
  it('rejects smuggled replacement arguments inside scope', async () => {
    const s = setup();
    const { token } = await s.dispatcher.preview('campaigns_update', args, scope);
    await expect(s.dispatcher.write(token, { ...scope, arguments: { name: 'Other' } } as any)).rejects.toThrow('INVALID_SCOPE');
    expect(s.requests).toEqual([]);
  });
  it('rechecks execution entitlement and unknown costs before any mutation', async () => {
    const denied = setup({ authorizeWrite: async () => false });
    const preview = await denied.dispatcher.preview('campaigns_update', args, scope);
    await expect(denied.dispatcher.write(preview.token, scope)).rejects.toThrow('ENTITLEMENT_DENIED');
    expect(denied.requests).toEqual([]);
    const paid = setup({ allowedWrites: ['campaigns_create'] });
    const paidPreview = await paid.dispatcher.preview('campaigns_create', { name: 'Draft' }, scope);
    await expect(paid.dispatcher.write(paidPreview.token, scope)).rejects.toThrow('COST_POLICY_DENIED');
    expect(paid.requests).toEqual([]);
  });
  it('atomically permits one concurrent token execution', async () => {
    const s = setup();
    const preview = await s.dispatcher.preview('campaigns_update', args, scope);
    const results = await Promise.allSettled([s.dispatcher.write(preview.token, scope), s.dispatcher.write(preview.token, scope)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(mutations(s.requests)).toHaveLength(1);
  });
  it('binds tokens to registry and context revisions and policy', async () => {
    const store = new MemoryPreviewStore();
    const first = setup({ store });
    const { token } = await first.dispatcher.preview('campaigns_update', args, scope);
    for (const change of [{ registryRevision: 'changed' }, { contextRevision: 'changed' }, { authorizeWrite: async () => true,
    allowedWrites: ['campaigns_update'] }]) {
      const second = setup({ store, ...change });
      await expect(second.dispatcher.write(token, scope)).rejects.toThrow('STALE_PREVIEW');
      expect(second.requests).toEqual([]);
    }
  });
  it('checks expiry again after asynchronous prerequisites', async () => {
    const s = setup({ identity: async () => { s.advance(); return identity; } });
    const { token } = await s.dispatcher.preview('campaigns_update', args, scope);
    await expect(s.dispatcher.write(token, scope)).rejects.toThrow('EXPIRED_PREVIEW');
    expect(s.requests).toEqual([]);
  });
  it('purges expired plans from both stores', () => {
    const record = { expires: 1, binding: 'b', command: 'c', args: {}, planHash: 'h' };
    const memory = new MemoryPreviewStore();
    const token = memory.issue(record); memory.prune(1);
    expect(() => memory.peek(token)).toThrow('INVALID_PREVIEW');
    const directory = mkdtempSync(join(tmpdir(), 'instantly-expired-'));
    try {
      const file = new FilePreviewStore(directory);
      const persisted = file.issue(record); file.prune(1);
      expect(() => file.peek(persisted)).toThrow('INVALID_PREVIEW');
    } finally { rmSync(directory, { recursive: true }); }
  });
  it('persists private tokens across store instances and consumes atomically', () => {
    const directory = mkdtempSync(join(tmpdir(), 'instantly-preview-'));
    try {
      const first = new FilePreviewStore(directory);
      const record = { expires: 1, binding: 'b', command: 'c', args: {}, planHash: 'h' };
      const token = first.issue(record);
      expect(statSync(join(directory, token + '.json')).mode & 0o777).toBe(0o600);
      const second = new FilePreviewStore(directory);
      expect(second.peek(token)).toEqual(record);
      first.consume(token);
      expect(() => second.consume(token)).toThrow('INVALID_PREVIEW');
      expect(() => second.peek('../escape')).toThrow('INVALID_PREVIEW');
    } finally { rmSync(directory, { recursive: true }); }
  });
});
