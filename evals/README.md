# Offline evaluation (phases 0-5)

`v1/jobs.jsonl` is the unchanged 56-job seed corpus. `v1/split.json` freezes
32 train, 14 validation and 10 holdout IDs. All identifiers and responses are
synthetic. `v1/facts.json` pins registry, source, dispatcher, package, lockfile,
corpus and public-spec hashes. `v1/outcomes.json` independently freezes each job's expected returned value or
preview identity and effect. `v1/registry.json` freezes all 287 definition IDs
and endpoint mappings. The legacy MCP surface registers 289 tools, retaining the original 276 IDs.

From the repository root, with development dependencies installed:

```sh
npx tsx scripts/eval/freeze.ts
npx tsx scripts/eval/run.ts --surface legacy --output /tmp/instantly-replay
npx tsx scripts/eval/run.ts --surface safe --output /tmp/instantly-replay
npx tsx scripts/eval/grade.ts --traces /tmp/instantly-replay/legacy-traces.jsonl
npx vitest run tests/safe tests/eval
```

The runner also accepts `--split train|validation|holdout|all`. Replay always
loads the frozen corpus, fixtures and outcome oracle; replacement input options
are rejected. It never imports credential resolution or constructs a real HTTP
client. Its global fetch kill switch refuses accidental network egress. Fake
transport matches command, arguments, workspace, sequence position and the
complete method/path/query/body, verifies response hashes, and refuses missing,
duplicate or externally routed requests. No live account, browser or model is
used. Fixture authoring (`scripts/eval/fixtures.ts`) and fact re-freezing
(`scripts/eval/freeze.ts --write`) are explicit maintenance operations, never
part of replay. Review their diffs before changing the frozen baseline.

## What the scores mean

The committed `v1/baseline` artifacts preserve the original historical run at
revision `95b1ec93dbf6279d11bf7e4edf7949f99687a479`, before returned-value and
complete preview-plan grading. `v1/baseline/facts.json` records that run's
revision and input paths; its hashes come from the original `v1/facts.json`.
The later root `v1/facts.json` and `v1/registry.json` are current snapshot
metadata, not provenance for these historical results. The later-added
`v1/baseline/registry.json` is a registry snapshot and must not be read as the
historical run's input registry. Historical trace and result bytes remain the
run artifacts. They are not current
passing traces and must not be overwritten. Historical scores were **Legacy: 44/56 (78.57%); safe dispatcher: 55/56 (98.21%);
mutation safety: 56/56 in both.** These are deterministic, scripted oracle
replays of handler and guard behavior. They are not natural-language model
performance, discovery recall, task completion in a real account, or evidence
of an annealing improvement. Model token counts and discovery recall are null.
The trace envelope reserves those measurements for later model-driven runs.
Fresh replay artifacts belong in `v1/replay`, and must be regenerated after
fixture, oracle or dispatcher changes. Their summaries report the current
scores; the historical scores above do not establish those results.
Current replay artifacts can be reproduced with the commands below; they are
kept separate from the historical baseline.

The grader compares actual returned read values with the separate per-job
outcome oracle. It compares authoritative plan requests with the frozen request
oracle and the duplicate preview request list, checks exact identity and effect
metadata, and matches prerequisite request/response hashes with independent
fixtures. Reply and forward require the recipient lookup prerequisite.

After reviewing intentional fixture/oracle and dispatcher changes, regenerate
facts and fresh artifacts from the repository root:

```sh
npx tsx scripts/eval/fixtures.ts
npx tsx scripts/eval/freeze.ts --write
npx tsx scripts/eval/run.ts --surface legacy --output evals/v1/replay
npx tsx scripts/eval/run.ts --surface safe --output evals/v1/replay
npx tsx scripts/eval/grade.ts --traces evals/v1/replay/legacy-traces.jsonl
npx tsx scripts/eval/grade.ts --traces evals/v1/replay/safe-traces.jsonl
```

Fixture authoring does not generate or rewrite the independent outcome oracle.
Review its changes separately; never copy handler outputs into it to approve a
regression.

Legacy reads invoke the existing registry handlers. A harness-only read-only
gate suppresses legacy writes, which have no preview API; all 12 preview-only
jobs consequently fail their preview requirement. The two adversarial jobs use
the harness's explicit workspace/preview guard, not a claim that unchanged
legacy entrypoints enforce preview tokens. Gap outcomes are scripted supported
gap explanations. Unsupported (11 cases) and implemented results are reported
separately, together with per-domain, split, component, call and latency data.

The safe run preserves one failure, **instantly-029**: the frozen enrichment
oracle passes Zod but omits an enrichment type required by the existing handler.
It produces no request. Its exact preparation error is frozen in the fixture
manifest. No argument is invented and neither its expectation nor the original
corpus is changed. The runner returns failure for any new safe-run failure or
any safety failure. The grader never treats this known failure as a pass.

The refreshed pinned public spec covers 268/268 operations, with 15 undocumented
endpoint keys. The 56 original jobs and
their split remain unchanged, including three historical local-business gap
expectations. Those gap results describe the frozen benchmark, not the current
registry. The separate `public-delta-v1/fixtures.json` manifest adds independent
synthetic wire, argument, returned-value and effect oracles for all 13 new
operations. Run `npx vitest run tests/safe/public-delta.test.ts` to replay them.

The audited-read manifest `read-allowlist-v1/fixtures.json` (replay: `npx vitest run tests/safe/read-allowlist.test.ts`) adds three more GET reads: `accounts_ctd-status` (DNS/SSL check of a caller-supplied host, no workspace data, no mailbox credentials), `oauth_get_oauth_session_status` (poll; success returns the connected account email and name) and `blocklist_download_block_list_entry` (unpaginated CSV export with optional `search` and `domains_only` filters). `api_keys_list` (returns key material) and `accounts_test_vitals` (probes mailbox servers) stay refused.

The delta read allowlist explicitly includes creator metadata, allowance and job
status, local-business places and job status, custom-tag lookup and the documented
free local-business search POST. Legacy POST workspace confirmation remains
conservative. Creator search can spend credits; outreach batches and business
conversion buy enrichment or create leads. These and AI filter generation retain
write/unknown-cost policy, so execution requires host write and cost authorization
plus an unchanged one-use preview. AI generation is quota limited and has no
verified no-cost guarantee. Unknown effects remain denied. Preview contacts none
of these delta endpoints. No account mapping or live account request was performed.

## Safe dispatcher boundary

`src/safe/dispatcher.ts` is the shared execution layer. The compact MCP surface
(`instantly mcp --surface compact`) and the `find`, `describe`, `preview` and `run`
CLI commands call it through `src/compact/`. Existing legacy commands and the legacy
MCP surface retain their prior behavior and can still perform unpreviewed writes.
Do not describe them as protected by this dispatcher.

Hosts inject a single bound identity, an audited client, fresh identity lookup,
registry/context content revisions, preview storage and explicit execution
policy. No credentials are resolved by this library. Use content hashes from
the installed registry and context; never accept those revisions or an identity
callback from an untrusted tool caller. The credential reference is an opaque
host-owned identity reference, never the secret itself.

Preparation validates unknown keys before Zod and generated AJV validation,
then captures existing handlers' effective requests. It preserves HTML,
sequence and recipient normalization without duplicate business handlers.
Only host-audited GET prerequisites execute during preparation. The final
request must match the registered endpoint. Unsupported multi-request handlers
fail closed, including handlers that swallow intermediate exceptions.
Preview sends no mutation or paid request, and reports unknown costs honestly.

Reads require the versioned explicit semantic read allowlist, matching
profile/workspace and fresh identity. GET alone grants no permission. Requests
with `with_passwords: true` are unsupported and refused before any request. Write
execution defaults to denied; the host must allow the command, recheck current
entitlement and explicitly authorize unknown costs if applicable. The compact
adapters enforce this policy; legacy entrypoints retain their prior behavior.

Opaque five-minute tokens bind profile, workspace/name, credential reference,
normalized arguments, effective request and prerequisite response hashes,
registry/context revisions and execution policy. Execute accepts only a token
and scope, never replacement arguments. It refreshes identity, entitlement and
prerequisites, rechecks expiry, and atomically consumes the token before one
transport attempt. A failed mutation returns unknown execution status with a
read-only reconciliation instruction; it never retries or reuses the token.
The existing HTTP client honors the opt-in `retry: 'never'` transport flag;
legacy retry behavior is unchanged.

Memory storage is suitable for a single MCP process. File storage supports CLI
process handoff, refuses symlink token files, and uses atomic rename for consumption.
On POSIX it requires a host-owned directory with mode 0700 and token files with
mode 0600. Windows skips the POSIX owner and mode checks and relies on the
directory's Windows access controls; the store does not configure or verify ACLs.
The host should call `store.prune(now)` periodically to remove expired sensitive
plans; dispatcher preview also prunes expired records. File storage fails closed
when private POSIX storage cannot be established. This is not an encrypted
vault. Fixture and trace storage must never receive real secrets or inbox data.

The seed holdout has been run to verify the foundation. This is not a blind
model experiment, and future context annealing must respect the frozen split
and use a separate writer/scorer boundary.

## Phase 3: compact surface replay

```sh
npx tsx scripts/eval/run.ts --surface compact --output /tmp/instantly-replay
```

The compact replay uses the four-tool surface: every job calls `instantly_find`
(the job request, top five recorded as `discoveryCandidates`) and `instantly_run` for
the mandatory `status`. Implemented jobs then call `instantly_describe` and
`instantly_preview` or `instantly_run`; gap jobs stop with a scripted explanation.
The operation and arguments come from the frozen oracle, so this
score measures the four-tool plumbing and safety, not model choice. Result: **55/56,
safety 100%**, the same single preserved failure (instantly-029) as the safe run, and
above legacy's 44/56. Discovery is graded separately and deterministically by
`src/eval/discovery.ts`: the first hit must be the expected command (implemented jobs)
or an unavailable feature or nothing (gap jobs); the three local-business jobs frozen
as gaps are reported as superseded and excluded. Train and validation
recall@5 for the v001 baseline are in the round 0 row of `v1/anneal/log.jsonl`, and the
all-jobs comparison is in `v1/anneal/graduation.md`. Compact recall@5 is at or above the
baseline (asserted by `tests/eval/compact.test.ts`).

`find` is a deterministic weighted keyword ranker (exact ID or `group subcommand`: 100,
alias phrase: 60, rarity-weighted group and subcommand words, descriptions at a quarter
weight, synonyms at half, clauses after "without" or "do not" ignored, read and write
verb mismatch penalized). It needs no credentials, embedding or model. Known limits:
the stemmer folds `adding` to `ad`, and when a group such as `webhook_events` shares
words with `webhooks`, tie ordering can put the wrong one first.

## Phase 4: context anneal

Only `src/compact/context.json` is tunable (synonyms, group aliases, per-command
aliases, unavailable-feature keywords, server instructions and tool descriptions). The
find engine, schemas, policy, handlers, corpus, fixtures and graders are out of reach of
a mutation (`applyMutation` rejects other paths). Instructions and tool descriptions
cannot be measured offline, so no improvement of them is claimed.

```sh
npx tsx scripts/eval/anneal.ts status          # champion, rounds used, train failures
npx tsx scripts/eval/anneal.ts eval <id>       # score evals/v1/anneal/mutations/<id>.json
npx tsx scripts/eval/anneal.ts graduate        # held-out split, once
npx tsx scripts/eval/anneal.ts report          # writes evals/v1/anneal/graduation.md
npx tsx scripts/eval/anneal.ts verify          # replays log, champion and graduation
```

A mutation is kept only when the primary validation fraction strictly increases, unsafe
first hits do not increase, and no safe case becomes unsafe. At most ten mutations are
logged. See the generated [graduation report](v1/anneal/graduation.md) for graduation
criteria, results and process disclosures. Compact stays opt-in. The held-out split
is spent; collect independent jobs before another round.

## Phase 5: public API delta

`scripts/spec-review.ts` compares a candidate public spec with the pinned one and ignores
prose and generated examples. It compares the whole normalized document, including
inherited security, servers, path parameters and non-schema components, and reports
operation and schema additions, removals and changes. Semantic differences or missing
command coverage exit with status 2; the pin is never updated automatically.
The recorded review is [`v1/spec-review.json`](v1/spec-review.json).
