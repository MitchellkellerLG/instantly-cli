import { z } from 'zod';
import { stringArray } from '../../core/schemas.js';
import type { CommandDefinition } from '../../core/types.js';

export const leadsMoveCommand: CommandDefinition = {
  name: 'leads_move',
  group: 'leads',
  subcommand: 'move',
  description: 'Move leads between campaigns. Specify lead IDs and the target campaign.',
  examples: [
    'instantly leads move --lead-ids "id1,id2" --to-campaign-id <id>',
  ],

  inputSchema: z.object({
    lead_ids: stringArray.describe('Array of lead IDs to move'),
    from_campaign_id: z.string().optional().describe('Source campaign ID'),
    to_campaign_id: z.string().describe('Destination campaign ID'),
  }),

  cliMappings: {
    options: [
      { field: 'lead_ids', flags: '--lead-ids <ids>', description: 'Comma-separated lead IDs' },
      { field: 'from_campaign_id', flags: '--from-campaign-id <id>', description: 'Source campaign' },
      { field: 'to_campaign_id', flags: '--to-campaign-id <id>', description: 'Destination campaign' },
    ],
  },

  endpoint: { method: 'POST', path: '/leads/move' },

  fieldMappings: {
    lead_ids: 'body',
    from_campaign_id: 'body',
    to_campaign_id: 'body',
  },

  handler: async (input, client) => {
    let leadIds = input.lead_ids;
    if (typeof leadIds === 'string') {
      leadIds = leadIds.split(',').map((id: string) => id.trim());
    }
    return client.post('/leads/move', { ids: leadIds, to_campaign_id: input.to_campaign_id,
      ...(input.from_campaign_id !== undefined ? { campaign: input.from_campaign_id } : {}),
    });
  },
};
