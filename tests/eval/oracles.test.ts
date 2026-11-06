import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { allCommands } from '../../src/commands/index.js';
import { grade, type Job, type Trace } from '../../src/eval/grader.js';
import { FakeTransport, type Fixture } from '../../src/eval/offline.js';
import { canonical, digest } from '../../src/safe/canonical.js';
import { SafeDispatcher, validateArguments } from '../../src/safe/dispatcher.js';
import { MemoryPreviewStore } from '../../src/safe/preview-store.js';
import { replayOptions } from '../../scripts/eval/options.js';

const jobs: Job[] = readFileSync('evals/v1/jobs.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
const manifest = JSON.parse(readFileSync('evals/v1/fixtures.json', 'utf8'));
const outcomes = JSON.parse(readFileSync('evals/v1/outcomes.json', 'utf8'));
const facts = JSON.parse(readFileSync('evals/v1/facts.json', 'utf8'));
const identity = { profile: 'sandbox', workspace: jobs[0].fixture.workspace_id,
  workspaceName: 'Synthetic sandbox', credentialRef: 'synthetic-key-reference' };
const scope = { profile: identity.profile, workspace: identity.workspace };
const score = (job: Job, trace: Trace) => grade(job, trace, manifest.fixtures, facts.registrySourceHash, manifest.plans, outcomes);
function setup(job: Job) {
  const status = manifest.fixtures.find((f: Fixture) => f.context.command === 'status');
  const transport = new FakeTransport({ command: job.expected.tool!, arguments: job.expected.key_arguments,
    workspace: job.fixture.workspace_id }, manifest.fixtures);
  const trace: Trace = { version: 1, id: job.id, surface: 'safe', provenance: 'synthetic', driver: 'test',
    registryHash: facts.registrySourceHash, fixtureHash: digest(manifest.fixtures), oracleHash: digest(outcomes),
    identity: { profile: identity.profile, workspace: identity.workspace, verified: true },
    identityRequests: [{ request: status.request, matched: true, responseHash: status.responseHash }],
    invocations: [{ command: 'status', arguments: {} }, { command: job.expected.tool!, arguments: job.expected.key_arguments }],
    requests: [], previews: [], outcome: job.expected.outcome, elapsedMs: 0, modelTokens: null, discoveryCandidates: [] };
  const dispatcher = new SafeDispatcher({ commands: allCommands, bound: identity, identity: async () => identity,
    client: transport.client, store: new MemoryPreviewStore(), registryRevision: facts.registrySourceHash,
    contextRevision: 'offline-v1', prerequisiteAllowed: (id, request) =>
      ['email_reply', 'email_forward'].includes(id) && request.method === 'GET' &&
      request.path === '/emails/22222222-2222-4222-8222-222222222222' });
  return { dispatcher, transport, trace };
}
async function previewTrace(job: Job) {
  const { dispatcher, transport, trace } = setup(job);
  const { plan } = await dispatcher.preview(job.expected.tool!, job.expected.key_arguments, scope);
  transport.assertComplete();
  trace.previews = [{ command: plan.command, planHash: digest(plan), requests: structuredClone(plan.requests), plan }];
  trace.requests = transport.events;
  return trace;
}
describe('independent outcome and preview oracles', () => {
  it.each(['legacy', 'safe'])('checks the actual unread count on %s', async surface => {
    const job = jobs.find(j => j.expected.tool === 'email_unread_count')!;
    const { dispatcher, transport, trace } = setup(job);
    const command = allCommands.find(c => c.name === job.expected.tool)!;
    trace.surface = surface as Trace['surface'];
    trace.result = surface === 'safe'
      ? await dispatcher.read(command.name, job.expected.key_arguments, scope)
      : await command.handler(validateArguments(command, job.expected.key_arguments), transport.client);
    transport.assertComplete();
    trace.requests = transport.events;
    expect(trace.result).toEqual({ count: 0 });
    expect(score(job, trace).passed).toBe(true);
    trace.result = { count: 99 };
    expect(score(job, trace).failures).toContain('read_result');
    trace.result = { from_address_email: 'lead@example.com' };
    expect(score(job, trace).failures).toContain('read_result');
    delete trace.result;
    expect(score(job, trace).failures).toContain('read_result');
  });
  it.each(['instantly-005', 'instantly-006', 'instantly-017', 'instantly-018'])('rejects rehashed plan tampering for %s', async id => {
    const job = jobs.find(j => j.id === id)!;
    const good = await previewTrace(job);
    expect(score(job, good).passed).toBe(true);
    const changes: ((trace: Trace) => void)[] = [
      t => { t.previews[0].plan.requests[0].path = '/wrong-resource'; },
      t => { t.previews[0].plan.requests[0].body = { changed: true }; },
      t => { t.previews[0].requests[0].path = '/wrong-duplicate'; },
      t => { t.previews[0].plan.requests = []; t.previews[0].requests = []; },
      t => { t.previews[0].plan.identity.profile = 'other'; },
      t => { t.previews[0].plan.identity.workspace = '99999999-9999-4999-8999-999999999999'; },
      t => { t.previews[0].plan.identity.credentialRef = 'other-reference'; },
      t => { t.previews[0].plan.identity.workspaceName = 'Other workspace'; },
      t => { t.previews[0].plan.effect.effect = 'read'; },
      t => { t.previews[0].plan.effect.cost = 'invented'; },
      t => { t.previews[0].plan.effect.notifications = false; },
    ];
    for (const change of changes) {
      const trace = structuredClone(good);
      change(trace);
      trace.previews[0].planHash = digest(trace.previews[0].plan);
      expect(score(job, trace).failures).toContain('server_preview');
    }
    const payload = structuredClone(good);
    payload.previews[0].plan.requests[0].body[id === 'instantly-018' ? 'to' : 'name'] = 'other@example.com';
    payload.previews[0].planHash = digest(payload.previews[0].plan);
    expect(score(job, payload).failures).toContain('server_preview');
    const changed = structuredClone(good);
    changed.previews[0].plan.requests[0].path = '/wrong';
    changed.previews[0].requests = structuredClone(changed.previews[0].plan.requests);
    changed.previews[0].planHash = digest(changed.previews[0].plan);
    expect(score(job, changed).failures).toContain('server_preview');
  });
  it.each(['email_reply', 'email_forward'])('requires independently matched recipient prerequisites for %s', async tool => {
    const job = jobs.find(j => j.expected.tool === tool)!;
    const good = await previewTrace(job);
    expect(good.previews[0].plan.prerequisites).toHaveLength(1);
    const changes: ((trace: Trace) => void)[] = [
      t => { t.previews[0].plan.prerequisites = []; },
      t => { delete t.previews[0].plan.prerequisites; },
      t => { t.previews[0].plan.prerequisites[0].responseHash = digest({ other: true }); },
      t => { t.previews[0].plan.prerequisites[0].request.path = '/emails/other'; },
      t => { t.previews[0].plan.prerequisites.push(structuredClone(t.previews[0].plan.prerequisites[0])); },
      t => { t.requests = []; },
      t => { t.requests[0].matched = false; },
    ];
    for (const change of changes) {
      const trace = structuredClone(good);
      change(trace);
      trace.previews[0].planHash = digest(trace.previews[0].plan);
      expect(score(job, trace).failures).toContain('server_preview');
    }
    const fixtures = manifest.fixtures.filter((f: Fixture) => !(f.context.command === tool &&
      canonical(f.context.arguments) === canonical(job.expected.key_arguments)));
    const omitted = structuredClone(good);
    omitted.fixtureHash = digest(fixtures);
    omitted.previews[0].plan.prerequisites = [];
    omitted.previews[0].planHash = digest(omitted.previews[0].plan);
    omitted.requests = [];
    expect(grade(job, omitted, fixtures, facts.registrySourceHash, manifest.plans, outcomes).failures).toContain('server_preview');
  });
});
describe('frozen replay inputs', () => {
  it.each(['--corpus', '--fixtures', '--corpus=other.jsonl', '--fixtures=other.json'])(
    'rejects replacement option %s', flag => {
      expect(() => replayOptions([flag, 'replacement.json'])).toThrow('UNSUPPORTED_REPLAY_OPTION: ' + flag);
    },
  );
  it('retains surface, split and output selection', () => {
    expect(replayOptions(['--surface', 'safe', '--split', 'holdout', '--output', '/tmp/replay']))
      .toEqual({ surface: 'safe', split: 'holdout', directory: '/tmp/replay' });
  });
});
