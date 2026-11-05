import { z } from 'zod';

/** Strict envelopes shared by the MCP registrations and the CLI mirror. Dynamic arguments are validated per command at runtime. */
const commandId = z.string().min(1).max(200).describe('Command ID exactly as returned by instantly_find, for example campaigns_list. status and health are also valid.');
const args = z.record(z.string(), z.unknown()).describe('Command inputs exactly as shown by instantly_describe. Do not include profile or workspace_id here.');
const profile = z.string().min(1).max(100).describe('Profile slug this process is bound to. Use default if no profile is configured. A different slug is refused.');
const workspace = z.uuid().describe('Workspace UUID you expect. Mismatch with the live workspace sends nothing.');

export const findShape = {
  intent: z.string().min(1).max(500).describe('Plain-language request, for example: list unread replies'),
  limit: z.number().int().min(1).max(10).default(5).describe('Maximum hits, 1 to 10'),
  effect: z.enum(['any', 'read', 'write']).default('any').describe('Restrict to reads or writes'),
};
export const describeShape = { command_id: commandId };
export const previewShape = { command_id: commandId, arguments: args, profile, workspace_id: workspace };
/** Flat registration shape; the discriminated union below enforces the real contract. */
export const runShape = {
  mode: z.enum(['read', 'write']).describe('read runs a read command. write executes a previously previewed write.'),
  command_id: commandId.optional().describe('Required when mode is read. Not allowed when mode is write.'),
  arguments: args.optional().describe('Used only when mode is read.'),
  preview_token: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Required when mode is write. Not allowed when mode is read.'),
  profile,
  workspace_id: workspace,
};

export const findInput = z.object(findShape).strict();
export const describeInput = z.object(describeShape).strict();
export const previewInput = z.object(previewShape).strict();
export const runInput = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('read'), command_id: commandId, arguments: args.default({}), profile, workspace_id: workspace }).strict(),
  z.object({ mode: z.literal('write'), preview_token: z.string().regex(/^[a-f0-9]{64}$/), profile, workspace_id: workspace }).strict(),
]);

export type FindInput = z.infer<typeof findInput>;
export type DescribeInput = z.infer<typeof describeInput>;
export type PreviewInput = z.infer<typeof previewInput>;
export type RunInput = z.infer<typeof runInput>;

export const TOOL_NAMES = ['instantly_find', 'instantly_describe', 'instantly_preview', 'instantly_run'] as const;
