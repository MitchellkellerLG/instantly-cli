// Network-denying fixture for built CLI and MCP smoke tests. No real credentials.
const workspace = '11111111-1111-4111-8111-111111111111';
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://api.instantly.ai') throw new Error('Unexpected mock origin');
  const method = options.method ?? 'GET';
  const path = url.pathname;
  let result;
  if (method === 'GET' && path === '/api/v2/workspaces/current') result = { id: workspace, name: 'Mock workspace' };
  else if (method === 'GET' && path === '/api/v2/supersearch-enrichment/saved-searches') result = { items: [{ name: 'Mock search' }] };
  else if (method === 'PUT' && path === '/api/v2/domains/example.com/forwarding') {
    const body = JSON.parse(options.body);
    if (body.forwarding_domain !== 'destination.com') throw new Error('Unexpected forwarding body');
    result = { domain: 'example.com', ...body };
  } else throw new Error(`Mock refuses unexpected request: ${method} ${path}`);
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
};
