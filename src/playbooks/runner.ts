import { randomBytes } from 'node:crypto';
import type { CommandDefinition } from '../core/types.js';
import { canonical, clone, digest } from '../safe/canonical.js';
import type { SafeDispatcher, Scope } from '../safe/dispatcher.js';
import { effectPolicy } from '../safe/policy.js';
import { TIER_POLICY, effectiveWrites, visibleTo } from './tiers.js';
import type { BrowserStep, Computed, PlaybookDefinition, ReadResults, ReadStep, Refusal, Tier, WriteStep } from './types.js';

export const MAX_READS = 12;
export const MAX_REQUESTS = 24;
export const MAX_WRITES = 12;
const TTL_MS = 300_000;

export interface RunnerOptions {
  dispatcher: SafeDispatcher;
  scope: Scope;
  tier: Tier;
  commands: CommandDefinition[];
  playbooks: PlaybookDefinition[];
  /** Writes the host enabled. The effective set is this list intersected with the tier maximum. */
  hostAllowedWrites?: string[];
  /** Mirror of the host dispatcher setting. Every allowed write has unknown cost, so without it nothing can run. */
  allowUnknownCost?: boolean;
  now?: () => number;
}

export interface PlannedStep {
  id: string;
  stage: number;
  command: string;
  summary: string;
  credits: number;
  /** True when a declared field is filled from an earlier response. The step is re-previewed at run time. */
  deferred: boolean;
  arguments: Record<string, unknown>;
  fills: { into: string; from: string; path: string }[];
  executable: boolean;
  not_executable_reason?: 'WRITE_POLICY_DENIED' | 'SPEND_CEILING' | 'COST_POLICY_DENIED';
  requests: unknown;
}
export interface PlaybookPreview {
  playbook: string;
  identity: { profile: string; workspace_id: string };
  tier: Tier;
  artifact: unknown;
  steps: PlannedStep[];
  browser: (BrowserStep & { attended: true })[];
  refusals: Refusal[];
  cost: Computed['cost'];
  reads: { id: string; command: string; ok: boolean; code?: string }[];
  plan_hash: string;
  playbook_token: string | null;
  expires_in_seconds: number;
  note: string;
}
export interface Receipt { step: string; command: string; plan_hash: string; response_hash: string; response?: unknown }
export interface PlaybookRunResult {
  playbook: string;
  status: 'completed' | 'refused' | 'failed';
  receipts: Receipt[];
  failed?: { step: string; code: string; message: string };
  unexecuted: string[];
  reconcile?: ReadStep;
  credits_spent_max: number;
}

interface StoredStep { step: WriteStep; planned: PlannedStep; token: string | null }
interface StoredPlan {
  expires: number;
  binding: string;
  playbook: string;
  steps: StoredStep[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Dotted path with numeric indexes, e.g. items.0.id. No wildcards, no computed keys. */
function extract(value: unknown, path: string): unknown {
  let cur: any = value;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}
export function applyFills(step: WriteStep, done: Record<string, unknown>): Record<string, unknown> {
  const args = clone(step.args);
  for (const fill of step.fills ?? []) {
    const value = extract(done[fill.from], fill.path);
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('DEPENDENT_VALUE_INVALID: ' + fill.from + '.' + fill.path);
    args[fill.into] = fill.asArray ? [value] : value;
  }
  return args;
}

const codeOf = (error: unknown): { code: string; message: string } => {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(/^([A-Z][A-Z_]+)(?::\s*(.*))?$/s);
  return { code: match ? match[1] : 'UNKNOWN_ERROR', message: match?.[2] ?? raw };
};

export class PlaybookRunner {
  private now: () => number;
  private plans = new Map<string, StoredPlan>();
  private catalog: Map<string, CommandDefinition>;
  constructor(private options: RunnerOptions) {
    this.now = options.now ?? Date.now;
    this.catalog = new Map(options.commands.map(c => [c.name, c]));
  }
  get allowedWrites(): string[] { return effectiveWrites(this.options.tier, this.options.hostAllowedWrites ?? []); }
  list(): PlaybookDefinition[] { return this.options.playbooks.filter(p => visibleTo(this.options.tier, p)); }
  get(slug: string): PlaybookDefinition {
    const def = this.list().find(p => p.slug === slug);
    if (!def) throw new Error('UNKNOWN_PLAYBOOK: ' + slug);
    return def;
  }
  private binding(): string {
    return digest({ scope: this.options.scope, tier: this.options.tier, writes: this.allowedWrites });
  }
  /** Every read must be a frozen allowlisted read with no cost before any request is made. */
  private assertReads(reads: ReadStep[]): void {
    if (reads.length > MAX_READS) throw new Error('TOO_MANY_READS');
    for (const step of reads) {
      const command = this.catalog.get(step.command);
      if (!command) throw new Error('UNSUPPORTED_COMMAND: ' + step.command);
      const effect = effectPolicy(command);
      if (effect.effect !== 'read' || effect.cost !== 'none') throw new Error('READ_POLICY_DENIED: ' + step.command);
    }
  }
  private async execReads(steps: ReadStep[]): Promise<ReadResults> {
    const out: ReadResults = {};
    let requests = 0;
    for (const step of steps) {
      try {
        const base = typeof step.args === 'function' ? step.args(out) : step.args;
        if (base === null) continue;
        const pages = Math.max(1, Math.min(step.pages ?? 1, 10));
        let merged: any; let cursor: string | undefined;
        for (let page = 0; page < pages; page++) {
          if (++requests > MAX_REQUESTS) throw new Error('TOO_MANY_READS');
          const args = cursor ? { ...base, starting_after: cursor } : base;
          const value: any = await this.options.dispatcher.read(step.command, args, this.options.scope);
          if (step.requireComplete && !Array.isArray(value?.items)) throw new Error('INCOMPLETE_LOOKUP');
          if (pages === 1 && !step.requireComplete) { merged = value; break; }
          merged = merged ? { ...value, items: [...(merged.items ?? []), ...(value?.items ?? [])] } : { ...value, items: [...(value?.items ?? [])] };
          cursor = typeof value?.next_starting_after === 'string' && value.next_starting_after ? value.next_starting_after : undefined;
          if (step.requireComplete && ((!cursor && value.items.length >= Number(base.limit) && value.next_starting_after !== null) || (cursor && page === pages - 1))) throw new Error('INCOMPLETE_LOOKUP');
          if (!cursor) break;
        }
        out[step.id] = { ok: true, value: merged };
      } catch (error) {
        const { code } = codeOf(error);
        // A mismatched workspace or a policy error is never optional. Only data errors are tolerated.
        if (!step.optional || ['WORKSPACE_MISMATCH', 'READ_POLICY_DENIED', 'INVALID_SCOPE', 'TOO_MANY_READS'].includes(code)) throw error;
        out[step.id] = { ok: false, code };
      }
    }
    return out;
  }
  async preview(slug: string, rawInput: unknown): Promise<PlaybookPreview> {
    const def = this.get(slug);
    const input = this.parseInput(def, rawInput);
    const readSteps = def.reads(input);
    this.assertReads(readSteps);
    const reads = await this.execReads(readSteps);
    const computed = def.compute(input, reads, { now: new Date(this.now()).toISOString() });
    if (computed.writes.length > MAX_WRITES) throw new Error('TOO_MANY_WRITES');
    for (const write of computed.writes) this.assertWrite(write);
    const refusals = [...computed.refusals];
    const allowed = this.allowedWrites;
    const ceiling = TIER_POLICY[this.options.tier].creditCeiling;
    const totalCredits = computed.writes.reduce((sum, w) => sum + w.credits, 0);
    const overCeiling = totalCredits > ceiling;
    if (overCeiling) refusals.push({ code: 'SPEND_CEILING', message: `Plan may spend up to ${totalCredits} credits; the ${this.options.tier} ceiling is ${ceiling}.` });
    const steps: StoredStep[] = [];
    for (const step of [...computed.writes].sort((a, b) => a.stage - b.stage)) {
      const planned: PlannedStep = { id: step.id, stage: step.stage, command: step.command, summary: step.summary, credits: step.credits,
        deferred: !!step.fills?.length, arguments: clone(step.args), fills: (step.fills ?? []).map(f => ({ into: f.into, from: f.from, path: f.path })),
        executable: allowed.includes(step.command) && this.options.allowUnknownCost === true && !(step.credits > 0 && overCeiling), requests: null };
      if (!allowed.includes(step.command)) planned.not_executable_reason = 'WRITE_POLICY_DENIED';
      else if (this.options.allowUnknownCost !== true) planned.not_executable_reason = 'COST_POLICY_DENIED';
      else if (step.credits > 0 && overCeiling) planned.not_executable_reason = 'SPEND_CEILING';
      let token: string | null = null;
      if (!planned.deferred) {
        const issued = await this.options.dispatcher.preview(step.command, step.args, this.options.scope);
        token = issued.token; planned.requests = issued.plan.requests;
      }
      steps.push({ step, planned, token });
    }
    if (steps.some(s => s.planned.not_executable_reason === 'WRITE_POLICY_DENIED')) {
      refusals.push({ code: 'WRITE_POLICY_DENIED', message: 'This host or tier has not enabled one or more writes in this plan. The plan is preview-only.' });
    }
    // Deterministic over what would be written, not over incidental read noise.
    const planHash = digest({ playbook: def.slug, scope: this.options.scope, tier: this.options.tier,
      steps: steps.map(s => ({ id: s.step.id, command: s.step.command, args: s.step.args, fills: s.step.fills ?? [], credits: s.step.credits })) });
    if (steps.some(x => x.planned.not_executable_reason === 'COST_POLICY_DENIED')) {
      refusals.push({ code: 'COST_POLICY_DENIED', message: 'The host has not allowed writes of unknown cost (--allow-unknown-cost). The plan is preview-only.' });
    }
    const runnable = steps.length > 0 && steps.every(s => s.planned.executable);
    let playbookToken: string | null = null;
    if (runnable) {
      playbookToken = randomBytes(32).toString('hex');
      this.prune();
      this.plans.set(playbookToken, { expires: this.now() + TTL_MS, binding: this.binding(), playbook: def.slug, steps });
    }
    return {
      playbook: def.slug, identity: { profile: this.options.scope.profile, workspace_id: this.options.scope.workspace },
      tier: this.options.tier, artifact: computed.artifact, steps: steps.map(s => s.planned),
      browser: computed.browser.map(b => ({ ...b, attended: true as const })), refusals, cost: computed.cost,
      reads: readSteps.map(r => ({ id: r.id, command: r.command, ok: reads[r.id]?.ok === true, ...(reads[r.id]?.ok === false ? { code: (reads[r.id] as { code: string }).code } : {}) })),
      plan_hash: planHash, playbook_token: playbookToken, expires_in_seconds: TTL_MS / 1000,
      note: steps.length ? 'A preview is a plan, not authorization. Nothing was sent. Browser steps are an attended checklist; this layer never clicks.' : 'Read-only playbook. Nothing to execute.',
    };
  }
  private parseInput(def: PlaybookDefinition, raw: unknown): Record<string, any> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_ARGUMENTS');
    const unknown = Object.keys(raw as object).filter(k => !Object.hasOwn(def.inputSchema.shape, k));
    if (unknown.length) throw new Error('UNKNOWN_ARGUMENTS: ' + unknown.join(','));
    return def.inputSchema.parse(clone(raw));
  }
  private assertWrite(write: WriteStep): void {
    const command = this.catalog.get(write.command);
    if (!command) throw new Error('UNSUPPORTED_COMMAND: ' + write.command);
    const effect = effectPolicy(command);
    if (effect.effect !== 'write') throw new Error('PLAYBOOK_WRITE_NOT_A_WRITE: ' + write.command);
    if (/activate|resume|pause|send|delete|launch|reply|forward/.test(command.name)) {
      throw new Error('PLAYBOOK_FORBIDDEN_COMMAND: ' + write.command);
    }
  }
  private prune(): void { for (const [t, p] of this.plans) if (p.expires <= this.now()) this.plans.delete(t); }

  /** Execute a previewed plan. Takes only the playbook token. Stops at the first failure and never retries. */
  async run(playbookToken: string): Promise<PlaybookRunResult> {
    if (!playbookToken) throw new Error('MISSING_PREVIEW');
    if (!/^[a-f0-9]{64}$/.test(playbookToken)) throw new Error('INVALID_PREVIEW');
    const plan = this.plans.get(playbookToken);
    if (!plan) throw new Error('INVALID_PREVIEW');
    if (plan.expires <= this.now()) { this.plans.delete(playbookToken); throw new Error('EXPIRED_PREVIEW'); }
    if (plan.binding !== this.binding()) throw new Error('STALE_PREVIEW');
    this.plans.delete(playbookToken); // single use, claimed before any step runs
    const allowed = this.allowedWrites;
    const denied = plan.steps.find(s => !allowed.includes(s.step.command));
    const unexecuted = plan.steps.map(s => s.step.id);
    if (denied) return { playbook: plan.playbook, status: 'refused', receipts: [], failed: { step: denied.step.id, code: 'WRITE_POLICY_DENIED', message: 'Not enabled for this host or tier.' }, unexecuted, credits_spent_max: 0 };
    const receipts: Receipt[] = [];
    const done: Record<string, unknown> = {};
    let creditsMax = 0;
    for (const { step, token: stored } of plan.steps) {
      try {
        let token = stored;
        let planHash = digest({ command: step.command, args: step.args });
        if (!token) {
          // Only the declared uuid fields vary. The result is previewed and written under the same host policy.
          const args = applyFills(step, done);
          const issued = await this.options.dispatcher.preview(step.command, args, this.options.scope);
          token = issued.token; planHash = digest(issued.plan);
        }
        creditsMax += step.credits;
        const result = await this.options.dispatcher.write(token, this.options.scope);
        done[step.id] = result;
        receipts.push({ step: step.id, command: step.command, plan_hash: planHash, response_hash: digest(result ?? null), ...(step.exposeResponse ? { response: result } : {}) });
        unexecuted.splice(unexecuted.indexOf(step.id), 1);
      } catch (error) {
        const { code, message } = codeOf(error);
        return { playbook: plan.playbook, status: 'failed', receipts, failed: { step: step.id, code, message }, unexecuted,
          ...(step.reconcile ? { reconcile: step.reconcile } : {}), credits_spent_max: creditsMax };
      }
    }
    return { playbook: plan.playbook, status: 'completed', receipts, unexecuted, credits_spent_max: creditsMax };
  }
  /** Stateless handoff for the CLI: recompute the plan and execute only if it matches the hash the operator reviewed. */
  async execute(slug: string, input: unknown, confirmHash: string): Promise<{ preview: PlaybookPreview; run?: PlaybookRunResult }> {
    const preview = await this.preview(slug, input);
    if (preview.plan_hash !== confirmHash) throw new Error('STALE_PREVIEW: the plan changed since you reviewed it. Preview again.');
    if (!preview.playbook_token) throw new Error('WRITE_POLICY_DENIED: nothing in this plan can execute under the current host and tier.');
    return { preview, run: await this.run(preview.playbook_token) };
  }
}
export { canonical };
