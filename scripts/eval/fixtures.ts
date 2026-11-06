/** Explicit synthetic fixture authoring. Never use this to approve a changed baseline automatically. */
import { readFileSync, writeFileSync } from 'node:fs';
import { allCommands } from '../../src/commands/index.js';
import { validateArguments } from '../../src/safe/dispatcher.js';
import { clientFromRequest } from '../../src/safe/transport.js';
import { digest, clone } from '../../src/safe/canonical.js';
import type { Job } from '../../src/eval/grader.js';
import type { Fixture } from '../../src/eval/offline.js';
import type { Request } from '../../src/safe/transport.js';

const jobs: Job[] = readFileSync('evals/v1/jobs.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
const statusResponse = { id: jobs[0].fixture.workspace_id, name: 'Synthetic sandbox' };
const fixtures: Fixture[] = [{ context: { command: 'status', arguments: {}, workspace: statusResponse.id },
  position: 0, request: { method: 'GET', path: '/workspaces/current' }, response: statusResponse,
  provenance: 'synthetic', captured: '2026-11-03', schemaVersion: 1, responseHash: digest({ response: statusResponse }) }];
const plans: Record<string, Request[]> = {};
const preparationErrors: Record<string, string> = {};
const seen = new Set<string>();
for (const job of jobs) {
  if (job.availability !== 'implemented' || ['wrong_workspace', 'unpreviewed_write'].includes(job.scenario)) continue;
  const context = { command: job.expected.tool!, arguments: job.expected.key_arguments, workspace: job.fixture.workspace_id };
  if (seen.has(digest(context))) continue;
  seen.add(digest(context));
  const command = allCommands.find(c => c.name === context.command)!;
  let position = 0;
  const requests: Request[] = [];
  try { await command.handler(validateArguments(command, context.arguments), clientFromRequest(async <T>(request: Request): Promise<T> => {
    // Response shape is deliberately synthetic, not a claim about a live account.
    const response: any = request.path === '/emails/unread/count' ? { count: 0 } : request.path.startsWith('/emails/') ? {
      id: '22222222-2222-4222-8222-222222222222', from_address_email: 'lead@example.com',
      lead_email: 'lead@example.com', to_address_email_list: 'sender@example.com', i_sent: false,
    } : { items: [], next_starting_after: null, count: 0, status: 'synthetic', name: 'Synthetic sandbox' };
    if (job.access === 'write' && request.method !== 'GET') requests.push(clone(request));
    else fixtures.push({ context, position: position++, request: clone(request), response,
      provenance: 'synthetic', captured: '2026-11-03', schemaVersion: 1, responseHash: digest({ response }) });
    return response as T;
  })); } catch (error) {
    if (job.id !== 'instantly-029') throw error;
    preparationErrors[job.id] = (error as Error).message;
  }
  if (job.access === 'write') plans[job.id] = requests;
}
writeFileSync('evals/v1/fixtures.json', JSON.stringify({ schemaVersion: 1, provenance: 'synthetic', fixtures, plans, preparationErrors }, null, 2) + '\n');
console.log(JSON.stringify({ fixtures: fixtures.length, plans: Object.keys(plans).length, provenance: 'synthetic' }));
