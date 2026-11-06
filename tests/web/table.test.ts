import { describe, it, expect } from 'vitest';
import { allCommands } from '../../src/commands/index.js';
import { webCommands, webReadCommands } from '../../src/commands/web/index.js';
import { activeCommands } from '../../src/commands/active.js';
import { WEB_ROUTES } from '../../src/web/table.js';
import { effectPolicy } from '../../src/safe/policy.js';
import { createWebClient } from '../../src/web/client.js';
import policy from '../../src/safe/web-read-policy.json';

describe('web route table, registry and policy', () => {
  it('pins the reviewed web allowlist to the route table exactly (a new route needs a reviewed policy change)', () => {
    const expected = Object.fromEntries(WEB_ROUTES.map(r => [r.id, { method: 'GET', path: r.path }]));
    expect(policy).toEqual(expected);
    expect(Object.keys(policy)).toEqual([...Object.keys(policy)].sort());
  });
  it('classifies every web command read/no-cost and nothing in the table can be a write', () => {
    expect(webReadCommands).toHaveLength(WEB_ROUTES.length);
    for (const c of webReadCommands) {
      expect(c.origin).toBe('web');
      expect(c.endpoint.method).toBe('GET');
      expect(c.mutating).toBe(false);
      expect(effectPolicy(c)).toEqual({ effect: 'read', cost: 'none', notifications: false });
    }
  });
  it('an unlisted or retargeted web command is unknown, never a write', () => {
    const base = webReadCommands[0];
    expect(effectPolicy({ ...base, name: 'web_new_route' }).effect).toBe('unknown');
    expect(effectPolicy({ ...base, endpoint: { method: 'GET', path: '/backend-alt/api/v1/other' } }).effect).toBe('unknown');
    expect(effectPolicy({ ...base, endpoint: { method: 'POST', path: base.endpoint.path } }).effect).toBe('unknown');
  });
  it('routes stay on the two private families and never overlap the public registry', () => {
    for (const r of WEB_ROUTES) expect(r.path).toMatch(/^\/(backend-alt\/api\/v[12]|api-alt)\/[a-z0-9/_-]+$/);
    const publicNames = new Set(allCommands.map(c => c.name));
    expect(webCommands.filter(c => publicNames.has(c.name))).toEqual([]);
    expect(new Set(webCommands.map(c => c.name)).size).toBe(webCommands.length);
    expect(new Set(WEB_ROUTES.map(r => r.id)).size).toBe(WEB_ROUTES.length);
    expect(new Set(WEB_ROUTES.map(r => `${r.group} ${r.sub}`)).size).toBe(WEB_ROUTES.length);
  });
  it('joins the active registry only when an attended browser is configured', () => {
    expect(activeCommands({})).toBe(allCommands);
    expect(activeCommands({ INSTANTLY_WEB_BROWSER_URL: 'http://127.0.0.1:9222' })).toHaveLength(allCommands.length + webCommands.length);
  });
  it('rejects hostile argument values before any request exists', () => {
    const tasks = webReadCommands.find(c => c.name === 'web_crm_tasks_list')!;
    expect(tasks.inputSchema.safeParse({ status: 'Active&x=1' }).success).toBe(false);
    expect(tasks.inputSchema.safeParse({ status: '../../etc' }).success).toBe(false);
    expect(tasks.inputSchema.safeParse({ status: 'Active', limit: 5 }).success).toBe(true);
  });

  it.each([
    ['web_automation_workflows_list', 'starting_after', 'workflow/+==:cursor'],
    ['web_automation_apps_list', 'starting_after', 'app/+==:cursor'],
    ['web_automation_connections_list', 'starting_after', 'connection/+==:cursor'],
    ['web_integrations_directory_list', 'starting_after', 'directory/+==:cursor'],
    ['web_visitors_integrations_list', 'skip', 2000],
    ['web_crm_opportunities_list', 'skip', 2000],
    ['web_leadfinder_searches_list', 'skip', 2000],
    ['web_voice_suppressions_list', 'offset', 2000],
    ['web_copilot_artifacts_list', 'offset', 2000],
  ])('forwards continuation for %s through the generated command', async (name, field, value) => {
    const command = webReadCommands.find(c => c.name === name)!;
    const urls: string[] = [];
    const client = createWebClient({ async call(call) {
      urls.push(call.url);
      return { status: 200, json: name === 'web_leadfinder_searches_list' ? [] : { items: [], data: [], total: 0 } };
    } }, 'test-workspace');
    const input = command.inputSchema.parse({ [field]: value, limit: 5 });
    await command.handler(input, client);
    const query = new URL(urls[0], 'https://app.instantly.ai').searchParams;
    expect(query.get(field)).toBe(String(value));
    expect(query.get('limit')).toBe('5');
    if (name === 'web_integrations_directory_list') expect(query.get('surface')).toBe('settings');
    expect(command.cliMappings.options?.some(o => o.field === field)).toBe(true);
    expect(command.inputSchema.safeParse({ [field]: value, limit: 1001 }).success).toBe(false);
    if (typeof value === 'number') {
      for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(command.inputSchema.safeParse({ [field]: invalid }).success).toBe(false);
      }
    }
  });

});
