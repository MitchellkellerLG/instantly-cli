import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import { webCommands, webReadCommands } from '../../src/commands/web/index.js';
import { webActionCommands } from '../../src/commands/web/actions.js';
import { directCommands, activeCommands } from '../../src/commands/active.js';
import { SCREENS, WEB_ACTIONS, resolveAction } from '../../src/web/actions.js';
import { actionScript, createCdpTransport } from '../../src/web/cdp.js';
import { createWebClient } from '../../src/web/client.js';
import { effectPolicy } from '../../src/safe/policy.js';
import { SafeDispatcher } from '../../src/safe/dispatcher.js';
import { MemoryPreviewStore } from '../../src/safe/preview-store.js';
import { clientFromRequest } from '../../src/safe/transport.js';
import { TIER_POLICY } from '../../src/playbooks/tiers.js';
import type { ActionCall, WebTransport } from '../../src/web/transport.js';
import actionPolicy from '../../src/safe/web-action-policy.json';

const workspace = '11111111-1111-4111-8111-111111111111';
const identity = { profile: 'sandbox', workspace, workspaceName: 'Synthetic sandbox', credentialRef: 'fake-ref' };
const scope = { profile: identity.profile, workspace };
const apiClient = clientFromRequest(async () => { throw new Error('the public API must never be called'); });

function rig(options: Record<string, unknown> = {}) {
  const acts: ActionCall[] = [];
  const transport: WebTransport = { async call() { throw new Error('no read expected'); },
    async act(c) { acts.push(c); return { status: 200, json: { opened: c.page, fields_filled: c.fills.length, awaiting: 'the user' } }; } };
  const dispatcher = new SafeDispatcher({ commands: webCommands, bound: identity, identity: async () => identity, client: apiClient,
    webClient: createWebClient(transport, workspace), store: new MemoryPreviewStore(), registryRevision: 'web-v1', contextRevision: 'web-v1',
    authorizeWrite: async () => true, ...options });
  return { dispatcher, acts };
}

describe('attended browser actions', () => {
  it('documents preview and write execution instead of direct browser subcommands', () => {
    for (const command of webActionCommands) {
      expect(command.examples).toHaveLength(2);
      expect(command.examples[0]).toContain(`preview ${command.name}`);
      expect(command.examples[1]).toContain('run --mode write');
      expect(command.examples.join('\n')).not.toContain('web-browser');
    }
  });
  it('are zero-cost writes in the policy, pinned to a reviewed list', () => {
    expect(WEB_ACTIONS.map(a => a.id).sort()).toEqual([...actionPolicy].sort());
    for (const c of webActionCommands) expect(effectPolicy(c)).toEqual({ effect: 'write', cost: 'none', notifications: false });
    expect(effectPolicy({ ...webActionCommands[0], name: 'web_action_other', endpoint: { method: 'POST', path: '/browser-action/web_action_other' } }).effect).toBe('unknown');
  });
  it('never appear on the direct CLI or legacy MCP, which have no preview step', () => {
    expect(directCommands({ INSTANTLY_WEB_BROWSER_URL: 'http://127.0.0.1:9222' }).some(c => c.name.startsWith('web_action_'))).toBe(false);
    expect(directCommands({ INSTANTLY_WEB_BROWSER_URL: 'http://127.0.0.1:9222' }).filter(c => c.origin === 'web')).toHaveLength(webReadCommands.length);
    expect(activeCommands({ INSTANTLY_WEB_BROWSER_URL: 'http://127.0.0.1:9222' }).filter(c => c.origin === 'web')).toHaveLength(webCommands.length);
  });
  it('only the internal tier may enable them; vip and managed cannot', () => {
    for (const a of WEB_ACTIONS) {
      expect(TIER_POLICY.internal.allowedWrites).toContain(a.id);
      expect(TIER_POLICY.vip.allowedWrites).not.toContain(a.id);
      expect(TIER_POLICY.managed.allowedWrites).not.toContain(a.id);
    }
  });
  it('preview sends nothing; write is denied unless the host enabled it', async () => {
    const r = rig();
    const { plan, token } = await r.dispatcher.preview('web_action_open_screen', { screen: 'agents-new' }, scope);
    expect(plan.requests).toEqual([{ method: 'POST', path: '/browser-action/web_action_open_screen', body: { screen: 'agents-new' } }]);
    expect(r.acts).toEqual([]);
    await expect(r.dispatcher.write(token, scope)).rejects.toThrow('WRITE_POLICY_DENIED');
    expect(r.acts).toEqual([]);
  });
  it('an enabled action runs once, only after its preview, and cannot be replayed', async () => {
    const r = rig({ allowedWrites: ['web_action_agent_prefill'] });
    const { token } = await r.dispatcher.preview('web_action_agent_prefill', { text: 'Call leads who asked about pricing' }, scope);
    const out = await r.dispatcher.write(token, scope) as { opened: string; fields_filled: number };
    expect(out).toMatchObject({ opened: '/app/agents/new', fields_filled: 1 });
    expect(r.acts).toEqual([{ page: '/app/agents/new', workspace, fills: [{ selector: 'input[placeholder^="Search agents or templates"]', value: 'Call leads who asked about pricing' }] }]);
    await expect(r.dispatcher.write(token, scope)).rejects.toThrow('INVALID_PREVIEW');
    expect(r.acts).toHaveLength(1);
  });
  it('a workspace mismatch at write time sends nothing', async () => {
    let live = identity;
    const r = rig({ allowedWrites: ['web_action_open_screen'], identity: async () => live });
    const { token } = await r.dispatcher.preview('web_action_open_screen', { screen: 'crm-home' }, scope);
    live = { ...identity, workspace: '22222222-2222-4222-8222-222222222222' };
    await expect(r.dispatcher.write(token, scope)).rejects.toThrow('WORKSPACE_MISMATCH');
    expect(r.acts).toEqual([]);
  });
  it('rejects unknown screens, unknown fields, control characters and oversize text before the browser', () => {
    const open = WEB_ACTIONS[0], fill = WEB_ACTIONS[1];
    expect(() => resolveAction(open, { screen: 'billing-admin' })).toThrow('unknown screen');
    expect(() => resolveAction(open, { screen: 'agents', extra: 1 })).toThrow('UNKNOWN_ARGUMENTS');
    expect(() => resolveAction(fill, { text: 'a\nb' })).toThrow('INVALID_ARGUMENTS');
    expect(() => resolveAction(fill, { text: 'x'.repeat(501) })).toThrow('INVALID_ARGUMENTS');
    expect(() => resolveAction(fill, {})).toThrow('INVALID_ARGUMENTS');
    expect(resolveAction(open, { screen: 'crm-home' })).toEqual({ page: SCREENS['crm-home'], fills: [] });
  });
  it.each([
    [workspace, 'synthetic-session', undefined],
    ['different-workspace', 'synthetic-session', 'WEB_WORKSPACE_MISMATCH'],
    [null, 'synthetic-session', 'WEB_SIGNED_OUT'],
    [workspace, null, 'WEB_SIGNED_OUT'],
  ])('executes attended prefill only for the bound signed-in workspace: %s / %s', async (liveWorkspace, token, error) => {
    const events: Event[] = [];
    const click = vi.fn(), submit = vi.fn(), requestSubmit = vi.fn(), fetch = vi.fn();
    class Input {
      private text = '';
      get value() { return this.text; }
      set value(value: string) { this.text = value; }
      dispatchEvent(event: Event) { events.push(event); return true; }
      click = click;
      form = { submit, requestSubmit };
    }
    const input = new Input();
    const location = { pathname: '/app/agents' };
    const push = vi.fn((page: string) => { location.pathname = page; });
    const querySelector = vi.fn(() => input);
    const result = await runInNewContext(actionScript({ page: '/app/agents/new', workspace,
      fills: [{ selector: 'input', value: 'Call interested leads' }] }), {
      localStorage: { getItem: (key: string) => key === 'organizationId' ? liveWorkspace : token },
      location, window: { next: { router: { push } } }, document: { querySelector }, Event, fetch,
    });
    if (error) {
      expect(result).toEqual({ error });
      expect(input.value).toBe('');
      expect(events).toEqual([]);
      expect(push).not.toHaveBeenCalled();
      expect(querySelector).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual({ status: 200, json: { opened: '/app/agents/new', fields_filled: 1,
        awaiting: 'the user to review and press the final button' } });
      expect(push).toHaveBeenCalledExactlyOnceWith('/app/agents/new');
      expect(querySelector).toHaveBeenCalledExactlyOnceWith('input');
      expect(input.value).toBe('Call interested leads');
      expect(events.map(e => ({ type: e.type, bubbles: e.bubbles }))).toEqual([{ type: 'input', bubbles: true }]);
    }
    for (const sideEffect of [click, submit, requestSubmit, fetch]) expect(sideEffect).not.toHaveBeenCalled();
  });
  it('the transport maps screen mismatches to a stop, never a submit', async () => {
    const sent: unknown[] = [];
    class Sock { handlers: Record<string, ((e: unknown) => void)[]> = {}; constructor() { setTimeout(() => this.handlers.open?.forEach(f => f({})), 0); }
      addEventListener(t: string, f: (e: unknown) => void) { (this.handlers[t] ??= []).push(f); }
      send(d: string) { sent.push(JSON.parse(d)); setTimeout(() => this.handlers.message?.forEach(f => f({ data: JSON.stringify({ id: 1, result: { result: { value: { error: 'WEB_ELEMENT_NOT_FOUND' } } } }) })), 0); } close() {} }
    const t = createCdpTransport({ browserUrl: 'http://127.0.0.1:9341', WebSocketImpl: Sock as never,
      fetchImpl: (async () => ({ json: async () => [{ type: 'page', url: 'https://app.instantly.ai/app', webSocketDebuggerUrl: 'ws://127.0.0.1:9341/x' }] })) as never });
    await expect(t.act!({ page: '/app/agents/new', workspace, fills: [{ selector: 'input', value: 'x' }] })).rejects.toThrow('WEB_ELEMENT_NOT_FOUND');
    expect(sent).toHaveLength(1);
  });
});
