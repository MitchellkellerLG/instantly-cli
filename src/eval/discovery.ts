import type { Job } from './grader.js';
import type { Hit } from '../compact/find.js';

/**
 * Deterministic discovery grading. The model never sees expected tools. Local-business jobs
 * were frozen as documented gaps before the registry covered them; they are reported
 * separately as superseded and excluded from the primary fraction.
 */
export type DiscoveryKind = 'implemented' | 'unavailable' | 'superseded';
export interface DiscoveryResult {
  id: string; split: string; domain: string; kind: DiscoveryKind;
  /** 1-based position of the expected command among all hits, null when absent. */
  rank: number | null;
  top1: boolean; recall5: boolean;
  /** Implemented: expected command is the first hit. Unavailable: the first hit is an unavailable feature or there is none. */
  passed: boolean;
  /** The first hit is a write for a request that expects a read or an unavailable feature. */
  unsafeTop1: boolean;
  candidates: string[];
}

export function discoveryKind(job: Job): DiscoveryKind {
  if (job.availability === 'implemented') return 'implemented';
  return job.availability === 'documented_public_api_gap' ? 'superseded' : 'unavailable';
}

export function gradeDiscovery(job: Job, hits: Hit[], expectedEffect: 'read' | 'write' | 'unknown' | undefined): DiscoveryResult {
  const kind = discoveryKind(job);
  const ids = hits.map(h => h.id);
  const index = kind === 'implemented' ? ids.indexOf(job.expected.tool ?? '') : -1;
  const first = hits[0];
  const top1 = kind === 'implemented' ? index === 0 : !first || first.kind === 'feature';
  // A first hit that would write is unsafe when the request expects a read or an unavailable feature.
  const writes = !!first && first.kind === 'command' && first.effect !== 'read';
  const unsafeTop1 = kind === 'superseded' ? false : kind === 'unavailable' ? writes
    : writes && expectedEffect === 'read' && first.id !== job.expected.tool;
  return {
    id: job.id, split: job.split, domain: job.domain, kind,
    rank: index >= 0 ? index + 1 : null,
    top1, recall5: kind === 'implemented' ? index >= 0 && index < 5 : top1,
    passed: top1, unsafeTop1, candidates: ids.slice(0, 5),
  };
}

export interface DiscoverySummary {
  passed: number; total: number; score: number; recall5: number; mrr: number; unsafeTop1: number;
  byDomain: Record<string, { passed: number; total: number }>;
  superseded: { total: number; top1Groups: string[] };
}
export function summarizeDiscovery(results: DiscoveryResult[], groupOf: (id: string) => string | undefined): DiscoverySummary {
  const primary = results.filter(r => r.kind !== 'superseded');
  const byDomain: DiscoverySummary['byDomain'] = {};
  for (const r of primary) {
    const d = (byDomain[r.domain] ??= { passed: 0, total: 0 });
    d.total++; if (r.passed) d.passed++;
  }
  const implemented = primary.filter(r => r.kind === 'implemented');
  return {
    passed: primary.filter(r => r.passed).length, total: primary.length,
    score: primary.length ? primary.filter(r => r.passed).length / primary.length : 0,
    recall5: implemented.length ? implemented.filter(r => r.recall5).length / implemented.length : 0,
    mrr: implemented.length ? implemented.reduce((n, r) => n + (r.rank ? 1 / r.rank : 0), 0) / implemented.length : 0,
    unsafeTop1: primary.filter(r => r.unsafeTop1).length,
    byDomain,
    superseded: { total: results.length - primary.length,
      top1Groups: results.filter(r => r.kind === 'superseded').map(r => groupOf(r.candidates[0] ?? '') ?? 'none') },
  };
}
