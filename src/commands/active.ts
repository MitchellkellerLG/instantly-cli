import type { CommandDefinition } from '../core/types.js';
import { WEB_BROWSER_ENV } from '../web/cdp.js';
import { allCommands } from './index.js';
import { webCommands } from './web/index.js';

/**
 * The public registry is frozen by its evals. Private web-app commands join only when an attended browser is
 * configured, so the default API registry and its frozen registry revision stay unchanged.
 */
/** Legacy direct-execution surfaces (CLI groups, legacy MCP) have no preview step, so browser actions never appear there. */
export function directCommands(env: Record<string, string | undefined> = process.env): CommandDefinition[] {
  return activeCommands(env).filter(c => !(c.origin === 'web' && c.mutating));
}
export function activeCommands(env: Record<string, string | undefined> = process.env): CommandDefinition[] {
  return env[WEB_BROWSER_ENV] ? [...allCommands, ...webCommands] : allCommands;
}
