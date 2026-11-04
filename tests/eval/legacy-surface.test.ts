import { it, expect, vi } from 'vitest';
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
import baseline from '../../evals/v1/baseline/registry.json';
it('retains the 276 existing MCP registrations and adds 13 public operations without credentials or network', async () => {
  await startMcpServer();
  expect(tools).toEqual([...allCommands.map(c => c.name), 'status', 'health']);
  expect(tools).toHaveLength(289);
  expect(new Set(tools).size).toBe(289);
  for (const command of baseline) expect(tools).toContain(command.id);
});
