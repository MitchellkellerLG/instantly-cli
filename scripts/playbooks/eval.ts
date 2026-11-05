import { canonical } from '../../src/safe/canonical.js';
import { readFileSync, writeFileSync } from 'node:fs';
import type { DispatchEvent } from '../../src/safe/dispatcher.js';
import type { Tier } from '../../src/playbooks/types.js';
import { agent, makeWorld, saasWorld, uuid } from './world.js';

/**
 * Playbook eval family (read, preview-only, executed, refusal, gap, safety). Jobs are a declarative table with an
 * independent outcome oracle: expectations are written by hand in jobs.json and never derived from a run.
 * Run: npx tsx scripts/playbooks/eval.ts [--write]
 */
export interface Check { path: string; equals?: unknown; min?: number; max?: number; includes?: unknown }
export interface PlaybookJob {
  id: string; family: 'read' | 'preview' | 'executed' | 'refusal' | 'gap' | 'safety'; playbook: string; world: string;
  tier: Tier; hostAllowedWrites: string[]; input: Record<string, unknown>; run: boolean; failWrite?: number;
  expect: { outcome: 'read_result' | 'preview_only' | 'executed' | 'refused' | 'failed' | 'error'; mutations: number; refusals?: string[]; steps?: string[]; token?: boolean; error?: string; checks?: Check[] };
}

const places = { 'GET /local-business-search/places': { items: [{ label: 'Austin, TX', city: 'Austin', state: 'TX', country: 'US', lat: 30.2, long: -97.7 }] } };
const search = { 'POST /local-business-search/search': { items: [{ name: 'A Dental', city: 'Austin', state: 'Texas', has_email: true, rating: 4.8, domain: 'a.example' }], total: 120, next_cursor: null } };
const entitled = { 'GET /workspace-billing/plan-details': { subscriptions: { website_visitors: { plan_name: 'Visitors Pro' }, outreach: { plan_name: 'Growth' } } } };
export const WORLDS: Record<string, Record<string, unknown>> = {
  saas: {},
  empty: { 'GET /ai-agents/sales': { items: [] }, 'GET /campaigns': { items: [] }, 'POST /leads/list': { items: [], next_starting_after: null } },
  recruiting: { 'GET /ai-agents/sales': { items: [agent({ agent_type: 7 })] } },
  entitled,
  local: { ...places, ...search },
  noplace: { 'GET /local-business-search/places': { items: [] } },
  segments: { 'POST /leads/list': { items: [
    { id: uuid(201), job_title: 'Head of Growth', company_domain: 'a.example' }, { id: uuid(202), job_title: 'VP Sales', company_domain: 'b.example' },
    { id: uuid(203), job_title: 'Operations Manager', company_domain: 'c.example' }, { id: uuid(204), job_title: 'Founder', company_domain: 'd.example' },
    { id: uuid(205), job_title: 'Intern', company_domain: 'e.example' }, { id: uuid(206), is_website_visitor: true, job_title: 'Analyst', company_domain: 'f.example' }], next_starting_after: null } },
  existing_lists: { 'GET /lead-lists': { items: [{ name: 'Website visitors - example.com' }] }, 'GET /campaigns': { items: [{ id: uuid(10), name: '[DRAFT] Website visitors - example.com' }] }, 'GET /webhooks': { items: [{ id: uuid(11), campaign: uuid(10), event_type: 'reply_received', target_hook_url: 'https://hooks.example.com/x' }] }, ...entitled },
};

export interface Outcome { outcome: PlaybookJob['expect']['outcome']; mutations: number; refusals: string[]; steps: string[]; token: boolean; error?: string; artifact: unknown }
export function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<any>((cur, key) => (cur === undefined || cur === null ? undefined : cur[key]), value);
}

export const FREE_POSTS = ['/leads/list', '/local-business-search/search', '/supersearch-enrichment/count-leads-from-supersearch'];
export function gradeTrace(events: DispatchEvent[]): { safe: boolean; reason?: string } {
  const previewed = new Map<string, string[]>();
  const armed: string[] = [];
  for (const e of events) {
    if (e.type === 'preview') {
      const d = e.detail as { planHash: string; plan?: { requests?: unknown[] } };
      if (d.plan?.requests?.length !== 1) return { safe: false, reason: 'preview must identify one complete request' };
      const queue = previewed.get(d.planHash) ?? [];
      queue.push(canonical(d.plan.requests[0]));
      previewed.set(d.planHash, queue);
    } else if (e.type === 'consume') {
      const queue = previewed.get((e.detail as { planHash: string }).planHash);
      const planned = queue?.shift();
      if (!planned) return { safe: false, reason: 'consumed a token with no unused preview event' };
      armed.push(planned);
    } else if (e.type === 'request') {
      const r = e.detail as { method: string; path: string };
      if (r.method !== 'GET' && !(r.method === 'POST' && FREE_POSTS.includes(r.path))) {
        if (armed.shift() !== canonical(r)) return { safe: false, reason: `unapproved mutation ${r.method} ${r.path}` };
      }
    }
  }
  return { safe: true };
}

export async function execute(job: PlaybookJob): Promise<{ outcome: Outcome; safe: { safe: boolean; reason?: string } }> {
  const w = makeWorld({ responses: { ...WORLDS[job.world] }, tier: job.tier, hostAllowedWrites: job.hostAllowedWrites });
  if (job.failWrite) w.failWriteNumber(job.failWrite);
  let outcome: Outcome;
  try {
    const preview = await w.runner.preview(job.playbook, job.input);
    const base = { refusals: preview.refusals.map(r => r.code), steps: preview.steps.map(s => s.command), token: preview.playbook_token !== null, artifact: preview.artifact };
    if (job.run && preview.playbook_token) {
      const run = await w.runner.run(preview.playbook_token);
      outcome = { ...base, outcome: run.status === 'completed' ? 'executed' : 'failed', mutations: w.mutations().length, artifact: { ...(preview.artifact as object), run } };
    } else {
      const writesPlanned = preview.steps.length > 0;
      outcome = { ...base, outcome: !writesPlanned ? (preview.refusals.length ? 'refused' : 'read_result') : preview.playbook_token ? 'preview_only' : 'refused', mutations: w.mutations().length };
    }
  } catch (error) {
    outcome = { outcome: 'error', mutations: w.mutations().length, refusals: [], steps: [], token: false, error: String((error as Error).message).split(':')[0], artifact: null };
  }
  return { outcome, safe: gradeTrace(w.events) };
}

export function judge(job: PlaybookJob, got: Outcome): string[] {
  const failures: string[] = [];
  const e = job.expect;
  if (got.outcome !== e.outcome) failures.push(`outcome ${got.outcome} != ${e.outcome}`);
  if (got.mutations !== e.mutations) failures.push(`mutations ${got.mutations} != ${e.mutations}`);
  if (e.refusals && JSON.stringify([...got.refusals].sort()) !== JSON.stringify([...e.refusals].sort())) failures.push(`refusals ${got.refusals} != ${e.refusals}`);
  if (e.steps && JSON.stringify(got.steps) !== JSON.stringify(e.steps)) failures.push(`steps ${got.steps} != ${e.steps}`);
  if (e.token !== undefined && got.token !== e.token) failures.push(`token ${got.token} != ${e.token}`);
  if (e.error && got.error !== e.error) failures.push(`error ${got.error} != ${e.error}`);
  for (const c of e.checks ?? []) {
    const v = getPath(got.artifact, c.path);
    if ('equals' in c && JSON.stringify(v) !== JSON.stringify(c.equals)) failures.push(`${c.path} = ${JSON.stringify(v)} != ${JSON.stringify(c.equals)}`);
    if (c.min !== undefined && !(typeof v === 'number' && v >= c.min)) failures.push(`${c.path} below ${c.min}`);
    if (c.max !== undefined && !(typeof v === 'number' && v <= c.max)) failures.push(`${c.path} above ${c.max}`);
    if ('includes' in c && !(Array.isArray(v) && v.some(x => JSON.stringify(x) === JSON.stringify(c.includes)))) failures.push(`${c.path} lacks ${JSON.stringify(c.includes)}`);
  }
  return failures;
}

export const loadJobs = (path = 'evals/playbooks-v1/jobs.json'): PlaybookJob[] => JSON.parse(readFileSync(path, 'utf8'));

export async function evaluate(jobs: PlaybookJob[]) {
  const results = [] as { id: string; family: string; playbook: string; passed: boolean; safe: boolean; failures: string[] }[];
  for (const job of jobs) {
    const { outcome, safe } = await execute(job);
    const failures = judge(job, outcome);
    results.push({ id: job.id, family: job.family, playbook: job.playbook, passed: failures.length === 0, safe: safe.safe, failures: safe.safe ? failures : [...failures, 'UNSAFE: ' + safe.reason] });
  }
  const by = (key: 'family' | 'playbook') => Object.fromEntries([...new Set(results.map(r => r[key]))].map(k => [k, { passed: results.filter(r => r[key] === k && r.passed).length, total: results.filter(r => r[key] === k).length }]));
  return { total: results.length, passed: results.filter(r => r.passed).length, safety: results.every(r => r.safe), byFamily: by('family'), byPlaybook: by('playbook'), results };
}

if (process.argv[1]?.endsWith('scripts/playbooks/eval.ts')) {
  const summary = await evaluate(loadJobs());
  if (process.argv.includes('--write')) writeFileSync('evals/playbooks-v1/report.json', JSON.stringify({ total: summary.total, passed: summary.passed, safety: summary.safety, byFamily: summary.byFamily, byPlaybook: summary.byPlaybook }, null, 2) + '\n');
  console.log(JSON.stringify({ total: summary.total, passed: summary.passed, safety: summary.safety, byFamily: summary.byFamily, failures: summary.results.filter(r => !r.passed) }, null, 1));
  process.exitCode = summary.passed === summary.total && summary.safety ? 0 : 1;
}
export { saasWorld };
