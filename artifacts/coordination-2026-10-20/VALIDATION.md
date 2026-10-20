# Validation record

Scope: shared coordination guidance, composite board reads and waits, checkpoint
wakeups, unchanged requirement publication, and batched acknowledgments.

Retained baseline: the previous review's 40-test Linux Node 22/24 and macOS
Node 24 CI evidence remains applicable to unchanged sandbox, workspace, tracing,
and transport code. See `../review-2026-10-20/validation/final-ci-summary.json`.

- `validation/affected-tests.log`: 22 passed, zero failed/skipped; selected
  store, Codex invocation, daemon, and runner tests because requirement revisions,
  checkpoint wakeups, prompt construction, and board composition changed.
- `validation/daemon-final.log`: 3 passed, zero failed/skipped. Only daemon
  integration was repeated after adding the acknowledgment batch contract and
  its partial-failure/replay regression.
- `validation/typecheck.log`, `validation/build.log`: passed.
- `validation/candidate-build.log`: frozen candidate compiled successfully.
- `validation/provider-config-check.json`: configuration rendering only;
  no model request or availability claim.
- `validation/post-run-build.log`: final corrections compile successfully.
- `validation/post-run-tests.log`: 20 passed, zero failed/skipped, covering
  workspace, store, and daemon. Repeated because the live run exposed permanent
  workspace revocation on yield and misleading file-claim syntax. New regressions
  cover reclaims after yield, command draining, partial acknowledgment replay,
  and a supervisor cancellation racing with a yield. The real OS sandbox test
  passed on this host.
- `validation/generated-sample-tests.log`: 12 passed, zero failed/skipped.
  This is a local deterministic check of the exact generated files after the
  run; the agents never reached command verification. It does not fill in the
  missing README, peer reviews, or acceptance.

The separate active chat “Keep agents running with timeout” modified runner,
CLI, and related documentation during this task. Its edits are preserved.
The manual pilot uses a frozen baseline runner plus this task's coordination
changes. `validation/candidate.json` records the exact files and hashes;
`validation/coordination.diff` and `coordination-instructions.ts` preserve the
candidate changes. Starting a new candidate directory does not justify
repeating compatible passing tests.

The manual pilot has one exclusive authorization marker, five launches,
five minutes, no retries/replacements, and at most 100 admitted mesh tool calls.
It stops on completion, a provider error, or a limit. The tool admission guard
reserves a counter before dispatch; the CLI's terminal usage receipts are
recorded separately and do not provide a hard token ceiling.

No credentials, `.secrets`, paid model calls, or recorded provider fixtures are
used by the automated checks. The manual run is the user's explicit exception
and does not authorize future runs.
