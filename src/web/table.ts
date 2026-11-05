/**
 * Private web-app routes, read-only, reached through the operator's signed-in browser. Mapped on 2026-11-05;
 * see the browser map in the PR description. Pure data so the client, policy and registry share one source.
 * `expect` pins the response shape: 'array', 'object', or the top-level keys that must be present. A missing
 * key means the private route drifted and the call fails closed.
 */
export type Param = { name: string; type: 'string' | 'cursor' | 'number' | 'boolean' | 'enum'; max?: number; values?: readonly string[]; required?: boolean; description: string };
export type Expect = 'array' | 'object' | readonly string[];
export interface WebRoute { id: string; sub: string; group: string; path: string; description: string; params?: Param[]; expect: Expect }

const B1 = '/backend-alt/api/v1', B2 = '/backend-alt/api/v2', A = '/api-alt';
const limit: Param = { name: 'limit', type: 'number', max: 1000, description: 'Items to return' };
const skip: Param = { name: 'skip', type: 'number', description: 'Items to skip' };
const offset: Param = { name: 'offset', type: 'number', description: 'Items to skip' };
const startingAfter: Param = { name: 'starting_after', type: 'cursor', description: 'Continuation from next_starting_after' };
const range = (a: string, b: string): Param[] => [
  { name: a, type: 'string', description: 'Start, ISO date or datetime' }, { name: b, type: 'string', description: 'End, ISO date or datetime' }];

export const WEB_ROUTES: WebRoute[] = [
  { id: 'web_crm_opportunities_list', group: 'web-crm', sub: 'opportunities', path: `${B1}/opportunities`, expect: ['data'],
    description: 'CRM opportunities pipeline as shown in the web app. Private route, read-only.',
    params: [limit, skip, { name: 'sort_by', type: 'string', description: 'Sort field' }, { name: 'sort_order', type: 'enum', values: ['asc', 'desc'], description: 'Sort direction' },
      { name: 'start_of_period', type: 'string', description: 'Period start' }, { name: 'end_of_period', type: 'string', description: 'Period end' }] },
  { id: 'web_crm_opportunities_stats', group: 'web-crm', sub: 'opportunity-stats', path: `${B1}/opportunities/stats`, expect: 'array',
    description: 'CRM opportunity totals by stage. Private route, read-only.',
    params: [{ name: 'start_of_period', type: 'string', description: 'Period start' }, { name: 'end_of_period', type: 'string', description: 'Period end' }] },
  { id: 'web_crm_stats', group: 'web-crm', sub: 'stats', path: `${B1}/crm/stats`, expect: 'object',
    description: 'CRM funnel statistics. Private route, read-only.',
    params: [{ name: 'include', type: 'string', description: 'Sections to include' }, { name: 'from', type: 'string', description: 'Start date' }, { name: 'to', type: 'string', description: 'End date' }] },
  { id: 'web_crm_pending_actions_count', group: 'web-crm', sub: 'pending-actions', path: `${B1}/crm/pending-actions-count`, expect: ['count'],
    description: 'Count of CRM actions awaiting the user. Private route, read-only.' },
  { id: 'web_crm_tasks_list', group: 'web-crm', sub: 'tasks', path: `${B1}/tasks`, expect: ['data'],
    description: 'CRM follow-up tasks. Private route, read-only.',
    params: [limit, { name: 'status', type: 'string', description: 'Task status, for example Active' }] },
  { id: 'web_crm_integration_get', group: 'web-crm', sub: 'integration', path: `${B1}/crm/integration`, expect: 'array',
    description: 'Connected external CRM integrations. Private route, read-only.' },
  { id: 'web_visitors_integrations_list', group: 'web-visitors', sub: 'integrations', path: `${B1}/website-visitor-integrations`, expect: ['data'],
    description: 'Website visitor tracking setups (domain, tag, test and pixel-conflict state). Private route, read-only.', params: [limit, skip] },
  { id: 'web_visitors_count', group: 'web-visitors', sub: 'count', path: `${B1}/website-visitor/count`, expect: ['total'],
    description: 'Total identified website visitors. Private route, read-only.' },
  { id: 'web_voice_suppressions_list', group: 'web-voice', sub: 'suppressions', path: `${B2}/ai-agents/voice-agent/suppressions`, expect: ['items', 'total'],
    description: 'Voice agent call suppression list. Private route, read-only.', params: [limit, offset] },
  { id: 'web_voice_phone_numbers_list', group: 'web-voice', sub: 'phone-numbers', path: `${B2}/crm-actions/phone-numbers`, expect: 'array',
    description: 'Phone numbers attached to the workspace for calls. Private route, read-only.' },
  { id: 'web_voice_available_numbers_list', group: 'web-voice', sub: 'available-numbers', path: `${A}/communication/list-phone-numbers`, expect: 'array',
    description: 'Phone numbers offered for a country in Calls and SMS setup. Listing only, nothing is bought.',
    params: [{ name: 'country', type: 'string', required: true, description: 'Two-letter country code, for example US' }] },
  { id: 'web_agents_sales_list', group: 'web-agents', sub: 'sales', path: `${B2}/ai-agents/sales`, expect: ['items'],
    description: 'AI sales agents shown on the Agents screen. Private route, read-only.', params: [limit, { name: 'agent_type', type: 'string', description: 'Agent type filter' }] },
  { id: 'web_agents_lead_finder_list', group: 'web-agents', sub: 'lead-finder', path: `${B2}/ai-agents/lead-finder`, expect: ['items'],
    description: 'Lead Finder agents. Private route, read-only.', params: [limit] },
  { id: 'web_agents_pending_activities_list', group: 'web-agents', sub: 'pending-activities', path: `${B2}/ai-agents/pending-activities`, expect: ['items', 'total'],
    description: 'AI agent activities waiting for approval. Private route, read-only.', params: [limit, { name: 'agent_id', type: 'string', description: 'Agent id' }, { name: 'action_type', type: 'string', description: 'Action type' }] },
  { id: 'web_agents_pending_groups_list', group: 'web-agents', sub: 'pending-groups', path: `${B2}/ai-agents/pending-activities/groups`, expect: ['items', 'total'],
    description: 'Pending AI agent activities grouped by agent and action. Private route, read-only.' },
  { id: 'web_agents_used_tags_get', group: 'web-agents', sub: 'used-tags', path: `${B2}/ai-agents/used-tags`, expect: ['usedTags'],
    description: 'Tags already claimed by AI agents. Private route, read-only.' },
  { id: 'web_agent_items_list', group: 'web-agents', sub: 'items', path: `${B2}/agent-items`, expect: ['items'],
    description: 'Agent work items feed. Private route, read-only.', params: [limit] },
  { id: 'web_engage_items_list', group: 'web-agents', sub: 'engage-items', path: `${B2}/engage-items`, expect: ['items'],
    description: 'Engage feed items. Private route, read-only.', params: [limit] },
  { id: 'web_automation_workflows_list', group: 'web-automation', sub: 'workflows', path: `${B2}/automation/workflows`, expect: ['items'],
    description: 'Automation workflows built in the web app. Private route, read-only.', params: [limit, startingAfter] },
  { id: 'web_automation_templates_list', group: 'web-automation', sub: 'templates', path: `${B2}/automation/workflow-templates`, expect: ['items'],
    description: 'Automation workflow templates. Private route, read-only.' },
  { id: 'web_automation_approvals_list', group: 'web-automation', sub: 'approvals', path: `${B2}/automation/approvals`, expect: ['items'],
    description: 'Automation steps waiting for approval. Private route, read-only.', params: [limit] },
  { id: 'web_automation_apps_list', group: 'web-automation', sub: 'apps', path: `${B2}/automation/apps`, expect: ['items'],
    description: 'Apps available to automations. Private route, read-only.', params: [limit, startingAfter] },
  { id: 'web_automation_connections_list', group: 'web-automation', sub: 'connections', path: `${B2}/automation/app/connections`, expect: ['items'],
    description: 'App connections used by automations. Private route, read-only.', params: [limit, startingAfter] },
  { id: 'web_analytics_sales_agent', group: 'web-analytics', sub: 'sales-agent', path: `${B2}/ai-sales-agent/analytics`, expect: ['totals'],
    description: 'AI sales agent activity, replies and opportunities per day. Private route, read-only.', params: range('start_date', 'end_date') },
  { id: 'web_analytics_inbox_manager', group: 'web-analytics', sub: 'inbox-manager', path: `${B2}/ai-inbox-manager-analytics/summary`, expect: ['total_actions'],
    description: 'AI inbox manager totals: replies, follow-ups, time saved, resolution rate. Private route, read-only.', params: range('from', 'to') },
  { id: 'web_analytics_inbox_manager_by_date', group: 'web-analytics', sub: 'inbox-manager-by-date', path: `${B2}/ai-inbox-manager-analytics/summary-by-date`, expect: 'array',
    description: 'AI inbox manager activity per day. Private route, read-only.', params: range('from', 'to') },
  { id: 'web_analytics_email_marketing', group: 'web-analytics', sub: 'email-marketing', path: `${B2}/email-marketing/metrics`, expect: ['totals', 'series'],
    description: 'Email marketing totals and series. Private route, read-only.', params: [{ name: 'time_range', type: 'string', description: 'Window, for example 30d' }] },
  { id: 'web_credits_get', group: 'web-billing', sub: 'credits', path: `${B2}/workspaces/current/instantly-credits`, expect: ['balance'],
    description: 'Remaining Instantly credits. Use before any spend to check the ceiling. Private route, read-only.' },
  { id: 'web_plan_details_get', group: 'web-billing', sub: 'plan', path: `${B2}/workspace-billing/plan-details`, expect: ['subscriptions'],
    description: 'Subscription plan, lead limits and addons. No payment details. Private route, read-only.' },
  { id: 'web_payment_status_get', group: 'web-billing', sub: 'payment-status', path: `${B2}/workspace-billing/payment-status`, expect: ['status'],
    description: 'Whether a payment is overdue. Private route, read-only.' },
  { id: 'web_leadfinder_searches_list', group: 'web-leadfinder', sub: 'searches', path: `${A}/leads-finder/searches`, expect: 'array',
    description: 'Saved Lead Finder searches. Private route, read-only.', params: [limit, skip] },
  { id: 'web_supersearch_recent_list', group: 'web-leadfinder', sub: 'recent-searches', path: `${A}/supersearch/recent-searches`, expect: ['items'],
    description: 'Recent SuperSearch searches. Private route, read-only.', params: [limit] },
  { id: 'web_supersearch_proposals_list', group: 'web-leadfinder', sub: 'proposals', path: `${A}/supersearch/proposals`, expect: 'object',
    description: 'Suggested SuperSearch audiences. Private route, read-only.',
    params: [{ name: 'surface', type: 'enum', values: ['classic_landing', 'todays_focus'], required: true, description: 'Screen the suggestions are for' }] },
  { id: 'web_company_lists_list', group: 'web-leadfinder', sub: 'company-lists', path: `${B2}/supersearch-enrichment/company-lists`, expect: ['data', 'total'],
    description: 'Company lists used for enrichment. Private route, read-only.', params: [limit] },
  { id: 'web_company_list_sources', group: 'web-leadfinder', sub: 'company-list-sources', path: `${B2}/supersearch-enrichment/company-lists/sources`, expect: 'array',
    description: 'Sources a company list can be built from. Private route, read-only.' },
  { id: 'web_copilot_focus_get', group: 'web-copilot', sub: 'focus', path: `${B2}/instantly-ai/focus`, expect: ['items'],
    description: 'Copilot daily focus suggestions and paused or autopilot agents. Private route, read-only.' },
  { id: 'web_copilot_sessions_list', group: 'web-copilot', sub: 'sessions', path: `${B2}/instantly-ai/sessions`, expect: ['items'],
    description: 'Copilot chat sessions. Private route, read-only.', params: [limit] },
  { id: 'web_copilot_artifacts_list', group: 'web-copilot', sub: 'artifacts', path: `${B2}/instantly-ai/artifacts/library`, expect: ['items'],
    description: 'Copilot saved artifacts. Private route, read-only.', params: [limit, offset] },
  { id: 'web_integrations_directory_list', group: 'web-integrations', sub: 'directory', path: `${B2}/integrations/directory`, expect: ['items'],
    description: 'Integrations directory shown in settings. Private route, read-only.', params: [limit, startingAfter] },
];

/** The directory route needs a fixed surface value; the others take only the params above. */
export const FIXED_QUERY: Record<string, Record<string, string>> = {
  web_integrations_directory_list: { surface: 'settings' },
};
export const WEB_BY_PATH: Map<string, WebRoute> = new Map(WEB_ROUTES.map(r => [r.path, r]));
