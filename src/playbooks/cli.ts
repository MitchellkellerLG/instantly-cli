import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { createLiveHost } from '../compact/host.js';
import { isCompactError } from '../compact/surface.js';
import { output } from '../core/output.js';
import type { GlobalOptions } from '../core/types.js';
import { MemoryPreviewStore } from '../safe/preview-store.js';
import { PlaybookService, playbookError, isPlaybookFailure } from './service.js';
import { resolveTier } from './tiers.js';

interface Flags { input?: string; inputFile?: string; allowWrite?: string; allowUnknownCost?: boolean; tier?: string; confirm?: string }

const fail = (code: string, message: string, next?: string) => ({ error: { code, message, ...(next ? { next } : {}) } });

function emit(result: unknown, globals: GlobalOptions): void {
  if (isCompactError(result)) {
    if (!globals.quiet) console.error(JSON.stringify(result));
    process.exitCode = 1;
    return;
  }
  if (isPlaybookFailure(result)) process.exitCode = 1;
  output(result, { ...globals, output: globals.pretty ? 'pretty' : globals.output });
}

function parseInput(flags: Flags): { ok: true; value: Record<string, unknown> } | { ok: false; failure: ReturnType<typeof fail> } {
  if (flags.input !== undefined && flags.inputFile !== undefined) return { ok: false, failure: fail('INVALID_ARGUMENTS', '--input and --input-file are mutually exclusive.') };
  let text = flags.input;
  if (flags.inputFile !== undefined) {
    try { text = readFileSync(flags.inputFile, 'utf8'); } catch { return { ok: false, failure: fail('INVALID_ARGUMENTS', `Cannot read --input-file ${flags.inputFile}.`) }; }
  }
  if (text === undefined) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return { ok: true, value };
  } catch { return { ok: false, failure: fail('INVALID_ARGUMENTS', 'Input must be one JSON object.', 'Pass --input \'{"count":18}\' or --input-file /absolute/path.json') }; }
}

function serviceFor(globals: GlobalOptions & Flags): PlaybookService {
  const tier = resolveTier(globals.tier, process.env.INSTANTLY_TIER);
  const host = createLiveHost({
    profile: globals.profile, apiKey: globals.apiKey, store: new MemoryPreviewStore(),
    allowedWrites: (globals.allowWrite ?? '').split(',').map(s => s.trim()).filter(Boolean),
    allowUnknownCost: globals.allowUnknownCost === true,
  });
  return new PlaybookService({ host: () => host, tier });
}

function scopeOf(globals: GlobalOptions): { profile: string; workspace: string } | ReturnType<typeof fail> {
  const profile = globals.profile ?? process.env.INSTANTLY_PROFILE;
  if (!profile) return fail('PROFILE_REQUIRED', 'Pass --profile <slug> (or --profile default for the default key).', 'Run instantly status to see the bound profile and workspace.');
  if (!globals.workspace) return fail('WORKSPACE_REQUIRED', 'Pass --workspace <uuid> with the workspace you expect.', 'Run instantly status to see the bound workspace.');
  return { profile, workspace: globals.workspace };
}
const isScope = (v: unknown): v is { profile: string; workspace: string } => !!v && typeof v === 'object' && 'workspace' in v;

/** Any thrown error becomes the same JSON error envelope the other surfaces use, never a stack trace. */
const guarded = (fn: (this: Command, ...args: any[]) => unknown | Promise<unknown>) => async function (this: Command, ...args: any[]) {
  try { await fn.apply(this, args); } catch (error) { emit(playbookError(error), globals(this)); }
};
const globals = (cmd: Command) => cmd.optsWithGlobals() as GlobalOptions & Flags;

const POLICY = `
Policy: a playbook previews by default and sends nothing. To execute, review the plan, then repeat the same command with
--confirm <plan_hash> plus --allow-write <command ids> --allow-unknown-cost and a --tier (or INSTANTLY_TIER) that permits them.
The default tier is vip, which can never execute a write. Browser steps are an attended checklist; this layer never clicks.`;

export function registerPlaybookCommands(program: Command): void {
  const group = program.command('playbooks').description('Ready-made plans over safe Instantly commands: offer profile, campaign ideas, segmentation, website visitors, local lookalike.')
    .option('--tier <tier>', 'vip (default), managed or internal. A visibility filter that can only narrow what --allow-write enables.')
    .addHelpText('after', POLICY);

  group.command('list')
    .description('List the playbooks visible to this tier. With --profile and --workspace, rank them by the workspace offer (reads only).')
    .action(guarded(async function (this: Command) {
      const g = globals(this);
      if (!g.workspace && !g.profile) return emit(await new PlaybookService({ host: () => { throw new Error('NO_EXECUTION_HOST'); }, tier: resolveTier(g.tier, process.env.INSTANTLY_TIER) }).list(), g);
      const scope = scopeOf(g);
      if (!isScope(scope)) return emit(scope, g);
      emit(await serviceFor(g).list(scope), g);
    }));

  group.command('describe <slug>')
    .description('Show a playbook input schema, requirements and tier ceiling. Offline.')
    .action(guarded(function (this: Command, slug: string) {
      const g = globals(this);
      emit(new PlaybookService({ host: () => { throw new Error('NO_EXECUTION_HOST'); }, tier: resolveTier(g.tier, process.env.INSTANTLY_TIER) }).describe(slug), g);
    }));

  group.command('run <slug>')
    .description('Preview a playbook (default) or execute the plan you reviewed (--confirm <plan_hash>).')
    .option('--input <json>', 'Playbook input as one JSON object')
    .option('--input-file <path>', 'Playbook input from a JSON file')
    .option('--confirm <plan_hash>', 'Execute only if the freshly computed plan hash equals this reviewed one')
    .option('--allow-write <ids>', 'Comma-separated command IDs the operator permits to execute (default: none)')
    .option('--allow-unknown-cost', 'Also permit allowed writes whose cost is unknown')
    .action(guarded(async function (this: Command, slug: string) {
      const g = globals(this);
      const scope = scopeOf(g);
      if (!isScope(scope)) return emit(scope, g);
      const input = parseInput(g);
      if (!input.ok) return emit(input.failure, g);
      const service = serviceFor(g);
      emit(g.confirm ? await service.execute(slug, input.value, g.confirm, scope) : await service.preview(slug, input.value, scope), g);
    }));

  group.command('digest')
    .description('Print the playbook recommendations for this workspace as plain text plus JSON. Reads only; nothing is sent anywhere.')
    .action(guarded(async function (this: Command) {
      const g = globals(this);
      const scope = scopeOf(g);
      if (!isScope(scope)) return emit(scope, g);
      emit(await serviceFor(g).list(scope), g);
    }));
}

/** The mcp command lives in the frozen registry sources, so its opt-in flags are attached here instead. */
export function extendMcpCommand(program: Command): void {
  const mcp = program.commands.find(c => c.name() === 'mcp');
  if (!mcp) return;
  mcp.option('--playbooks', 'Also register the playbooks_* tools and playbooks/<slug> prompts (opt-in; default surfaces unchanged). Write allowances then apply to playbooks.')
    .option('--tier <tier>', 'With --playbooks: vip (default), managed or internal. Narrows, never widens, --allow-write.');
}
