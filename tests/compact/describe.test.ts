import { describe, it, expect } from 'vitest';
import { CompactSurface } from '../../src/compact/surface.js';
import { VIRTUAL_IDS } from '../../src/compact/catalog.js';
import { allCommands } from '../../src/commands/index.js';

const surface = new CompactSurface();
describe('compact describe', () => {
  it('describes every registry command and virtual command with a valid JSON schema', () => {
    for (const id of [...allCommands.map(c => c.name), ...VIRTUAL_IDS]) {
      const d: any = surface.describe({ command_id: id });
      expect(d.error, id).toBeUndefined();
      expect(d.input_schema.type, id).toBe('object');
      expect(d.cli.command, id).toMatch(/^instantly /);
      expect(() => JSON.stringify(d)).not.toThrow();
    }
  });
  it('shows required inputs, CLI flags, effect and cost for a write', () => {
    const d: any = surface.describe({ command_id: 'campaigns_update' });
    expect(d.effect).toMatchObject({ effect: 'write', cost: 'none' });
    expect(d.required).toContain('id');
    expect(d.cli.usage).toMatch(/instantly campaigns update <id>/);
    expect(d.cli.flags.length).toBeGreaterThan(1);
    expect(d.how_to_call).toMatch(/instantly_preview/);
    expect(d.registry_revision).toMatch(/^[0-9a-f]{64}$/);
  });
  it('marks undocumented endpoints and unavailable features', () => {
    expect((surface.describe({ command_id: 'sales_flow_list' }) as any).availability).toBe('undocumented');
    const f: any = surface.describe({ command_id: 'voice_agent' });
    expect(f).toMatchObject({ kind: 'feature', available: false });
    expect(f.next).toMatch(/do not guess/i);
  });
  it('answers unknown IDs with suggestions and rejects extra keys', () => {
    const e: any = surface.describe({ command_id: 'campaign_list' });
    expect(e.error.code).toBe('UNKNOWN_COMMAND');
    expect(e.error.did_you_mean).toContain('campaigns_list');
    expect((surface.describe({ command_id: 'campaigns_list', extra: 1 }) as any).error.code).toBe('INVALID_ARGUMENTS');
  });
});
