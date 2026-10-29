import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const home = await mkdtemp(join(tmpdir(), 'instantly-coverage-smoke-'));
const workspace = '11111111-1111-4111-8111-111111111111';
const loader = resolve('tests/fixtures/mock-api.mjs');
await mkdir(join(home, 'profiles'));
await writeFile(join(home, 'profiles', 'mock.json'), JSON.stringify({ api_key: 'mock-only', workspace_id: workspace, workspace_name: 'Mock workspace' }));
// These script-local variables isolate authentication from any real credentials.
const env = { ...process.env, INSTANTLY_HOME: home, INSTANTLY_PROFILE: 'mock', INSTANTLY_API_KEY: '' };
function cli(args: string[], success = true) {
  const result = spawnSync(process.execPath, ['--import', loader, resolve('dist/index.js'), ...args], { env, encoding: 'utf8' });
  assert.equal(result.status, success ? 0 : 1, result.stderr);
  return JSON.parse(success ? result.stdout : result.stderr);
}
try {
  assert.equal(cli(['saved-searches', 'list-saved-searches']).items[0].name, 'Mock search');
  console.log('PASS built CLI: generated saved-searches read');
  const write = ['domains', 'update-domain-forwarding', '--domain', 'example.com', '--body', '{"forwarding_domain":"destination.com"}'];
  assert.equal(cli(['--workspace', workspace, ...write]).forwarding_domain, 'destination.com');
  console.log('PASS built CLI: PUT forwarding with bound workspace');
  assert.ok(cli(write, false).error);
  assert.ok(cli(['--workspace', '22222222-2222-4222-8222-222222222222', ...write], false).error);
  console.log('PASS built CLI: refuses missing and mismatching workspace');
  const client = new Client({ name: 'coverage-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', loader, resolve('dist/mcp.js')], env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'domains_update_domain_forwarding'));
    assert.ok(tools.some(t => t.name === 'saved_searches_list_saved_searches'));
    console.log(`PASS built MCP: lists ${tools.length} tools including generated commands`);
    const read = await client.callTool({ name: 'saved_searches_list_saved_searches', arguments: { profile: 'mock' } });
    assert.notEqual(read.isError, true);
    const result = await client.callTool({ name: 'domains_update_domain_forwarding', arguments: { profile: 'mock', workspace_id: workspace, domain: 'example.com', body: { forwarding_domain: 'destination.com' } } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const refused = await client.callTool({ name: 'domains_update_domain_forwarding', arguments: { profile: 'mock', domain: 'example.com', body: { forwarding_domain: 'destination.com' } } });
    assert.equal(refused.isError, true);
    console.log('PASS built MCP: generated read/write and workspace refusal over stdio');
  } finally { await client.close(); }
} finally { await rm(home, { recursive: true, force: true }); }
