import { z } from 'zod';
import type { InstantlyClient } from '../../src/core/types.js';

export async function verifyLookalikeCampaign(client: Pick<InstantlyClient, 'get' | 'post'>, job: any) {
  const evidence = { campaign_id_valid: z.uuid().safeParse(job?.campaign_id).success,
    campaign_draft_verified: false, campaign_leads_verified: false, campaign_status: null as number | null, campaign_lead_count: 0 };
  if (!evidence.campaign_id_valid || job?.status !== 'done') return evidence;
  const campaign = await client.get<any>(`/campaigns/${job.campaign_id}`);
  evidence.campaign_status = typeof campaign?.status === 'number' ? campaign.status : null;
  evidence.campaign_draft_verified = campaign?.id === job.campaign_id && campaign.status === 0;
  const leads = await client.post<any>('/leads/list', { campaign: job.campaign_id, limit: 100 });
  const items = Array.isArray(leads?.items) ? leads.items : [];
  evidence.campaign_lead_count = items.length;
  evidence.campaign_leads_verified = Number.isInteger(job.created) && job.created > 0 && items.length === job.created &&
    items.every((lead: any) => lead?.campaign === job.campaign_id && z.uuid().safeParse(lead?.id).success) &&
    new Set(items.map((lead: any) => lead.id)).size === job.created;
  return evidence;
}
