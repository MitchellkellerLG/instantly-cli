import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DispatchEvent } from '../../src/safe/dispatcher.js';
import { allPlaybooks } from '../../src/playbooks/registry.js';
import { evaluate, execute, gradeTrace, judge, loadJobs } from '../../scripts/playbooks/eval.js';

const jobs = loadJobs();
const ev = (type: DispatchEvent['type'], detail: unknown): DispatchEvent => ({ type, detail });

describe('playbook eval family', () => {
  it('has a job family per playbook: every playbook has reads or previews, a refusal and a governed write path', () => {
    for (const p of allPlaybooks) {
      const mine = jobs.filter(j => j.playbook === p.slug);
      expect(mine.length, p.slug).toBeGreaterThanOrEqual(4);
      expect(mine.some(j => ['read', 'preview', 'gap'].includes(j.family)), p.slug).toBe(true);
      expect(mine.some(j => j.family === 'refusal'), p.slug).toBe(true);
    }
    for (const family of ['read', 'preview', 'executed', 'refusal', 'gap', 'safety']) expect(jobs.some(j => j.family === family), family).toBe(true);
    expect(new Set(jobs.map(j => j.id)).size).toBe(jobs.length);
  });
  it('every job passes its independent oracle with a 100 percent safety score', async () => {
    const summary = await evaluate(jobs);
    expect(summary.results.filter(r => !r.passed)).toEqual([]);
    expect(summary.passed).toBe(summary.total);
    expect(summary.safety).toBe(true);
  }, 60_000);
  it('the committed report matches a fresh run', async () => {
    const fresh = await evaluate(jobs);
    const report = JSON.parse(readFileSync('evals/playbooks-v1/report.json', 'utf8'));
    expect(report).toEqual({ total: fresh.total, passed: fresh.passed, safety: fresh.safety, byFamily: fresh.byFamily, byPlaybook: fresh.byPlaybook });
  }, 60_000);
  it('job expectations use the supported outcome contract', () => {
    for (const j of jobs) {
      expect(Object.keys(j.expect).sort().every(k => ['outcome', 'mutations', 'refusals', 'steps', 'token', 'error', 'checks'].includes(k)), j.id).toBe(true);
    }
  });
  it('the judge fails a wrong outcome, extra mutations and a missing refusal (mutation test of the oracle)', async () => {
    const job = jobs.find(j => j.id === 'ci-06')!;
    const { outcome } = await execute(job);
    expect(judge(job, outcome)).toEqual([]);
    expect(judge({ ...job, expect: { ...job.expect, mutations: 1 } }, outcome)).toContain('mutations 2 != 1');
    expect(judge({ ...job, expect: { ...job.expect, outcome: 'preview_only' } }, outcome).length).toBeGreaterThan(0);
    expect(judge({ ...job, expect: { ...job.expect, refusals: ['NOT_ENTITLED'] } }, outcome).length).toBeGreaterThan(0);
  });
});

describe('trace grader (a write needs a matching preview event)', () => {
  const plan = 'p'.repeat(64);
  const post = { method: 'POST', path: '/campaigns' };
  it('accepts preview, consume, one request', () => {
    expect(gradeTrace([ev('preview', { planHash: plan, plan: { requests: [post] } }), ev('consume', { planHash: plan }), ev('request', post)])).toEqual({ safe: true });
  });
  it('rejects a mutation with no consumed token', () => {
    expect(gradeTrace([ev('request', post)]).safe).toBe(false);
  });
  it('rejects a consumed token that was never previewed', () => {
    expect(gradeTrace([ev('consume', { planHash: plan }), ev('request', post)]).safe).toBe(false);
  });
  it('rejects a consumed token for one request used to send another (substitution)', () => {
    const planned = { planHash: plan, plan: { requests: [{ method: 'POST', path: '/lead-lists' }] } };
    expect(gradeTrace([ev('preview', planned), ev('consume', { planHash: plan }), ev('request', { method: 'POST', path: '/lead-lists' })]).safe).toBe(true);
    expect(gradeTrace([ev('preview', planned), ev('consume', { planHash: plan }), ev('request', { method: 'POST', path: '/campaigns' })]).safe).toBe(false);
  });
  it('rejects a second mutation under one consumed token', () => {
    expect(gradeTrace([ev('preview', { planHash: plan, plan: { requests: [post] } }), ev('consume', { planHash: plan }), ev('request', post), ev('request', post)]).safe).toBe(false);
  });
  it('rejects reuse of one preview across two consume/request pairs', () => {
    expect(gradeTrace([ev('preview', { planHash: plan, plan: { requests: [post] } }), ev('consume', { planHash: plan }), ev('request', post), ev('consume', { planHash: plan }), ev('request', post)]).safe).toBe(false);
  });
  it.each(['body', 'query'])('rejects changed %s at the same endpoint', field => {
    const request = { ...post, [field]: { value: 'approved' } };
    const trace = [ev('preview', { planHash: plan, plan: { requests: [request] } }), ev('consume', { planHash: plan })];
    expect(gradeTrace([...trace, ev('request', { ...request, [field]: { value: 'changed' } })]).safe).toBe(false);
    expect(gradeTrace([...trace, ev('request', request)]).safe).toBe(true);
  });
  it('lets reads and free POST searches through without a token', () => {
    expect(gradeTrace([ev('request', { method: 'GET', path: '/campaigns' }), ev('request', { method: 'POST', path: '/leads/list' })]).safe).toBe(true);
  });
});
