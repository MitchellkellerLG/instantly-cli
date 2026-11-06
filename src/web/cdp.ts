import { redactText } from './redact.js';
import { WebError, type ActionCall, type WebCall, type WebReply, type WebTransport } from './transport.js';

export const WEB_BROWSER_ENV = 'INSTANTLY_WEB_BROWSER_URL';
const APP_PREFIX = 'https://app.instantly.ai/app';

/** Only a debugging port on this machine. This layer never launches a browser and never attaches to a remote one. */
export function assertLoopback(browserUrl: string): URL {
  let url: URL;
  try { url = new URL(browserUrl); } catch { throw new WebError('WEB_BROWSER_URL_INVALID', 'not a URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new WebError('WEB_BROWSER_URL_DENIED', 'only a loopback http debugging endpoint is allowed');
  }
  return url;
}

interface Target { type: string; url: string; webSocketDebuggerUrl?: string }
export interface CdpOptions {
  browserUrl: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  timeoutMs?: number;
}

/**
 * Runs the request as a page-context fetch inside an already signed-in Instantly tab. The session token is
 * read inside the page and attached there; it is never returned. The page's own workspace must equal the
 * expected one or nothing is sent.
 */
export function pageScript(call: WebCall): string {
  return `(async () => {
  const req = ${JSON.stringify({ method: call.method, url: call.url, body: call.body ?? null, workspace: call.workspace })};
  const read = k => { let v = localStorage.getItem(k); try { const j = JSON.parse(v); if (typeof j === 'string') v = j; } catch (e) {} return v; };
  const ws = read('organizationId'), token = read('organizationAuth');
  if (!ws || !token) return { error: 'WEB_SIGNED_OUT' };
  if (ws !== req.workspace) return { error: 'WEB_WORKSPACE_MISMATCH' };
  const headers = { 'x-workspace-id': ws, 'x-org-auth': token, 'x-frontend-version': 'new', 'x-app-page': location.pathname, accept: 'application/json' };
  if (req.body !== null) headers['content-type'] = 'application/json';
  const r = await fetch(req.url, { method: req.method, credentials: 'include', headers, body: req.body === null ? undefined : JSON.stringify(req.body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text: json === null ? text.slice(0, 200) : undefined };
})()`;
}

/** Fills text fields only. There is deliberately no click, submit or key event anywhere in this script. */
export function actionScript(call: ActionCall): string {
  return `(async () => {
  const req = ${JSON.stringify({ page: call.page, fills: call.fills, workspace: call.workspace })};
  const read = k => { let v = localStorage.getItem(k); try { const j = JSON.parse(v); if (typeof j === 'string') v = j; } catch (e) {} return v; };
  const check = (onPage = true) => {
    const ws = read('organizationId');
    if (!ws || !read('organizationAuth')) return 'WEB_SIGNED_OUT';
    if (ws !== req.workspace) return 'WEB_WORKSPACE_MISMATCH';
    if (onPage && location.pathname !== req.page) return 'WEB_ELEMENT_NOT_FOUND';
  };
  let error = check(false);
  if (error) return { error };
  if (location.pathname !== req.page) {
    if (!(window.next && window.next.router)) return { error: 'WEB_NAVIGATION_UNAVAILABLE' };
    window.next.router.push(req.page);
  }
  for (let i = 0; i < 50 && location.pathname !== req.page; i++) {
    await new Promise(r => setTimeout(r, 200));
    error = check(false);
    if (error) return { error };
  }
  error = check();
  if (error) return { error };
  let filled = 0;
  for (const f of req.fills) {
    let el;
    for (let i = 0; i < 50; i++) {
      error = check();
      if (error) return { error };
      el = document.querySelector(f.selector);
      if (el) break;
      await new Promise(r => setTimeout(r, 200));
    }
    error = check();
    if (error) return { error };
    if (!el) return { error: 'WEB_ELEMENT_NOT_FOUND' };
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, f.value);
    error = check();
    if (error) return { error };
    el.dispatchEvent(new Event('input', { bubbles: true }));
    error = check();
    if (error) return { error };
    if (el.value !== f.value) return { error: 'WEB_FILL_FAILED' };
    filled++;
  }
  return { status: 200, json: { opened: location.pathname, fields_filled: filled, awaiting: 'the user to review and press the final button' } };
})()`;
}

export function createCdpTransport(options: CdpOptions): WebTransport {
  const base = assertLoopback(options.browserUrl);
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  async function evaluate(expression: string): Promise<{ error?: string } & Partial<WebReply>> {
    let targets: Target[];
    try {
      const res = await doFetch(new URL('/json/list', base));
      targets = await res.json() as Target[];
    } catch { throw new WebError('WEB_BROWSER_UNAVAILABLE', 'no attended browser is listening on the configured debugging endpoint'); }
    const page = targets.find(t => t.type === 'page' && t.url.startsWith(APP_PREFIX) && t.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) throw new WebError('WEB_SIGNED_OUT', 'no signed-in Instantly app tab is open in the attended browser');
    const WS = options.WebSocketImpl ?? globalThis.WebSocket;
    if (!WS) throw new WebError('WEB_NODE_UNSUPPORTED', 'web commands need Node 22 or newer (global WebSocket)');
    const ws = new WS(page.webSocketDebuggerUrl);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new WebError('WEB_TIMEOUT', 'the browser did not answer in time')); }, timeoutMs);
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new WebError('WEB_BROWSER_UNAVAILABLE', 'debugging socket error')); });
      ws.addEventListener('close', () => { clearTimeout(timer); reject(new WebError('WEB_BROWSER_UNAVAILABLE', 'the browser closed the debugging socket before answering')); });
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true } })));
      ws.addEventListener('message', event => {
        const msg = JSON.parse(String(event.data));
        if (msg.id !== 1) return;
        clearTimeout(timer); ws.close();
        if (msg.error || msg.result?.exceptionDetails) reject(new WebError('WEB_PAGE_ERROR', redactText(JSON.stringify(msg.error ?? msg.result.exceptionDetails.text ?? 'script error')).slice(0, 200)));
        else resolve(msg.result.result.value);
      });
    });
  }
  const finish = (result: { error?: string } & Partial<WebReply>): WebReply => {
    if (result.error) throw new WebError(result.error, result.error === 'WEB_WORKSPACE_MISMATCH'
      ? 'the browser session is on a different workspace than the bound one; nothing was sent'
      : result.error === 'WEB_SIGNED_OUT' ? 'sign in to Instantly in the attended browser first' : 'the screen did not match what was mapped; nothing was submitted');
    return { status: result.status as number, json: result.json ?? null, text: result.text };
  };
  return {
    call: async (call: WebCall) => finish(await evaluate(pageScript(call))),
    act: async (call: ActionCall) => finish(await evaluate(actionScript(call))),
  };
}
