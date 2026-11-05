import { allCommands } from '../commands/index.js';
import { Finder } from '../compact/find.js';
import { buildCatalog, contextRevision, type Context } from '../compact/catalog.js';
import { digest } from '../safe/canonical.js';
import { effectPolicy } from '../safe/policy.js';
import { gradeDiscovery, summarizeDiscovery, type DiscoveryResult, type DiscoverySummary } from './discovery.js';
import type { Job } from './grader.js';

export const MAX_MUTATIONS = 10;
/** Surfaces the writer may change. Executable schemas, policy, handlers, corpus and graders are out of reach. */
const WRITABLE_ROOTS = ['aliases', 'groupAliases', 'synonyms', 'features', 'tools', 'instructions'] as const;
const MAX_ALIASES_PER_COMMAND = 4;

export interface Mutation {
  id: string;
  kind: 'add-alias' | 'add-group-alias' | 'add-synonym' | 'feature-keywords' | 'subtract' | 'structural';
  hypothesis: string;
  /** Train job IDs whose observed failure this one conceptual change addresses. */
  addresses: string[];
  /** Dotted path to full replacement value. null deletes the key. */
  set: Record<string, unknown>;
}

export function applyMutation(context: Context, mutation: Mutation): Context {
  const next = structuredClone(context) as Record<string, any>;
  for (const [path, value] of Object.entries(mutation.set)) {
    const keys = path.split('.');
    if (!WRITABLE_ROOTS.includes(keys[0] as (typeof WRITABLE_ROOTS)[number])) throw new Error(`MUTATION_PATH_DENIED: ${path}`);
    let node = next;
    for (const key of keys.slice(0, -1)) {
      if (!node[key] || typeof node[key] !== 'object') throw new Error(`MUTATION_PATH_MISSING: ${path}`);
      node = node[key];
    }
    const leaf = keys[keys.length - 1];
    if (value === null) delete node[leaf]; else node[leaf] = value;
  }
  return next as Context;
}

/** Deterministic integrity gate, independent of scores. */
export function integrityProblems(context: Context): string[] {
  const problems: string[] = [];
  const ids = new Set(buildCatalog(allCommands).map(c => c.id));
  for (const [id, phrases] of Object.entries(context.aliases)) {
    if (!ids.has(id)) problems.push(`alias target is not a registry command: ${id}`);
    if (phrases.length > MAX_ALIASES_PER_COMMAND) problems.push(`more than ${MAX_ALIASES_PER_COMMAND} aliases for ${id}`);
  }
  const text = JSON.stringify([context.aliases, context.groupAliases, context.synonyms, context.features, context.tools, context.instructions]);
  if (/instantly-\d{3}/.test(text)) problems.push('test job ID in context');
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) problems.push('fixture identifier in context');
  for (const f of context.features) if (ids.has(f.id)) problems.push(`feature collides with command: ${f.id}`);
  for (const tool of ['find', 'describe', 'preview', 'run'] as const) if (!context.tools[tool]) problems.push(`missing tool description: ${tool}`);
  return problems;
}

export interface Scored {
  summary: DiscoverySummary;
  results: DiscoveryResult[];
  meanFindMs: number;
}
export function scoreContext(context: Context, jobs: Job[]): Scored {
  const finder = new Finder(context);
  const group = (id: string) => finder.catalog.find(c => c.id === id)?.group;
  const started = performance.now();
  const results = jobs.map(job => {
    const command = allCommands.find(c => c.name === job.expected.tool);
    return gradeDiscovery(job, finder.find(job.request, 5).hits, command ? effectPolicy(command).effect : undefined);
  });
  return { summary: summarizeDiscovery(results, group), results, meanFindMs: (performance.now() - started) / Math.max(jobs.length, 1) };
}

export interface Round {
  round: number;
  mutation: Mutation | null;
  decision: 'baseline' | 'accepted' | 'rejected';
  reason: string;
  train: { passed: number; total: number; recall5: number; unsafeTop1: number };
  validation: { passed: number; total: number; recall5: number; unsafeTop1: number; byDomain: Record<string, { passed: number; total: number }> };
  contextTokens: number;
  contextHash: string;
  championHash: string;
  meanFindMs: number;
}

export const contextTokens = (c: Context): number =>
  Object.values(c.tools).concat(c.instructions).join(' ').split(/\s+/).length +
  Object.values(c.aliases).flat().join(' ').split(/\s+/).length + c.features.reduce((n, f) => n + f.keywords.length, 0);

const brief = (s: DiscoverySummary) => ({ passed: s.passed, total: s.total, recall5: s.recall5, unsafeTop1: s.unsafeTop1 });

/**
 * Gain-only decision. A candidate replaces the champion only if validation strictly improves,
 * unsafe first hits do not increase, and no case that was safe before becomes unsafe.
 */
export function evaluateRound(round: number, champion: Context, mutation: Mutation, train: Job[], validation: Job[]): { round: Round; candidate: Context } {
  const candidate = applyMutation(champion, mutation);
  const problems = integrityProblems(candidate);
  const before = { train: scoreContext(champion, train), validation: scoreContext(champion, validation) };
  const after = { train: scoreContext(candidate, train), validation: scoreContext(candidate, validation) };
  const unsafeNow = (s: Scored) => new Set(s.results.filter(r => r.unsafeTop1).map(r => r.id));
  const regress = (a: Scored, b: Scored) => [...unsafeNow(b)].filter(id => !unsafeNow(a).has(id)).length;
  let decision: Round['decision'] = 'accepted';
  let reason = `validation ${before.validation.summary.passed}/${before.validation.summary.total} -> ${after.validation.summary.passed}/${after.validation.summary.total}`;
  if (problems.length) { decision = 'rejected'; reason = 'integrity: ' + problems.join('; '); }
  else if (regress(before.train, after.train) + regress(before.validation, after.validation) > 0 ||
      after.train.summary.unsafeTop1 + after.validation.summary.unsafeTop1 > before.train.summary.unsafeTop1 + before.validation.summary.unsafeTop1) {
    decision = 'rejected'; reason = 'safety gate: a first hit became an unsafe write';
  } else if (after.validation.summary.passed <= before.validation.summary.passed) {
    decision = 'rejected'; reason = `no strict validation gain (${reason})`;
  }
  const kept = decision === 'accepted' ? candidate : champion;
  return {
    candidate: kept,
    round: {
      round, mutation, decision, reason,
      train: brief(after.train.summary),
      validation: { ...brief(after.validation.summary), byDomain: after.validation.summary.byDomain },
      contextTokens: contextTokens(candidate), contextHash: contextRevision(candidate), championHash: contextRevision(kept),
      meanFindMs: Math.round((after.train.meanFindMs + after.validation.meanFindMs) * 500) / 1000,
    },
  };
}

export function baselineRound(context: Context, train: Job[], validation: Job[]): Round {
  const t = scoreContext(context, train); const v = scoreContext(context, validation);
  return { round: 0, mutation: null, decision: 'baseline', reason: 'v001 context and frozen find engine',
    train: brief(t.summary), validation: { ...brief(v.summary), byDomain: v.summary.byDomain },
    contextTokens: contextTokens(context), contextHash: contextRevision(context), championHash: contextRevision(context),
    meanFindMs: Math.round((t.meanFindMs + v.meanFindMs) * 500) / 1000 };
}

export interface Graduation {
  graduated: boolean;
  criteria: { noUnsafe: boolean; passFractionAtLeast90: boolean; withinTenPointsOfValidation: boolean; noRegressionVsBaseline: boolean };
  baseline: { holdout: DiscoverySummary; validationScore: number };
  champion: { holdout: DiscoverySummary; validationScore: number; contextHash: string };
  results: { baseline: DiscoveryResult[]; champion: DiscoveryResult[] };
  digest: string;
}
export function graduate(base: Context, champion: Context, validation: Job[], holdout: Job[]): Graduation {
  const b = scoreContext(base, holdout); const c = scoreContext(champion, holdout);
  const vb = scoreContext(base, validation).summary.score; const vc = scoreContext(champion, validation).summary.score;
  const criteria = {
    noUnsafe: c.summary.unsafeTop1 === 0,
    passFractionAtLeast90: c.summary.score >= 0.9,
    withinTenPointsOfValidation: c.summary.score >= vc - 0.1,
    noRegressionVsBaseline: c.summary.passed >= b.summary.passed && c.results.every(r => r.passed || !b.results.find(x => x.id === r.id)?.passed),
  };
  const out = { graduated: Object.values(criteria).every(Boolean), criteria,
    baseline: { holdout: b.summary, validationScore: vb }, champion: { holdout: c.summary, validationScore: vc, contextHash: contextRevision(champion) },
    results: { baseline: b.results, champion: c.results } };
  return { ...out, digest: digest(out) };
}
