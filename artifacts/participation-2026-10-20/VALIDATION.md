# Participation lifecycle validation

Scope: general implementation participation through acceptance. Add an
authenticated, bounded same-process wait; expose live peer availability and exit
eligibility; distinguish claim release from participation completion; reject
malformed checkpoint bodies. No task-specific instructions are added.

Affected checks: daemon integration tests (tool schemas, waiting, delayed
consultations, lease fencing, closing/terminal transitions, real acceptance)
and Codex invocation tests (bootstrap participation instructions). Reuse passing
A2A, workspace, store, and runner evidence for unchanged behavior; no full-suite
rerun. Compile and preserve the exact candidate before the live trial.

One manual live allowance is authorized by the user: five Terra launches,
five minutes, no tool-call ceiling, no replacement generations or provider
retries. Stop at mission completion, first provider error, or the wall-clock
deadline. Existing Codex authentication is used; no `.secrets` or API keys are
loaded. Persist an exclusive consumed-grant marker. No subsequent live attempt
is implied by this allowance.

Use the unchanged functional slugifier roadmap. Evaluate actual mission
acceptance, current independent reviews, closed consultations and acknowledged
messages, app tests, tool errors, lifecycle transitions, and receipt coverage.
Preserve every peer message verbatim in JSON and a readable transcript. Provider
usage is unknown for any process without a terminal receipt, not zero.

## Recorded checks

- `validation/build.log`: successful TypeScript build.
- `validation/affected-tests.log`: 13 passed, zero failed/skipped. Includes delayed
  mail waking the same reviewer run, real acceptance after that review, shared
  revision wakeups, lease fencing, closing-state waits, and checkpoint validation.
- `validation/generated-tests.log`: six generated app tests passed.
- `validation/independent-tests.log`: four independent API/CLI checks passed.
- `validation/candidate.json`: hashes of the exact frozen source, tests, compiled
  output, and unchanged input task. The candidate includes shared-checkout runner
  and board pagination changes already present before this task's implementation.
  `validation/shared-candidate.diff` records that whole candidate, not exclusive
  authorship of every hunk by this task.

The live mission completed. All five processes ended after `mission.completed`,
with one generation per peer, no replacement launches, and no tool-call ceiling.
All eighteen messages were acknowledged; every consultation is terminal.
The runner then aborted the CLI peers, so all five final `result.json` files and
all five terminal usage receipts are absent. Export metadata preserves those
missing-file records. Aggregate usage remains unknown.

After the live run, README and protocol documentation were reconciled with the
general participation contract, removing earlier guidance to exit when locally
idle. These are documentation-only changes; the tested application source is
unchanged. Formatting and whitespace checks pass without repeating app tests.
