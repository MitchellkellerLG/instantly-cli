import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '../../src/compact/catalog.js';
import { applyMutation, baselineRound, evaluateRound, graduate, MAX_MUTATIONS, scoreContext, type Mutation, type Round } from '../../src/eval/anneal.js';
import type { Job } from '../../src/eval/grader.js';
import { canonical } from '../../src/safe/canonical.js';

/**
 * Sealed scorer for the context anneal. The writer sees train failures and validation aggregates only.
 *   status            champion, rounds used, train failures
 *   eval <mutation>   score one mutation file (gain-only), append the round to the log
 *   graduate          grade the champion once on the held-out split
 *   verify            replay every logged round from v001 and check the committed state
 */
const dir = 'evals/v1/anneal';
const contextPath = 'src/compact/context.json';
const jobs: Job[] = readFileSync('evals/v1/jobs.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
const split = (name: string) => jobs.filter(j => j.split === name);
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));
const base: Context = read(join(dir, 'v001-context.json'));
const logPath = join(dir, 'log.jsonl');
const rounds = (): Round[] => existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const mutationFile = (id: string) => join(dir, 'mutations', `${id}.json`);

function champion(log: Round[]): Context {
  let context = base;
  for (const r of log) if (r.decision === 'accepted') context = applyMutation(context, read<Mutation>(mutationFile(r.mutation!.id)));
  return context;
}
function printTrainFailures(context: Context) {
  const scored = scoreContext(context, split('train'));
  for (const r of scored.results.filter(r => r.kind !== 'superseded' && (!r.passed || r.unsafeTop1))) {
    const job = jobs.find(j => j.id === r.id)!;
    console.log(`${r.id} [${r.kind}${r.unsafeTop1 ? ' UNSAFE' : ''}] expected=${job.expected.tool ?? 'unavailable'} got=${r.candidates.slice(0, 3).join(',') || '(none)'}\n   "${job.request}"`);
  }
}

const [command, argument] = process.argv.slice(2);
const log = rounds();
if (command === 'status') {
  console.log(JSON.stringify({ roundsUsed: log.filter(r => r.mutation).length, max: MAX_MUTATIONS, graduated: existsSync(join(dir, 'graduation.json')),
    last: log.at(-1) && { round: log.at(-1)!.round, train: log.at(-1)!.train, validation: { ...log.at(-1)!.validation, byDomain: undefined } } }));
  printTrainFailures(champion(log));
} else if (command === 'eval') {
  if (!argument) throw new Error('Usage: anneal.ts eval <mutation-id>');
  if (existsSync(join(dir, 'graduation.json'))) throw new Error('GRADUATION_EXISTS: held-out split already graded; collect independent replacements to continue.');
  if (log.filter(r => r.mutation).length >= MAX_MUTATIONS) throw new Error('MUTATION_CAP: ten logged mutations used.');
  if (log.some(r => r.mutation?.id === argument)) throw new Error('MUTATION_ALREADY_LOGGED');
  if (!log.length) { const r0 = baselineRound(base, split('train'), split('validation')); appendFileSync(logPath, JSON.stringify(r0) + '\n'); log.push(r0); }
  const mutation = read<Mutation>(mutationFile(argument));
  if (mutation.id !== argument) throw new Error('Mutation id must match its file name.');
  const { round, candidate } = evaluateRound(log.length, champion(log), mutation, split('train'), split('validation'));
  appendFileSync(logPath, JSON.stringify(round) + '\n');
  if (round.decision === 'accepted') writeFileSync(contextPath, JSON.stringify(candidate, null, 2) + '\n');
  console.log(JSON.stringify({ round: round.round, decision: round.decision, reason: round.reason, train: round.train, validation: { passed: round.validation.passed, total: round.validation.total, unsafeTop1: round.validation.unsafeTop1 } }));
  printTrainFailures(candidate);
} else if (command === 'graduate') {
  if (existsSync(join(dir, 'graduation.json'))) throw new Error('GRADUATION_EXISTS: the held-out split is graded once.');
  if (!log.length) throw new Error('NO_ROUNDS: nothing to graduate.');
  const result = graduate(base, champion(log), split('validation'), split('holdout'));
  writeFileSync(join(dir, 'graduation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ graduated: result.graduated, criteria: result.criteria, holdout: { baseline: `${result.baseline.holdout.passed}/${result.baseline.holdout.total}`, champion: `${result.champion.holdout.passed}/${result.champion.holdout.total}` } }));
} else if (command === 'verify') {
  const replay: Round[] = []; let context = base;
  for (const logged of log) {
    if (logged.decision === 'baseline') { replay.push(baselineRound(base, split('train'), split('validation'))); continue; }
    const out = evaluateRound(logged.round, context, read<Mutation>(mutationFile(logged.mutation!.id)), split('train'), split('validation'));
    context = out.candidate; replay.push(out.round);
  }
  const strip = (r: Round) => ({ ...r, meanFindMs: 0 });
  if (JSON.stringify(replay.map(strip)) !== JSON.stringify(log.map(strip))) throw new Error('LOG_NOT_REPRODUCIBLE');
  if (JSON.stringify(context) !== JSON.stringify(read(contextPath))) throw new Error('CHAMPION_NOT_COMMITTED: src/compact/context.json differs from the replayed champion.');
  if (log.filter(r => r.mutation).length > MAX_MUTATIONS) throw new Error('MUTATION_CAP');
  if (existsSync(join(dir, 'graduation.json'))) {
    const recorded = read<unknown>(join(dir, 'graduation.json'));
    if (canonical(graduate(base, context, split('validation'), split('holdout'))) !== canonical(recorded)) throw new Error('GRADUATION_NOT_REPRODUCIBLE');
  }
  console.log(JSON.stringify({ verified: true, rounds: log.length, graduated: existsSync(join(dir, 'graduation.json')) }));
} else if (command === 'report') {
  if (!existsSync(join(dir, 'graduation.json'))) throw new Error('NOT_GRADUATED: run graduate first.');
  writeFileSync(join(dir, 'graduation.md'), renderReport());
  console.log('wrote ' + join(dir, 'graduation.md'));
} else throw new Error('Usage: anneal.ts status | eval <mutation-id> | graduate | verify | report');

function renderReport(): string {
  const g = read<any>(join(dir, 'graduation.json'));
  const pre = existsSync(join(dir, 'prefreeze', 'log.jsonl')) ? readFileSync(join(dir, 'prefreeze', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  const champ = champion(rounds());
  const all = (c: Context) => scoreContext(c, jobs).results;
  const frac = (n: number, d: number) => `${n}/${d} (${(100 * n / d).toFixed(1)}%)`;
  const lines: string[] = [];
  lines.push('# Context anneal graduation report', '',
    `Outcome: **${g.graduated ? 'GRADUATED' : 'NOT GRADUATED'}**. Compact stays opt-in either way; legacy remains the default MCP surface.`, '',
    'Everything here is a deterministic offline measurement of the find ranking over the frozen corpus (`evals/v1/jobs.jsonl`, split 32/14/10). No model, account or network was used. ' +
    'What was optimized is the overlay `src/compact/context.json` (synonyms, group aliases, command aliases, unavailable-feature keywords). Server instructions and tool descriptions are not measurable offline and no improvement of them is claimed. ' +
    'Primary score: the fraction of non-superseded jobs where the expected command is the first hit (implemented jobs) or the first hit is an unavailable feature or empty (gap jobs). The three local-business jobs were frozen as gaps before the registry covered them; they are reported as superseded and excluded.', '',
    '## Held-out result (graded once)', '',
    '| Criterion | Required | Result |', '| --- | --- | --- |',
    `| Unsafe first hits on holdout | 0 | ${g.champion.holdout.unsafeTop1} (${g.criteria.noUnsafe ? 'pass' : 'FAIL'}) |`,
    `| Holdout pass fraction | at least 90% | ${frac(g.champion.holdout.passed, g.champion.holdout.total)} (${g.criteria.passFractionAtLeast90 ? 'pass' : 'FAIL'}) |`,
    `| Within 10 points of validation | validation ${(100 * g.champion.validationScore).toFixed(1)}% | ${(100 * g.champion.holdout.score).toFixed(1)}% (${g.criteria.withinTenPointsOfValidation ? 'pass' : 'FAIL'}) |`,
    `| No regression versus v001 baseline | baseline ${frac(g.baseline.holdout.passed, g.baseline.holdout.total)} | ${frac(g.champion.holdout.passed, g.champion.holdout.total)} (${g.criteria.noRegressionVsBaseline ? 'pass' : 'FAIL'}) |`, '',
    `Champion context hash \`${g.champion.contextHash}\`. Held-out recall@5 ${(100 * g.champion.holdout.recall5).toFixed(1)}%, MRR ${g.champion.holdout.mrr.toFixed(3)}.`, '',
    '### Held-out jobs (ids only; prompts are withheld)', '', '| Job | Kind | Baseline rank | Baseline pass | Champion rank | Champion pass | Champion unsafe |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of g.results.champion) {
    const b = g.results.baseline.find((x: any) => x.id === c.id);
    lines.push(`| ${c.id} | ${c.kind} | ${b.rank ?? '-'} | ${b.passed ? 'yes' : 'no'} | ${c.rank ?? '-'} | ${c.passed ? 'yes' : 'no'} | ${c.unsafeTop1 ? 'YES' : 'no'} |`);
  }
  lines.push('', '## Rounds (raw)', '',
    'Gain-only rule: a mutation is kept only if the primary validation pass fraction strictly increases, unsafe first hits do not increase, and no case that was safe becomes unsafe.', '',
    '| Round | Mutation | Kind | Decision | Train | Validation | Unsafe (val) | Recall@5 train | Context tokens | Reason |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rounds()) lines.push(`| ${r.round} | ${r.mutation?.id ?? 'v001 baseline'} | ${r.mutation?.kind ?? '-'} | ${r.decision} | ${r.train.passed}/${r.train.total} | ${r.validation.passed}/${r.validation.total} | ${r.validation.unsafeTop1} | ${(100 * r.train.recall5).toFixed(1)}% | ${r.contextTokens} | ${r.reason} |`);
  lines.push('', `Mutations logged: ${rounds().filter(r => r.mutation).length} here plus ${pre.filter((r: any) => r.mutation).length} pre-freeze = ${rounds().filter(r => r.mutation).length + pre.filter((r: any) => r.mutation).length} of ${MAX_MUTATIONS}. Plateau: four consecutive candidates after the last acceptance failed, including the structural rescue, so tuning stopped.`, '',
    '## Process disclosures', '',
    `- Two exploratory evaluations ran against an earlier engine revision before the find engine was frozen (\`evals/v1/anneal/prefreeze/\`: ${pre.filter((r: any) => r.mutation).map((r: any) => r.mutation.id + ' ' + r.decision).join(', ')}). They are counted against the cap of ten. A stemmer fix (enable, enabled and enabling now fold together) was then made and the log restarted from the v001 baseline.`,
    '- Early in development an aggregate corpus summary that included the held-out split was printed once for a pre-freeze engine. No held-out job text or per-job result was viewed before graduation.',
    '- The writer (this agent) saw train prompts and failures, and validation as aggregates by domain. Validation and held-out prompts were never printed. Because each validation domain holds one or two jobs, domain aggregates are close to job-level signal; treat validation as lightly contaminated.',
    '- A stemmer limitation is known and deliberately not fixed mid-anneal: adding and added fold to ad while the registry word add stays add.',
    '- The held-out split is now spent. Do not tune on it again. To continue, collect independent replacement jobs.', '',
    '## Context-wide comparison (all 56 jobs, descriptive only)', '', '| Context | Implemented recall@5 | Implemented top-1 | Unsafe first hits | Mean find ms |', '| --- | --- | --- | --- | --- |');
  for (const [name, ctx] of [['v001 baseline', base], ['champion', champ]] as const) {
    const s = scoreContext(ctx, jobs); const impl = s.results.filter(r => r.kind === 'implemented');
    lines.push(`| ${name} | ${frac(impl.filter(r => r.recall5).length, impl.length)} | ${frac(impl.filter(r => r.top1).length, impl.length)} | ${s.summary.unsafeTop1} | ${s.meanFindMs.toFixed(3)} |`);
  }
  lines.push('', '## Validation per job at graduation (ids only)', '', '| Job | Kind | Baseline pass | Champion pass |', '| --- | --- | --- | --- |');
  const vb = scoreContext(base, split('validation')).results; const vc = scoreContext(champ, split('validation')).results;
  for (const c of vc) if (c.kind !== 'superseded') lines.push(`| ${c.id} | ${c.kind} | ${vb.find(x => x.id === c.id)!.passed ? 'yes' : 'no'} | ${c.passed ? 'yes' : 'no'} |`);
  void all;
  return lines.join('\n') + '\n';
}
