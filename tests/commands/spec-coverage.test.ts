import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { allCommands, registerAllCommands } from '../../src/commands/index.js';
import { generatedCommands } from '../../src/commands/generated/index.js';
import { createSpecCommand } from '../../src/core/spec-command.js';
import { InstantlyClient } from '../../src/core/client.js';
import { isMutatingCommand } from '../../src/core/mutating.js';
import { commandSpec, coverage, operations, resolve, operationKey } from '../../scripts/openapi.js';
import { Command } from 'commander';

const exec = promisify(execFile);

const spec = JSON.parse(readFileSync(new URL('../../spec/api_v2.json', import.meta.url), 'utf8'));
const uuid = '01a1891e-6582-72d0-81dd-79c45db816ca';
const client = () => new InstantlyClient({ apiKey: 'mock-only', maxRetries: 0 });
afterEach(() => vi.unstubAllGlobals());

function mockHttp(text = '{"ok":true}', contentType = 'application/json') {
  const fetchMock = vi.fn().mockResolvedValue(new Response(text, { headers: { 'content-type': contentType } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function command(id: string) {
  const op = operations(spec).find(o => o.operationId === id)!;
  return createSpecCommand(commandSpec(spec, op));
}

describe('public API coverage and generator', () => {
  it('covers 268/268 operations and explicitly labels the 15 off-spec endpoints', () => {
    const report = coverage(spec, allCommands);
    expect(report).toMatchObject({ total: 268, covered: 268, missing: [] });
    expect(report.undocumented).toHaveLength(15);
    for (const c of allCommands.filter(c => report.undocumented.includes(operationKey(c.endpoint.method, c.endpoint.path)))) {
      expect(c.description).toContain('[Undocumented API]');
    }
    expect(generatedCommands).toHaveLength(116);
  });

  it('detects spec additions and missing methods, normalizing path parameter names and slashes', () => {
    const added = { ...spec, paths: { ...spec.paths, '/api/v2/new-resource/{resource}': { get: { operationId: 'newResource' } } } };
    expect(coverage(added, allCommands).missing).toEqual(['GET /new-resource/{}']);
    expect(operationKey('get', '/api/v2/leads/{lead_id}/')).toBe('GET /leads/{}');
    expect(coverage(spec, allCommands.filter(c => c.endpoint.method !== 'PUT')).missing).toEqual(['PUT /domains/{}/forwarding']);
  });

  it('the drift-check executable exits nonzero for a newly added operation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'instantly-drift-'));
    try {
      const file = join(directory, 'spec.json');
      writeFileSync(file, JSON.stringify({ openapi: '3.0.0', paths: { '/api/v2/new-resource': { get: { operationId: 'newResource' } } } }));
      const result = await exec(process.execPath, ['--import', 'tsx', 'scripts/spec-drift.ts', file], { encoding: 'utf8' }).catch(error => error);
      expect(result.code, result.stderr).toBe(1);
      expect(JSON.parse(result.stdout).missing).toEqual(['GET /new-resource']);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('resolves request refs and rejects external, missing and cyclic refs', () => {
    expect(resolve({ defs: { x: { type: 'string' } } }, { $ref: '#/defs/x' })).toEqual({ type: 'string' });
    for (const ref of ['https://example.org/schema', '#/missing']) expect(() => resolve({}, { $ref: ref })).toThrow();
    expect(() => resolve({ x: { $ref: '#/x' } }, { $ref: '#/x' })).toThrow();
  });

  it('keeps every generated identity, endpoint and input schema deterministic', () => {
    for (const cmd of generatedCommands) {
      const op = operations(spec).find(o => operationKey(o.method, o.path) === operationKey(cmd.endpoint.method, cmd.endpoint.path))!;
      const generated = createSpecCommand(commandSpec(spec, op));
      expect(generated.name).toBe(cmd.name);
      expect(generated.endpoint).toEqual(cmd.endpoint);
      // MCP's real schema consumer uses input mode. All tools must be describable.
      expect(z.toJSONSchema(cmd.inputSchema, { io: 'input' }).type).toBe('object');
      expect(isMutatingCommand(cmd)).toBe(cmd.endpoint.method !== 'GET');
    }
  });

  it('registers generated OAuth commands on the existing CLI group', () => {
    const program = new Command();
    registerAllCommands(program);
    const oauth = program.commands.filter(c => c.name() === 'oauth');
    expect(oauth).toHaveLength(1);
    expect(oauth[0].commands.map(c => c.name())).toContain('init-google-oauth');
    expect(oauth[0].commands.map(c => c.name())).toContain('connect');
  });
});

describe('generated requests use mocked HTTP only', () => {
  it.each([
    ['listAgentItems', {}],
    ['getDomainForwarding', { domain: 'example.com' }],
    ['initGoogleOAuth', {}],
    ['initMicrosoftOAuth', {}],
    ['getOAuthSessionStatus', { sessionId: uuid }],
    ['listSalesAgents', {}],
    ['listInboxManagerAgents', {}],
    ['listLeadFinderAgents', {}],
    ['getDeliverabilityAgent', {}],
    ['listCompanyLists', {}],
    ['listSavedSearches', {}],
    ['getIntegrationProviders', {}],
    ['getSubsequenceAnalytics', { campaign_id: uuid }],
    ['shareCampaign', { id: uuid }],
    ['cancelCurrentWorkspaceRemoval', {}],
    ['pauseAccounts', { body: { emails: ['sender@example.com'] } }],
    ['sendTestEmail', { body: { eaccount: 'sender@example.com', to_address_email_list: 'lead@example.com', subject: 'Test', body: { html: 'Hello' } } }],
    ['updateLeadInterestStatus', { body: { lead_email: 'lead@example.com', interest_value: 1 } }],
  ])('%s routes parameters and method to the public spec endpoint', async (id, input) => {
    const fetchMock = mockHttp();
    const cmd = command(id);
    await cmd.handler(input, client());
    const [url, request] = fetchMock.mock.calls[0];
    expect(request.method).toBe(cmd.endpoint.method);
    let expected = cmd.endpoint.path;
    for (const [key, value] of Object.entries(input)) expected = expected.replace(`{${key}}`, encodeURIComponent(String(value)));
    expect(new URL(url).pathname).toBe(`/api/v2${expected}`);
    if ('body' in input) expect(JSON.parse(request.body)).toEqual(input.body);
  });

  it('sends PUT forwarding with a JSON body and marks it as mutating', async () => {
    const fetchMock = mockHttp();
    const cmd = command('updateDomainForwarding');
    await cmd.handler({ domain: 'example.com', body: '{"forwarding_domain":"destination.com"}' }, client());
    expect(isMutatingCommand(cmd)).toBe(true);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: '{"forwarding_domain":"destination.com"}' });
  });

  it('serializes array filters as repeated query parameters', async () => {
    const fetchMock = mockHttp();
    await command('listSalesAgentActivities').handler({ id: uuid, action_status: '["pending","approved"]', limit: '2' }, client());
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.getAll('action_status')).toEqual(['pending', 'approved']);
    expect(url.searchParams.get('limit')).toBe('2');
  });

  it('returns CSV download text without JSON parsing', async () => {
    mockHttp('email\nblocked@example.com\n', 'text/csv');
    expect(await command('downloadBlockListEntry').handler({}, client())).toBe('email\nblocked@example.com\n');
  });

  it('rejects malformed JSON, absent required fields and invalid enum values before HTTP', async () => {
    const fetchMock = mockHttp();
    const cmd = command('updateDomainForwarding');
    for (const body of ['{broken', {}, { forwarding_domain: 'example.com', forwarding_mode: 'invalid' }]) {
      await expect(cmd.handler({ domain: 'example.com', body }, client())).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts union-typed date query values without treating them as JSON strings', async () => {
    const fetchMock = mockHttp();
    const cmd = createSpecCommand({ name: 'date', group: 'test', subcommand: 'date', description: 'date', endpoint: { method: 'GET', path: '/date' },
      parameters: [{ name: 'date', field: 'date', location: 'query', required: true, description: 'date', schema: { anyOf: [{ type: 'string', format: 'date' }, { type: 'string', format: 'date-time' }] } }] });
    await cmd.handler({ date: '2026-10-29' }, client());
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('date')).toBe('2026-10-29');
  });

  it('enforces conditional schemas while preserving property names that resemble schema keywords', async () => {
    const fetchMock = mockHttp();
    const cmd = createSpecCommand({ name: 'test', group: 'test', subcommand: 'test', description: 'test', endpoint: { method: 'POST', path: '/test' }, parameters: [],
      bodyRequired: true, body: { type: 'object', properties: { if: { type: 'string' }, flag: { type: 'boolean' }, value: { type: 'string' } },
        if: { properties: { flag: { const: true } }, required: ['flag'] }, then: { required: ['value'] } } });
    await expect(cmd.handler({ body: { flag: true } }, client())).rejects.toThrow();
    await cmd.handler({ body: { flag: false, if: 'preserved' } }, client());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ flag: false, if: 'preserved' });
  });
});
