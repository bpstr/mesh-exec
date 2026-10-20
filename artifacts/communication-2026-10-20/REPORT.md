# Three-peer Terra communication exercise

## Result

All three peers exchanged a substantive request and answer, acknowledged all six
deliveries, checkpointed their conclusions, and exited normally. The exercise
used 27 mesh calls in 86.333 seconds. Source files were unchanged.

The stricter clean-run criterion failed: three send attempts failed before the
agents recovered. The original tool wrapper returned those failures as ordinary
result payloads, so the initial span-only evaluator incorrectly reported a pass.
The detailed trace review caught the discrepancy. `initial-analysis.json` is
preserved; the corrected `analysis.json` checks both trace failures and CLI tool
result payloads and reports failure.

There were no provider errors, replacement launches, missing exports, native
commands, or file edits. The three failed sends were peer transport/protocol
errors, not provider retries. The run consumed its three-launch allowance.

## Changes

Before the run:

- Added a general discussion profile, selected with `workflow: "discussion"`,
  exposing only communication and handoff tools. Product implementation remains
  the default profile. The roadmap supplies only a topic.
- Moved general workflow instructions into `mesh_join`, allowing an appropriate
  small instruction set and tool surface per profile.
- Added atomic reply plus acknowledgment through optional `deliveryId`.
  Wrong-task deliveries are rejected, failed transactions roll back both actions,
  and exact replays do not duplicate mail.
- Added inbox waits that wake on pending mail rather than unrelated board changes.
- Retained and exercised the prior yield/reclaim and claim-syntax corrections.

After examining the run:

- Discussion questions now use `mesh_ask`. The service chooses the partner and
  task/context IDs; the schema accepts none of those routing fields. Incoming
  requests still use `mesh_reply`.
- Permanent send failures now produce `DELIVERY_FAILED`, an MCP tool error, and
  a failed trace span. Their outbox evidence remains available.
- Improved the evaluator to inspect raw tool outcomes as well as trace spans.

The final ask/reply refinement has passed deterministic tests. It is distinct
from the live-tested version and has not yet been live-retested.

## Communication and usage

Topic: whether brief team updates are clearer as bullets or a short paragraph.
No slot assignments or tool recipe were added to that topic. The shared profile
arranged a ring so every participant asked and answered once.

| Measurement | Recorded result |
|---|---:|
| Terra launches / normal exits | 3 / 3 |
| Completed tasks | 3 |
| Handled deliveries | 6 / 6 |
| Checkpoints | 3 |
| Mesh calls | 27 |
| Failed send attempts | 3 |
| Reported input tokens | 709,520 |
| Cached input tokens | 638,208 |
| Uncached input tokens | 71,312 |
| Output tokens | 4,465 |
| Total reported tokens | 713,985 |

Reasoning output is 803 tokens, included in output; it is not added twice.
There are three terminal usage receipts. These numbers are CLI usage, not a
monetary bill. Token consumption remains substantial for six short messages.
The earlier five-agent coding pilot is a different workload and population;
this result does not establish a causal token reduction or general throughput.

The tool mix was three joins, six sends, six polls, three replies, three
acknowledgments, three checkpoints, and three yields. Three sends were avoidable:
A3 invented a task ID for a new request; A2 tried to answer an incoming request
using send with its incoming task ID, then its context ID. All failed attempts
remain in the outbox/event evidence.

The successful exchange contained actual reasoning. A1 favored bullets for
ownership and actions, A3 supported a brief context sentence plus actionable
bullets, and A2 identified a single causal narrative within a small team as an
exception where a paragraph could be clearer.

## Scope and limits

Mission: `48cf07d2-478d-4d16-88f8-1eb6086a4b1d`.
Model: `gpt-5.6-terra`, low reasoning, existing Codex authentication.
Authorization: three launches, two minutes, at most forty mesh tool calls,
no provider retries or replacement generations, stop on completion or first
provider error. The persisted marker prevents reusing this allowance.

This is discussion participation, not implementation-mission acceptance. The
supervisor finished with `resource-limit` after all three normal handoffs and
exhaustion of its launch budget. The narrower communication checks evaluate
durable tasks and deliveries separately.

The live run used a frozen candidate based on `9ed4a65` plus these communication
changes. Concurrent timeout and board-context work in the shared checkout was
preserved and excluded from the recorded live candidate. Exact identities are
in `validation/candidate.json`.

## Validation and evidence

- Pre-run: TypeScript build and 15 affected A2A/daemon/Codex tests passed,
  with zero failures or skips.
- Post-run refinement: build and all six daemon tests passed, including the
  restricted ask schema, automatic recipient routing, atomic reply acknowledgment,
  and explicit failed-delivery reporting.
- Retained earlier passing workspace/store tests for unchanged functionality.
- Final workspace build passed. A focused discussion-profile check passed after
  returning checkpoint rows consistently; no additional live launches were made.

See [VALIDATION.md](VALIDATION.md), `validation/`, and the exact `pilot.mjs`.
`terra-run/export/` contains prompts, schemas, per-agent output, messages, tasks,
and events. `terra-run/coordination.json` contains checkpoints and shared records.
`terra-run/analysis.json` is the corrected analysis; `evaluate.py` reads existing
evidence without any model calls.

The final isolated change is preserved in `validation/final-communication.patch`
with source hashes in `validation/refined-candidate.json`. Working changes remain
in the repository alongside other chats' edits.

Cleanup removed only the two temporary candidates' reproducible `dist/`
directories. The trial listener is closed; runtime evidence and other services
are preserved. See `validation/cleanup.json` for paths and disk measurements.
