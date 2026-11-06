import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const resolver = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/core/auth.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/auth.js')>()),
  resolveCredentials: async () => { resolver.count++; throw new Error('key resolution must not happen here'); },
}));
import { createCompactServer, mcpOptionsFrom } from '../../src/mcp/compact.js';
import { allCommands } from '../../src/commands/index.js';

async function connect(): Promise<Client> {
  const server = createCompactServer({});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}
const text = (r: any) => JSON.parse(r.content[0].text);
const scope = { profile: 'sandbox', workspace_id: '11111111-1111-4111-8111-111111111111' };
beforeEach(() => { resolver.count = 0; });

describe('compact MCP surface', () => {
  it('registers exactly the four tools and server instructions, resolving no key at startup', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['instantly_find', 'instantly_describe', 'instantly_preview', 'instantly_run']);
    expect(tools.every(t => t.inputSchema.type === 'object')).toBe(true);
    expect(tools.find(t => t.name === 'instantly_run')?.annotations?.destructiveHint).toBe(true);
    expect(client.getInstructions()).toMatch(/instantly_find/);
    expect(resolver.count).toBe(0);
  });
  it('serves find and describe offline for registry commands', async () => {
    const client = await connect();
    const found = text(await client.callTool({ name: 'instantly_find', arguments: { intent: 'pause a sending account', limit: 3 } }));
    expect(found.hits.length).toBeLessThanOrEqual(3);
    for (const command of allCommands.slice(0, 40)) {
      const d = text(await client.callTool({ name: 'instantly_describe', arguments: { command_id: command.name } }));
      expect(d.id).toBe(command.name);
    }
    expect(resolver.count).toBe(0);
  });
  it('rejects unknown envelope keys and mixed run shapes before any execution', async () => {
    const client = await connect();
    const bad: any = await client.callTool({ name: 'instantly_find', arguments: { intent: 'x', extra: 1 } });
    expect(bad.isError).toBe(true);
    const mixed: any = await client.callTool({ name: 'instantly_run', arguments: { mode: 'write', preview_token: 'a'.repeat(64), command_id: 'x', ...scope } });
    expect(text(mixed).error.code).toBe('INVALID_ARGUMENTS');
    const missing: any = await client.callTool({ name: 'instantly_run', arguments: { mode: 'write', ...scope } });
    expect(text(missing).error.code).toBe('MISSING_PREVIEW');
    expect(missing.isError).toBe(true);
    expect(resolver.count).toBe(0);
  });
  it('returns a typed error, not a crash, when execution needs a key', async () => {
    const client = await connect();
    const r: any = await client.callTool({ name: 'instantly_run', arguments: { mode: 'read', command_id: 'campaigns_list', arguments: {}, ...scope } });
    expect(resolver.count).toBeGreaterThan(0);
    expect(r.isError).toBe(true);
    expect(text(r).error.code).toBeTruthy();
  });
});

describe('surface switch', () => {
  it('parses flags and environment, defaults to legacy, and refuses unknown values', () => {
    expect(mcpOptionsFrom({}, {}).surface).toBe('legacy');
    expect(mcpOptionsFrom({}, { INSTANTLY_MCP_SURFACE: 'compact' }).surface).toBe('compact');
    expect(mcpOptionsFrom({ surface: 'compact', allowWrite: 'campaigns_update, email_reply' }, {}).allowWrites).toEqual(['campaigns_update', 'email_reply']);
    expect(() => mcpOptionsFrom({ surface: 'tiny' }, {})).toThrow(/Unknown MCP surface/);
    expect(mcpOptionsFrom({ surface: 'legacy', allowWrite: 'campaigns_update' }, {}).allowWrites).toEqual(['campaigns_update']);
    expect(mcpOptionsFrom({}, { INSTANTLY_MCP_ALLOW_SENSITIVE: 'api_keys_list' }).allowSensitive).toEqual(['api_keys_list']);
    expect(() => mcpOptionsFrom({ surface: 'legacy', allowUnknownCost: true }, {})).toThrow(/only to --surface compact/);
    expect(() => mcpOptionsFrom({ surface: 'compact', allowSensitive: 'api_keys_list' }, {})).toThrow(/legacy surface/);
  });
});

describe('compact MCP over stdio from a clean environment', () => {
  it('starts without any key and lists four tools', async () => {
    const home = mkdtempSync(join(tmpdir(), 'instantly-mcp-'));
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', 'src/mcp.ts'], cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: home, INSTANTLY_HOME: join(home, '.instantly'), INSTANTLY_MCP_SURFACE: 'compact' }, stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name)).toEqual(['instantly_find', 'instantly_describe', 'instantly_preview', 'instantly_run']);
      const found = text(await client.callTool({ name: 'instantly_find', arguments: { intent: 'list campaigns' } }));
      expect(found.hits[0].id).toBe('campaigns_list');
    } finally { await client.close(); }
  }, 60_000);
});
