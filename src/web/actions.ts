/**
 * Attended browser actions for UI-only tasks the API cannot do. An action opens a screen in the operator's own
 * signed-in tab and may prefill text fields. It never clicks, never submits, and never reads a page value back
 * to the caller: the human reviews the screen and presses the final button. Pure data, shared by the registry,
 * policy, client and transport.
 */
export interface FillSpec { field: string; selector: string; max: number; description: string }
export interface WebAction {
  id: string;
  sub: string;
  description: string;
  /** Fixed app path, or a field whose value picks one from `screens`. */
  page?: string;
  screenField?: string;
  fills: FillSpec[];
}

/** Screens a human may be sent to. Each is a plain app route; opening one changes nothing. */
export const SCREENS: Record<string, string> = {
  agents: '/app/agents',
  'agents-new': '/app/agents/new',
  'crm-home': '/app/crm/home',
  'website-visitors': '/app/settings/website-visitors',
  'calls-sms': '/app/settings/calls-sms',
  integrations: '/app/settings/integrations',
  leadfinder: '/app/leadfinder',
  copilot: '/app/copilot',
  billing: '/app/settings/billing',
};

export const WEB_ACTIONS: WebAction[] = [
  { id: 'web_action_open_screen', sub: 'open-screen', screenField: 'screen', fills: [],
    description: `Open a named Instantly screen in the attended browser so the user can finish a UI-only task (voice agent, CRM, website visitor setup, calls). Screens: ${Object.keys(SCREENS).join(', ')}. Nothing is clicked or submitted.` },
  { id: 'web_action_agent_prefill', sub: 'agent-prefill', page: '/app/agents/new',
    fills: [{ field: 'text', selector: 'input[placeholder^="Search agents or templates"]', max: 500, description: 'Agent or automation request to type into the Agents box' }],
    description: 'Open the Agents creation screen and type a request into its box (for example a voice agent brief). The user reviews it and presses Generate; this never submits. The app may run its own search as text is typed.' },
];
export const actionPath = (id: string) => `/browser-action/${id}`;
export const WEB_ACTION_BY_PATH: Map<string, WebAction> = new Map(WEB_ACTIONS.map(a => [actionPath(a.id), a]));

/** The concrete page and field values for one action call, validated. Throws on anything outside the table. */
export function resolveAction(action: WebAction, body: Record<string, unknown>): { page: string; fills: { selector: string; value: string }[] } {
  const allowed = new Set([...(action.screenField ? [action.screenField] : []), ...action.fills.map(f => f.field)]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new Error(`UNKNOWN_ARGUMENTS: ${key}`);
  let page = action.page;
  if (action.screenField) {
    const screen = body[action.screenField];
    if (typeof screen !== 'string' || !Object.hasOwn(SCREENS, screen)) throw new Error('INVALID_ARGUMENTS: unknown screen');
    page = SCREENS[screen];
  }
  const fills = action.fills.map(f => {
    const value = body[f.field];
    if (typeof value !== 'string' || value.length < 1 || value.length > f.max || /[\u0000-\u001f]/.test(value)) throw new Error(`INVALID_ARGUMENTS: ${f.field}`);
    return { selector: f.selector, value };
  });
  return { page: page as string, fills };
}
