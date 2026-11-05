import { z } from 'zod';
import type { BrowserStep, Computed, PlaybookDefinition, ReadResults, ReadStep, WriteStep } from '../types.js';

const val = (reads: ReadResults, id: string): any => { const r = reads[id]; return r && r.ok ? r.value : undefined; };
const items = (v: any): any[] => Array.isArray(v?.items) ? v.items : [];
const HOST = /^(?=.{4,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

export const SUBSCRIPTION_ROUTE = 'Instantly app: Billing > Plans, add Website Visitors. Setup then lives under Leads > Website Visitors > Setup.';

export function isEntitled(billing: any): boolean {
  const plan = billing?.subscriptions?.website_visitors?.plan_name;
  return typeof plan === 'string' && plan.trim() !== '';
}
export function legalChecklist(domain: string): BrowserStep[] {
  const b = (id: string, page: string, action: BrowserStep['action'], instruction: string, fields?: string[]): BrowserStep => ({ id, page, action, instruction, ...(fields ? { fields } : {}) });
  return [
    b('legal', 'external: client website', 'external', `Before any pixel goes live on ${domain}: publish the privacy-policy paragraph Instantly supplies (CPRA-compliant) and a cookie banner with affirmative consent and an opt-out. The client owns this public claim; a human confirms it. Tracking covers US traffic only; EU and Canadian visitors are ignored.`),
    b('setup', 'Instantly: Leads > Website Visitors > Setup', 'attended-submit', `Add New, enter ${domain}, press Get the Pixel. This creates a configured website in the account and starts the credit meter once the pixel is live (3 credits per resolved person, 2 per company-only). A human presses the button.`, ['domain']),
    b('install', 'external: client website', 'external', 'Place the pixel in the site header through the CMS or tag manager. This happens outside Instantly.'),
    b('verify', 'Instantly: Website Visitors > Setup', 'attended-submit', 'Press Test code installation and wait for status Successful. A human presses the button.'),
    b('view', 'Instantly: Website Visitors > Views', 'fill', 'Prepare a Website Visitor View: time range, revenue, seniority, department, industry, employees, URL and referrer filters; destination is the draft campaign or list created by this playbook. A human reviews and presses Save.', ['filters', 'destination', 'slack_webhook', 'webhook_url']),
  ];
}

export const visitors: PlaybookDefinition = {
  slug: 'website_visitors_setup',
  title: 'Website visitor identification setup (handoff)',
  description: 'Entitlement-gated setup plan for website visitor identification. Returns NOT_ENTITLED with the subscription route when the workspace has no Website Visitors plan. Otherwise stages a holding list, a paused draft campaign and an optional reply webhook, and returns the pixel, legal and View steps as an attended browser checklist. It never clicks, submits or installs anything.',
  requires: ['api_read', 'api_write', 'browser_read'],
  offerFit: offer => offer.entitlements.website_visitors || offer.motion === 'demand_gen',
  examples: ["instantly --profile <slug> --workspace <uuid> playbooks run website_visitors_setup --input '{\"domain\":\"example.com\"}'"],
  inputSchema: z.object({
    domain: z.string().toLowerCase().regex(HOST, 'a bare hostname such as example.com'),
    webhook_url: z.string().url().startsWith('https://').max(300).optional().describe('Optional HTTPS endpoint for reply_received on the draft campaign'),
    max_pages: z.coerce.number().int().min(1).max(5).default(3).describe('Lead pages (100 each) scanned for visitors'),
  }).strict(),
  reads(input): ReadStep[] {
    return [
      { id: 'billing', command: 'workspace_billing_plan-details', args: {} },
      { id: 'campaigns', command: 'campaigns_list', args: { limit: 100, search: `[DRAFT] Website visitors - ${input.domain}` }, pages: 10, requireComplete: true },
      { id: 'lists', command: 'lead_lists_list', args: { limit: 100, search: `Website visitors - ${input.domain}` }, pages: 10, requireComplete: true },
      ...(input.webhook_url ? [{ id: 'hooks', command: 'webhooks_list', args: { limit: 100, event_type: 'reply_received' }, pages: 10, requireComplete: true }] : []),
      { id: 'leads', command: 'leads_list', args: { limit: 100 }, pages: input.max_pages, optional: true },
    ];
  },
  compute(input, reads): Computed {
    const billing = val(reads, 'billing');
    if (!isEntitled(billing)) {
      return { artifact: { entitled: false, domain: input.domain }, writes: [], browser: [], cost: { credits: 'none', max_credits: 0, notes: 'Nothing is staged without an entitlement.' },
        refusals: [{ code: 'NOT_ENTITLED', message: 'This workspace has no Website Visitors subscription. Nothing was staged.', route: SUBSCRIPTION_ROUTE }] };
    }
    const leads = items(val(reads, 'leads'));
    const visitors = leads.filter(l => l?.is_website_visitor === true);
    const stem = `Website visitors - ${input.domain}`;
    const campaignName = `[DRAFT] ${stem}`;
    const campaign = items(val(reads, 'campaigns')).find(c => c?.name === campaignName);
    const lists = new Set(items(val(reads, 'lists')).map(l => String(l?.name ?? '')));
    const writes: WriteStep[] = [];
    if (!lists.has(stem)) writes.push({ id: 'list', stage: 1, command: 'lead_lists_create', summary: 'Create the holding list for identified visitors', args: { name: stem }, credits: 0,
      reconcile: { id: 'list_check', command: 'lead_lists_list', args: { search: stem, limit: 5 } } });
    if (!campaign) {
      writes.push({ id: 'campaign', stage: 2, command: 'campaigns_create', summary: 'Create a paused draft campaign with no senders (cannot send)', credits: 0,
        args: { name: campaignName, text_only: true, stop_on_reply: true, sequences: [{ steps: [
          { type: 'email', delay: 3, delay_unit: 'days', variants: [{ subject: 'Saw you stop by, {{firstName}}', body: 'Hi {{firstName}},\n\n[DRAFT - rewrite] Thanks for looking at us. Happy to answer anything specific.\n\nWorth a quick call?' }] },
          { type: 'email', delay: 0, delay_unit: 'days', variants: [{ subject: 'Re: Saw you stop by, {{firstName}}', body: 'Hi {{firstName}},\n\n[DRAFT - rewrite] Following up in case this got buried.' }] },
        ] }] },
        reconcile: { id: 'campaign_check', command: 'campaigns_list', args: { search: campaignName, limit: 5 } } });
    }
    if (input.webhook_url) {
      if (campaign && !z.uuid().safeParse(campaign.id).success) throw new Error('DEPENDENT_VALUE_INVALID: existing campaign id');
      const exists = campaign && items(val(reads, 'hooks')).some(h => h.campaign === campaign.id && h.event_type === 'reply_received' && h.target_hook_url === input.webhook_url);
      if (!exists) writes.push({ id: 'webhook', stage: 3, command: 'webhooks_create', summary: 'Notify an HTTPS endpoint when the draft campaign gets a reply', credits: 0,
        args: { name: `${stem} replies`, target_hook_url: input.webhook_url, event_type: 'reply_received', ...(campaign ? { campaign: campaign.id } : {}) },
        ...(campaign ? {} : { fills: [{ into: 'campaign', from: 'campaign', path: 'id' }] }) });
    }
    return { artifact: { entitled: true, domain: input.domain, plan: billing?.subscriptions?.website_visitors?.plan_name,
      visitors: { scanned_leads: leads.length, identified: visitors.length, sample_ids: visitors.slice(0, 10).map(v => String(v.id)) },
      next_loop: 'Re-run this playbook to re-read visitors. Verify emails before contact (email_verification, metered); never contact unverified visitors.' },
      writes, browser: legalChecklist(input.domain), refusals: [],
      cost: { credits: 'metered', max_credits: 0, notes: 'The playbook spends nothing. Credits are charged by Instantly per detection once the pixel is live: the client owns that spend.' } };
  },
};
