import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allCommands } from '../../src/commands/index.js';
import { SafeDispatcher, validateArguments } from '../../src/safe/dispatcher.js';
import { MemoryPreviewStore } from '../../src/safe/preview-store.js';
import { digest, clone } from '../../src/safe/canonical.js';
import { FakeTransport } from '../../src/eval/offline.js';
import { grade, type Trace, type Job } from '../../src/eval/grader.js';
import { replayOptions } from './options.js';
import { CompactSurface, type CompactHost } from '../../src/compact/surface.js';
import { Finder } from '../../src/compact/find.js';
import { gradeDiscovery, summarizeDiscovery } from '../../src/eval/discovery.js';
import { effectPolicy } from '../../src/safe/policy.js';

// The executable is offline-only, including accidental real-client/fetch imports.
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('OFFLINE_EGRESS_DENIED'); }) as typeof fetch;
try {
  const { surface, split, directory } = replayOptions(process.argv.slice(2));
  const jobs: Job[] = readFileSync('evals/v1/jobs.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const manifest = JSON.parse(readFileSync('evals/v1/fixtures.json', 'utf8'));
  const outcomes = JSON.parse(readFileSync('evals/v1/outcomes.json', 'utf8'));
  const facts = JSON.parse(readFileSync('evals/v1/facts.json', 'utf8'));
  const traces: Trace[] = [];
  for (const job of jobs.filter(j => split === 'all' || j.split === split)) {
    const started = performance.now();
    const identity = { profile: job.fixture.profile, workspace: job.fixture.workspace_id,
      workspaceName: 'Synthetic sandbox', credentialRef: 'synthetic-key-reference' };
    const trace: Trace = { version: 1, id: job.id, surface, provenance: 'synthetic',
      driver: 'scripted-oracle-replay-v1 (no model)', registryHash: facts.registrySourceHash,
      fixtureHash: digest(manifest.fixtures), oracleHash: digest(outcomes), identity: { ...identity, verified: false }, identityRequests: [],
      invocations: [{ command: 'status', arguments: {} }], requests: [], previews: [], outcome: '',
      elapsedMs: 0, modelTokens: null, discoveryCandidates: [] };
    const transport = new FakeTransport({ command: job.expected.tool ?? 'unsupported',
      arguments: job.expected.key_arguments, workspace: job.fixture.workspace_id }, manifest.fixtures);
    const verifyIdentity = async () => {
      const statusTransport = new FakeTransport({ command: 'status', arguments: {}, workspace: identity.workspace }, manifest.fixtures);
      const response = await statusTransport.client.get<{ id: string; name: string }>('/workspaces/current');
      statusTransport.assertComplete();
      trace.identityRequests.push(...statusTransport.events.map(event => ({ ...event, responseHash: digest({ response }) })));
      if (response.id !== identity.workspace) throw new Error('WORKSPACE_MISMATCH');
      trace.identity.verified = true;
      return { ...identity, workspace: response.id, workspaceName: response.name };
    };
    if (surface !== 'compact') await verifyIdentity();
    const store = new MemoryPreviewStore();
    const makeDispatcher = (count: () => void = () => {}) => new SafeDispatcher({ commands: allCommands, bound: identity, identity: verifyIdentity,
      client: transport.client, store, registryRevision: facts.registrySourceHash,
      contextRevision: 'offline-v1', prerequisiteAllowed: (id, request) =>
        ['email_reply', 'email_forward'].includes(id) && request.method === 'GET' &&
        request.path === '/emails/22222222-2222-4222-8222-222222222222',
      event: event => {
        if (event.type === 'request') count();
        if (event.type === 'preview') {
          const detail = event.detail as any;
          trace.previews.push({ command: event.command!, planHash: detail.planHash, requests: detail.plan.requests, plan: detail.plan });
        }
      },
    });
    const dispatcher = makeDispatcher();
    if (surface === 'compact') {
      // Scripted oracle selection through exactly the four tools. Discovery quality is graded separately below.
      const host: CompactHost = { dispatcher: async count => makeDispatcher(count),
        allowedWrites: [], allowUnknownCost: false,
        status: async scope => {
          const live = await verifyIdentity();
          return { authenticated: true, profile: identity.profile, workspace_id: live.workspace, workspace_name: live.workspaceName,
            matches_expected: scope.profile === identity.profile && scope.workspace === live.workspace };
        },
        health: async () => { throw new Error('NOT_IN_CORPUS'); } };
      const tools = new CompactSurface(new Finder(), () => host);
      const call = async (tool: string, result: any) => { trace.toolCalls!.push({ tool, ...(result?.error ? { error: result.error.code } : {}) }); return result; };
      trace.toolCalls = [];
      const found: any = await call('instantly_find', tools.find({ intent: job.request, limit: 5 }));
      trace.discoveryCandidates = (found.hits ?? []).map((h: any) => h.id);
      await call('instantly_run', await tools.run({ mode: 'read', command_id: 'status', arguments: {}, profile: identity.profile, workspace_id: identity.workspace }));
      if (job.availability !== 'implemented') {
        trace.outcome = 'unsupported_with_explanation';
        trace.explanation = `This requested ${job.domain} capability is an unimplemented gap in the frozen registry. No endpoint was guessed.`;
      } else {
        trace.invocations.push({ command: job.expected.tool!, arguments: clone(job.expected.key_arguments) });
        await call('instantly_describe', tools.describe({ command_id: job.expected.tool! }));
        const scope = { profile: identity.profile, workspace_id: job.fixture.provided_workspace_id ?? identity.workspace };
        let result: any;
        if (job.scenario === 'unpreviewed_write') result = await call('instantly_run', await tools.run({ mode: 'write', ...scope }));
        else if (job.scenario === 'wrong_workspace' || job.access === 'write') {
          result = await call('instantly_preview', await tools.preview({ command_id: job.expected.tool, arguments: job.expected.key_arguments, ...scope }));
        } else result = await call('instantly_run', await tools.run({ mode: 'read', command_id: job.expected.tool, arguments: job.expected.key_arguments, ...scope }));
        if (result.error) {
          trace.refusal = result.error.code;
          trace.outcome = trace.refusal === 'MISSING_PREVIEW' ? 'missing_preview_rejected' :
            trace.refusal === 'WORKSPACE_MISMATCH' ? 'workspace_mismatch_rejected' : 'refused';
        } else if (job.access === 'write') trace.outcome = 'preview_only';
        else { trace.result = result.result; transport.assertComplete(); trace.outcome = 'read_result'; }
      }
    } else if (job.availability !== 'implemented') {
      trace.outcome = 'unsupported_with_explanation';
      trace.explanation = `This requested ${job.domain} capability is an unimplemented gap in the frozen registry. No endpoint was guessed.`;
    } else {
      trace.invocations.push({ command: job.expected.tool!, arguments: clone(job.expected.key_arguments) });
      const command = allCommands.find(c => c.name === job.expected.tool)!;
      const scope = { profile: identity.profile, workspace: job.fixture.provided_workspace_id ?? identity.workspace };
      try {
        if (job.scenario === 'unpreviewed_write') {
          await dispatcher.write('', scope);
        } else if (job.scenario === 'wrong_workspace') {
          await dispatcher.preview(command.name, job.expected.key_arguments, scope);
        } else if (job.access === 'write') {
          if (surface === 'legacy') throw new Error('LEGACY_PREVIEW_UNAVAILABLE');
          await dispatcher.preview(command.name, job.expected.key_arguments, scope);
          trace.outcome = 'preview_only';
        } else {
          trace.result = surface === 'legacy'
            ? await command.handler(validateArguments(command, job.expected.key_arguments), transport.client)
            : await dispatcher.read(command.name, job.expected.key_arguments, scope);
          transport.assertComplete();
          trace.outcome = 'read_result';
        }
      } catch (error) {
        trace.refusal = (error as Error).message;
        trace.outcome = trace.refusal === 'MISSING_PREVIEW' ? 'missing_preview_rejected' :
          trace.refusal === 'WORKSPACE_MISMATCH' ? 'workspace_mismatch_rejected' : 'refused';
      }
    }
    trace.requests = transport.events;
    trace.elapsedMs = performance.now() - started;
    traces.push(trace);
  }
  const results = traces.map(t => grade(jobs.find(j => j.id === t.id)!, t, manifest.fixtures, facts.registrySourceHash, manifest.plans, outcomes));
  const groups = (key: 'domain' | 'split' | 'implemented') => Object.fromEntries([...new Set(results.map(r => String(r[key])))].map(k => {
    const rows = results.filter(r => String(r[key]) === k);
    return [k, { passed: rows.filter(r => r.passed).length, total: rows.length }];
  }));
  const summary = { surface, driver: 'scripted oracle replay; no model or discovery measurement', provenance: 'synthetic',
    passed: results.filter(r => r.passed).length, total: results.length,
    score: results.filter(r => r.passed).length / results.length,
    safety: results.filter(r => r.safety).length / results.length,
    byDomain: groups('domain'), bySplit: groups('split'), byImplemented: groups('implemented'),
    components: Object.fromEntries(['envelope', 'identity', 'identity_transport', 'operation', 'arguments', 'outcome', 'read_result', 'wire', 'server_preview', 'unsupported', 'refusal', 'safety'].map(component =>
      [component, { passed: results.filter(r => !r.failures.includes(component)).length, total: results.length }])),
    modelTokens: null, discoveryRecallAt5: null as number | null, discovery: undefined as unknown,
    toolCalls: traces.reduce((n, t) => n + (t.surface === 'compact' ? t.toolCalls!.length : t.invocations.length), 0),
    requestCalls: traces.reduce((n, t) => n + t.requests.length + t.identityRequests.length, 0),
    elapsedMs: traces.reduce((n, t) => n + t.elapsedMs, 0), registryHash: facts.registrySourceHash, fixtureHash: digest(manifest.fixtures), oracleHash: digest(outcomes) };
  if (surface === 'compact') {
    const finder = new Finder();
    const graded = traces.map(t => { const job = jobs.find(j => j.id === t.id)!;
      const command = allCommands.find(c => c.name === job.expected.tool);
      return gradeDiscovery(job, finder.find(job.request, 5).hits, command ? effectPolicy(command).effect : undefined); });
    const groupOf = (id: string) => finder.catalog.find(c => c.id === id)?.group;
    const discovery = summarizeDiscovery(graded, groupOf);
    summary.discoveryRecallAt5 = discovery.recall5;
    summary.discovery = { ...discovery, driver: 'deterministic find over job.request; expected tools hidden' };
    summary.driver = 'scripted oracle selection through the four compact tools; discovery graded separately; no model';
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${surface}-traces.jsonl`), traces.map(t => JSON.stringify(t)).join('\n') + '\n');
  writeFileSync(join(directory, `${surface}-results.json`), JSON.stringify({ summary, results }, null, 2) + '\n');
  console.log(JSON.stringify(summary));
  const unexpectedFailures = results.filter(r => !r.passed && surface !== 'legacy' && !Object.hasOwn(manifest.preparationErrors, r.id));
  if (summary.safety !== 1 || unexpectedFailures.length) process.exitCode = 1;
} finally { globalThis.fetch = originalFetch; }
