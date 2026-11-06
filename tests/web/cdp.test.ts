import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import { assertLoopback, createCdpTransport, pageScript, actionScript } from '../../src/web/cdp.js';

const ws = '11111111-1111-4111-8111-111111111111';
const call = { method: 'GET' as const, url: '/backend-alt/api/v1/tasks?limit=1', workspace: ws };

class FakeSocket {
  static sent: any[] = [];
  static reply: any = { id: 1, result: { result: { value: { status: 200, json: { data: [] } } } } };
  private handlers: Record<string, ((e: any) => void)[]> = {};
  constructor(readonly url: string) { setTimeout(() => this.emit('open', {}), 0); }
  addEventListener(type: string, fn: (e: any) => void) { (this.handlers[type] ??= []).push(fn); }
  protected emit(type: string, e: any) { for (const fn of this.handlers[type] ?? []) fn(e); }
  send(data: string) { FakeSocket.sent.push(JSON.parse(data)); setTimeout(() => this.emit('message', { data: JSON.stringify(FakeSocket.reply) }), 0); }
  close() {}
}
const tabs = (list: any[]) => (async () => ({ json: async () => list })) as unknown as typeof fetch;
const appTab = { type: 'page', url: 'https://app.instantly.ai/app/agents', webSocketDebuggerUrl: 'ws://127.0.0.1:9341/devtools/page/x' };
const make = (list: any[]) => createCdpTransport({ browserUrl: 'http://127.0.0.1:9341', fetchImpl: tabs(list), WebSocketImpl: FakeSocket as never, timeoutMs: 500 });

describe('attended browser transport', () => {
  it('attaches only to a loopback debugging endpoint', () => {
    expect(() => assertLoopback('http://127.0.0.1:9341')).not.toThrow();
    expect(() => assertLoopback('http://localhost:9222')).not.toThrow();
    for (const bad of ['https://127.0.0.1:9341', 'http://10.0.0.5:9222', 'http://example.com:9222', 'ws://127.0.0.1:9222', 'nope']) {
      expect(() => assertLoopback(bad)).toThrow(/WEB_BROWSER_URL/);
    }
  });
  it.each([false, true])('executes a workspace-bound request with encoded storage: %s', async encoded => {
    const storage: Record<string, string> = { organizationId: ws, organizationAuth: 'synthetic-session' };
    const fetch = vi.fn(async () => ({ status: 200, text: async () => '{"data":[]}' }));
    const result = await runInNewContext(pageScript({ ...call, body: { a: 1 } }), {
      localStorage: { getItem: (key: string) => encoded ? JSON.stringify(storage[key]) : storage[key] },
      location: { pathname: '/app/agents' }, fetch,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(call.url, {
      method: 'GET', credentials: 'include', body: '{"a":1}',
      headers: { 'x-workspace-id': ws, 'x-org-auth': 'synthetic-session', 'x-frontend-version': 'new',
        'x-app-page': '/app/agents', accept: 'application/json', 'content-type': 'application/json' },
    });
    expect(result).toEqual({ status: 200, json: { data: [] }, text: undefined });
  });
  it.each([
    ['different-workspace', 'synthetic-session', 'WEB_WORKSPACE_MISMATCH'],
    [null, 'synthetic-session', 'WEB_SIGNED_OUT'],
    [ws, null, 'WEB_SIGNED_OUT'],
  ])('sends no page request for session %s / %s', async (workspace, token, error) => {
    const fetch = vi.fn();
    const result = await runInNewContext(pageScript(call), {
      localStorage: { getItem: (key: string) => key === 'organizationId' ? workspace : token },
      location: { pathname: '/app/agents' }, fetch,
    });
    expect(result).toEqual({ error });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('evaluates in the open Instantly tab and returns status and json only', async () => {
    FakeSocket.sent = [];
    const reply = await make([{ type: 'page', url: 'about:blank' }, appTab]).call(call);
    expect(reply).toEqual({ status: 200, json: { data: [] }, text: undefined });
    expect(FakeSocket.sent).toHaveLength(1);
    expect(FakeSocket.sent[0].method).toBe('Runtime.evaluate');
    expect(Object.keys(FakeSocket.sent[0].params).sort()).toEqual(['awaitPromise', 'expression', 'returnByValue']);
  });
  it('refuses with a clear code when there is no signed-in tab or no browser', async () => {
    await expect(make([{ type: 'page', url: 'https://example.com/' }]).call(call)).rejects.toThrow('WEB_SIGNED_OUT');
    const gone = createCdpTransport({ browserUrl: 'http://127.0.0.1:9341', fetchImpl: (async () => { throw new Error('refused'); }) as never });
    await expect(gone.call(call)).rejects.toThrow('WEB_BROWSER_UNAVAILABLE');
  });
  it('surfaces a workspace mismatch from the page without sending anything', async () => {
    FakeSocket.reply = { id: 1, result: { result: { value: { error: 'WEB_WORKSPACE_MISMATCH' } } } };
    await expect(make([appTab]).call(call)).rejects.toThrow('WEB_WORKSPACE_MISMATCH');
    FakeSocket.reply = { id: 1, result: { result: { value: { error: 'WEB_SIGNED_OUT' } } } };
    await expect(make([appTab]).call(call)).rejects.toThrow('WEB_SIGNED_OUT');
    FakeSocket.reply = { id: 1, result: { exceptionDetails: { text: 'boom eyJabcdefgh.ijklmnop.qrstuvwx' } } };
    const error = await make([appTab]).call(call).catch(e => e as Error);
    expect(error.message).toContain('WEB_PAGE_ERROR');
    expect(error.message).not.toContain('eyJ');
  });
  it('fails fast when the browser closes the socket before answering', async () => {
    class Closing extends FakeSocket { send() { setTimeout(() => (this as any).emit('close', {}), 0); } }
    const t = createCdpTransport({ browserUrl: 'http://127.0.0.1:9341', fetchImpl: tabs([appTab]), WebSocketImpl: Closing as never, timeoutMs: 5000 });
    await expect(t.call(call)).rejects.toThrow('WEB_BROWSER_UNAVAILABLE');
  });
});


describe('attended action scope across waits', () => {
  it.each(['navigation', 'element', 'lookup', 'setter', 'input'])(
    'revalidates the workspace and destination after %s', async phase => {
      for (const change of ['workspace', 'sign-out', 'page', 'none']) {
        const page = '/app/agents/new';
        const location = { pathname: phase === 'navigation' ? '/app/agents' : page };
        const storage: Record<string, string | null> = { organizationId: ws, organizationAuth: 'synthetic-session' };
        const changeScope = () => {
          if (change === 'workspace') storage.organizationId = 'other-workspace';
          if (change === 'sign-out') storage.organizationAuth = null;
          if (change === 'page') location.pathname = '/app/settings/billing';
        };
        const events: string[] = [];
        const writes: string[] = [];
        class Input {
          private text = '';
          constructor(readonly name: string) {}
          get value() { return this.text; }
          set value(value: string) {
            writes.push(this.name);
            this.text = value;
            if (phase === 'setter') changeScope();
          }
          dispatchEvent(event: Event) {
            events.push(event.type);
            if (phase === 'input') changeScope();
            return true;
          }
        }
        const first = new Input('first'), second = new Input('second');
        let ready = phase !== 'element';
        const result = await runInNewContext(actionScript({ page, workspace: ws,
          fills: [{ selector: '#first', value: 'First brief' }, { selector: '#second', value: 'Second brief' }] }), {
          localStorage: { getItem: (key: string) => storage[key] }, location, Event,
          window: { next: { router: { push() {} } } },
          document: { querySelector(selector: string) {
            if (!ready) return null;
            if (phase === 'lookup') changeScope();
            return selector === '#first' ? first : second;
          } },
          setTimeout(callback: () => void) {
            location.pathname = page;
            ready = true;
            changeScope();
            callback();
          },
        });
        if (change === 'none') {
          expect(result).toMatchObject({ status: 200, json: { opened: page, fields_filled: 2 } });
          expect([first.value, second.value]).toEqual(['First brief', 'Second brief']);
          expect(events).toEqual(['input', 'input']);
        } else {
          expect(result).toEqual({ error: change === 'workspace' ? 'WEB_WORKSPACE_MISMATCH'
            : change === 'sign-out' ? 'WEB_SIGNED_OUT' : 'WEB_ELEMENT_NOT_FOUND' });
          const changedAfterWrite = phase === 'setter' || phase === 'input';
          expect(writes).toEqual(changedAfterWrite ? ['first'] : []);
          expect(first.value).toBe(changedAfterWrite ? 'First brief' : '');
          expect(second.value).toBe('');
          expect(events).toEqual(phase === 'input' ? ['input'] : []);
        }
      }
    });
  it('checks the session after navigation even when no fields are requested', async () => {
    let liveWorkspace = ws;
    const location = { pathname: '/app/agents' };
    const result = await runInNewContext(actionScript({ page: '/app/crm/home', workspace: ws, fills: [] }), {
      localStorage: { getItem: (key: string) => key === 'organizationId' ? liveWorkspace : 'synthetic-session' },
      location, window: { next: { router: { push() {} } } },
      setTimeout(callback: () => void) {
        liveWorkspace = 'other-workspace';
        location.pathname = '/app/crm/home';
        callback();
      },
    });
    expect(result).toEqual({ error: 'WEB_WORKSPACE_MISMATCH' });
  });
});
