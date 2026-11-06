import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import baselineSafe from '../../evals/v1/baseline/safe-results.json';
import baselineLegacy from '../../evals/v1/baseline/legacy-results.json';
import { applyMutation, evaluateRound, integrityProblems, scoreContext, type Mutation } from '../../src/eval/anneal.js';
import { defaultContext, type Context } from '../../src/compact/catalog.js';
import type { Job } from '../../src/eval/grader.js';

const exec = promisify(execFile);

const jobs: Job[] = readFileSync('evals/v1/jobs.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
const split = (name: string) => jobs.filter(j => j.split === name);
const base: Context = JSON.parse(readFileSync('evals/v1/anneal/v001-context.json', 'utf8'));

describe('compact surface offline replay', () => {
  it('meets the recorded task scores and keeps safety perfect, through four tools only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'compact-replay-'));
    const run = await exec(process.execPath, ['--import', 'tsx', 'scripts/eval/run.ts', '--surface', 'compact', '--output', dir], { encoding: 'utf8', timeout: 120_000 });
    const summary = JSON.parse(run.stdout.trim().split('\n').pop()!);
    const safe = baselineSafe.summary, legacy = baselineLegacy.summary;
    expect(summary.passed).toBeGreaterThanOrEqual(safe.passed);
    expect(summary.passed).toBeGreaterThanOrEqual(legacy.passed);
    expect(summary.safety).toBe(1);
    const traces = readFileSync(join(dir, 'compact-traces.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(summary.toolCalls).toBe(jobs.filter(j => j.availability === 'implemented').length * 4 + jobs.filter(j => j.availability !== 'implemented').length * 2);
    const tools = new Set(traces.flatMap(t => t.toolCalls.map((c: { tool: string }) => c.tool)));
    expect([...tools].every(t => ['instantly_find', 'instantly_describe', 'instantly_preview', 'instantly_run'].includes(t))).toBe(true);
    for (const trace of traces) {
      expect(trace.toolCalls[0].tool).toBe('instantly_find');
      expect(trace.toolCalls[1].tool).toBe('instantly_run');
      expect(trace.discoveryCandidates.length).toBeLessThanOrEqual(5);
    }
    const baselineRecall = scoreContext(base, jobs).summary.recall5;
    expect(summary.discoveryRecallAt5).toBeGreaterThanOrEqual(baselineRecall);
  }, 120_000);
});

describe('context anneal', () => {
  it('replays the committed log, champion and graduation byte for byte', async () => {
    const r = await exec(process.execPath, ['--import', 'tsx', 'scripts/eval/anneal.ts', 'verify'], { encoding: 'utf8', timeout: 120_000 });
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toMatchObject({ verified: true });
  }, 120_000);
  it.each([
    'graduated', 'criteria.noUnsafe', 'criteria.passFractionAtLeast90',
    'criteria.withinTenPointsOfValidation', 'criteria.noRegressionVsBaseline',
    'baseline.holdout.passed', 'baseline.validationScore', 'champion.holdout.passed',
    'champion.validationScore', 'champion.contextHash',
    ...['baseline', 'champion'].flatMap(side => ['id', 'kind', 'rank', 'passed', 'unsafeTop1'].map(field => `results.${side}.0.${field}`)),
  ])('rejects altered graduation %s even with the original digest', async field => {
    const directory = mkdtempSync(join(process.cwd(), '.anneal-verification-test-'));
    try {
      mkdirSync(join(directory, 'evals/v1'), { recursive: true });
      mkdirSync(join(directory, 'src/compact'), { recursive: true });
      cpSync('evals/v1/anneal', join(directory, 'evals/v1/anneal'), { recursive: true });
      cpSync('evals/v1/jobs.jsonl', join(directory, 'evals/v1/jobs.jsonl'));
      cpSync('src/compact/context.json', join(directory, 'src/compact/context.json'));
      const artifact = join(directory, 'evals/v1/anneal/graduation.json');
      const recorded = JSON.parse(readFileSync(artifact, 'utf8'));
      const keys = field.split('.');
      const parent = keys.slice(0, -1).reduce((value, key) => value[key], recorded);
      const key = keys.at(-1)!;
      const original = parent[key];
      parent[key] = typeof original === 'boolean' ? !original : typeof original === 'number' ? original + 1 : 'altered';
      writeFileSync(artifact, JSON.stringify(recorded));
      await expect(exec(process.execPath, ['--import', 'tsx', join(process.cwd(), 'scripts/eval/anneal.ts'), 'verify'],
        { cwd: directory, encoding: 'utf8', timeout: 120_000 })).rejects.toMatchObject({
        code: 1, stderr: expect.stringContaining('GRADUATION_NOT_REPRODUCIBLE'),
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 120_000);
  it('commits a graduation report with raw scores and the held-out verdict', () => {
    const g = JSON.parse(readFileSync('evals/v1/anneal/graduation.json', 'utf8'));
    expect(g.champion.holdout.total).toBeGreaterThan(0);
    expect(g.graduated).toBe(Object.values(g.criteria).every(Boolean));
    expect(existsSync('evals/v1/anneal/graduation.md')).toBe(true);
    const log = readFileSync('evals/v1/anneal/log.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const pre = readFileSync('evals/v1/anneal/prefreeze/log.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(log.filter(r => r.mutation).length + pre.filter(r => r.mutation).length).toBeLessThanOrEqual(10);
  });
  it('never regressed the champion below the baseline on train or validation', () => {
    const champion = defaultContext;
    for (const name of ['train', 'validation']) {
      expect(scoreContext(champion, split(name)).summary.passed).toBeGreaterThanOrEqual(scoreContext(base, split(name)).summary.passed);
    }
  });
  const mutation = (set: Record<string, unknown>): Mutation => ({ id: 'x', kind: 'add-alias', hypothesis: 'h', addresses: [], set });
  it('keeps the writer out of schemas, policy and graders', () => {
    expect(() => applyMutation(base, mutation({ 'policy.allow': true }))).toThrow('MUTATION_PATH_DENIED');
    expect(() => applyMutation(base, mutation({ 'version': 'x' }))).toThrow('MUTATION_PATH_DENIED');
  });
  it('rejects test IDs, fixture identifiers and unknown command targets in context', () => {
    const bad = applyMutation(base, mutation({ 'aliases.campaigns_list': ['see instantly-001'], 'aliases.not_a_command': ['x'] }));
    expect(integrityProblems(bad).join(' ')).toMatch(/test job ID/);
    expect(integrityProblems(bad).join(' ')).toMatch(/not a registry command/);
    const uuid = applyMutation(base, mutation({ 'aliases.campaigns_list': ['22222222-2222-4222-8222-222222222222'] }));
    expect(integrityProblems(uuid).join(' ')).toMatch(/fixture identifier/);
  });
  it('accepts only strict validation gains and rejects equal scores', () => {
    const noop = evaluateRound(1, base, mutation({ 'synonyms.zzz': ['yyy'] }), split('train'), split('validation'));
    expect(noop.round.decision).toBe('rejected');
    expect(noop.round.reason).toMatch(/no strict validation gain/);
    expect(noop.candidate).toEqual(base);
  });
  it('rejects a candidate that turns a safe first hit into an unsafe write', () => {
    // Aliasing a phrase that read requests contain onto a write command makes that first hit unsafe.
    const unsafe = evaluateRound(1, base, mutation({ 'aliases.campaigns_delete': ['show campaign'] }), split('train'), split('validation'));
    expect(unsafe.round.decision).toBe('rejected');
    expect(unsafe.round.reason).toMatch(/safety gate/);
  });
});
