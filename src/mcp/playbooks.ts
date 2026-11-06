import { z } from 'zod';
import type { ResolvedCredentials } from '../core/auth.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, GetPromptRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { isCompactError, type CompactHost } from '../compact/surface.js';
import { createLiveHost } from '../compact/host.js';
import { MemoryPreviewStore } from '../safe/preview-store.js';
import { PlaybookService, isPlaybookFailure } from '../playbooks/service.js';
import { resolveTier } from '../playbooks/tiers.js';

const profile = z.string().min(1).max(100).describe('Profile slug this process is bound to. Use default if no profile is configured.');
const workspace = z.uuid().describe('Workspace UUID you expect. A mismatch sends nothing.');
const reply = (result: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result) }], ...((isCompactError(result) || isPlaybookFailure(result)) ? { isError: true } : {}) });

/** Shares the compact host when there is one, otherwise builds a lazy live host. Credentials resolve on first use. */
export function playbookServiceFor(options: { allowWrites?: string[]; allowUnknownCost?: boolean; profile?: string; tier?: string; credentials?: ResolvedCredentials }, shared?: CompactHost): PlaybookService {
  const host = shared ?? createLiveHost({ profile: options.profile, credentials: options.credentials, store: new MemoryPreviewStore(), allowedWrites: options.allowWrites, allowUnknownCost: options.allowUnknownCost });
  return new PlaybookService({ host: () => host, tier: resolveTier(options.tier, process.env.INSTANTLY_TIER) });
}

export const PLAYBOOK_TOOLS = ['playbooks_list', 'playbooks_describe', 'playbooks_preview', 'playbooks_run'] as const;

/** Four tools and one prompt per tier-visible playbook. Opt-in: the default surfaces are unchanged. Nothing is resolved at registration. */
export function registerPlaybooks(server: McpServer, service: PlaybookService): void {
  server.registerTool('playbooks_list', {
    description: `List the ${service.tier}-tier playbooks: ready-made plans over safe Instantly commands (offer profile, campaign ideas, segmentation, website visitors, local lookalike). Pass profile and workspace_id to rank them for this workspace by its detected offer. Read-only.`,
    inputSchema: z.object({ profile: profile.optional(), workspace_id: workspace.optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args: { profile?: string; workspace_id?: string }) => reply(await service.list(args.profile && args.workspace_id ? { profile: args.profile, workspace: args.workspace_id } : undefined)));
  server.registerTool('playbooks_describe', {
    description: 'Show one playbook: its input schema, what it requires, and the write ceiling of this tier. Needs no network.',
    inputSchema: z.object({ slug: z.string().min(1).max(60) }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args: { slug: string }) => reply(service.describe(args.slug)));
  server.registerTool('playbooks_preview', {
    description: 'Run a playbook\'s reads and computation and return its plan: the artifact, each single-request write it would make, the attended browser checklist and a one-use playbook_token. Sends no mutation and spends nothing.',
    inputSchema: z.object({ slug: z.string().min(1).max(60), input: z.record(z.string(), z.unknown()).default({}), profile, workspace_id: workspace }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args: { slug: string; input: Record<string, unknown>; profile: string; workspace_id: string }) =>
    reply(await service.preview(args.slug, args.input, { profile: args.profile, workspace: args.workspace_id })));
  server.registerTool('playbooks_run', {
    description: 'Execute a previewed playbook by its playbook_token only. Writes run one at a time in order, stop at the first failure and are never retried. Refused unless the host enabled every write in the plan. Never clicks in a browser.',
    inputSchema: z.object({ playbook_token: z.string().regex(/^[a-f0-9]{64}$/), profile, workspace_id: workspace }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (args: { playbook_token: string; profile: string; workspace_id: string }) =>
    reply(await service.run(args.playbook_token, { profile: args.profile, workspace: args.workspace_id })));

  const visible = service.visible();
  const renderPrompt = (name: string, args: { profile?: string; workspace_id?: string }) => {
    const playbook = visible.find(p => `playbooks/${p.slug}` === name);
    if (!playbook) throw new McpError(ErrorCode.InvalidParams, `Prompt ${name} not found`);
    return {
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: promptText(playbook.slug, playbook.title, playbook.description, playbook.requires, args.profile, args.workspace_id) } }],
    };
  };
  for (const playbook of visible) {
    server.registerPrompt(`playbooks/${playbook.slug}`, {
      title: playbook.title,
      description: playbook.description,
      argsSchema: { profile: z.string().optional(), workspace_id: z.string().optional() },
    }, args => renderPrompt(`playbooks/${playbook.slug}`, args));
  }
  // The SDK validates an omitted arguments object before optional fields. The
  // protocol schema validates supplied strings; normalize omission at this boundary.
  server.server.setRequestHandler(GetPromptRequestSchema, async request =>
    renderPrompt(request.params.name, request.params.arguments ?? {}));
}

export function promptText(slug: string, title: string, description: string, requires: string[], profileSlug = '<slug>', workspaceId = '<uuid>'): string {
  return [
    `Playbook: ${title}`, '', description, '',
    'How to run it safely:',
    `1. Confirm the workspace: playbooks need profile "${profileSlug}" and workspace_id ${workspaceId}. Call instantly status first if unsure.`,
    `2. Preview: call playbooks_preview with slug "${slug}", your input, profile and workspace_id. CLI: instantly --profile ${profileSlug} --workspace ${workspaceId} playbooks run ${slug}`,
    '3. Show the user the artifact, every planned write, the refusals and the attended browser checklist. A preview is a plan, not authorization.',
    '4. Only if the user approves and the preview returned a playbook_token, call playbooks_run with that token. If it returns WRITE_POLICY_DENIED, stop: the operator has not enabled those writes.',
    '5. Browser steps are a checklist for a human. Never click Save, Submit, Launch or Send for them.',
    '', `Requires: ${requires.join(', ')}.`,
  ].join('\n');
}
