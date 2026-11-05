import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { allPlaybooks } from '../../src/playbooks/registry.js';
import { TIER_POLICY, effectiveWrites, resolveTier, visibleTo } from '../../src/playbooks/tiers.js';
import { allCommands } from '../../src/commands/index.js';
import { effectPolicy } from '../../src/safe/policy.js';

describe('playbook registry', () => {
  it('lists exactly the five ranked playbooks with unique slugs', () => {
    expect(allPlaybooks.map(p => p.slug)).toEqual(['campaign_ideas', 'offer_profile', 'skin_in_the_game_segments', 'website_visitors_setup', 'local_lookalike']);
    expect(new Set(allPlaybooks.map(p => p.slug)).size).toBe(5);
  });
  it('never reuses a registered command name, so legacy and compact surfaces are untouched', () => {
    const names = new Set(allCommands.map(c => c.name));
    for (const p of allPlaybooks) expect(names.has(p.slug)).toBe(false);
    expect(allCommands.length).toBe(287);
  });
  it('declares requires from the closed vocabulary and strict input schemas', () => {
    const vocabulary = new Set(['api_read', 'api_write', 'spend', 'browser_read', 'browser_write', 'model']);
    for (const p of allPlaybooks) {
      expect(p.requires.length).toBeGreaterThan(0);
      for (const r of p.requires) expect(vocabulary.has(r)).toBe(true);
      expect(() => p.inputSchema.parse({ definitely_unknown_key: 1 })).toThrow();
    }
  });
  it('every static read command is a frozen allowlisted read with no cost', () => {
    const samples: Record<string, Record<string, unknown>> = {
      skin_in_the_game_segments: { campaign_id: '00000000-0000-4000-8000-000000000001', apply: 'lists', size_filters: [{}] },
      website_visitors_setup: { domain: 'example.com' }, local_lookalike: { category: 'dentist', place: 'Austin, TX' },
    };
    for (const p of allPlaybooks) {
      for (const step of p.reads(p.inputSchema.parse(samples[p.slug] ?? {}))) {
        const command = allCommands.find(c => c.name === step.command)!;
        expect(command, step.command).toBeDefined();
        expect(effectPolicy(command)).toMatchObject({ effect: 'read', cost: 'none' });
      }
    }
  });
});

describe('tiers', () => {
  it('defaults to vip and rejects typos instead of widening access', () => {
    expect(resolveTier(undefined, '')).toBe('vip');
    expect(resolveTier(undefined, 'managed')).toBe('managed');
    expect(() => resolveTier('Internal')).toThrow('UNKNOWN_TIER');
    expect(() => resolveTier('admin')).toThrow('UNKNOWN_TIER');
  });
  it('vip can never execute a write and is hidden from nothing but browser-write playbooks', () => {
    expect(TIER_POLICY.vip.allowedWrites).toEqual([]);
    expect(effectiveWrites('vip', ['campaigns_create'])).toEqual([]);
    const browserWrite = { requires: ['api_read', 'browser_write'] } as const;
    expect(visibleTo('vip', browserWrite as never)).toBe(false);
    expect(visibleTo('managed', browserWrite as never)).toBe(false);
    expect(visibleTo('internal', browserWrite as never)).toBe(true);
    for (const p of allPlaybooks) expect(visibleTo('vip', p)).toBe(true);
  });
  it('tier maxima never include activation, sending or deletion, and managed cannot spend', () => {
    for (const tier of ['vip', 'managed', 'internal'] as const) {
      for (const w of TIER_POLICY[tier].allowedWrites) expect(w).not.toMatch(/activate|resume|pause|send|delete|launch|reply|forward/);
    }
    expect(TIER_POLICY.managed.allowedWrites).not.toContain('local_business_search_convert_local_businesses');
    expect(TIER_POLICY.managed.creditCeiling).toBe(0);
  });
  it('effective writes are host flags intersected with the tier maximum (a tier can only narrow)', () => {
    expect(effectiveWrites('managed', ['campaigns_create', 'local_business_search_convert_local_businesses', 'campaigns_activate'])).toEqual(['campaigns_create']);
    expect(effectiveWrites('internal', [])).toEqual([]);
  });
  it('z is available for schemas', () => { expect(z.string().parse('x')).toBe('x'); });
});
