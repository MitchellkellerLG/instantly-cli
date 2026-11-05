import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgram } from '../../src/program.js';
import { CompactSurface } from '../../src/compact/surface.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const SYNTHETIC = 'synthetic-test-value-not-a-real-key';

let out: string[]; let err: string[];
beforeEach(() => {
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  process.exitCode = undefined;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); process.exitCode = undefined; });
const cli = (...args: string[]) => createProgram().parseAsync(['node', 'instantly', ...args]);

describe('CLI mirror parity with the shared surface', () => {
  it.each(['help', 'README.md', 'SKILL.md'])('%s find examples discover campaigns first', async source => {
    // Published examples are executable documentation. The campaigns-listing
    // contract requires campaigns_list first, rejecting empty or unrelated hits.
    let documentation = '';
    if (source === 'help') {
      createProgram().commands.find(command => command.name() === 'find')!
        .configureOutput({ writeOut: text => { documentation += text; } }).outputHelp();
    } else {
      documentation = readFileSync(new URL(`../../${source}`, import.meta.url), 'utf8');
    }
    const examples = [...documentation.matchAll(/instantly find "([^"]+)"((?: --(?:limit|effect) \w+)*)/g)];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      out.length = 0;
      await cli('find', example[1], ...example[2].trim().split(/\s+/).filter(Boolean));
      expect(err).toEqual([]);
      expect(process.exitCode).toBeUndefined();
      expect(JSON.parse(out[0]).hits[0]).toMatchObject({
        id: 'campaigns_list', effect: 'read', runnable: true,
      });
    }
  });
  it('find prints exactly what instantly_find returns', async () => {
    for (const query of ['list campaigns', 'pause a sending account', 'crm opportunity pipeline']) {
      out.length = 0;
      await cli('find', ...query.split(' '), '--limit', '4', '--effect', 'any');
      expect(JSON.parse(out[0])).toEqual(new CompactSurface().find({ intent: query, limit: 4, effect: 'any' }));
    }
  });
  it('describe prints exactly what instantly_describe returns', async () => {
    await cli('describe', 'email_list');
    expect(JSON.parse(out[0])).toEqual(new CompactSurface().describe({ command_id: 'email_list' }));
  });
  it('rejects bad find input with the same typed error', async () => {
    await cli('find', 'x', '--limit', '99');
    expect(JSON.parse(err[0]).error.code).toBe('INVALID_ARGUMENTS');
    expect(process.exitCode).toBe(1);
  });
  it.each([
    ['find', 'x', '--limit', '99'],
    ['describe', 'not_a_command'],
    ['--profile', 'sandbox', '--workspace', workspace, 'preview', 'campaigns_update', '--args', '[1]'],
    ['--profile', 'sandbox', '--workspace', workspace, 'run', '--mode', 'write'],
  ])('quiet suppresses errors from %s while retaining failure status', async (...args) => {
    await cli('--quiet', ...args);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
  it.each([
    ['find', 'list', 'campaigns'],
    ['describe', 'campaigns_list'],
  ])('quiet suppresses successful %s output', async (...args) => {
    await cli('--quiet', ...args);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
  it('requires an explicit profile and workspace for preview and run', async () => {
    await cli('run', 'status', '--mode', 'read');
    expect(JSON.parse(err[0]).error.code).toBe('PROFILE_REQUIRED');
    err.length = 0;
    await cli('--profile', 'sandbox', 'run', 'status', '--mode', 'read');
    expect(JSON.parse(err[0]).error.code).toBe('WORKSPACE_REQUIRED');
  });
  it('refuses a write run without a token and mixed shapes, before any key is read', async () => {
    await cli('--profile', 'sandbox', '--workspace', workspace, 'run', '--mode', 'write');
    expect(JSON.parse(err[0]).error.code).toBe('MISSING_PREVIEW');
    err.length = 0;
    await cli('--profile', 'sandbox', '--workspace', workspace, 'run', 'campaigns_list', '--mode', 'write', '--preview-token', 'a'.repeat(64));
    expect(JSON.parse(err[0]).error.code).toBe('INVALID_ARGUMENTS');
  });
  it('rejects conflicting or malformed argument input', async () => {
    await cli('--profile', 'sandbox', '--workspace', workspace, 'preview', 'campaigns_update', '--args', '{}', '--args-file', '/nope');
    expect(JSON.parse(err[0]).error.message).toMatch(/mutually exclusive/);
    err.length = 0;
    await cli('--profile', 'sandbox', '--workspace', workspace, 'preview', 'campaigns_update', '--args', '[1]');
    expect(JSON.parse(err[0]).error.message).toMatch(/one JSON object/);
  });
});

describe('CLI preview then run across two invocations, transport faked', () => {
  it('previews with no mutation, then executes once under an explicit operator allowance', async () => {
    const home = mkdtempSync(join(tmpdir(), 'instantly-cli-compact-'));
    vi.stubEnv('INSTANTLY_HOME', home);
    vi.stubEnv('INSTANTLY_API_KEY', SYNTHETIC);
    vi.stubEnv('INSTANTLY_PROFILE', 'client-a');
    const calls: { method: string; path: string; body?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { method: string; body?: string }) => {
      const path = new URL(url).pathname.replace('/api/v2', '');
      calls.push({ method: init.method, path, body: init.body });
      const body = path === '/workspaces/current' ? { id: workspace, name: 'Synthetic' } : { id, name: 'Renamed' };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const argsFile = join(home, 'args.json');
    writeFileSync(argsFile, JSON.stringify({ id, name: 'Renamed' }));
    const base = ['--profile', 'default', '--workspace', workspace];

    await cli(...base, 'run', 'status', '--mode', 'read');
    expect(err).toEqual([]);
    expect(JSON.parse(out[0]).result).toMatchObject({ profile: 'default', matches_expected: true });
    out.length = 0;
    await cli(...base, 'run', 'campaigns_get', '--mode', 'read', '--args', JSON.stringify({ id }));
    expect(err).toEqual([]);
    expect(JSON.parse(out[0]).result).toMatchObject({ id });
    out.length = 0;

    await cli(...base, 'preview', 'campaigns_update', '--args-file', argsFile, '--allow-write', 'campaigns_update');
    expect(err).toEqual([]);
    const preview = JSON.parse(out[0]);
    expect(preview.preview_token).toMatch(/^[a-f0-9]{64}$/);
    expect(calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    expect(readdirSync(join(home, 'previews')).some(f => f.startsWith(preview.preview_token))).toBe(true);

    out.length = 0;
    await cli(...base, 'run', '--mode', 'write', '--preview-token', preview.preview_token);
    expect(JSON.parse(err[0]).error.code).toBe('WRITE_POLICY_DENIED');
    expect(calls.filter(c => c.method !== 'GET')).toHaveLength(0);

    err.length = 0;
    await cli(...base, 'run', '--mode', 'write', '--preview-token', preview.preview_token, '--allow-write', 'campaigns_update');
    expect(JSON.parse(out[0]).audit).toMatchObject({ effect: 'write', requests: 1 });
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([{ method: 'PATCH', path: `/campaigns/${id}`, body: JSON.stringify({ name: 'Renamed' }) }]);

    out.length = 0; err.length = 0;
    await cli(...base, 'run', '--mode', 'write', '--preview-token', preview.preview_token, '--allow-write', 'campaigns_update');
    expect(JSON.parse(err[0]).error.code).toBe('INVALID_PREVIEW');
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(1);

    out.length = 0; err.length = 0;
    await cli(...base, 'preview', 'campaigns_update', '--args-file', argsFile, '--allow-write', 'campaigns_update');
    const beforeRotation = JSON.parse(out[0]).preview_token;
    vi.stubEnv('INSTANTLY_API_KEY', 'synthetic-rotated-test-key');
    out.length = 0;
    await cli(...base, 'run', '--mode', 'write', '--preview-token', beforeRotation, '--allow-write', 'campaigns_update');
    expect(JSON.parse(err[0]).error.code).toBe('STALE_PREVIEW');
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });
});

describe('help and discovery need no key', () => {
  const exec = promisify(execFile);
  const clean = (home: string) => ({ PATH: process.env.PATH ?? '', HOME: home, INSTANTLY_HOME: join(home, '.instantly') });
  const run = (args: string[]) => {
    const home = mkdtempSync(join(tmpdir(), 'instantly-help-'));
    return exec(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], { cwd: process.cwd(), env: clean(home), encoding: 'utf8', timeout: 60_000 });
  };
  it.each([['--help'], ['find', '--help'], ['describe', '--help'], ['preview', '--help'], ['run', '--help'], ['mcp', '--help']])('%s exits 0 from an empty environment', async (...args) => {
    const r = await run(args);
    expect(r.stdout.length).toBeGreaterThan(50);
  }, 60_000);
  it('find and describe print JSON from an empty environment', async () => {
    const found = await run(['find', 'list', 'unread', 'replies', '--effect', 'read']);
    expect(JSON.parse(found.stdout).hits.length).toBeGreaterThan(0);
    const described = await run(['describe', 'campaigns_list']);
    expect(JSON.parse(described.stdout).id).toBe('campaigns_list');
  }, 60_000);
  it('mcp help documents the surface switch', async () => {
    expect((await run(['mcp', '--help'])).stdout).toMatch(/--surface <name>[\s\S]*compact/);
  }, 60_000);
});
