import type { CommandDefinition } from '../core/types.js';
import readPolicy from './read-policy.json';
import webReadPolicy from './web-read-policy.json';
import webActionPolicy from './web-action-policy.json';
import { digest } from './canonical.js';

export interface EffectPolicy {
  effect: 'read' | 'write' | 'unknown';
  cost: 'none' | 'unknown';
  notifications: boolean | 'unknown';
}

// Frozen semantic allowlist, independent of the legacy mutating heuristic.
// New commands and changed endpoints require explicit review; GET alone grants nothing.
const READS: Record<string, { method: string; path: string }> = readPolicy;
// Private HTTP routes allow reads only; attended UI actions have a separate allowlist.
const WEB_READS: Record<string, { method: string; path: string }> = webReadPolicy;
const NO_COST_WRITES = new Set(['campaigns_update', 'email_reply', 'email_forward']);
const WEB_ACTIONS = new Set(webActionPolicy);
const UNSAFE_GETS = new Set(['accounts_test_vitals']);
export const POLICY_VERSION = digest({ version: 'safe-dispatch-v3-web-reads', reads: READS, webReads: WEB_READS, webActions: [...WEB_ACTIONS],
  noCostWrites: [...NO_COST_WRITES], unsafe: [...UNSAFE_GETS] });
export function effectPolicy(command: CommandDefinition): EffectPolicy {
  if (command.origin === 'web') {
    // Only declared attended actions may classify as web writes; private HTTP mutations stay unknown.
    if (WEB_ACTIONS.has(command.name) && command.endpoint.method === 'POST' && command.endpoint.path === `/browser-action/${command.name}`) {
      // Navigation and prefill need preview and host enablement. The human submits; typing may trigger app search.
      return { effect: 'write', cost: 'none', notifications: false };
    }
    const web = WEB_READS[command.name];
    return web?.method === command.endpoint.method && web.path === command.endpoint.path
      ? { effect: 'read', cost: 'none', notifications: false }
      : { effect: 'unknown', cost: 'unknown', notifications: 'unknown' };
  }
  const read = READS[command.name];
  if (read?.method === command.endpoint.method && read.path === command.endpoint.path) {
    return { effect: 'read', cost: 'none', notifications: false };
  }
  if (command.endpoint.method === 'GET' || UNSAFE_GETS.has(command.name)) return { effect: 'unknown', cost: 'unknown', notifications: 'unknown' };
  return { effect: 'write', cost: NO_COST_WRITES.has(command.name) ? 'none' : 'unknown',
    notifications: ['email_reply', 'email_forward'].includes(command.name) ? true : 'unknown' };
}
