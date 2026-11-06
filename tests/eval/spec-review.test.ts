import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import review from '../../evals/v1/spec-review.json';
import facts from '../../evals/v1/facts.json';

const exec = promisify(execFile);

describe('phase 5 pinned-spec review', () => {
  it('records the pinned spec hash that is actually pinned', () => {
    const pinned = createHash('sha256').update(readFileSync('spec/api_v2.json')).digest('hex');
    expect(review.pinnedSha256).toBe(pinned);
    expect(review.pinnedSha256).toBe(facts.pinnedSpecSha256);
  });
  it('found no documented gap, so no operation was added', () => {
    expect(review.addedOperations).toEqual([]);
    expect(review.removedOperations).toEqual([]);
    expect(review.operationsChangedSemantically).toEqual([]);
    expect(review.schemasChangedSemantically).toEqual([]);
    expect(review.coverageAgainstCandidate).toEqual({ total: 268, covered: 268, missing: [] });
    expect(facts.coverage.total).toBe(268);
  });
});

describe('spec review contract changes', () => {
  const run = async (mutate: (spec: any) => void) => {
    const directory = mkdtempSync(join(process.cwd(), '.spec-review-test-'));
    try {
      const spec = JSON.parse(readFileSync('spec/api_v2.json', 'utf8'));
      mutate(spec);
      const candidate = join(directory, 'candidate.json');
      writeFileSync(candidate, JSON.stringify(spec));
      const result = await exec(process.execPath, ['--import', 'tsx', 'scripts/spec-review.ts', candidate], { encoding: 'utf8' }).then(
        result => ({ status: 0, stdout: result.stdout }),
        error => ({ status: error.code, stdout: error.stdout }),
      );
      return { status: result.status, review: JSON.parse(result.stdout) };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  };
  it('detects a type change on a property named description', async () => {
    const result = await run(spec => { spec.components.schemas.InboxPlacementTest.properties.description.type = 'number'; });
    expect(result.status).toBe(2);
    expect(result.review.schemasChangedSemantically).toContain('InboxPlacementTest');
  });
  it('detects a removed operation', async () => {
    const result = await run(spec => { delete spec.paths['/api/v2/campaigns'].get; });
    expect(result.status).toBe(2);
    expect(result.review.removedOperations).toContain('GET /api/v2/campaigns');
  });
  it('detects a removed schema', async () => {
    const result = await run(spec => { delete spec.components.schemas.InboxPlacementTest; });
    expect(result.status).toBe(2);
    expect(result.review.schemasRemoved).toContain('InboxPlacementTest');
  });
  it.each([
    ['security scheme', (spec: any) => { spec.components.securitySchemes.ApiKeyAuth.scheme = 'basic'; }],
    ['root security', (spec: any) => { spec.security = []; }],
    ['servers', (spec: any) => { spec.servers = [{ url: 'https://different.example.test' }]; }],
    ['path parameters', (spec: any) => { spec.paths['/api/v2/campaigns'].parameters = [{ name: 'tenant', in: 'header', required: true, schema: { type: 'string' } }]; }],
    ['shared response', (spec: any) => { spec.components.responses = { description: { content: { 'application/json': { schema: { type: 'number' } } } } }; }],
  ] as const)('detects inherited contract changes to %s', async (_name, mutate) => {
    const result = await run(mutate);
    expect(result.status).toBe(2);
    expect(result.review.documentChangedSemantically).toBe(true);
    expect(result.review.conclusion).toBe('Documented differences found. Review before updating the pin.');
  });
  it('ignores prose-only changes', async () => {
    const result = await run(spec => { spec.components.schemas.InboxPlacementTest.description = 'Updated prose'; });
    expect(result.status).toBe(0);
    expect(result.review.schemasChangedSemantically).toEqual([]);
    expect(result.review.documentChangedSemantically).toBe(false);
  });
});
