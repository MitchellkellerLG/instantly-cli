import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MemoryPreviewStore } from '../safe/preview-store.js';
import { CompactSurface, isCompactError } from '../compact/surface.js';
import { createLiveHost } from '../compact/host.js';
import { defaultContext, type Context } from '../compact/catalog.js';
import { Finder } from '../compact/find.js';
import { describeShape, findShape, previewShape, runShape } from '../compact/tools.js';

export interface McpOptions {
  surface?: 'compact' | 'legacy';
  /** Command IDs the operator allows to execute as writes after a preview. Default none. */
  allowWrites?: string[];
  allowUnknownCost?: boolean;
  profile?: string;
}

const reply = (result: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
  return server;
}

export async function startCompactMcpServer(options: McpOptions = {}): Promise<void> {
  const server = createCompactServer(options);
  await server.connect(new StdioServerTransport());
  console.error('Instantly MCP server started (compact surface). Tools registered: 4');
}

/** Flags win over the host-provided environment. An unknown surface is an error, never a silent fallback. */
export function mcpOptionsFrom(
  flags: { surface?: string; allowWrite?: string; allowUnknownCost?: boolean; profile?: string },
  host: Record<string, string | undefined> = process.env,
): McpOptions {
  const surface = flags.surface ?? host.INSTANTLY_MCP_SURFACE ?? 'legacy';
  if (surface !== 'compact' && surface !== 'legacy') throw new Error(`Unknown MCP surface '${surface}'. Use compact or legacy.`);
  const allow = (flags.allowWrite ?? host.INSTANTLY_MCP_ALLOW_WRITES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const unknownCost = flags.allowUnknownCost === true || host.INSTANTLY_MCP_ALLOW_UNKNOWN_COST === '1';
  if (surface === 'legacy' && (allow.length || unknownCost)) throw new Error('Write allowances apply only to --surface compact.');
  return { surface, allowWrites: allow, allowUnknownCost: unknownCost, profile: flags.profile };
}
