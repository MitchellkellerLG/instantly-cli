# Context anneal graduation report

Outcome: **NOT GRADUATED**. Compact stays opt-in either way; legacy remains the default MCP surface.

Everything here is a deterministic offline measurement of the find ranking over the frozen corpus (`evals/v1/jobs.jsonl`, split 32/14/10). No model, account or network was used. What was optimized is the overlay `src/compact/context.json` (synonyms, group aliases, command aliases, unavailable-feature keywords). Server instructions and tool descriptions are not measurable offline and no improvement of them is claimed. Primary score: the fraction of non-superseded jobs where the expected command is the first hit (implemented jobs) or the first hit is an unavailable feature or empty (gap jobs). The three local-business jobs were frozen as gaps before the registry covered them; they are reported as superseded and excluded.

## Held-out result (graded once)

| Criterion | Required | Result |
| --- | --- | --- |
| Unsafe first hits on holdout | 0 | 0 (pass) |
| Holdout pass fraction | at least 90% | 7/10 (70.0%) (FAIL) |
| Within 10 points of validation | validation 61.5% | 70.0% (pass) |
| No regression versus v001 baseline | baseline 4/10 (40.0%) | 7/10 (70.0%) (pass) |

Champion context hash `0d29d9a49790e977f22edc881a96b128b8fbb726b8842fcc5988d329bf83ae60`. Held-out recall@5 90.0%, MRR 0.783.

### Held-out jobs (ids only; prompts are withheld)

| Job | Kind | Baseline rank | Baseline pass | Champion rank | Champion pass | Champion unsafe |
| --- | --- | --- | --- | --- | --- | --- |
| instantly-004 | implemented | 3 | no | 1 | yes | no |
| instantly-005 | implemented | - | no | - | no | no |
| instantly-006 | implemented | - | no | 1 | yes | no |
| instantly-007 | implemented | 1 | yes | 1 | yes | no |
| instantly-008 | implemented | 1 | yes | 1 | yes | no |
| instantly-017 | implemented | 3 | no | 3 | no | no |
| instantly-018 | implemented | 1 | yes | 1 | yes | no |
| instantly-019 | implemented | 1 | yes | 1 | yes | no |
| instantly-055 | implemented | - | no | 1 | yes | no |
| instantly-056 | implemented | 3 | no | 2 | no | no |

## Rounds (raw)

Gain-only rule: a mutation is kept only if the primary validation pass fraction strictly increases, unsafe first hits do not increase, and no case that was safe becomes unsafe.

| Round | Mutation | Kind | Decision | Train | Validation | Unsafe (val) | Recall@5 train | Context tokens | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | v001 baseline | - | baseline | 16/30 | 7/13 | 0 | 77.3% | 219 | v001 context and frozen find engine |
| 1 | 003-verb-synonyms | add-synonym | accepted | 18/30 | 8/13 | 0 | 77.3% | 219 | validation 7/13 -> 8/13 |
| 2 | 004-group-vocabulary | add-group-alias | rejected | 18/30 | 8/13 | 1 | 81.8% | 219 | safety gate: a first hit became an unsafe write |
| 3 | 005-account-aliases | add-alias | rejected | 18/30 | 8/13 | 0 | 77.3% | 257 | no strict validation gain (validation 8/13 -> 8/13) |
| 4 | 006-leads-prospect-vocabulary | add-group-alias | rejected | 19/30 | 8/13 | 1 | 81.8% | 219 | safety gate: a first hit became an unsafe write |
| 5 | 007-repair-add-folding | subtract | rejected | 18/30 | 8/13 | 0 | 77.3% | 219 | no strict validation gain (validation 8/13 -> 8/13) |

Mutations logged: 5 here plus 2 pre-freeze = 7 of 10. Plateau: four consecutive candidates after the last acceptance failed, including the structural rescue, so tuning stopped.

## Process disclosures

- Two exploratory evaluations ran against an earlier engine revision before the find engine was frozen (`evals/v1/anneal/prefreeze/`: 001-unibox-vocabulary rejected, 002-unibox-command-aliases rejected). They are counted against the cap of ten. A stemmer fix (enable, enabled and enabling now fold together) was then made and the log restarted from the v001 baseline.
- Early in development an aggregate corpus summary that included the held-out split was printed once for a pre-freeze engine. No held-out job text or per-job result was viewed before graduation.
- The writer (this agent) saw train prompts and failures, and validation as aggregates by domain. Validation and held-out prompts were never printed. Because each validation domain holds one or two jobs, domain aggregates are close to job-level signal; treat validation as lightly contaminated.
- A stemmer limitation is known and deliberately not fixed mid-anneal: adding and added fold to ad while the registry word add stays add.
- The held-out split is now spent. Do not tune on it again. To continue, collect independent replacement jobs.

## Context-wide comparison (all 56 jobs, descriptive only)

| Context | Implemented recall@5 | Implemented top-1 | Unsafe first hits | Mean find ms |
| --- | --- | --- | --- | --- |
| v001 baseline | 35/45 (77.8%) | 24/45 (53.3%) | 2 | 1.666 |
| champion | 37/45 (82.2%) | 30/45 (66.7%) | 1 | 0.810 |

## Validation per job at graduation (ids only)

| Job | Kind | Baseline pass | Champion pass |
| --- | --- | --- | --- |
| instantly-003 | implemented | yes | yes |
| instantly-010 | implemented | no | no |
| instantly-013 | implemented | yes | yes |
| instantly-015 | implemented | yes | yes |
| instantly-021 | implemented | no | no |
| instantly-023 | implemented | yes | yes |
| instantly-025 | implemented | no | no |
| instantly-028 | implemented | no | no |
| instantly-031 | implemented | no | no |
| instantly-033 | implemented | yes | yes |
| instantly-035 | implemented | no | yes |
| instantly-038 | implemented | yes | yes |
| instantly-041 | implemented | yes | yes |
