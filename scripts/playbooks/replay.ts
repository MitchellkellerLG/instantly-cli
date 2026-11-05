import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { allCommands } from '../../src/commands/index.js';
import { canonical, digest } from '../../src/safe/canonical.js';
import { SafeDispatcher } from '../../src/safe/dispatcher.js';
import { MemoryPreviewStore } from '../../src/safe/preview-store.js';
import { clientFromRequest, type Request } from '../../src/safe/transport.js';
import { PlaybookRunner } from '../../src/playbooks/runner.js';
import { allPlaybooks } from '../../src/playbooks/registry.js';
import type { Tier } from '../../src/playbooks/types.js';

export interface Exchange { request: Request; response: unknown }
export interface Recording {
  id: string; playbook: string; tier: Tier; input: Record<string, unknown>;
  scope: { profile: string; workspace: string }; workspaceName: string; allowedWrites: string[];
  exchanges: Exchange[];
  expect: { plan_hash: string; artifact_hash: string; refusals: string[]; steps: { command: string; arguments: unknown }[]; token_issued: boolean };
}
export const DIRECTORY = 'evals/playbooks-v1/recorded';
export const loadRecordings = (dir = DIRECTORY): Recording[] =>
  readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));

const key = (r: Request) => canonical({ method: r.method, path: r.path, query: r.query ?? null, body: r.body ?? null });

/** Strict sequential fake: every request must match the next recorded exchange exactly. No network, ever. */
export function replayRunner(rec: Recording) {
  const seen: Request[] = [];
  let cursor = 0;
  const client = clientFromRequest(async <T>(request: Request): Promise<T> => {
    seen.push(structuredClone(request));
    const expected = rec.exchanges[cursor++];
    if (!expected) throw new Error('REPLAY_EXTRA_REQUEST ' + key(request));
    if (key({ ...request, retry: undefined } as Request) !== key(expected.request)) throw new Error('REPLAY_MISMATCH at ' + (cursor - 1) + ': ' + key(request) + ' != ' + key(expected.request));
    return structuredClone(expected.response) as T;
  });
  const identity = { profile: rec.scope.profile, workspace: rec.scope.workspace, workspaceName: rec.workspaceName, credentialRef: 'replay-ref' };
  const dispatcher = new SafeDispatcher({ commands: allCommands, bound: identity, identity: async () => { await client.get('/workspaces/current'); return identity; },
    client, store: new MemoryPreviewStore(), registryRevision: 'replay', contextRevision: 'replay', allowedWrites: rec.allowedWrites, allowUnknownCost: true, authorizeWrite: async () => true });
  const runner = new PlaybookRunner({ dispatcher, scope: rec.scope, tier: rec.tier, commands: allCommands, playbooks: allPlaybooks, hostAllowedWrites: rec.allowedWrites, allowUnknownCost: true });
  return { runner, seen, remaining: () => rec.exchanges.length - cursor };
}
/**
 * Fill each exchange's request from what the code builds over the redacted responses. The result is a golden file:
 * it pins request construction and computation on live-shaped data without any live value. Method and path must
 * still agree with what was seen live.
 */
export async function learn(rec: Recording): Promise<Recording> {
  const learned: Exchange[] = [];
  let cursor = 0;
  const client = clientFromRequest(async <T>(request: Request): Promise<T> => {
    const expected = rec.exchanges[cursor++];
    if (!expected) throw new Error('LEARN_EXTRA_REQUEST ' + request.method + ' ' + request.path);
    if (request.method !== expected.request.method || request.path !== expected.request.path) throw new Error(`LEARN_PATH_MISMATCH at ${cursor - 1}: ${request.method} ${request.path} != ${expected.request.method} ${expected.request.path}`);
    learned.push({ request: JSON.parse(JSON.stringify({ ...request, retry: undefined })), response: expected.response });
    return structuredClone(expected.response) as T;
  });
  const identity = { profile: rec.scope.profile, workspace: rec.scope.workspace, workspaceName: rec.workspaceName, credentialRef: 'replay-ref' };
  const dispatcher = new SafeDispatcher({ commands: allCommands, bound: identity, identity: async () => { await client.get('/workspaces/current'); return identity; },
    client, store: new MemoryPreviewStore(), registryRevision: 'replay', contextRevision: 'replay', allowedWrites: rec.allowedWrites, allowUnknownCost: true, authorizeWrite: async () => true });
  const runner = new PlaybookRunner({ dispatcher, scope: rec.scope, tier: rec.tier, commands: allCommands, playbooks: allPlaybooks, hostAllowedWrites: rec.allowedWrites, allowUnknownCost: true });
  await runner.preview(rec.playbook, rec.input);
  // Redaction removes the text that drove some live decisions, so trailing live-only exchanges (for example write previews) are dropped.
  return { ...rec, exchanges: learned };
}
export async function replay(rec: Recording) {
  const { runner, seen, remaining } = replayRunner(rec);
  const preview = await runner.preview(rec.playbook, rec.input);
  return { preview, seen, remaining: remaining(), got: {
    plan_hash: preview.plan_hash, artifact_hash: digest(preview.artifact), refusals: preview.refusals.map(r => r.code),
    steps: preview.steps.map(s => ({ command: s.command, arguments: s.arguments })), token_issued: preview.playbook_token !== null } };
}
if (process.argv[1]?.endsWith('replay.ts')) {
  let failed = 0;
  for (const rec of loadRecordings()) {
    try {
      const r = await replay(rec);
      const ok = r.remaining === 0 && canonical(r.got) === canonical(rec.expect);
      if (!ok) failed++;
      console.log(JSON.stringify({ id: rec.id, playbook: rec.playbook, requests: r.seen.length, mutations: r.seen.filter(x => x.method !== 'GET' && !['/leads/list', '/local-business-search/search', '/supersearch-enrichment/count-leads-from-supersearch'].includes(x.path)).length, ok }));
    } catch (error) { failed++; console.log(JSON.stringify({ id: rec.id, ok: false, error: String(error).slice(0, 200) })); }
  }
  process.exitCode = failed ? 1 : 0;
}
