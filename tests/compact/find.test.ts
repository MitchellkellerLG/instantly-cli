import { describe, it, expect } from 'vitest';
import { allCommands } from '../../src/commands/index.js';
import { buildCatalog, contextRevision, defaultContext, registryRevision, VIRTUAL_IDS } from '../../src/compact/catalog.js';
import { Finder } from '../../src/compact/find.js';
import { parseQuery, stem } from '../../src/compact/text.js';
import registry from '../../evals/v1/registry.json';

const finder = new Finder();
describe('compact find', () => {
  it('indexes every registry command plus virtual status and health', () => {
    expect(finder.catalog).toHaveLength(allCommands.length + 2);
    expect(finder.catalog.map(c => c.id)).toEqual(expect.arrayContaining([...VIRTUAL_IDS, ...registry.map(c => c.id)]));
  });
  it('makes every operation discoverable by exact ID and by group plus subcommand', () => {
    for (const entry of finder.catalog) {
      expect(finder.find(entry.id, 5).hits[0]?.id, entry.id).toBe(entry.id);
      if (entry.definition) {
        const phrase = `${entry.group} ${entry.subcommand}`;
        expect(finder.find(phrase, 5).hits[0]?.id, phrase).toBe(entry.id);
      }
    }
  });
  it('returns small ranked summaries without schemas, with effect and availability', () => {
    const result = finder.find('list campaigns', 3);
    expect(result.hits[0]).toMatchObject({ id: 'campaigns_list', effect: 'read', availability: 'public', runnable: true });
    expect(JSON.stringify(result)).not.toContain('inputSchema');
    expect(JSON.stringify(result).length).toBeLessThan(3000);
    expect(result.hits.length).toBeLessThanOrEqual(3);
  });
  it('is deterministic and breaks ties by stable ID', () => {
    const a = finder.find('webhook event', 10); const b = new Finder().find('webhook event', 10);
    expect(a).toEqual(b);
    const tied = a.hits.filter((h, i) => i > 0 && h.score === a.hits[i - 1].score);
    for (const h of tied) expect(h.id.localeCompare(a.hits[a.hits.findIndex(x => x === h) - 1].id)).toBeGreaterThanOrEqual(0);
  });
  it('filters by effect using policy metadata, not wording', () => {
    expect(finder.find('campaign', 10, 'read').hits.every(h => h.effect === 'read')).toBe(true);
    expect(finder.find('campaign', 10, 'write').hits.every(h => h.effect !== 'read')).toBe(true);
  });
  it('returns no executable hit for nonsense and reports unavailable features as not runnable', () => {
    const none = finder.find('zzz qqq xyzzy');
    expect(none.hits).toEqual([]);
    expect(none.note).toMatch(/Rephrase/);
    const feature = finder.find('crm opportunity pipeline deal').hits.find(h => h.kind === 'feature');
    expect(feature).toMatchObject({ runnable: false, effect: 'unavailable', availability: 'unavailable' });
  });
  it('ignores negated clauses so excluded actions do not drive the choice', () => {
    expect(parseQuery('Show emails without marking anything read').tokens).not.toContain('mark');
    expect(parseQuery('List leads. Do not delete them.').tokens).not.toContain('delete');
    expect(finder.find('Show the first 20 unread replies, without marking anything read.', 3).hits[0]?.effect).not.toBe('write');
  });
  it('folds inflections consistently', () => {
    expect(stem('enabling')).toBe(stem('enable'));
    expect(stem('campaigns')).toBe(stem('campaign'));
    expect(stem('replies')).toBe(stem('reply'));
  });
  it('rejects aliases and context drift through revisions', () => {
    expect(registryRevision()).toBe('8c519b04b3838b6e6d741bc41b34d9f47435df69910097e5047d19f8c0c76339');
    expect(contextRevision({ ...defaultContext, version: 'other' })).not.toBe(contextRevision());
  });
  it('catalog effects match the dispatcher policy for execution decisions', () => {
    const catalog = buildCatalog();
    expect(catalog.find(c => c.id === 'accounts_test_vitals')!.effect.effect).toBe('unknown');
    expect(catalog.find(c => c.id === 'campaigns_list')!.effect.effect).toBe('read');
    expect(finder.find('accounts test vitals').hits.find(h => h.id === 'accounts_test_vitals')?.runnable).toBe(false);
  });
});
