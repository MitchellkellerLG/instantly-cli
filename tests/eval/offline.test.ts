import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FakeTransport, type Fixture } from '../../src/eval/offline.js';
import { digest } from '../../src/safe/canonical.js';
import { grade as score, type Job, type Trace } from '../../src/eval/grader.js';
const jobs: Job[] = readFileSync('evals/v1/jobs.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
const manifest = JSON.parse(readFileSync('evals/v1/fixtures.json', 'utf8'));
const outcomes = JSON.parse(readFileSync('evals/v1/outcomes.json', 'utf8'));
const facts = JSON.parse(readFileSync('evals/v1/facts.json', 'utf8'));
function grade(job: Job, trace: Trace, fixtures: Fixture[], registryHash: string, plans = {}) {
  return score(job, trace, fixtures, registryHash, plans, outcomes);
}
const context = { command: 'campaigns_list', arguments: { limit: 20 }, workspace: jobs[0].fixture.workspace_id };
const fixture: Fixture = { context, position: 0, request: { method: 'GET', path: '/campaigns', query: { limit: 20 } },
  response: { items: [] }, provenance: 'synthetic', captured: '2026-11-03', schemaVersion: 1,
  responseHash: digest({ response: { items: [] } }) };
describe('offline request gate and deterministic trace grading', () => {
  it('refuses unmatched requests and URLs without calling fetch', async () => {
    const transport = new FakeTransport(context, [fixture]);
    await expect(transport.client.get('/unmatched')).rejects.toThrow('UNMATCHED_FIXTURE');
    await expect(transport.client.get('https://api.instantly.ai/campaigns')).rejects.toThrow('EXTERNAL_ROUTE_DENIED');
    await expect(transport.client.get('//other-host/path')).rejects.toThrow('EXTERNAL_ROUTE_DENIED');
    expect(transport.events).toHaveLength(1);
  });
  it('enforces arguments, sequence position, response hashes and pagination', async () => {
    const transport = new FakeTransport(context, [fixture]);
    expect(await transport.client.get('/campaigns', { limit: 20 })).toEqual({ items: [] });
    transport.assertComplete();
    await expect(transport.client.get('/campaigns', { limit: 20 })).rejects.toThrow('UNMATCHED_FIXTURE');
    const corrupted = new FakeTransport(context, [{ ...fixture, response: { changed: true } }]);
    await expect(corrupted.client.request(fixture.request)).rejects.toThrow('FIXTURE_HASH_MISMATCH');
    const changedArgs = new FakeTransport({ ...context, arguments: { limit: 100 } }, [fixture]);
    await expect(changedArgs.client.request(fixture.request)).rejects.toThrow('UNMATCHED_FIXTURE');
    const pages = [fixture, { ...fixture, position: 1, request: { ...fixture.request, query: { limit: 20, starting_after: 'cursor' } } }];
    const paginated = new FakeTransport(context, pages);
    await paginated.client.request(pages[0].request);
    expect(() => paginated.assertComplete()).toThrow('INCOMPLETE_FIXTURE_SEQUENCE');
    await paginated.client.request(pages[1].request);
    paginated.assertComplete();
  });
  it.each(['AUTH_EXPIRED', 'ENTITLEMENT_DENIED', 'RATE_LIMIT_429', 'MALFORMED_PAYLOAD'])(
    'replays %s once without falling through to a live transport', async error => {
      const entry = { ...fixture, response: undefined, error, responseHash: digest({ error }) };
      const transport = new FakeTransport(context, [entry]);
      await expect(transport.client.request(fixture.request)).rejects.toThrow(error);
      expect(transport.events).toHaveLength(1);
    },
  );
  function goodTrace(): Trace {
    const status = manifest.fixtures.find((f: Fixture) => f.context.command === 'status');
    const read = manifest.fixtures.filter((f: Fixture) => f.context.command === context.command);
    return { version: 1, id: jobs[0].id, surface: 'legacy', provenance: 'synthetic', driver: 'test',
      registryHash: facts.registrySourceHash, fixtureHash: digest(manifest.fixtures), oracleHash: digest(outcomes),
      identity: { profile: 'sandbox', workspace: context.workspace, verified: true },
      identityRequests: [{ request: status.request, matched: true, responseHash: status.responseHash }],
      invocations: [{ command: 'status', arguments: {} }, { command: context.command, arguments: context.arguments }],
      requests: read.map((f: Fixture) => ({ request: f.request, matched: true })), previews: [],
      result: read[0].response, outcome: 'read_result', elapsedMs: 0, modelTokens: null, discoveryCandidates: [] };
  }
  it('passes a verified read and rejects operation, argument, scope, wire and safety regressions', () => {
    const good = goodTrace();
    expect(grade(jobs[0], good, manifest.fixtures, facts.registrySourceHash).passed).toBe(true);
    const changes = [
      (t: Trace) => { t.invocations[1].command = 'campaigns_delete'; },
      (t: Trace) => { t.invocations[1].arguments = { limit: 100 }; },
      (t: Trace) => { t.identity.verified = false; },
      (t: Trace) => { t.result = { wrong: true }; },
      (t: Trace) => { delete t.result; },
      (t: Trace) => { t.identityRequests = []; },
      (t: Trace) => { t.requests = []; },
      (t: Trace) => { t.requests.push({ request: { method: 'POST', path: '/emails/reply' }, matched: true }); },
      (t: Trace) => { t.requests[0].matched = false; },
    ];
    for (const change of changes) {
      const trace = structuredClone(good); change(trace);
      expect(grade(jobs[0], trace, manifest.fixtures, facts.registrySourceHash).passed).toBe(false);
    }
  });
  it('rejects textual preview claims with no server event and guessed gap requests', () => {
    const previewJob = jobs.find(j => j.expected.outcome === 'preview_only')!;
    const trace = goodTrace();
    trace.id = previewJob.id;
    trace.invocations[1] = { command: previewJob.expected.tool!, arguments: previewJob.expected.key_arguments };
    trace.outcome = 'preview_only'; trace.explanation = 'I previewed this'; trace.requests = [];
    expect(grade(previewJob, trace, manifest.fixtures, facts.registrySourceHash, manifest.plans).failures).toContain('server_preview');
    const gapJob = jobs.find(j => j.availability !== 'implemented')!;
    trace.id = gapJob.id; trace.outcome = 'unsupported_with_explanation';
    trace.requests = [{ request: { method: 'GET', path: '/guessed-gap' }, matched: false }];
    const result = grade(gapJob, trace, manifest.fixtures, facts.registrySourceHash);
    expect(result.passed).toBe(false); expect(result.safety).toBe(false);
  });
});
