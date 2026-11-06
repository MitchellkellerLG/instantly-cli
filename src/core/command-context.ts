import { InstantlyClient } from './client.js';
import { ValidationError } from './errors.js';
import { webClientFor } from '../web/browser-client.js';
import { resolveCredentials, type ResolvedCredentials } from './auth.js';
import {
  assertProfileWorkspace,
  assertWorkspaceMatchesLive,
  assertWriteWorkspace,
  fetchLiveWorkspace,
  type LiveWorkspace,
} from './workspace.js';

export interface CommandContextOptions {
  apiKey?: string;
  credentials?: ResolvedCredentials;
  profile?: string;
  workspace?: string;
  mutating: boolean;
  /** MCP: a write must carry the workspace UUID on every path, including the default single-key path. */
  requireWriteWorkspace?: boolean;
  /** 'web' swaps the HTTP client for the attended-browser client, bound to the API key's live workspace. */
  origin?: 'api' | 'web';
}

export interface CommandContext {
  client: InstantlyClient;
  credentials: ResolvedCredentials;
  liveWorkspace?: LiveWorkspace;
}

/**
 * Build the HTTP client for a single command invocation.
 * One process, one workspace: a selected profile is verified against the live
 * workspace, and writes also require an explicit matching --workspace UUID.
 * When `--workspace` is passed on any path, live id must match that flag.
 */
export async function createCommandContext(opts: CommandContextOptions): Promise<CommandContext> {
  const context = await createApiContext(opts);
  if (opts.origin !== 'web') return context;
  // The API key proves the workspace; the browser session must be on that same workspace or nothing is sent.
  const live = context.liveWorkspace ?? await fetchLiveWorkspace(context.client);
  return { ...context, liveWorkspace: live, // Web handlers only call request/get; the class-only members (paginate) are never reached for origin web.
    client: webClientFor(live.id) as unknown as InstantlyClient };
}

async function createApiContext(
  opts: CommandContextOptions,
): Promise<CommandContext> {
  const credentials = opts.credentials ?? await resolveCredentials({
    apiKey: opts.apiKey,
    profile: opts.profile,
  });
  const client = new InstantlyClient({ apiKey: credentials.apiKey });
  const workspaceFlag = opts.workspace?.trim() || undefined;

  if (credentials.profile) {
    const liveWorkspace = await assertProfileWorkspace(client, credentials.profile);
    if (opts.mutating) {
      assertWriteWorkspace(credentials.profile, workspaceFlag);
    }
    if (workspaceFlag) {
      assertWorkspaceMatchesLive(liveWorkspace, workspaceFlag);
    }
    return { client, credentials, liveWorkspace };
  }

  const bound = opts.credentials?.boundWorkspace;
  if (opts.mutating && opts.requireWriteWorkspace && !workspaceFlag) {
    throw new ValidationError('Write tools require workspace_id matching the workspace shown by status.');
  }
  if (!workspaceFlag && !bound) return { client, credentials };

  const liveWorkspace = await fetchLiveWorkspace(client);
  if (bound) assertWorkspaceMatchesLive(liveWorkspace, bound.id);
  if (workspaceFlag) assertWorkspaceMatchesLive(liveWorkspace, workspaceFlag);
  return { client, credentials, liveWorkspace };
}
