import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { getConfigDir } from '../core/config.js';
import { output } from '../core/output.js';
import type { GlobalOptions } from '../core/types.js';
import { FilePreviewStore, MemoryPreviewStore } from '../safe/preview-store.js';
import { CompactSurface, isCompactError } from './surface.js';
import { createLiveHost } from './host.js';

interface ExecFlags { args?: string; argsFile?: string; allowWrite?: string; allowUnknownCost?: boolean; mode?: string; previewToken?: string }

const cliError = (code: string, message: string, next?: string) => ({ error: { code, message, ...(next ? { next } : {}) } });

type Parsed = { ok: true; value: Record<string, unknown> } | { ok: false; failure: ReturnType<typeof cliError> };

function parseArguments(flags: ExecFlags): Parsed {
  if (flags.args !== undefined && flags.argsFile !== undefined) return { ok: false, failure: cliError('INVALID_ARGUMENTS', '--args and --args-file are mutually exclusive.') };
  let text = flags.args;
  if (flags.argsFile !== undefined) {
    try { text = readFileSync(flags.argsFile, 'utf8'); }
    catch { return { ok: false, failure: cliError('INVALID_ARGUMENTS', `Cannot read --args-file ${flags.argsFile}.`) }; }
  }
  if (text === undefined) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, failure: cliError('INVALID_ARGUMENTS', 'Arguments must be one JSON object.', 'Pass --args \'{"limit":10}\' or --args-file /absolute/path.json') };
  }
}

/** Scope is always explicit: the same profile and workspace the MCP tools require. */
type Scoped = { ok: true; value: { profile: string; workspace_id: string } } | { ok: false; failure: ReturnType<typeof cliError> };
function scopeFrom(globals: GlobalOptions): Scoped {
  const profile = globals.profile ?? process.env.INSTANTLY_PROFILE;
  const fail = (failure: ReturnType<typeof cliError>): Scoped => ({ ok: false, failure });
  if (!profile) return fail(cliError('PROFILE_REQUIRED', 'Pass --profile <slug> (or --profile default for the default key).', 'Run instantly status to see the bound profile and workspace.'));
  if (!globals.workspace) return fail(cliError('WORKSPACE_REQUIRED', 'Pass --workspace <uuid> with the workspace you expect.', 'Run instantly status to see the bound workspace.'));
  return { ok: true, value: { profile, workspace_id: globals.workspace } };
}

function emit(result: unknown, globals: GlobalOptions): void {
  if (isCompactError(result)) {
    if (!globals.quiet) console.error(JSON.stringify(result));
    process.exitCode = 1;
    return;
  }
  output(result, { ...globals, output: globals.pretty ? 'pretty' : globals.output });
}

function hostFor(globals: GlobalOptions, flags: ExecFlags, durable: boolean) {
  const store = durable ? new FilePreviewStore(join(getConfigDir(), 'previews')) : new MemoryPreviewStore();
  return createLiveHost({
    profile: globals.profile, apiKey: globals.apiKey, store,
    allowedWrites: (flags.allowWrite ?? '').split(',').map(s => s.trim()).filter(Boolean),
    allowUnknownCost: flags.allowUnknownCost === true,
  });
}

const POLICY_HELP = `
Write policy: writes never execute unless the operator names the command with --allow-write <command_id>.
Pass the same --allow-write and --allow-unknown-cost to preview and to run, or the token is rejected as stale.`;

export function registerCompactCommands(program: Command, surface: CompactSurface = new CompactSurface()): void {
  const globals = (cmd: Command) => cmd.optsWithGlobals() as GlobalOptions & ExecFlags;

  program.command('find <intent...>')
    .description('Find Instantly commands by plain-language intent. Offline: needs no credentials. Mirrors the instantly_find MCP tool.')
    .option('--limit <n>', 'Maximum hits, 1 to 10', '5')
    .option('--effect <effect>', 'any, read or write', 'any')
    .addHelpText('after', '\nExamples:\n  $ instantly find "list campaigns" --limit 5 --effect read')
    .action(function (this: Command, intent: string[], flags: { limit: string; effect: string }) {
      emit(surface.find({ intent: intent.join(' '), limit: Number(flags.limit), effect: flags.effect }), globals(this));
    });

  program.command('describe <command_id>')
    .description('Show the full input schema, effect, cost and CLI flags for one command ID. Offline. Mirrors instantly_describe.')
    .addHelpText('after', '\nExamples:\n  $ instantly describe email_list')
    .action(function (this: Command, commandId: string) {
      emit(surface.describe({ command_id: commandId }), globals(this));
    });

  program.command('preview <command_id>')
    .description('Plan a command without sending it and print a one-use preview token. Mirrors instantly_preview.')
    .option('--args <json>', 'Command inputs as one JSON object')
    .option('--args-file <path>', 'Command inputs from a JSON file (use for multiline copy)')
    .option('--allow-write <ids>', 'Comma-separated command IDs the operator permits to execute (default: none)')
    .option('--allow-unknown-cost', 'Also permit allowed writes whose cost is unknown')
    .addHelpText('after', `\nExamples:\n  $ instantly --profile sandbox --workspace <uuid> preview campaigns_update --args-file /abs/args.json${POLICY_HELP}`)
    .action(async function (this: Command, commandId: string) {
      const g = globals(this);
      const scope = scopeFrom(g);
      const args = parseArguments(g);
      if (!scope.ok) return emit(scope.failure, g);
      if (!args.ok) return emit(args.failure, g);
      const live = new CompactSurface(surface.finder, () => hostFor(g, g, true));
      emit(await live.preview({ command_id: commandId, arguments: args.value, ...scope.value }), g);
    });

  program.command('run [command_id]')
    .description('Run a read command, or execute a previewed write by its token. Mirrors instantly_run.')
    .requiredOption('--mode <mode>', 'read or write')
    .option('--args <json>', 'Command inputs as one JSON object (read mode)')
    .option('--args-file <path>', 'Command inputs from a JSON file (read mode)')
    .option('--preview-token <token>', 'Token from preview (write mode). Arguments cannot change.')
    .option('--allow-write <ids>', 'Comma-separated command IDs the operator permits to execute (default: none)')
    .option('--allow-unknown-cost', 'Also permit allowed writes whose cost is unknown')
    .addHelpText('after', `\nExamples:\n  $ instantly --profile sandbox --workspace <uuid> run status --mode read\n  $ instantly --profile sandbox --workspace <uuid> run email_list --mode read --args '{"limit":20}'\n  $ instantly --profile sandbox --workspace <uuid> run --mode write --preview-token <token> --allow-write campaigns_update${POLICY_HELP}`)
    .action(async function (this: Command, commandId: string | undefined) {
      const g = globals(this);
      const scope = scopeFrom(g);
      if (!scope.ok) return emit(scope.failure, g);
      // Only what the caller supplied is sent, so the strict envelope rejects mismatched combinations exactly as MCP does.
      const input: Record<string, unknown> = { mode: g.mode, ...scope.value };
      if (commandId !== undefined) input.command_id = commandId;
      if (g.previewToken !== undefined) input.preview_token = g.previewToken;
      if (g.args !== undefined || g.argsFile !== undefined) {
        const args = parseArguments(g);
        if (!args.ok) return emit(args.failure, g);
        input.arguments = args.value;
      }
      const live = new CompactSurface(surface.finder, () => hostFor(g, g, g.mode === 'write'));
      emit(await live.run(input), g);
    });
}
