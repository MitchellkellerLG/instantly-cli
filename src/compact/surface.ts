import { ZodError } from 'zod';
import type { SafeDispatcher, Scope } from '../safe/dispatcher.js';
import { Finder } from './find.js';
import { describeCommand, describeFeature, unknownCommand, type CompactError } from './describe.js';
import { buildFeatures, contextRevision, registryRevision } from './catalog.js';
import { describeInput, findInput, previewInput, runInput } from './tools.js';
import { VIRTUAL_IDS } from './catalog.js';

export interface CompactHost {
  dispatcher(count: () => void): Promise<SafeDispatcher>;
  status(scope: Scope): Promise<unknown>;
  health(scope: Scope, count: () => void): Promise<unknown>;
  allowedWrites: string[];
  allowUnknownCost: boolean;
}

const NEXT: Record<string, string> = {
  WORKSPACE_MISMATCH: 'Nothing was sent. Run command_id=status, confirm the profile and workspace with the user, then retry with the correct workspace_id.',
  PROFILE_MISMATCH: 'This process is bound to one profile. Use the profile reported by status; do not switch profiles.',
  MISSING_PREVIEW: 'Writes need a preview. Call instantly_preview first, then instantly_run mode=write with only its token.',
  INVALID_PREVIEW: 'The preview token is unknown, already used, or malformed. Call instantly_preview again.',
  EXPIRED_PREVIEW: 'The preview expired after five minutes. Call instantly_preview again.',
  STALE_PREVIEW: 'The workspace, policy or request changed since the preview. Call instantly_preview again.',
  WRITE_POLICY_DENIED: 'This host has not enabled this write. Ask the operator to allow it. Do not retry.',
  COST_POLICY_DENIED: 'This write has unknown cost and the host has not authorized that. Ask the operator.',
  ENTITLEMENT_DENIED: 'The host did not authorize this write.',
  READ_POLICY_DENIED: 'This command is not an approved read. Use instantly_preview for writes.',
  UNKNOWN_EFFECT: 'The effect of this command is not classified, so it cannot be previewed or run.',
  UNKNOWN_ARGUMENTS: 'Remove the unknown keys. Call instantly_describe for the exact input names.',
  UNKNOWN_EXECUTION_STATUS: 'The write may or may not have happened. Do not retry. Reconcile with a read, then preview again if needed.',
  UNSUPPORTED_MULTI_REQUEST: 'This command cannot be previewed safely because it makes several requests.',
  UNSUPPORTED_PASSWORD_EXPORT: 'Exporting passwords is not supported.',
  UNSUPPORTED_COMMAND: 'Call instantly_find to get a valid command ID.',
};

export function toError(error: unknown): CompactError {
  if (error instanceof ZodError) {
    const issues = error.issues.slice(0, 8).map(i => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
    return { error: { code: 'INVALID_ARGUMENTS', message: issues, next: 'Call instantly_describe for the exact input schema.' } };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  const match = raw.match(/^([A-Z][A-Z_]+)(?::\s*(.*))?$/s);
  const id = match ? match[1] : typeof code === 'string' ? code : 'UNKNOWN_ERROR';
  return { error: { code: id, message: match && match[2] ? match[2] : raw, ...(NEXT[id] ? { next: NEXT[id] } : {}) } };
}
export const isCompactError = (value: unknown): value is CompactError =>
  !!value && typeof value === 'object' && 'error' in value && Object.keys(value).length === 1;

/** One implementation behind the four MCP tools and the four CLI commands. Never throws. */
export class CompactSurface {
  readonly registry = registryRevision();
  constructor(readonly finder: Finder = new Finder(), private host?: () => CompactHost) {}
  private features = () => buildFeatures(this.finder.context);
  get contextRevision(): string { return contextRevision(this.finder.context); }

  find(input: unknown) {
    try {
      const { intent, limit, effect } = findInput.parse(input);
      return { ...this.finder.find(intent, limit, effect), registry_revision: this.registry, context_revision: this.contextRevision };
    } catch (error) { return toError(error); }
  }
  describe(input: unknown) {
    try {
      const { command_id } = describeInput.parse(input);
      const entry = this.finder.catalog.find(c => c.id === command_id);
      if (entry) return describeCommand(entry, this.finder, this.registry);
      const feature = this.features().find(f => f.id === command_id);
      if (feature) return describeFeature(feature, this.registry, this.finder);
      return unknownCommand(command_id, this.finder);
    } catch (error) { return toError(error); }
  }
  async preview(input: unknown) {
    try {
      const { command_id, arguments: args, profile, workspace_id } = previewInput.parse(input);
      if ((VIRTUAL_IDS as readonly string[]).includes(command_id)) {
        return { error: { code: 'NOT_A_WRITE', message: `${command_id} is a read command; nothing to preview.`, next: 'Use instantly_run mode=read.' } };
      }
      if (!this.finder.catalog.some(c => c.id === command_id)) {
        return this.features().some(f => f.id === command_id) ? this.unavailable(command_id) : unknownCommand(command_id, this.finder);
      }
      const host = this.requireHost();
      const dispatcher = await host.dispatcher(() => {});
      const { plan, token } = await dispatcher.preview(command_id, args, { profile, workspace: workspace_id });
      const warnings: string[] = [];
      if (plan.effect.effect === 'read') warnings.push('This is a read; instantly_run mode=read does not need a preview.');
      if (plan.effect.cost === 'unknown') warnings.push('Cost is unknown. Credits may be spent when this executes.');
      if (plan.effect.notifications === true) warnings.push('This sends an external email or notification when executed.');
      if (plan.effect.effect === 'write' && !host.allowedWrites.includes(command_id)) warnings.push('The host has not enabled this write. Execution will be refused until the operator allows it.');
      return {
        command_id, preview_token: token, expires_in_seconds: 300,
        effect: plan.effect, profile: plan.identity.profile,
        workspace: { id: plan.identity.workspace, name: plan.identity.workspaceName },
        arguments: plan.arguments, requests: plan.requests,
        prerequisites: plan.prerequisites, warnings,
        next: { tool: 'instantly_run', arguments: { mode: 'write', preview_token: token, profile, workspace_id } },
        note: 'A preview is a plan, not authorization. Nothing was sent.',
      };
    } catch (error) { return toError(error); }
  }
  async run(input: unknown) {
    try {
      const raw = input as { mode?: unknown; preview_token?: unknown } | null;
      if (raw && typeof raw === 'object' && raw.mode === 'write' && (raw.preview_token === undefined || raw.preview_token === '')) throw new Error('MISSING_PREVIEW');
      const parsed = runInput.parse(input);
      const scope: Scope = { profile: parsed.profile, workspace: parsed.workspace_id };
      const host = this.requireHost();
      let requests = 0;
      const count = () => { requests++; };
      if (parsed.mode === 'write') {
        const dispatcher = await host.dispatcher(count);
        const result = await dispatcher.write(parsed.preview_token, scope);
        return { mode: 'write', result, audit: this.audit(requests, scope, 'write') };
      }
      const id = parsed.command_id;
      if (!this.finder.catalog.some(c => c.id === id)) {
        return this.features().some(f => f.id === id) ? this.unavailable(id) : unknownCommand(id, this.finder);
      }
      let result: unknown;
      if (id === 'status' || id === 'health') {
        if (Object.keys(parsed.arguments).length) throw new Error('UNKNOWN_ARGUMENTS: ' + Object.keys(parsed.arguments).join(','));
        result = await (id === 'status' ? host.status(scope) : host.health(scope, count));
      } else {
        result = await (await host.dispatcher(count)).read(id, parsed.arguments, scope);
      }
      return { mode: 'read', command_id: id, result, audit: this.audit(requests, scope, 'read') };
    } catch (error) { return toError(error); }
  }
  private audit(requests: number, scope: Scope, effect: string) {
    return { profile: scope.profile, workspace_id: scope.workspace, effect,
      requests,
      registry_revision: this.registry, context_revision: this.contextRevision };
  }
  private unavailable(id: string): CompactError {
    return { error: { code: 'UNAVAILABLE_FEATURE', message: `${id} has no supported command.`, next: 'Tell the user it is unavailable. Do not guess an endpoint or use a browser fallback.' } };
  }
  private requireHost(): CompactHost {
    if (!this.host) throw new Error('NO_EXECUTION_HOST');
    return this.host();
  }
}
