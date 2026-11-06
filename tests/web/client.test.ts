import { describe, it, expect } from 'vitest';
import { createWebClient, checkShape } from '../../src/web/client.js';
import { redactText, leaks } from '../../src/web/redact.js';
import type { WebCall, WebReply, WebTransport } from '../../src/web/transport.js';

const ws = '11111111-1111-4111-8111-111111111111';
function fake(reply: WebReply | ((c: WebCall) => WebReply)) {
  const calls: WebCall[] = [];
  const transport: WebTransport = { async call(c) { calls.push(c); return typeof reply === 'function' ? reply(c) : reply; } };
  return { calls, client: createWebClient(transport, ws) };
}
const TASKS = '/backend-alt/api/v1/tasks';

describe('web client', () => {
  it('sends one GET with the encoded query and the bound workspace, nothing else', async () => {
    const t = fake({ status: 200, json: { data: [], limit: 3 } });
    await expect(t.client.get(TASKS, { limit: 3, status: 'Active', skip: undefined })).resolves.toEqual({ data: [], limit: 3 });
    expect(t.calls).toEqual([{ method: 'GET', url: `${TASKS}?limit=3&status=Active`, workspace: ws }]);
  });
  it('refuses unmapped paths and every non-GET method before the browser is touched', async () => {
    const t = fake({ status: 200, json: {} });
    await expect(t.client.get('/backend-alt/api/v1/other')).rejects.toThrow('WEB_ROUTE_DENIED');
    await expect(t.client.get('/api/v2/campaigns')).rejects.toThrow('WEB_ROUTE_DENIED');
    await expect(t.client.post(TASKS, { a: 1 })).rejects.toThrow('WEB_METHOD_DENIED');
    await expect(t.client.patch(TASKS, {})).rejects.toThrow('WEB_METHOD_DENIED');
    await expect(t.client.delete(TASKS)).rejects.toThrow('WEB_METHOD_DENIED');
    expect(t.calls).toEqual([]);
  });
  it('fails closed when the private route drifts', async () => {
    await expect(fake({ status: 200, json: { rows: [] } }).client.get(TASKS)).rejects.toThrow('WEB_SHAPE_DRIFT: ' + TASKS + ' lost key(s): data');
    await expect(fake({ status: 200, json: null }).client.get(TASKS)).rejects.toThrow('WEB_SHAPE_DRIFT');
    expect(() => checkShape('/p', {}, 'array')).toThrow('array');
    expect(() => checkShape('/p', [], 'object')).toThrow('object');
    expect(() => checkShape('/p', { a: 1 }, 'object')).not.toThrow();
  });
  it('maps auth failures to WEB_SIGNED_OUT and redacts anything echoed back', async () => {
    await expect(fake({ status: 401, json: null }).client.get(TASKS)).rejects.toThrow('WEB_SIGNED_OUT');
    const leak = fake({ status: 500, json: null, text: 'boom x-org-auth: eyJabcdefgh.ijklmnop.qrstuvwx for a@b.co ' + ws });
    const error = await leak.client.get(TASKS).catch(e => e as Error);
    expect(error.message).toContain('WEB_HTTP_ERROR');
    expect(leaks(error.message)).toBe(false);
  });
});
describe('redaction', () => {
  it('masks jwt, bearer, auth headers, emails and uuids and detects leftovers', () => {
    const dirty = `Bearer abcdefghijklmnop eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl cookie: a=b me@x.io ${ws}`;
    expect(leaks(dirty)).toBe(true);
    const clean = redactText(dirty);
    expect(clean).not.toMatch(/eyJ|abcdefghijklmnop|me@x\.io|a=b|1111/);
    expect(leaks(clean)).toBe(false);
  });
});
