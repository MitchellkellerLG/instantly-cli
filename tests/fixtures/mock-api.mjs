import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// Network-denying fixture for built CLI and MCP smoke tests. No real credentials.
const delta = JSON.parse(readFileSync(new URL('../../evals/public-delta-v1/fixtures.json', import.meta.url), 'utf8')).fixtures;
const workspace = '11111111-1111-4111-8111-111111111111';
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://api.instantly.ai') throw new Error('Unexpected mock origin');
  const method = options.method ?? 'GET';
  const path = url.pathname;
  let result;
  if (method === 'GET' && path === '/api/v2/workspaces/current') result = { id: workspace, name: 'Mock workspace' };
  else if (method === 'GET' && path === '/api/v2/supersearch-enrichment/saved-searches') result = { items: [{ name: 'Mock search' }] };
  else if (method === 'GET' && path === '/api/v2/workspace-members') {
    result = { items: [], query: Object.fromEntries(url.searchParams) };
  } else if (method === 'GET' && path === '/api/v2/emails/mock-thread') {
    result = { from_address_email: 'lead@example.com' };
  } else if ((method === 'POST' && [
    '/api/v2/accounts', '/api/v2/accounts/warmup/enable', '/api/v2/accounts/warmup/disable',
    '/api/v2/leads/list', '/api/v2/leads/bulk-assign', '/api/v2/leads/move', '/api/v2/leads/subsequence/move',
    '/api/v2/supersearch-enrichment/ai',
    '/api/v2/webhooks', '/api/v2/emails/reply',
  ].includes(path)) || (method === 'PATCH' && path === '/api/v2/webhooks/mock-hook')) {
    result = { id: 'mock-result', request: JSON.parse(options.body) };
  }
  else if (method === 'PUT' && path === '/api/v2/domains/example.com/forwarding') {
    const body = JSON.parse(options.body);
    if (body.forwarding_domain !== 'destination.com') throw new Error('Unexpected forwarding body');
    result = { domain: 'example.com', ...body };
  } else {
    const request = { method, path: path.replace(/^\/api\/v2/, '') };
    if (url.search) request.query = Object.fromEntries(url.searchParams);
    if (options.body) request.body = JSON.parse(options.body);
    const fixture = delta.find(f => isDeepStrictEqual(f.request, request));
    if (!fixture) throw new Error(`Mock refuses unexpected request: ${method} ${path}`);
    result = fixture.response;
  }
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
};
