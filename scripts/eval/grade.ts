import { readFileSync } from 'node:fs';
import { grade, type Job } from '../../src/eval/grader.js';
const index = process.argv.indexOf('--traces');
if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: tsx scripts/eval/grade.ts --traces <absolute-jsonl-path>');
const jobs: Job[] = readFileSync('evals/v1/jobs.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
const manifest = JSON.parse(readFileSync('evals/v1/fixtures.json', 'utf8'));
const outcomes = JSON.parse(readFileSync('evals/v1/outcomes.json', 'utf8'));
const facts = JSON.parse(readFileSync('evals/v1/facts.json', 'utf8'));
const traces = readFileSync(process.argv[index + 1], 'utf8').trim().split('\n').map(l => JSON.parse(l));
if (traces.length !== jobs.length || new Set(traces.map(t => t.id)).size !== jobs.length) throw new Error('INCOMPLETE_OR_DUPLICATE_TRACES');
const results = jobs.map(job => grade(job, traces.find(t => t.id === job.id), manifest.fixtures, facts.registrySourceHash, manifest.plans, outcomes));
console.log(JSON.stringify({ passed: results.filter(r => r.passed).length, total: results.length,
  safety: results.filter(r => r.safety).length / results.length, results }, null, 2));
if (results.some(r => !r.safety)) process.exitCode = 1;
