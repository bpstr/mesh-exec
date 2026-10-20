# General coordination changes and Sol 6.1 run

## Outcome

The shared workflow and protocol were improved and tested locally. One live
five-agent Sol 6.1 run was attempted. It stopped at the new 100-tool-call ceiling
after 69.770 seconds, with no mission acceptance. It exposed two additional
problems, which were corrected and tested offline. Those final corrections have
not been rerun with live agents.

The generated API, CLI, and test files pass 12 local tests. README is absent.
There are no final requirement or coverage reviews and no completion proposal.
This run does not establish reliable autonomous completion or lower token usage.

## General changes

- Every mission receives the same instructions from `src/coordination.ts`.
  Peers select contributions, one claims integration stewardship, requirement
  evidence is consolidated before final reviews, and the steward remains through
  acceptance. There are no task-specific IDs, file assignments, examples, or
  product criteria in those instructions.
- Join and board responses supply inbox messages, open consultations, reviews,
  and operation summaries. Peers can discover existing evidence without repeated
  requests to each other. Board reads can wait up to 30 seconds and suppress
  unchanged snapshots. Checkpoints wake waiting peers.
- Acknowledgments can be batched. They remain separate from terminal task replies;
  partial failures can be replayed safely.
- An identical requirement publication preserves its author and revision, so it
  does not invalidate reviews. Meaningful edits still create a new revision.
- After the live failure, `file:` claim prefixes now fail early with the correct
  relative-path syntax. Yield now drains commands and releases claims without
  permanently revoking a live run. Supervisor cancellation remains permanent,
  including when it races with yield.

The example's original functional requirements were preserved in
`inputs/ROADMAP.md`. Its former embedded coordination recipe, including the
prescribed `slugifier` requirement ID, was removed. No replacement task-specific
coordination instructions were added.

## Manual run

- Mission: `660cf934-c468-4497-8545-6abbde987f79`
- Requested model: `gpt-6.1-sol`, low reasoning, Codex CLI 0.160.0.
- Existing ChatGPT authentication through the Codex launcher; no API key or
  subscription proxy was provisioned.
- Five launches, five-minute maximum, no retries or replacement generations.
- Additional ceiling: at most 100 admitted mesh tool calls across all peers.
  Native Codex tools and provider requests are not counted by that mesh guard.
- Started 2026-10-20 17:07:25.996 UTC; export finished 17:08:35.766 UTC.
- All five runs were aborted and reaped at the tool ceiling.

The authorization marker is exclusive and consumed. The harness must not be
rerun under that marker. No further live calls were made after the stop.

| Observation | Terra baseline | Sol run |
|---|---:|---:|
| Mesh tool calls | 205 | 100, capped |
| Applied source patches | 4 | 2 |
| Message deliveries | 36 | 19 |
| A2A tasks | 26 | 11 |
| Unhandled deliveries | 4 | 7 |
| Terminal usage receipts | 5 | 0 |
| Reported total tokens | 4,198,594 | Unknown |
| Mission accepted | No | No |

Five result.json files are absent because workers were interrupted before final
handoffs. The export manifest lists these five missing artifacts explicitly.
All recorded stdout/stderr, prompts, result schemas, events, messages, and tasks
are retained.

The CLI did not emit terminal token receipts before interruption. Unknown usage
is not zero, and no dollar-cost or token-reduction claim is supported. Changing
the model, instructions, task recipe, and stop ceiling also prevents treating
this as a controlled model or efficiency comparison.

## What happened

A1 took integration stewardship and created four open requirements. A2 and A3
attempted CLI and documentation contributions using `file:`-prefixed claims.
Several peers interpreted failed patch attempts as published work and yielded.
The original yield implementation called permanent run cancellation, so
subsequent corrections in those same processes failed with `run_revoked`.
Repeated messages and reads consumed the tool budget.

A4 recovered the path syntax and published the API and tests. A1 published the
CLI. These two patches created three files shortly before the ceiling. A5 stayed
in a review role, but final source/evidence readiness never arrived. Four
requirements remained open, zero reviews were recorded, and five consultations
remained nonterminal. Six consultations completed.

The tool budget stopped further activity as designed. The missing README and
acceptance state are preserved, not filled in by the supervising assistant.
The generated tests were inspected and run locally afterward: 12 passed.

## Verification and reproducibility

See [VALIDATION.md](VALIDATION.md) for selected checks and reused baseline evidence.
Final affected workspace/store/daemon checks: 20 passed, zero failed/skipped.
TypeScript build passed. The generated sample's separate local suite passed 12/12.

Another active chat, “Keep agents running with timeout,” was editing the same
checkout. Its work was preserved. The pilot ran a frozen baseline runner plus
this task's pre-run coordination changes; it did not include the concurrent
timeout changes. `validation/candidate.json` records exact source hashes.
Post-run fixes are separate and are not represented as the live-tested version.

Evidence:

- `pilot.mjs`, `sol-launcher.sh`: exact one-shot harness and launcher.
- `inputs/`: exact task input.
- `sol-run/analysis.json`: computed counts, failures, hashes, and missing artifacts.
- `sol-run/coordination.json`: requirements, reviews, claims, checkpoints, proposals.
- `sol-run/export/`: observable per-agent traces and durable mesh state.
- `sol-run/task-result/`: untouched generated files.
- `validation/`: full local check logs, source identities, and candidate diff.
- `analyze.py`: deterministic evidence analysis; no provider calls.

## Closure

The user chose to keep the offline fixes and stop live runs. No second Sol
attempt was made. All five workers were reaped and the temporary daemon listener
on port 51355 is closed. Existing PostgreSQL listeners remain available. Removed
only the unused candidate `dist` build (668 KiB); source and run evidence remain.
About 15.1 GiB is free on the data volume. Other chats' services and shared
index were preserved. See `validation/cleanup.json`.
