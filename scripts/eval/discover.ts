import { readFileSync } from 'node:fs';
import { allCommands } from '../../src/commands/index.js';
import { Finder } from '../../src/compact/find.js';
import { gradeDiscovery, summarizeDiscovery } from '../../src/eval/discovery.js';
import { effectPolicy } from '../../src/safe/policy.js';
import type { Job } from '../../src/eval/grader.js';

/** Writer-visible discovery report. Validation prints aggregate only; holdout is never printed here. */
const split = process.argv[2] ?? 'train';
if (!['train', 'validation'].includes(split)) throw new Error('Only train and validation are available to this script. Holdout is graded once by anneal.ts graduate.');
const jobs: Job[] = readFileSync('evals/v1/jobs.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter((j: Job) => j.split === split);
const finder = new Finder();
const results = jobs.map(job => {
  const command = allCommands.find(c => c.name === job.expected.tool);
  return gradeDiscovery(job, finder.find(job.request, 5).hits, command ? effectPolicy(command).effect : undefined);
});
const summary = summarizeDiscovery(results, id => finder.catalog.find(c => c.id === id)?.group);
if (split === 'train') {
  for (const r of results.filter(r => !r.passed || r.unsafeTop1)) {
    const job = jobs.find(j => j.id === r.id)!;
    console.log(`${r.id} [${r.kind}${r.unsafeTop1 ? ' UNSAFE' : ''}] rank=${r.rank} expected=${job.expected.tool ?? 'unavailable'} got=${r.candidates.slice(0, 3).join(',') || '(none)'}\n   "${job.request}"`);
  }
}
console.log(JSON.stringify({ split, passed: summary.passed, total: summary.total, recall5: summary.recall5, mrr: summary.mrr, unsafeTop1: summary.unsafeTop1 }));
