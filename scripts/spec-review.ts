import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { allCommands } from '../src/commands/index.js';
import { coverage, SPEC_URL } from './openapi.js';

/**
 * Review a candidate public spec against the pinned one. The public document needs no key.
 * Semantic comparison ignores prose and generated examples; any operation or schema difference
 * after that is a real change that needs a reviewed pin update, never an automatic one.
 *   tsx scripts/spec-review.ts <spec.json | --live> [--write]
 */
const target = process.argv[2];
if (!target) throw new Error('Usage: tsx scripts/spec-review.ts <spec.json | --live> [--write]');
const pinnedText = readFileSync('spec/api_v2.json', 'utf8');
const candidateText = target === '--live'
  ? await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) }).then(r => { if (!r.ok) throw new Error(`Spec HTTP ${r.status}`); return r.text(); })
  : readFileSync(target, 'utf8');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const pinned = JSON.parse(pinnedText), candidate = JSON.parse(candidateText);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const operations = (spec: any) => Object.fromEntries(Object.entries<any>(spec.paths).flatMap(([path, item]) =>
  Object.entries<any>(item).filter(([method, op]) => METHODS.includes(method) && op && typeof op === 'object').map(([method, op]) => [`${method.toUpperCase()} ${path}`, op])));
const PROSE = new Set(['description', 'example', 'examples', 'summary', 'x-codeSamples', 'externalDocs', 'title', 'x-readme']);
const NAMED_MAPS = new Set(['paths', 'webhooks', 'variables', 'scopes', 'dependentSchemas', 'dependentRequired', 'properties', 'patternProperties', '$defs', 'definitions', 'schemas', 'parameters', 'responses', 'headers', 'links', 'callbacks', 'requestBodies', 'securitySchemes', 'content', 'encoding', 'mapping']);
const LITERALS = new Set(['default', 'const', 'enum', 'security']);
const strip = (value: any, mode: 'object' | 'map' | 'literal' = 'object'): any => Array.isArray(value) ? value.map(v => strip(v, mode === 'map' ? 'object' : mode))
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .filter(k => mode !== 'object' || !PROSE.has(k))
    .map(k => [k, strip(value[k], mode === 'literal' ? 'literal' : mode === 'map' ? 'object' : LITERALS.has(k) ? 'literal' : NAMED_MAPS.has(k) ? 'map' : 'object')])) : value;
const a = operations(pinned), b = operations(candidate);
const schemasA = pinned.components?.schemas ?? {}, schemasB = candidate.components?.schemas ?? {};
const review = {
  reviewed: new Date().toISOString().slice(0, 10),
  pinnedSha256: sha(pinnedText),
  candidateSha256: sha(candidateText),
  candidateSource: target === '--live' ? SPEC_URL : 'saved copy supplied on the command line',
  documentChangedSemantically: JSON.stringify(strip(pinned)) !== JSON.stringify(strip(candidate)),
  operations: { pinned: Object.keys(a).length, candidate: Object.keys(b).length },
  addedOperations: Object.keys(b).filter(k => !(k in a)),
  removedOperations: Object.keys(a).filter(k => !(k in b)),
  operationsChangedIncludingProse: Object.keys(a).filter(k => k in b && JSON.stringify(a[k]) !== JSON.stringify(b[k])).length,
  operationsChangedSemantically: Object.keys(a).filter(k => k in b && JSON.stringify(strip(a[k])) !== JSON.stringify(strip(b[k]))),
  schemasAdded: Object.keys(schemasB).filter(k => !(k in schemasA)),
  schemasRemoved: Object.keys(schemasA).filter(k => !(k in schemasB)),
  schemasChangedSemantically: Object.keys(schemasA).filter(k => k in schemasB && JSON.stringify(strip(schemasA[k])) !== JSON.stringify(strip(schemasB[k]))),
  coverageAgainstCandidate: (({ total, covered, missing }) => ({ total, covered, missing }))(coverage(candidate, allCommands)),
};
const result = { ...review, conclusion: !review.documentChangedSemantically && review.coverageAgainstCandidate.missing.length === 0
  ? 'No documented gap beyond the pinned spec. Byte differences are prose or generated examples only. The pin is unchanged.'
  : 'Documented differences found. Review before updating the pin.' };
if (process.argv.includes('--write')) writeFileSync('evals/v1/spec-review.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (review.documentChangedSemantically || review.coverageAgainstCandidate.missing.length) process.exitCode = 2;
