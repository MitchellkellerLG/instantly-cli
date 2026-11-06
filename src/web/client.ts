import type { InstantlyClient } from '../core/types.js';
import { clientFromRequest } from '../safe/transport.js';
import { redactText } from './redact.js';
import { WEB_ACTION_BY_PATH, resolveAction } from './actions.js';
import { WEB_BY_PATH, type Expect } from './table.js';
import { WebError, type WebTransport } from './transport.js';

type Request = Parameters<InstantlyClient['request']>[0];

/** Fails closed when a private route no longer looks like the mapped one. Names missing keys only. */
export function checkShape(path: string, body: unknown, expect: Expect): void {
  if (expect === 'array') { if (!Array.isArray(body)) throw new WebError('WEB_SHAPE_DRIFT', `${path} no longer returns an array`); return; }
  if (expect === 'object') { if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WebError('WEB_SHAPE_DRIFT', `${path} no longer returns an object`); return; }
  const missing = expect.filter(key => !body || typeof body !== 'object' || !(key in (body as object)));
  if (missing.length) throw new WebError('WEB_SHAPE_DRIFT', `${path} lost key(s): ${missing.join(', ')}`);
}
function queryString(query: Request['query']): string {
  const pairs = Object.entries(query ?? {}).filter(([, v]) => v !== undefined)
    .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(item => `${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`));
  return pairs.length ? `?${pairs.join('&')}` : '';
}

/**
 * InstantlyClient over the attended browser. Mapped read-only routes, plus the declared browser actions: unknown path or any method other
 * than GET (POST for an action) is refused before the browser is touched. Errors never carry response bodies beyond a redacted stub.
 */
export function createWebClient(transport: WebTransport, workspace: string): InstantlyClient {
  return clientFromRequest(async <T>(request: Request): Promise<T> => {
    const action = WEB_ACTION_BY_PATH.get(request.path);
    if (action) {
      if (request.method !== 'POST') throw new WebError('WEB_METHOD_DENIED', 'browser actions are POST-shaped plans');
      if (!transport.act) throw new WebError('WEB_ACTION_UNSUPPORTED', 'this transport cannot drive the attended browser');
      const reply = await transport.act({ ...resolveAction(action, (request.body ?? {}) as Record<string, unknown>), workspace });
      return reply.json as T;
    }
    const route = WEB_BY_PATH.get(request.path);
    if (!route) throw new WebError('WEB_ROUTE_DENIED', 'path is not a mapped web route');
    if (request.method !== 'GET') throw new WebError('WEB_METHOD_DENIED', 'web routes are read-only');
    const reply = await transport.call({ method: 'GET', url: request.path + queryString(request.query), workspace });
    if (reply.status < 200 || reply.status >= 300) {
      throw new WebError(reply.status === 401 || reply.status === 403 ? 'WEB_SIGNED_OUT' : 'WEB_HTTP_ERROR',
        `status ${reply.status}${reply.text ? ' ' + redactText(reply.text) : ''}`);
    }
    checkShape(request.path, reply.json, route.expect);
    return reply.json as T;
  });
}
