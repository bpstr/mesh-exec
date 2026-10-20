# Bounded shutdown after acceptance

The runner now gives existing peers time to finish final checkpoints, structured
handoffs and CLI usage reporting after the acceptance barrier succeeds.
This is a general runner and protocol change; the example task and its prompts
were not specialized. No live inference was run for this change.

## Behavior

- Acceptance closes launch admission. No replacements are started.
- Existing processes retain heartbeats and output capture until they exit.
- The default completion window is 30 seconds, configurable as
  `completionGraceMs` in runner options or CLI JSON configuration.
- The window is capped by the remaining original mission budget. The original
  deadline is never restarted. Operator cancellation, lease failures and
  individual run timeouts retain their existing stop behavior.
- Completed missions allow leased MCP peers to read terminal participation and
  operation results, and write final checkpoints. Other work stays closed;
  operation cancellation and A2A messaging are not admitted.
- Grace or deadline expiry terminates stragglers and preserves the mission's
  accepted state. Normal teardown still reaps processes and captures pending
  output; process cleanup can take time after the stop signal.
- `supervisor.draining` records the bounded window and deadline.
  `supervisor.ended.shutdownReason` records forced shutdown reasons.

## Evidence and limits

The TypeScript build passed. Across the selected offline checks, 29 cases passed
on the initial run and the four initially failing fixture cases passed after
test-only synchronization corrections. All 33 selected behaviors now have passing
evidence, with no skipped or cancelled cases. See [VALIDATION.md](VALIDATION.md)
for commands, retained evidence and the initial failures.

The process fixture proves two existing peers can exit normally after acceptance,
retain final `result.json` handoffs and emit two terminal usage records while
leases continue renewing. Three separate unresponsive-peer cases prove shutdown
at grace expiry, the original elapsed budget, and external cancellation without
replacement launches. The MCP integration proves that final checkpoints do not
alter acceptance, new claims and operation cancellation are rejected, and expired
leases lose access.

The worker responses and token counts are deterministic fixtures, not real model
usage. Actual agents can still crash, ignore exit guidance or fail to emit a
receipt before a deadline. This change does not recover the missing usage receipts
from the [previous live run](../participation-2026-10-20/REPORT.md).
