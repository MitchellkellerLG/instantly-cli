/**
 * Live proof run against the Keagans Space test workspace ONLY. Run as:
 *   lg-vault run --env dev bash -c 'INSTANTLY_API_KEY="$INSTANTLY_TEST_API" npx tsx scripts/playbooks/proof.ts --out <dir>'
 * It refuses any other workspace, prints no secret, records redacted request/response exchanges as replay fixtures,
 * spends at most CREDIT_CEILING credits, and deletes every object it created. Reads and previews run first; writes
 * only run for the ids this script created itself.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InstantlyClient } from '../../src/core/client.js';
import { resolveCredentials } from '../../src/core/auth.js';
import { fetchLiveWorkspace } from '../../src/core/workspace.js';
import { allCommands } from '../../src/commands/index.js';
import { digest } from '../../src/safe/canonical.js';
import { SafeDispatcher } from '../../src/safe/dispatcher.js';
import { MemoryPreviewStore } from '../../src/safe/preview-store.js';
import { clientFromRequest, type Request } from '../../src/safe/transport.js';
import { PlaybookRunner, type PlaybookRunResult } from '../../src/playbooks/runner.js';
import { allPlaybooks } from '../../src/playbooks/registry.js';
import { z } from 'zod';
import type { PlaybookDefinition, Tier } from '../../src/playbooks/types.js';
import { leaks, mapUuids, redact, redactPath, synthUuid } from './redact.js';
import type { Recording } from './replay.js';
import { verifyLookalikeCampaign } from './proof-checks.js';

const EXPECTED_WORKSPACE = 'a36a2911-822f-4b20-92c8-f64218842f5c';
const EXPECTED_NAME = 'Keagans Space';
const CREDIT_CEILING = 50;
const out = process.argv[process.argv.indexOf('--out') + 1];
if (!out || out.startsWith('--')) throw new Error('Usage: proof.ts --out <directory>');
const recordedDir = join(out, 'recorded');
mkdirSync(recordedDir, { recursive: true });

const credentials = await resolveCredentials({});
const real = new InstantlyClient({ apiKey: credentials.apiKey });
const live = await fetchLiveWorkspace(real);
if (live.id !== EXPECTED_WORKSPACE || live.name !== EXPECTED_NAME) throw new Error('REFUSED: this is not the Keagans Space test workspace.');

let exchanges: { request: Request; response: unknown }[] = [];
let requestCount = 0;
const metered = clientFromRequest(async <T>(request: Request): Promise<T> => {
  requestCount++;
  const response = await real.request(request) as T;
  exchanges.push({ request: JSON.parse(JSON.stringify({ ...request, retry: undefined })), response: JSON.parse(JSON.stringify(response ?? null)) });
  return response;
});
const identity = { profile: 'default', workspace: live.id, workspaceName: live.name, credentialRef: digest({ proof: true }) };
const scope = { profile: identity.profile, workspace: identity.workspace };

function runnerFor(tier: Tier, writes: string[], extra: PlaybookDefinition[] = []) {
  const dispatcher = new SafeDispatcher({ commands: allCommands, bound: identity,
    identity: async () => { const w = await fetchLiveWorkspace(metered); if (w.id !== EXPECTED_WORKSPACE) throw new Error('WORKSPACE_MISMATCH'); return identity; },
    client: metered, store: new MemoryPreviewStore(), registryRevision: 'proof', contextRevision: 'proof', allowedWrites: writes, allowUnknownCost: true, authorizeWrite: async c => writes.includes(c) });
  return new PlaybookRunner({ dispatcher, scope, tier, commands: allCommands, playbooks: [...allPlaybooks, ...extra].map(p => ({ ...p, compute: (...args) => {
    const computed = p.compute(...args);
    return { ...computed, writes: computed.writes.map(w => ({ ...w, exposeResponse: true })) };
  } })), hostAllowedWrites: writes, allowUnknownCost: true });
}
const credits = async () => ((await real.get<any>('/workspace-billing/plan-details'))?.subscriptions?.credits?.available_credits ?? null) as number | null;
const steps: Record<string, unknown>[] = [];
const record = (s: Record<string, unknown>) => { steps.push(s); console.error(JSON.stringify({ step: s.step, ok: s.ok })); };

// ---- A. read-only and preview recordings --------------------------------------------------------------------
const lists = await real.get<any>('/lead-lists', { limit: 5 });
const firstList: string | undefined = lists?.items?.[0]?.id;
const before = await credits();
const readCases: { id: string; playbook: string; input: Record<string, unknown> }[] = [
  { id: 'offer-profile', playbook: 'offer_profile', input: {} },
  { id: 'campaign-ideas', playbook: 'campaign_ideas', input: { count: 18 } },
  { id: 'segments-preview', playbook: 'skin_in_the_game_segments', input: { ...(firstList ? { list_id: firstList } : { campaign_id: EXPECTED_WORKSPACE }), apply: 'lists' } },
  { id: 'visitors-not-entitled', playbook: 'website_visitors_setup', input: { domain: 'example.com' } },
  { id: 'local-lookalike-preview', playbook: 'local_lookalike', input: { category: 'dentist', place: 'Austin, TX', count: 2 } },
];
const writesForRecording = ['campaigns_create', 'lead_lists_create', 'webhooks_create', 'local_business_search_convert_local_businesses'];
for (const c of readCases) {
  exchanges = []; requestCount = 0;
  const runner = runnerFor('internal', writesForRecording);
  const preview = await runner.preview(c.playbook, c.input);
  const mutationsSent = exchanges.filter(e => e.request.method !== 'GET' && !['/leads/list', '/local-business-search/search', '/supersearch-enrichment/count-leads-from-supersearch'].includes(e.request.path)).length;
  const rec: Recording = {
    id: c.id, playbook: c.playbook, tier: 'internal', input: mapUuids(c.input) as Record<string, unknown>,
    scope: { profile: 'default', workspace: synthUuid(live.id) }, workspaceName: 'Synthetic sandbox', allowedWrites: writesForRecording,
    exchanges: exchanges.map(e => ({ request: { method: e.request.method, path: redactPath(e.request.path) } as Request, response: redact(e.response) })),
    expect: { plan_hash: '', artifact_hash: '', refusals: [], steps: [], token_issued: false },
  };
  // Golden values come from replaying the redacted recording, so the committed test needs no live data.
  const { learn, replay } = await import('./replay.js');
  const learned = await learn(rec);
  const golden = await replay(learned);
  learned.expect = golden.got;
  writeFileSync(join(recordedDir, `${c.id}.json`), JSON.stringify(learned, null, 2) + '\n');
  record({ step: `read:${c.id}`, ok: mutationsSent === 0 && golden.remaining === 0, requests: requestCount, mutations: mutationsSent, refusals: preview.refusals.map(r => r.code), steps_planned: preview.steps.length });
}

// ---- B. staged write: campaign ideas draft (no senders) ------------------------------------------------------
const created = { campaigns: [] as string[], lists: [] as string[], webhooks: [] as string[] };
const cleaned = { campaigns: 0, lists: 0, webhooks: 0 };
const cleanupFailures: { resource: string; id: string }[] = [];
function track(result: PlaybookRunResult) {
  for (const receipt of result.receipts) {
    const resource = ({ campaigns_create: 'campaigns', lead_lists_create: 'lists', webhooks_create: 'webhooks' } as const)[receipt.command as 'campaigns_create' | 'lead_lists_create' | 'webhooks_create'];
    if (!resource) continue;
    const id = (receipt.response as { id?: string })?.id;
    if (!z.uuid().safeParse(id).success) throw new Error('Creation response is missing an ownership id.');
    created[resource].push(id!);
  }
}
async function cleanup() {
  for (const resource of ['webhooks', 'campaigns', 'lists'] as const) {
    for (const id of new Set(created[resource])) {
      try {
        await real.delete(`/${resource === 'lists' ? 'lead-lists' : resource}/${id}`);
        cleaned[resource]++;
      } catch { cleanupFailures.push({ resource, id }); }
    }
  }
}
let failure: string | null = null;
try {
  {
    const runner = runnerFor('internal', ['campaigns_create', 'lead_lists_create']);
    const preview = await runner.preview('campaign_ideas', { draft_idea: 'idea-01' });
    const result = await runner.run(preview.playbook_token!);
    track(result);
    const ids = result.receipts.map(r => r.step);
    const campaignId = (result.receipts.find(r => r.command === 'campaigns_create')?.response as any)?.id;
    const found = campaignId ? await real.get<any>(`/campaigns/${campaignId}`) : null;
    record({ step: 'write:campaign-ideas-draft', ok: result.status === 'completed' && !!found && found.status === 0, run_status: result.status, receipts: ids,
      draft_status: found?.status ?? null, draft_has_senders: Array.isArray(found?.email_list) ? found.email_list.length > 0 : false, never_activated: true });
  }
  // ---- C. fills smoke: a script-local playbook proves the typed dependent-argument path live --------------------
  {
    const smoke: PlaybookDefinition = { slug: 'proof_fill_smoke', title: 'proof', description: 'live proof of typed fills', requires: ['api_read', 'api_write'], examples: [],
      inputSchema: z.object({}).strict(), reads: () => [{ id: 'workspace', command: 'workspace_get', args: {} }],
      compute: () => ({ artifact: {}, refusals: [], browser: [], cost: { credits: 'none', max_credits: 0, notes: '' }, writes: [
        { id: 'campaign', stage: 1, command: 'campaigns_create', summary: 'draft', credits: 0, args: { name: `[PROOF] fills ${Date.now()}`, text_only: true } },
        { id: 'webhook', stage: 2, command: 'webhooks_create', summary: 'hook', credits: 0, args: { name: 'proof fills hook', target_hook_url: 'https://example.com/instantly-proof', event_type: 'reply_received' },
          fills: [{ into: 'campaign', from: 'campaign', path: 'id' }] }] }) };
    const runner = runnerFor('internal', ['campaigns_create', 'webhooks_create'], [smoke]);
    const preview = await runner.preview('proof_fill_smoke', {});
    const result = await runner.run(preview.playbook_token!);
    track(result);
    const campaignId = (result.receipts.find(r => r.command === 'campaigns_create')?.response as any)?.id;
    const hookId = (result.receipts.find(r => r.command === 'webhooks_create')?.response as any)?.id;
    const hook = hookId ? await real.get<any>(`/webhooks/${hookId}`) : null;
    const bound = !!campaignId && hook?.campaign === campaignId;
    record({ step: 'write:fills-smoke', ok: result.status === 'completed' && bound === true, run_status: result.status, webhook_bound_to_created_campaign: bound === true });
  }
  // ---- D. segments apply: idempotent holding lists --------------------------------------------------------------
  if (firstList) {
    const runner = runnerFor('internal', ['lead_lists_create']);
    const first = await runner.preview('skin_in_the_game_segments', { list_id: firstList, apply: 'lists' });
    let runStatus = 'no-writes-planned';
    if (first.playbook_token) {
      const result = await runner.run(first.playbook_token);
      runStatus = result.status;
      track(result);
    }
    const second = await runner.preview('skin_in_the_game_segments', { list_id: firstList, apply: 'lists' });
    record({ step: 'write:segments-lists-idempotent', ok: first.playbook_token === null ? true : runStatus === 'completed' && second.steps.length === 0, run_status: runStatus, first_run_steps: first.steps.length, rerun_steps: second.steps.length });
  }
  // ---- E. local lookalike convert (2 leads, at most 4 credits) -----------------------------------------------------
  {
    const spendBefore = await credits();
    const runner = runnerFor('internal', ['local_business_search_convert_local_businesses']);
    const input = { category: 'dentist', place: 'Austin, TX', count: 2, campaign_name: `[DRAFT] [PROOF] lookalike ${randomUUID()}` };
    const preview = await runner.preview('local_lookalike', input);
    if (preview.cost.max_credits > CREDIT_CEILING) throw new Error('Plan exceeds the proof credit ceiling.');
    const result = await runner.run(preview.playbook_token!);
    track(result);
    const job = (result.receipts[0]?.response as any)?.job;
    let status = job?.status as string | undefined; let final: any = job;
    const trackJob = (value: any) => {
      if (z.uuid().safeParse(value?.list_id).success) created.lists.push(value.list_id);
      if (z.uuid().safeParse(value?.campaign_id).success) created.campaigns.push(value.campaign_id);
    };
    trackJob(job);
    for (let i = 0; i < 40 && status === 'running'; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const response = await real.get<any>(`/local-business-search/convert/${job.id}`);
      final = response?.job;
      trackJob(final);
      status = final?.status;
    }
    const campaignEvidence = await verifyLookalikeCampaign(real, final);
    const spendAfter = await credits();
    const spent = spendBefore !== null && spendAfter !== null ? spendBefore - spendAfter : null;
    record({ step: 'write:local-lookalike-convert', ok: result.status === 'completed' && status === 'done' && campaignEvidence.campaign_draft_verified && campaignEvidence.campaign_leads_verified && (spent === null || spent <= (preview.cost.max_credits as number)), run_status: result.status, job_status: status ?? null, ...campaignEvidence,
      requested: final?.requested ?? null, created: final?.created ?? null, credits_reported_spent: final?.credits_spent ?? null, credits_before: spendBefore, credits_after: spendAfter, credits_delta: spent, ceiling: CREDIT_CEILING,
      idempotency_key_len: String((preview.steps[0].arguments as any).body.idempotency_key).length });
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await cleanup();
}
const after = await credits();
const summary = { workspace: `${live.name} (${live.id.slice(0, 8)}...)`, ran_at: new Date().toISOString().slice(0, 10), ceiling_credits: CREDIT_CEILING, credits_before_all: before, credits_after_all: after,
  credits_delta_all: before !== null && after !== null ? before - after : null, cleaned_up: cleaned, cleanup_failures: cleanupFailures.map(f => ({ ...f, id: synthUuid(f.id) })), failure: failure ? 'Proof interrupted; reconcile the failed step before rerunning.' : null, steps };
const text = JSON.stringify(summary, null, 2) + '\n';
const problems = leaks(text);
if (problems.length) throw new Error('LEAK_IN_PROOF: ' + problems.join(','));
writeFileSync(join(out, 'live-proof.json'), text);
console.log(text);

if (failure || cleanupFailures.length || steps.some(s => s.ok !== true)) process.exitCode = 1;
