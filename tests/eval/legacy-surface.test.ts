import { it, expect, vi, beforeEach } from 'vitest';
const tools = vi.hoisted(() => [] as string[]);
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(name: string) { tools.push(name); }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('../../src/core/auth.js', () => ({
  resolveCredentials: async () => ({ apiKey: 'synthetic-not-a-credential' }),
  boundWorkspaceOf: vi.fn(), displayProfileSlug: vi.fn(),
}));
import { startMcpServer } from '../../src/mcp/server.js';
import { allCommands } from '../../src/commands/index.js';
import { isReviewedRead } from '../../src/mcp/policy.js';
import { isMutatingCommand } from '../../src/core/mutating.js';

beforeEach(() => { tools.length = 0; });

it('registers only the reviewed read allowlist plus status and health by default', async () => {
  await startMcpServer();
  const reads = allCommands.filter(isReviewedRead).map(c => c.name);
  expect(reads.length).toBeGreaterThan(50);
  expect(tools).toEqual([...reads, 'status', 'health']);
  for (const command of allCommands.filter(c => isMutatingCommand(c) && !isReviewedRead(c))) expect(tools, command.name).not.toContain(command.name);
  for (const risky of ['campaigns_activate', 'email_reply', 'api_keys_create', 'api_keys_list', 'workspace_change-owner']) expect(tools).not.toContain(risky);
});

it('adds exactly the operator-allowed commands and rejects typos at startup', async () => {
  await startMcpServer({ allowWrites: ['campaigns_activate'], allowSensitive: ['api_keys_list'] });
  expect(tools).toContain('campaigns_activate');
  expect(tools).toContain('api_keys_list');
  expect(tools).not.toContain('email_reply');
  await expect(startMcpServer({ allowWrites: ['campaigns_activte'] })).rejects.toThrow(/Unknown command id/);
});
