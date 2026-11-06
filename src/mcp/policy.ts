import type { CommandDefinition } from '../core/types.js';
import { effectPolicy } from '../safe/policy.js';
import { isMutatingCommand } from '../core/mutating.js';
import { ValidationError } from '../core/errors.js';

/**
 * Operator policy for the legacy one-tool-per-command MCP surface.
 * It is set by flags or environment on the process that starts the server. A model can never widen it:
 * no tool argument reaches this object.
 */
export interface McpPolicy {
  /** Command ids registered as writes. Each call still needs a matching workspace_id. */
  allowWrites: ReadonlySet<string>;
  /** Command ids that may return credential material (password and key reads). */
  allowSensitive: ReadonlySet<string>;
}

export const DEFAULT_POLICY: McpPolicy = { allowWrites: new Set(), allowSensitive: new Set() };

export function parseIds(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

export function policyFrom(allowWrites: readonly string[] = [], allowSensitive: readonly string[] = []): McpPolicy {
  return { allowWrites: new Set(allowWrites), allowSensitive: new Set(allowSensitive) };
}

/** A read on the frozen, reviewed read allowlist. GET alone grants nothing. */
export function isReviewedRead(command: CommandDefinition): boolean {
  const effect = effectPolicy(command);
  return effect.effect === 'read' && effect.cost === 'none';
}

/** Inputs that ask the API to return credentials. Never allowed unless the operator opted the command in. */
export function requestsCredentials(command: CommandDefinition, input: Record<string, unknown>): boolean {
  return command.name === 'dfy_orders_list_accounts' && input.with_passwords === true;
}

export function isExposed(command: CommandDefinition, policy: McpPolicy): boolean {
  return isReviewedRead(command) || policy.allowWrites.has(command.name) || (!isMutatingCommand(command) && policy.allowSensitive.has(command.name));
}

/** A typo in an operator allowance fails at startup rather than silently doing nothing. */
export function assertKnownIds(commands: readonly CommandDefinition[], policy: McpPolicy): void {
  const known = new Set(commands.map(c => c.name));
  const unknown = [...policy.allowWrites, ...policy.allowSensitive].filter(id => !known.has(id));
  if (unknown.length) throw new ValidationError(`Unknown command id(s) in MCP allowance: ${unknown.join(', ')}`);
}
