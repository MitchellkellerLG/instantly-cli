import { allCommands } from '../../src/commands/index.js';
import { SafeDispatcher, type DispatchEvent } from '../../src/safe/dispatcher.js';
import { MemoryPreviewStore } from '../../src/safe/preview-store.js';
import { clientFromRequest, type Request } from '../../src/safe/transport.js';
import { PlaybookRunner } from '../../src/playbooks/runner.js';
import { allPlaybooks } from '../../src/playbooks/registry.js';
import type { Tier } from '../../src/playbooks/types.js';

export const workspace = '11111111-1111-4111-8111-111111111111';
export const identity = { profile: 'sandbox', workspace, workspaceName: 'Synthetic sandbox', credentialRef: 'fake-ref' };
export const scope = { profile: identity.profile, workspace };
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const agent = (over: Record<string, unknown> = {}) => ({ id: uuid(900), name: 'Synthetic agent', status: 1, agent_type: 2,
  config: { memory: {
    business_description: 'We are a software platform that helps sales teams grow revenue and fill the pipeline with booked meetings.',
    business_offers: [{ name: 'Outbound automation', description: 'Outbound platform to increase pipeline and close more sales' }],
    icps: [{ name: 'Revenue leaders', industry: ['B2B software', 'Fintech'], job_title: { include: ['VP Sales', 'Head of Growth'], exclude: [] }, problems_solved: ['Pipeline is too thin to hit revenue goals'], benefits: ['More booked meetings'] }],
  } }, ...over });

export const saasWorld = {
  'GET /workspaces/current': { id: workspace, name: 'Synthetic sandbox', plan_id: 'pid_free' },
  'GET /workspace-billing/plan-details': { subscriptions: { outreach: { plan_name: 'Growth' }, credits: { plan_name: 'Free Trial', available_credits: 1000 },
    crm: { plan_name: null }, website_visitors: { plan_name: null }, inbox_placement: { plan_name: null } } },
  'GET /ai-agents/sales': { items: [agent()] },
  'GET /campaigns': { items: [{ id: uuid(10), name: 'Q1 founders outreach', status: 0 }] },
  'POST /leads/list': { items: [
    { id: uuid(101), email: 'a1@example.com', job_title: 'VP Sales', company_domain: 'alpha.example', email_reply_count: 0, email_click_count: 0 },
    { id: uuid(102), email: 'a2@example.com', job_title: 'Head of Growth', company_domain: 'beta.example', email_reply_count: 1, email_click_count: 0 },
    { id: uuid(103), email: 'a3@example.com', job_title: 'Director of Operations', company_domain: 'gamma.example', email_reply_count: 0, email_click_count: 0 },
    { id: uuid(104), email: 'a4@example.com', job_title: 'Founder', company_domain: 'delta.example', email_reply_count: 0, email_click_count: 0 },
    { id: uuid(105), email: 'a5@example.com', job_title: '', company_domain: 'eps.example', email_reply_count: 0, email_click_count: 0 },
  ], next_starting_after: null },
  'GET /webhooks': { items: [] },
  'GET /lead-lists': { items: [] },
} as Record<string, unknown>;

export interface WorldOptions {
  responses?: Record<string, unknown | ((request: Request) => unknown)>;
  tier?: Tier;
  hostAllowedWrites?: string[];
  authorize?: boolean;
  allowUnknownCost?: boolean;
  now?: () => number;
}
const isMutation = (request: Request) => request.method !== 'GET' && !(request.method === 'POST' && ['/leads/list', '/local-business-search/search', '/supersearch-enrichment/count-leads-from-supersearch'].includes(request.path));

export function makeWorld(options: WorldOptions = {}) {
  const requests: Request[] = [];
  const events: DispatchEvent[] = [];
  const table: Record<string, unknown> = { ...saasWorld, ...(options.responses ?? {}) };
  let failAt: number | null = null;
  let writes = 0;
  const client = clientFromRequest(async <T>(request: Request): Promise<T> => {
    requests.push(JSON.parse(JSON.stringify(request)));
    if (isMutation(request)) {
      writes++;
      if (failAt !== null && writes === failAt) throw new Error('timeout');
    }
    const key = `${request.method} ${request.path}`;
    let value = table[key];
    if (typeof value === 'function') value = (value as (r: Request) => unknown)(request);
    if (value === undefined) {
      if (request.method === 'POST' && request.path === '/lead-lists') return { id: uuid(500 + writes), name: (request.body as any)?.name } as T;
      if (request.method === 'POST' && request.path === '/campaigns') return { id: uuid(600 + writes), name: (request.body as any)?.name, status: 0 } as T;
      if (request.method === 'POST' && request.path === '/webhooks') return { id: uuid(700 + writes) } as T;
      if (request.method === 'POST' && request.path === '/local-business-search/convert') return { job: { id: uuid(800), status: 'running', requested: (request.body as any)?.count } } as T;
      throw new Error(`UNMOCKED ${key}`);
    }
    return structuredClone(value) as T;
  });
  const hostAllowed = options.hostAllowedWrites ?? [];
  const dispatcher = new SafeDispatcher({ commands: allCommands, bound: identity, identity: async () => identity, client, store: new MemoryPreviewStore(),
    registryRevision: 'registry-v1', contextRevision: 'context-v1', allowedWrites: hostAllowed, allowUnknownCost: options.allowUnknownCost !== false,
    authorizeWrite: async () => options.authorize !== false, now: options.now, event: e => events.push(e) });
  const runner = new PlaybookRunner({ dispatcher, scope, tier: options.tier ?? 'internal', commands: allCommands, playbooks: allPlaybooks, hostAllowedWrites: hostAllowed, allowUnknownCost: options.allowUnknownCost !== false, now: options.now });
  const mutations = () => requests.filter(isMutation);
  return { runner, dispatcher, requests, events, mutations, failWriteNumber: (n: number) => { failAt = n; }, table };
}
