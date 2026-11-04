import { z } from 'zod';
import type { CommandDefinition, InstantlyClient } from '../core/types.js';
import { canonical, clone, digest } from './canonical.js';
import { effectPolicy, POLICY_VERSION } from './policy.js';
import type { PreviewStore } from './preview-store.js';
import { assertLocalPath, clientFromRequest, type Request } from './transport.js';

export interface Identity {
  profile: string;
  workspace: string;
  workspaceName: string;
  /** Opaque host-owned reference, never an API key. */
  credentialRef: string;
}
export interface Scope { profile: string; workspace: string }
export interface DispatcherOptions {
  commands: CommandDefinition[];
  bound: Identity;
  /** Must re-fetch the live identity, not echo caller arguments. */
  identity: () => Promise<Identity>;
  client: InstantlyClient;
  store: PreviewStore;
  registryRevision: string;
  contextRevision: string;
  now?: () => number;
  /** Host authorization. Default denies all executions of writes. */
  allowedWrites?: string[];
  allowUnknownCost?: boolean;
  /** Host must recheck current entitlement/authorization at execution time. */
  authorizeWrite?: (command: string, identity: Identity) => Promise<boolean>;
  /** Each prerequisite path must be audited harmless, including GET effects. */
  prerequisiteAllowed?: (command: string, request: Request) => boolean;
  event?: (event: DispatchEvent) => void;
}
export interface DispatchEvent {
  type: 'identity' | 'preview' | 'consume' | 'request' | 'refusal';
  command?: string;
  detail: unknown;
}
interface Plan {
  command: string;
  arguments: Record<string, unknown>;
  identity: Identity;
  effect: ReturnType<typeof effectPolicy>;
  requests: Request[];
  prerequisites: { request: Request; responseHash: string }[];
}
export function validateArguments(command: CommandDefinition, input: Record<string, unknown>): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_ARGUMENTS');
  const unknown = Object.keys(input).filter(key => !Object.hasOwn(command.inputSchema.shape, key));
  if (unknown.length) throw new Error('UNKNOWN_ARGUMENTS: ' + unknown.join(','));
  const args = command.inputSchema.parse(clone(input));
  if (args.with_passwords === true) throw new Error('UNSUPPORTED_PASSWORD_EXPORT');
  return args;
}

/** No credential resolution or real transport creation. CLI/MCP adapters inject one bound context. */
export class SafeDispatcher {
  private now: () => number;
  private commands: Map<string, CommandDefinition>;
  private options: DispatcherOptions;
  constructor(options: DispatcherOptions) {
    this.options = { ...options, bound: clone(options.bound), allowedWrites: [...(options.allowedWrites ?? [])] };
    this.commands = new Map(options.commands.map(c => [c.name, c]));
    this.now = options.now ?? Date.now;
  }
  private command(id: string): CommandDefinition {
    const command = this.commands.get(id);
    if (!command) throw new Error('UNSUPPORTED_COMMAND');
    return command;
  }
  private emit(type: DispatchEvent['type'], detail: unknown, command?: string): void {
    this.options.event?.({ type, detail: clone(detail), command });
  }
  private async identity(scope: Scope): Promise<Identity> {
    if (!scope || Object.keys(scope).some(k => !['profile', 'workspace'].includes(k))) throw new Error('INVALID_SCOPE');
    if (!scope.profile || !z.uuid().safeParse(scope.workspace).success ||
        scope.profile !== this.options.bound.profile || scope.workspace !== this.options.bound.workspace) {
      throw new Error('WORKSPACE_MISMATCH');
    }
    const live = await this.options.identity();
    if (live.profile !== scope.profile || live.workspace !== scope.workspace ||
        live.credentialRef !== this.options.bound.credentialRef) throw new Error('WORKSPACE_MISMATCH');
    this.emit('identity', live);
    return clone(live);
  }
  private binding(identity: Identity): string {
    return digest({ identity, registry: this.options.registryRevision, context: this.options.contextRevision,
      policy: POLICY_VERSION, allowedWrites: this.options.allowedWrites, allowUnknownCost: this.options.allowUnknownCost === true });
  }
  private async prepare(command: CommandDefinition, args: Record<string, unknown>, identity: Identity): Promise<{ plan: Plan; execute: () => Promise<unknown> }> {
    const effect = effectPolicy(command);
    if (effect.effect === 'unknown') throw new Error('UNKNOWN_EFFECT');
    const requests: Request[] = [];
    const prerequisites: Plan['prerequisites'] = [];
    const responses: unknown[] = [];
    let captureFailure = false;
    const capture = clientFromRequest(async <T>(request: Request): Promise<T> => {
      try {
        assertLocalPath(request);
        if (request.method === 'GET' && this.options.prerequisiteAllowed?.(command.name, request)) {
          // Never allow reads after a planned write; their result cannot be known at preview time.
          if (requests.length) { captureFailure = true; throw new Error('UNSUPPORTED_MULTI_REQUEST'); }
          const response = await this.options.client.request(request);
          prerequisites.push({ request: clone(request), responseHash: digest(response ?? null) });
          responses.push(structuredClone(response));
          return response as T;
        }
        if (requests.length || (request.method === 'GET' && effect.effect === 'write')) {
          captureFailure = true;
          throw new Error('UNSUPPORTED_MULTI_REQUEST');
        }
        const pattern = '^' + command.endpoint.path.split(/(\{[^}]+\})/).map(part =>
          part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$';
        if (request.method !== command.endpoint.method || !new RegExp(pattern).test(request.path)) {
          captureFailure = true; throw new Error('UNSUPPORTED_REQUEST_PLAN');
        }
        requests.push(clone(request));
        // Handlers may decorate their result; no transport or mutation occurs here.
        return {} as T;
      } catch (error) { captureFailure = true; throw error; }
    });
    await command.handler(clone(args), capture);
    if (captureFailure || requests.length !== 1) throw new Error('UNSUPPORTED_MULTI_REQUEST');
    const plan = { command: command.name, arguments: clone(args), identity, effect, requests, prerequisites };
    const execute = async () => {
      let index = 0;
      let failure: unknown;
      const client = clientFromRequest(async <T>(request: Request): Promise<T> => {
        try {
          const position = index++;
          const expected = position < prerequisites.length ? prerequisites[position].request : requests[position - prerequisites.length];
          if (!expected || canonical(request) !== canonical(expected)) throw new Error('CHANGED_REQUEST_PLAN');
          if (position < prerequisites.length) return structuredClone(responses[position]) as T;
          return await this.send(request, command.name) as T;
        } catch (error) { failure = error; throw error; }
      });
      const result = await command.handler(clone(args), client);
      if (failure) throw failure;
      if (index !== prerequisites.length + requests.length) throw new Error('CHANGED_REQUEST_PLAN');
      return result;
    };
    return { plan, execute };
  }
  async preview(id: string, input: Record<string, unknown>, scope: Scope): Promise<{ plan: Plan; token: string }> {
    const command = this.command(id);
    const args = validateArguments(command, input); // before identity/credentials
    const identity = await this.identity(scope);
    const { plan } = await this.prepare(command, args, identity);
    this.options.store.prune(this.now());
    const token = this.options.store.issue({ expires: this.now() + 300_000, binding: this.binding(identity),
      command: id, args, planHash: digest(plan) });
    this.emit('preview', { plan, planHash: digest(plan) }, id);
    return { plan, token };
  }
  async read(id: string, input: Record<string, unknown>, scope: Scope): Promise<unknown> {
    const command = this.command(id);
    const args = validateArguments(command, input);
    const effect = effectPolicy(command);
    if (effect.effect !== 'read' || effect.cost !== 'none') throw new Error('READ_POLICY_DENIED');
    await this.identity(scope);
    // Handler preparation captures the exact allowed request without executing it.
    const prepared = await this.prepare(command, args, this.options.bound);
    return prepared.execute();
  }
  private async send(request: Request, id: string): Promise<unknown> {
    assertLocalPath(request);
    this.emit('request', request, id);
    return this.options.client.request({ ...clone(request), retry: 'never' });
  }
  async write(token: string, scope: Scope, envelope?: never): Promise<unknown> {
    if (envelope !== undefined) throw new Error('CHANGED_ARGUMENTS');
    if (!token) throw new Error('MISSING_PREVIEW');
    const record = this.options.store.peek(token);
    if (record.expires <= this.now()) throw new Error('EXPIRED_PREVIEW');
    const command = this.command(record.command);
    if (!this.options.allowedWrites?.includes(record.command) || effectPolicy(command).effect !== 'write') {
      throw new Error('WRITE_POLICY_DENIED');
    }
    if (effectPolicy(command).cost === 'unknown' && !this.options.allowUnknownCost) throw new Error('COST_POLICY_DENIED');
    const identity = await this.identity(scope);
    if (record.binding !== this.binding(identity)) throw new Error('STALE_PREVIEW');
    if (!await this.options.authorizeWrite?.(record.command, identity)) throw new Error('ENTITLEMENT_DENIED');
    const args = validateArguments(command, record.args);
    const { plan, execute } = await this.prepare(command, args, identity);
    if (record.planHash !== digest(plan) || canonical(record.args) !== canonical(args)) throw new Error('STALE_PREVIEW');
    // Recheck clock after asynchronous identity/prerequisite work.
    if (record.expires <= this.now()) throw new Error('EXPIRED_PREVIEW');
    this.options.store.consume(token); // synchronous atomic claim before any mutation
    this.emit('consume', { planHash: record.planHash }, record.command);
    try { return await execute(); }
    catch { throw new Error('UNKNOWN_EXECUTION_STATUS: reconcile with a read before previewing again'); }
  }
}
