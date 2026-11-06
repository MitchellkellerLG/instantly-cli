import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MemoryPreviewStore } from '../safe/preview-store.js';
import { CompactSurface, isCompactError } from '../compact/surface.js';
import { createLiveHost } from '../compact/host.js';
import { defaultContext, type Context } from '../compact/catalog.js';
import { Finder } from '../compact/find.js';
import { describeShape, findShape, previewShape, runShape } from '../compact/tools.js';
import { redactValue } from '../core/redact.js';
import { resolveTier } from '../playbooks/tiers.js';
import { registerPlaybooks, playbookServiceFor } from './playbooks.js';

export interface McpOptions {
  surface?: 'compact' | 'legacy';
  /** Command IDs the operator allows to execute as writes after a preview. Default none. */
  allowWrites?: string[];
  allowUnknownCost?: boolean;
  /** Legacy surface only: credential-bearing reads the operator opts in to. Default none. */
  allowSensitive?: string[];
  profile?: string;
  /** Opt-in: also register the four playbook tools and playbook prompts. Default surfaces are unchanged. */
  playbooks?: boolean;
  tier?: string;
}

const reply = (result: unknown) => ({
  // Credential-named fields never reach the model; the compact surface has no credential-export opt-in.
  content: [{ type: 'text' as const, text: JSON.stringify(isCompactError(result) ? result : redactValue(result)) }],
  ...(isCompactError(result) ? { isError: true } : {}),
});

/** Exactly four registrations. No credentials are read here. */
export function registerCompactTools(server: McpServer, surface: CompactSurface, context: Context = defaultContext): void {
  server.registerTool('instantly_find', {
    description: context.tools.find, inputSchema: z.object(findShape).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args: unknown) => reply(surface.find(args)));
  server.registerTool('instantly_describe', {
    description: context.tools.describe, inputSchema: z.object(describeShape).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args: unknown) => reply(surface.describe(args)));
  server.registerTool('instantly_preview', {
    description: context.tools.preview, inputSchema: z.object(previewShape).strict(), annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args: unknown) => reply(await surface.preview(args)));
  server.registerTool('instantly_run', {
    description: context.tools.run, inputSchema: z.object(runShape).strict(), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (args: unknown) => reply(await surface.run(args)));
}

export function createCompactServer(options: McpOptions = {}, surface?: CompactSurface, context: Context = defaultContext): McpServer {
  const host = createLiveHost({ profile: options.profile, store: new MemoryPreviewStore(), allowedWrites: options.allowWrites,
    allowUnknownCost: options.allowUnknownCost, context });
  const server = new McpServer({ name: 'instantly', version: '0.1.22' }, { instructions: context.instructions });
  registerCompactTools(server, surface ?? new CompactSurface(new Finder(context), () => host), context);
  if (options.playbooks) registerPlaybooks(server, playbookServiceFor(options, host));
  return server;
}

export async function startCompactMcpServer(options: McpOptions = {}): Promise<void> {
  const server = createCompactServer(options);
  await server.connect(new StdioServerTransport());
  console.error('Instantly MCP server started (compact surface). Tools registered: 4');
}

/** Flags win over the host-provided environment. An unknown surface is an error, never a silent fallback. */
export function mcpOptionsFrom(
  flags: { surface?: string; allowWrite?: string; allowSensitive?: string; allowUnknownCost?: boolean; profile?: string; playbooks?: boolean; tier?: string },
  host: Record<string, string | undefined> = process.env,
): McpOptions {
  const surface = flags.surface ?? host.INSTANTLY_MCP_SURFACE ?? 'legacy';
  if (surface !== 'compact' && surface !== 'legacy') throw new Error(`Unknown MCP surface '${surface}'. Use compact or legacy.`);
  const allow = (flags.allowWrite ?? host.INSTANTLY_MCP_ALLOW_WRITES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const unknownCost = flags.allowUnknownCost === true || host.INSTANTLY_MCP_ALLOW_UNKNOWN_COST === '1';
  const playbooks = flags.playbooks === true || host.INSTANTLY_MCP_PLAYBOOKS === '1';
  const sensitive = (flags.allowSensitive ?? host.INSTANTLY_MCP_ALLOW_SENSITIVE ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (surface === 'legacy' && !playbooks && unknownCost) throw new Error('--allow-unknown-cost applies only to --surface compact or --playbooks.');
  if (surface === 'compact' && sensitive.length) throw new Error('--allow-sensitive applies only to the legacy surface; the compact surface never exports credentials.');
  const tier = flags.tier ?? host.INSTANTLY_TIER;
  if (tier !== undefined && tier !== '') resolveTier(tier); // a typo fails at startup and never widens access
  return { surface, allowWrites: allow, allowSensitive: sensitive, allowUnknownCost: unknownCost, profile: flags.profile, ...(playbooks ? { playbooks: true } : {}), ...(tier ? { tier } : {}) };
}
