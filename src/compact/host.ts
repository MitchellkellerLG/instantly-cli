import { InstantlyClient } from '../core/client.js';
import { boundWorkspaceOf, displayProfileSlug, resolveCredentials, type ResolvedCredentials } from '../core/auth.js';
import { assertProfileWorkspace, fetchLiveWorkspace } from '../core/workspace.js';
import { WorkspaceMismatchError } from '../core/errors.js';
import { buildAuthStatus } from '../commands/auth/status.js';
import { runHealth } from '../commands/health/index.js';
import { activeCommands } from '../commands/active.js';
import { digest } from '../safe/canonical.js';
import { SafeDispatcher, type Identity, type Scope } from '../safe/dispatcher.js';
import type { PreviewStore } from '../safe/preview-store.js';
import type { Request } from '../safe/transport.js';
import type { InstantlyClient as ClientShape } from '../core/types.js';
import { contextRevision, defaultContext, registryRevision, type Context } from './catalog.js';
import type { CompactHost } from './surface.js';
import { webClientFor } from '../web/browser-client.js';

/** Only reply and forward read the original message to resolve recipients. */
export function prerequisiteAllowed(command: string, request: Request): boolean {
  return ['email_reply', 'email_forward'].includes(command) && request.method === 'GET' &&
    /^\/emails\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.path);
}

const HEALTH_PATHS = new Set(['/accounts', '/campaigns', '/campaigns/analytics/overview']);
/** GET-only view over three fixed paths. health may not reach anything else. */
export function healthClient(client: ClientShape, count: () => void): InstantlyClient {
  const get = async <T>(path: string, query?: Record<string, unknown>): Promise<T> => {
    if (!HEALTH_PATHS.has(path)) throw new Error('READ_POLICY_DENIED');
    count();
    return client.get<T>(path, query);
  };
  async function* paginate<T>(options: { method: 'GET' | 'POST'; path: string; limit?: number }): AsyncGenerator<T[], void, undefined> {
    if (options.method !== 'GET') throw new Error('READ_POLICY_DENIED');
    let cursor: string | undefined;
    while (true) {
      const response = await get<{ items?: T[]; next_starting_after?: string }>(options.path, { limit: options.limit ?? 10, starting_after: cursor });
      if (response.items?.length) yield response.items;
      if (!response.next_starting_after || !response.items?.length) break;
      cursor = response.next_starting_after;
    }
  }
  const denied = () => { throw new Error('READ_POLICY_DENIED'); };
  return { get, paginate, request: denied, post: denied, patch: denied, delete: denied } as unknown as InstantlyClient;
}

export interface LiveHostOptions {
  profile?: string;
  apiKey?: string;
  credentials?: ResolvedCredentials;
  store: PreviewStore;
  allowedWrites?: string[];
  allowUnknownCost?: boolean;
  context?: Context;
}

/**
 * Real credentials and transport, resolved only on first execution. find and describe
 * never reach this object. One process serves one profile; the profile is fixed here.
 */
export function createLiveHost(options: LiveHostOptions): CompactHost {
  const allowedWrites = [...(options.allowedWrites ?? [])];
  const allowUnknownCost = options.allowUnknownCost === true;
  let ready: Promise<{ bound: Identity; slug: string; client: ClientShape; credentials: ResolvedCredentials; live: () => Promise<Identity> }> | undefined;

  const ensure = () => ready ??= (async () => {
    const credentials = options.credentials ?? await resolveCredentials({ apiKey: options.apiKey, profile: options.profile });
    const client = new InstantlyClient({ apiKey: credentials.apiKey });
    const slug = displayProfileSlug(credentials);
    let bound = boundWorkspaceOf(credentials);
    const credentialRef = digest({ source: credentials.source, profile: slug, apiKey: credentials.apiKey });
    const live = async (): Promise<Identity> => {
      const workspace = credentials.profile ? await assertProfileWorkspace(client, credentials.profile) : await fetchLiveWorkspace(client);
      if (bound && workspace.id !== bound.id) throw new WorkspaceMismatchError(`Workspace ${workspace.id} does not match the bound workspace ${bound.id}.`);
      return { profile: slug, workspace: workspace.id, workspaceName: workspace.name, credentialRef };
    };
    const first = await live();
    bound ??= { id: first.workspace, name: first.workspaceName ?? '' };
    return { bound: first, slug, client, live, credentials: { ...credentials, boundWorkspace: bound } };
  })().catch(error => { ready = undefined; throw error; });

  return {
    allowedWrites, allowUnknownCost,
    async dispatcher(count) {
      const { bound, live, client } = await ensure();
      return new SafeDispatcher({
        commands: activeCommands(), bound, identity: live, client, store: options.store,
        webClient: webClientFor(bound.workspace),
        registryRevision: registryRevision(), contextRevision: contextRevision(options.context ?? defaultContext),
        allowedWrites, allowUnknownCost, authorizeWrite: async command => allowedWrites.includes(command),
        prerequisiteAllowed, event: event => { if (event.type === 'request') count(); },
      });
    },
    async status(scope: Scope) {
      const { credentials } = await ensure();
      const status = await buildAuthStatus({ credentials });
      const matches = status.authenticated === true && status.profile === scope.profile && status.workspace_id === scope.workspace;
      return { ...status, expected: { profile: scope.profile, workspace_id: scope.workspace }, matches_expected: matches,
        ...(matches ? {} : { warning: 'Expected profile/workspace does not match. Do not run writes. Ask the user to confirm the workspace.' }) };
    },
    async health(scope: Scope, count) {
      const { slug, client, live } = await ensure();
      const identity = await live();
      if (scope.profile !== slug || scope.workspace !== identity.workspace) throw new Error('WORKSPACE_MISMATCH');
      const report = await runHealth(healthClient(client, count));
      return { source: 'compact', profile: slug, workspace_id: identity.workspace, workspace_name: identity.workspaceName, ...report };
    },
  };
}
