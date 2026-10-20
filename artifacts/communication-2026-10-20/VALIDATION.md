# Validation plan and evidence

The user approved exactly three Terra launches, two minutes, forty mesh tool
calls, no retries/replacements, and a stop on completion or first provider error.
This is a new manual allowance; previous grants remain closed.

Before live execution, the candidate passed a TypeScript build and 15 selected
A2A, daemon, and Codex invocation tests with zero failures/skips. New regressions
exercise atomic reply/acknowledgment rollback and replay, wrong-task delivery
rejection, inbox timeout/wakeup/fencing, and the discussion profile's restricted
tool surface. Existing acceptance and yield/reclaim regressions also passed.
Retain the prior 20-test workspace/store/daemon evidence for unchanged behavior;
no repeated full suite or sandbox run is needed for these communication changes.

The one-line CLI workflow forwarding change and final message-length guidance are
included in the frozen candidate build. Concurrent runner/timeout changes from
the other chat are preserved in the working tree but excluded from this pilot.
Exact candidate source hashes and patches are in validation/.

Predeclared communication checks in evaluate.py:
- Three normal, generation-one idle handoffs and three terminal usage receipts.
- Each peer sends one request and answers one request; all three tasks complete.
- Six deliveries, all acknowledged; one checkpoint per peer.
- Zero tool failures, no missing exported artifacts, and unchanged source files.
- Efficiency target: no more than 30 mesh tool calls (hard stop ceiling: 40).

Discussion participation is evaluated from durable messages and tasks. It is not
implementation-mission acceptance. The roadmap contains only a discussion topic;
the same general discussion profile controls partner routing and closure.
Automated checks use deterministic fixtures, without credentials or model calls.
The manual launcher uses existing Codex authentication and never loads .secrets.

## Findings and refinement

The first span-only analysis missed three send failures returned in normal tool
payloads. Its original output is preserved as `terra-run/initial-analysis.json`.
The corrected evaluator checks payload failures and raw CLI tool errors too;
the clean-run criterion is false. Closed tasks and handled deliveries are still
verified. No result was substituted for missing or failed evidence.

`validation/refined-build.log` and `validation/refined-daemon-tests.log` cover the
post-run fixes: six tests pass, zero fail/skip. These checks were repeated because
the send interface and failure reporting changed. The unchanged A2A atomic
transaction and inbox wait checks retain the earlier passing evidence.

The refined candidate is isolated from another chat's concurrent board-context
changes. The final code is available for review; any additional live attempt
requires a new three-launch allowance.

## Final workspace checks

The final discussion join returns checkpoint rows consistently with the
implementation profile. `validation/final-discussion-test.log` records the
targeted profile regression after that small response-shape correction: one
passes, zero fail or skip. Other passing checks above remain applicable.
`validation/final-workspace-build.log` records the successful final TypeScript
build, including concurrent changes present in the shared checkout.

`validation/final-communication.patch` and `validation/refined-candidate.json`
identify this task's final isolated changes against `9ed4a65`, excluding other
chats' timeout and board-context changes. They do not identify the live-run
candidate, which remains separately recorded in `validation/candidate.json`.
