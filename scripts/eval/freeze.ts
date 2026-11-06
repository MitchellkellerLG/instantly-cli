import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { allCommands } from '../../src/commands/index.js';
import { coverage } from '../openapi.js';
import { digest } from '../../src/safe/canonical.js';
import { validateArguments } from '../../src/safe/dispatcher.js';
import type { Job } from '../../src/eval/grader.js';

const directory = 'evals/v1';
const jobs: Job[] = readFileSync(join(directory, 'jobs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
function sha(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)]);
}
const registry = allCommands.map(c => ({ id: c.name, group: c.group, subcommand: c.subcommand,
  endpoint: c.endpoint, fieldMappings: c.fieldMappings, generated: !!c.generated }));
const facts = {
  version: 1, definitions: allCommands.length, legacyTools: allCommands.length + 2,
  registryHash: digest(registry), registrySourceHash: digest(files('src/commands').concat(files('src/core')).sort().map(p => [p, sha(p)])),
  dispatcherSourceHash: digest(files('src/safe').sort().map(p => [p, sha(p)])),
  pinnedSpecSha256: sha('spec/api_v2.json'), packageSha256: sha('package.json'), lockSha256: sha('package-lock.json'),
  corpusSha256: sha(join(directory, 'jobs.jsonl')),
  fixturesSha256: sha(join(directory, 'fixtures.json')), outcomesSha256: sha(join(directory, 'outcomes.json')),
  publicDeltaFixturesSha256: sha('evals/public-delta-v1/fixtures.json'),
  coverage: coverage(JSON.parse(readFileSync('spec/api_v2.json', 'utf8')), allCommands),
};
const split = Object.fromEntries(['train', 'validation', 'holdout'].map(s => [s, jobs.filter(j => j.split === s).map(j => j.id)]));
for (const job of jobs) {
  const command = allCommands.find(c => c.name === job.expected.tool);
  if (job.availability === 'implemented') {
    if (!command) throw new Error('Missing command ' + job.id);
    validateArguments(command, job.expected.key_arguments);
  } else if (command || job.expected.tool !== null) throw new Error('Executable gap ' + job.id);
}
if (jobs.length !== 56 || new Set(jobs.map(j => j.id)).size !== 56 ||
    split.train.length !== 32 || split.validation.length !== 14 || split.holdout.length !== 10) throw new Error('CORPUS_CHANGED');
for (const [name, data] of Object.entries({ 'facts.json': facts, 'split.json': split, 'registry.json': registry })) {
  const text = JSON.stringify(data, null, 2) + '\n';
  if (process.argv.includes('--write')) writeFileSync(join(directory, name), text);
  else if (readFileSync(join(directory, name), 'utf8') !== text) throw new Error('FROZEN_FACTS_CHANGED: ' + name);
}
console.log(JSON.stringify({ ...facts, splits: Object.fromEntries(Object.entries(split).map(([k, v]) => [k, v.length])),
  executableSchemas: jobs.filter(j => j.availability === 'implemented').length }));
