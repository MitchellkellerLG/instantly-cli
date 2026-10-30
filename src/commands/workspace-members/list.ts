import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { executeCommand } from '../../core/handler.js';

export const workspaceMembersListCommand: CommandDefinition = {
  name: 'workspace_members_list',
  group: 'workspace-members',
  subcommand: 'list',
  description: 'List all workspace members.',
  examples: ['instantly workspace-members list'],

  inputSchema: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().describe('Items per page (1-100)'),
    starting_after: z.string().optional().describe('Pagination cursor'),
    accepted: z.union([z.boolean(), z.enum(['true', 'false']).transform(value => value === 'true')]).optional().describe('Filter by invitation acceptance'),
  }),
  cliMappings: {
    options: [
      { field: 'limit', flags: '-l, --limit <number>', description: 'Items per page (1-100)' },
      { field: 'starting_after', flags: '--starting-after <cursor>', description: 'Pagination cursor' },
      { field: 'accepted', flags: '--accepted <bool>', description: 'Invitation accepted: true or false' },
    ],
  },
  endpoint: { method: 'GET', path: '/workspace-members' },
  fieldMappings: { limit: 'query', starting_after: 'query', accepted: 'query' },
  paginated: true,
  handler: (input, client) => executeCommand(workspaceMembersListCommand, input, client),
};
