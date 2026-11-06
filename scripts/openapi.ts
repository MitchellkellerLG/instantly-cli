import type { CommandDefinition } from '../src/core/types.js';

export const SPEC_URL = 'https://api.instantly.ai/openapi/api_v2.json';
export type Json = Record<string, any>;
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

export function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/^\/api\/v2(?=\/|$)/, '').replace(/\/$/, '').replace(/\{[^}]+\}/g, '{}')}`;
}

export function operations(spec: Json): Json[] {
  if (!spec.paths || !spec.openapi) throw new Error('Expected an OpenAPI document with paths');
  return Object.entries(spec.paths).flatMap(([path, item]: [string, any]) =>
    Object.entries(item).filter(([method]) => METHODS.has(method)).map(([method, operation]) => ({
      ...(operation as Json), method: method.toUpperCase(), path: path.replace(/^\/api\/v2(?=\/|$)/, ''),
      parameters: [...(item.parameters ?? []), ...((operation as Json).parameters ?? [])],
    })),
  );
}

export function coverage(spec: Json, commands: CommandDefinition[]) {
  const expected = new Set(operations(spec).map(o => operationKey(o.method, o.path)));
  const actual = new Set(commands.map(c => operationKey(c.endpoint.method, c.endpoint.path)));
  return {
    total: expected.size,
    covered: [...expected].filter(key => actual.has(key)).length,
    missing: [...expected].filter(key => !actual.has(key)).sort(),
    undocumented: [...actual].filter(key => !expected.has(key)).sort(),
  };
}

/** Resolve local references in request schemas; fail closed on cycles or external refs. */
export function resolve(spec: Json, value: any, seen: string[] = []): any {
  if (Array.isArray(value)) return value.map(v => resolve(spec, v, seen));
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    const ref = value.$ref as string;
    if (!ref.startsWith('#/') || seen.includes(ref)) throw new Error(`Unsupported reference: ${ref}`);
    const target = ref.slice(2).split('/').reduce((v, k) => v?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    if (!target) throw new Error(`Missing reference: ${ref}`);
    const { $ref, ...siblings } = value;
    return resolve(spec, { ...target, ...siblings }, [...seen, ref]);
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(spec, v, seen)]));
}

export const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();

export function commandIdentity(op: Json) {
  const parts = op.path.split('/').filter(Boolean);
  const aliases: Record<string, string> = {
    'block-lists-entries': 'blocklist', emails: 'email', workspaces: 'workspace',
    'supersearch-enrichment': 'enrichment',
  };
  let group = aliases[parts[0]] ?? parts[0];
  if (parts[0] === 'supersearch-enrichment' && ['saved-searches', 'company-lists'].includes(parts[1])) group = parts[1];
  // Operation IDs are stable and distinguish even deeply nested agent actions.
  const subcommand = kebab(op.operationId ?? `${op.method}-${parts.slice(1).join('-')}`);
  return { group, subcommand, name: `${group.replace(/-/g, '_')}_${subcommand.replace(/-/g, '_')}` };
}

export function commandSpec(spec: Json, op: Json) {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(op.method)) throw new Error(`Unsupported method ${op.method}`);
  const parameters = resolve(spec, op.parameters).map((p: Json) => {
    if (!['path', 'query'].includes(p.in)) throw new Error(`Unsupported parameter location ${p.in}`);
    return { name: p.name, field: ['profile', 'workspace_id', 'body'].includes(p.name) ? `api_${p.name}` : p.name,
      location: p.in, required: p.in === 'path' || p.required === true,
      schema: p.schema ?? {}, description: p.description ?? p.name };
  });
  const request = resolve(spec, op.requestBody);
  const body = request?.content?.['application/json']?.schema;
  if (request && !body) throw new Error(`Unsupported request content: ${op.operationId}`);
  const responses = Object.entries(op.responses ?? {}).filter(([code]) => /^2/.test(code));
  const responseText = responses.some(([, r]: any) => Object.keys(r.content ?? {}).some(t => t.startsWith('text/')));
  return { ...commandIdentity(op), description: `${op.summary ?? op.operationId}. ${op.description ?? ''}`.replace(/\u2014/g, '-'),
    endpoint: { method: op.method, path: op.path }, parameters, ...(body ? { body, bodyRequired: request.required === true || !!body.required?.length } : {}),
    responseText };
}
