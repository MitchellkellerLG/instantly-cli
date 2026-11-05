import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { directCommands } from '../commands/active.js';
import { buildAuthStatus } from '../commands/auth/status.js';
import { runHealth } from '../commands/health/index.js';
import { createCommandContext } from '../core/command-context.js';
import { isMutatingCommand } from '../core/mutating.js';
import { boundWorkspaceOf, displayProfileSlug, resolveCredentials } from '../core/auth.js';
import { fetchLiveWorkspace } from '../core/workspace.js';
import { ValidationError } from '../core/errors.js';
import { redactText, redactValue } from '../core/redact.js';
import { DEFAULT_POLICY, assertKnownIds, isExposed, isReviewedRead, policyFrom, requestsCredentials, type McpPolicy } from './policy.js';
import { startCompactMcpServer, type McpOptions } from './compact.js';
import { playbookServiceFor, registerPlaybooks } from './playbooks.js';

export type { McpOptions };

const MCP_READ_HINT =
  ' Read-only. This server is bound to one profile and workspace chosen by the operator at startup; call status to see them.';
const MCP_WRITE_HINT =
  ' Write enabled by the operator. Pass workspace_id equal to the workspace shown by status. This server is bound to one profile.';

const isolationShape = {
  workspace_id: z
    .string()
    .optional()
    .describe('Workspace UUID shown by status. Required on write tools; when passed it must match the live workspace.'),
  // Accepted only so a stray value is refused with a clear error; it can never select a credential.
  profile: z.string().optional().describe('Not selectable per call. The operator pins one profile at startup.'),
};

const toolText = (value: unknown, secrets: readonly string[], keepCredentialFields: boolean) => ({
  type: 'text' as const,
  text: redactText(
    JSON.stringify(keepCredentialFields ? value : redactValue(value, secrets), null, 2),
    secrets,
  ),
});

function errorResult(error: any, secrets: readonly string[]) {
  return {
    content: [{
      type: 'text' as const,
      text: redactText(JSON.stringify({ error: error?.message ?? String(error), code: error?.code ?? 'UNKNOWN_ERROR' }), secrets),
    }],
    isError: true,
  };
}

function isolationFromArgs(args: Record<string, unknown>): {
  profile?: string;
  workspace_id?: string;
  input: Record<string, unknown>;
} {
  const { profile, workspace_id, ...input } = args;
  return {
    profile: typeof profile === 'string' && profile.trim() ? profile.trim() : undefined,
    workspace_id: typeof workspace_id === 'string' ? workspace_id : undefined,
    input,
  };
}

/** The process binds to exactly one profile at startup; any other per-call profile is refused. */
export function assertPinnedProfile(requested: string | undefined, pinnedSlug: string | undefined): void {
  if (requested === undefined) return;
  if (requested === (pinnedSlug ?? 'default')) return;
  throw new ValidationError(
    `This MCP server is bound to profile '${pinnedSlug ?? 'default'}' and cannot switch to '${requested}'. ` +
      'Start a separate server for another profile.',
  );
}

export async function startMcpServer(options: McpOptions = {}): Promise<void> {
  // Legacy stays the default. Compact registers four tools and reads no credentials at startup.
  if (options.surface === 'compact') return startCompactMcpServer(options);
  const policy: McpPolicy = options.allowWrites || options.allowSensitive
    ? policyFrom(options.allowWrites, options.allowSensitive)
    : DEFAULT_POLICY;

  // Resolve one credential/profile binding for the life of the process. Fails fast when none exists.
  const pinned = await resolveCredentials({ profile: options.profile });
  const pinnedSlug = pinned.profile?.slug;
  const secrets = [pinned.apiKey];
  const asProfile = (requested: string | undefined) => {
    assertPinnedProfile(requested, pinnedSlug);
    return pinnedSlug;
  };

  const server = new McpServer({
    name: 'instantly',
    version: '0.1.22',
  });

  const all = directCommands();
  assertKnownIds(all, policy);
  const commands = all.filter(c => isExposed(c, policy));
  for (const cmdDef of commands) {
    // A POST that is on the reviewed read allowlist (for example leads_list) is a read, not a write.
    const mutating = !isReviewedRead(cmdDef) && isMutatingCommand(cmdDef);
    const shape = { ...cmdDef.inputSchema.shape, ...isolationShape };
    const keepCredentialFields = policy.allowSensitive.has(cmdDef.name);

    server.registerTool(
      cmdDef.name,
      {
        description: `${cmdDef.description}${mutating ? MCP_WRITE_HINT : MCP_READ_HINT}`,
        inputSchema: shape,
        annotations: {
          readOnlyHint: !mutating,
          ...(mutating ? { destructiveHint: true, idempotentHint: false } : {}),
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const { profile, workspace_id, input } = isolationFromArgs(args);
          const slug = asProfile(profile);
          if (requestsCredentials(cmdDef, input) && !keepCredentialFields) {
            throw new ValidationError(
              `${cmdDef.name} with credentials is disabled. The operator must opt in with --allow-sensitive ${cmdDef.name}.`,
            );
          }
          const { client } = await createCommandContext({
            profile: slug,
            workspace: workspace_id,
            mutating,
            requireWriteWorkspace: true,
            origin: cmdDef.origin,
          });
          const result = await cmdDef.handler(input, client);
          return { content: [toolText(result, secrets, keepCredentialFields)] };
        } catch (error: any) {
          return errorResult(error, secrets);
        }
      },
    );
  }

  if (options.playbooks) registerPlaybooks(server, playbookServiceFor(options));

  server.registerTool(
    'status',
    {
      description:
        'Show source, profile slug (or default), workspace_id, and workspace_name of the one profile this server is bound to.',
      inputSchema: { profile: isolationShape.profile },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: Record<string, unknown>) => {
      try {
        const { profile } = isolationFromArgs(args);
        const result = await buildAuthStatus({ profile: asProfile(profile) });
        return {
          content: [toolText(result, secrets, false)],
          isError: result.authenticated === false,
        };
      } catch (error: any) {
        return errorResult(error, secrets);
      }
    },
  );

  server.registerTool(
    'health',
    {
      description:
        'Read-only rollup of disconnected accounts, bounce totals, warmup status, and campaign sending status for the bound profile.',
      inputSchema: isolationShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: Record<string, unknown>) => {
      try {
        const { profile, workspace_id } = isolationFromArgs(args);
        const ctx = await createCommandContext({
          profile: asProfile(profile),
          workspace: workspace_id,
          mutating: false,
        });
        const report = await runHealth(ctx.client);
        const bound = boundWorkspaceOf(ctx.credentials);
        let live = ctx.liveWorkspace;
        if (!live) {
          try {
            live = await fetchLiveWorkspace(ctx.client);
          } catch {
            live = bound ? { id: bound.id, name: bound.name } : undefined;
          }
        }
        return {
          content: [
            toolText(
              {
                source: ctx.credentials.source,
                profile: displayProfileSlug(ctx.credentials),
                workspace_id: live?.id ?? bound?.id ?? null,
                workspace_name: live?.name ?? bound?.name ?? null,
                ...report,
              },
              secrets,
              false,
            ),
          ],
        };
      } catch (error: any) {
        return errorResult(error, secrets);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Instantly MCP server started. Tools registered:', commands.length + 2);
}
