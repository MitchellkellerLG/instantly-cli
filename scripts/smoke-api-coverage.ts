import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_POLICY, isExposed, policyFrom } from '../src/mcp/policy.js';
import { directCommands } from '../src/commands/active.js';
import { allCommands } from '../src/commands/index.js';
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
  const hook = ['webhooks', 'create', '--url', 'https://example.com/hook', '--custom-interest-value', '3', '--headers', '{"X-Example":"value"}'];
  assert.deepEqual(cli(['--workspace', workspace, ...hook]).request, {
    target_hook_url: 'https://example.com/hook', custom_interest_value: 3, headers: { 'X-Example': 'value' },
  });
  assert.ok(cli(hook, false).error);
  assert.deepEqual(cli(['--workspace', workspace, 'webhooks', 'update', 'mock-hook', '--headers', '{"X-Example":"updated"}']).request,
    { headers: { 'X-Example': 'updated' } });
  console.log('PASS built CLI: webhook headers/custom labels with profile write confirmation');
  assert.deepEqual(cli(['workspace-members', 'list', '--accepted', 'false', '--limit', '20', '--starting-after', 'cursor']).query,
    { accepted: 'false', limit: '20', starting_after: 'cursor' });
  const account = ['accounts', 'create', '--email', 'sender@example.com', '--smtp-host', 'smtp.example.com', '--smtp-port', '587',
    '--smtp-username', 'mock', '--smtp-password', 'mock', '--imap-host', 'imap.example.com', '--imap-port', '993',
    '--imap-username', 'mock', '--imap-password', 'mock', '--warmup', '{"limit":30}', '--provider-code', '1', '--enable-slow-ramp'];
  const created = cli(['--workspace', workspace, ...account]).request;
  assert.deepEqual(created.warmup, { limit: 30 });
  assert.equal(created.provider_code, 1);
  assert.equal(created.enable_slow_ramp, true);
  assert.deepEqual(cli(['--workspace', workspace, 'accounts', 'warmup-enable', '--account-ids', 'one, two']).request,
    { account_ids: ['one', 'two'] });
  assert.deepEqual(cli(['--workspace', workspace, 'leads', 'move', '--lead-ids', '["one","two"]', '--from-campaign-id', 'source', '--to-campaign-id', 'target']).request,
    { ids: ['one', 'two'], campaign: 'source', to_campaign_id: 'target' });
  assert.deepEqual(cli(['leads', 'list', '--campaign-id', 'source']).request, { campaign: 'source', limit: 10 });
  const ai = cli(['--workspace', workspace, 'enrichment', 'ai', '--resource-id', 'resource', '--output-column', 'result',
    '--resource-type', '1', '--model-version', 'mock-model', '--template-id', 'template-example']);
  assert.equal(ai.request.template_id, 'template-example');
  const reply = cli(['--workspace', workspace, 'email', 'reply', '--reply-to-uuid', 'mock-thread', '--to', 'lead@example.com',
    '--eaccount', 'sender@example.com', '--subject', 'Re: Hello', '--body-text', 'Hello', '--reminder-ts', '2026-11-01T10:00:00Z', '--assigned-to', workspace]);
  assert.equal(reply.request.reminder_ts, '2026-11-01T10:00:00Z');
  assert.equal(reply.request.assigned_to, workspace);
  assert.equal(reply.__confirmed_recipient, 'lead@example.com');
  console.log('PASS built CLI: member filters, account settings, array flags, lead list/move, string template IDs, reply reminder/assignment');
  const delta = JSON.parse(readFileSync('evals/public-delta-v1/fixtures.json', 'utf8')).fixtures;
  for (const fixture of delta) {
    const command = allCommands.find(c => c.name === fixture.context.command)!;
    const args = Object.entries(fixture.context.arguments).flatMap(([key, value]) =>
      [`--${key.replace(/_/g, '-')}`, typeof value === 'string' ? value : JSON.stringify(value)]);
    const invocation = [command.group, command.subcommand, ...args];
    assert.deepEqual(cli(['--workspace', workspace, ...invocation]), fixture.response);
    if (command.mutating) assert.ok(cli(invocation, false).error);
  }
  console.log('PASS built CLI: all 13 new public operations and conservative POST workspace guards');
  const mcpEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const defaultClient = new Client({ name: 'coverage-default-policy', version: '1.0.0' });
  try {
    await defaultClient.connect(new StdioClientTransport({ command: process.execPath,
      args: ['--import', loader, resolve('dist/mcp.js')],
      env: { ...mcpEnv, INSTANTLY_MCP_ALLOW_WRITES: '', INSTANTLY_MCP_ALLOW_SENSITIVE: '' } }));
    const { tools } = await defaultClient.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [...directCommands().filter(c => isExposed(c, DEFAULT_POLICY)).map(c => c.name), 'status', 'health'].sort());
    assert.ok(!tools.some(t => t.name === 'domains_update_domain_forwarding'));
    const denied = await defaultClient.callTool({ name: 'domains_update_domain_forwarding',
      arguments: { workspace_id: workspace, domain: 'example.com', body: { forwarding_domain: 'destination.com' } } });
    assert.equal(denied.isError, true);
    console.log('PASS built MCP: default policy hides and refuses writes');
  } finally { await defaultClient.close(); }
  const allowWrites = [...new Set(['domains_update_domain_forwarding', 'webhooks_create', 'accounts_warmup_enable', 'accounts_create',
    ...delta.map((fixture: any) => fixture.context.command)])];
  const client = new Client({ name: 'coverage-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', loader, resolve('dist/mcp.js')], env: { ...mcpEnv, INSTANTLY_MCP_ALLOW_WRITES: allowWrites.join(','), INSTANTLY_MCP_ALLOW_SENSITIVE: '' } });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'domains_update_domain_forwarding'));
    assert.ok(tools.some(t => t.name === 'saved_searches_list_saved_searches'));
    console.log(`PASS built MCP: lists ${tools.length} tools including generated commands`);
    assert.deepEqual(tools.map(t => t.name).sort(), [...directCommands().filter(c => isExposed(c, policyFrom(allowWrites))).map(c => c.name), 'status', 'health'].sort());
    for (const fixture of delta) {
      assert.ok(tools.some(t => t.name === fixture.context.command));
      const response = await client.callTool({ name: fixture.context.command,
        arguments: { profile: 'mock', workspace_id: workspace, ...fixture.context.arguments } });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      assert.deepEqual(JSON.parse((response.content as Array<{ text: string }>)[0].text), fixture.response);
    }
    console.log('PASS built MCP: all 13 new public operations over stdio against independent synthetic fixtures');
    const read = await client.callTool({ name: 'saved_searches_list_saved_searches', arguments: { profile: 'mock' } });
    assert.notEqual(read.isError, true);
    const result = await client.callTool({ name: 'domains_update_domain_forwarding', arguments: { profile: 'mock', workspace_id: workspace, domain: 'example.com', body: { forwarding_domain: 'destination.com' } } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const refused = await client.callTool({ name: 'domains_update_domain_forwarding', arguments: { profile: 'mock', domain: 'example.com', body: { forwarding_domain: 'destination.com' } } });
    assert.equal(refused.isError, true);
    console.log('PASS built MCP: generated read/write and workspace refusal over stdio');
    const call = async (name: string, args: Record<string, unknown>, success = true) => {
      const result = await client.callTool({ name, arguments: { profile: 'mock', ...args } });
      if (success) assert.notEqual(result.isError, true, JSON.stringify(result));
      else { assert.equal(result.isError, true); return undefined; }
      return JSON.parse((result.content as Array<{ text: string }>)[0].text);
    };
    const nativeHook = await call('webhooks_create', { workspace_id: workspace, target_hook_url: 'https://example.com/hook', custom_interest_value: 3, headers: { 'X-Example': 'native' } });
    assert.deepEqual(nativeHook.request.headers, { 'X-Example': 'native' });
    await call('webhooks_create', { target_hook_url: 'https://example.com/hook' }, false);
    await call('webhooks_create', { workspace_id: workspace, target_hook_url: 'https://example.com/hook', headers: [] }, false);
    const warmup = await call('accounts_warmup_enable', { workspace_id: workspace, account_ids: ['one', 'two'] });
    assert.deepEqual(warmup.request.account_ids, ['one', 'two']);
    const members = await call('workspace_members_list', { accepted: false, limit: 20 });
    assert.deepEqual(members.query, { accepted: 'false', limit: '20' });
    const nativeAccount = await call('accounts_create', { workspace_id: workspace, email: 'sender@example.com',
      smtp_host: 'smtp.example.com', smtp_port: 587, smtp_username: 'mock', smtp_password: 'mock',
      imap_host: 'imap.example.com', imap_port: 993, imap_username: 'mock', imap_password: 'mock', warmup: { limit: 30 } });
    assert.deepEqual(nativeAccount.request.warmup, { limit: 30 });
    console.log('PASS built MCP: native objects/arrays, false filter, invalid headers and missing-workspace refusal');
  } finally { await client.close(); }
} finally { await rm(home, { recursive: true, force: true }); }
