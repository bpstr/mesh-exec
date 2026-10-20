# Repository review and five-agent pilot — 20 October 2026

PR [#1](https://github.com/bpstr/mesh-exec/pull/1) was reviewed, corrected, tested,
and merged as `d152d12c79321e97607913acbd0b9c7d44e96e5b`.
The original reviewed head was `c607ba1a63c3152f69319fb38126b5a716c2ca0e`.

The application passes deterministic protocol, persistence, process supervision,
workspace, and completion checks. After a separately authorized retry, **five live
Terra agents produced a working sample with six passing tests, but did not reach
formal mission acceptance**. Read the [live-run analysis](live-run/REPORT.md) for
contributions, unresolved handoffs, timing, and token receipts. The first startup
failure remains preserved below. Follow-up export fixes and the first evidence
record were merged in [PR #2](https://github.com/bpstr/mesh-exec/pull/2).

## Review findings and changes

1. **macOS could not run the application.** The original implementation explicitly
   required Linux for workspace locking and worker confinement. The user authorized
   removing that requirement. macOS now uses Seatbelt (`sandbox-exec`) and Python
   3's `fcntl.flock`, while Linux retains bubblewrap and `flock`. Source files,
   `.git`, worker output, and private audit files have real OS-level tests.
   Codex does not nest another Seatbelt sandbox inside the runner's boundary.
   macOS cleanup requires cooperative commands to stay in their process group;
   Linux additionally has PID namespace isolation.
2. **The runner fixture assumed canonical temporary paths.** macOS aliases
   `/var` to `/private/var`; the fixture now canonicalizes its directory before
   comparing paths. The original local suite had 16 passes, 21 failures, and one
   skip: 11 failures from Linux-only workspace locking and 10 from runner fixture
   path comparisons. The original log is retained.
3. **Exports expected files that the runner did not retain.** A follow-up keeps
   an immutable result-schema copy beside run logs, and removes a nonexistent
   per-run event sidecar from the expected export list. Correlated events are
   already exported in the mission-wide `events.jsonl`.
4. **PostgreSQL timestamps disappeared in status and exports.** The redactor
   treated JavaScript `Date` values as ordinary objects, producing `{}`.
   It now preserves ISO timestamps while still redacting credentials. A
   regression test and a real PostgreSQL export check cover this behavior.

The review followed the runner launch/stop lifecycle, OS boundaries and writer
locking, MCP/A2A integration, completion gating, and exported evidence. It is
not a hostile-client security certification or a 50/100-agent capacity benchmark.

## Validation record

| Evidence | Result and scope |
| --- | --- |
| Original PR CI | Node 22/24 with PostgreSQL 17 and real Linux confinement passed |
| `validation/tests-baseline.txt` | Original local failures preserved, including the unsupported platform |
| `validation/tests-macos.txt` | 12 affected daemon/workspace tests passed, zero skips |
| `validation/tests-runner-final.txt` | 16 runner/Codex/sandbox tests passed, zero skips |
| `validation/tests-sandbox-portable.txt` | Cross-platform audit-file assertion corrected and macOS check passed |
| `validation/merged-pr.json` | All 39 tests passed on Linux Node 22/24 + PostgreSQL 17 and macOS Node 24 before PR #1 merged |
| `validation/tests-export-fix.txt` | 13 affected runner/daemon checks passed after schema retention changes |
| `validation/tests-timestamps.txt` | Timestamp redaction and daemon export regressions |
| `validation/tests-postgres-export.txt` | Affected export integration against local PostgreSQL 18.6 |
| `validation/final-ci-summary.json` | Follow-up PR #2: 40 passes, zero failures/skips in each Linux and macOS job |

Build results and failed intermediate checks are retained in `validation/`.
Passing evidence was carried forward; local full suites were not repeatedly
rerun after unrelated changes. Automated checks used deterministic subprocess
fixtures and local databases, without model inference.

## First authorized attempt: startup failure

The user explicitly approved live Terra through the Codex launcher, with five
launches, a five-minute cutoff, no replacements or retries, and a stop on
completion or the first provider error. This was an explicit exception to the
standing prohibition on synthetic paid-inference testing.

- Mission: `04cb49b8-98bd-4f47-b7e7-48b548108472`.
- Launcher: existing ChatGPT-authenticated Codex CLI `0.160.0`.
- Requested model: `gpt-5.6-terra`.
- Runtime: macOS, Node 24.19.0, PostgreSQL 18.6.
- Task: a dependency-free slugifier API, CLI, tests, and usage documentation.
  The exact roadmap and starting files are in `task-result/`.
- Supervision: five allocations, five starts, five reaped failures; no replacements.
- Trace: 47 events, zero mesh tool calls, zero peer messages, zero model
  thread/turn events, and no usage receipts.

| Slot | Generation | Result | Contribution or cooperation |
| --- | --- | --- | --- |
| A1 | 1 | Configuration failure | None; model execution did not start |
| A2 | 1 | Configuration failure | None; model execution did not start |
| A3 | 1 | Configuration failure | None; model execution did not start |
| A4 | 1 | Configuration failure | None; model execution did not start |
| A5 | 1 | Configuration failure | None; model execution did not start |

The pilot launcher tried to set zero retries on the built-in `openai` provider.
This CLI rejects overrides of reserved built-in provider IDs. All five processes
were admitted before the first failure reached the supervisor, then stopped.
This is a launcher configuration failure, not evidence about Terra's reasoning
or ability to cooperate. There is no completed sample app to evaluate.

`terra-launcher-v2.sh` instead uses a distinct `mesh-pilot` provider configuration
with OpenAI authentication and zero request/stream retries. The corrected
configuration passed `codex debug prompt-input`, which renders configuration and
prompt context without running inference. That does **not** qualify its live
endpoint, model calls, or tools. The configuration fields are documented in the
[official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The user explicitly approved a fresh five-launch/five-minute allowance.
`pilot-retry.mjs` executed it once; results are in `live-run/`. Both allowances
are now exhausted. The exclusive grant files prevent rerunning either script.
No further launch authorization is inferred from this report or from the
presence of a script.

## Evidence guide

- `export/`: original export, preserved unchanged, including its timestamp and
  missing-file defects.
- `corrected-export/`: the same persisted mission re-exported after the timestamp
  fix; this is a read-only export, not another agent run.
- `supplemental-schemas/`: original worker schemas recovered separately. They
  are not represented as pre-launch protected audit copies.
- `authorization-consumed.json`: scope, budget, starting revision, and CLI version.
- `runner-summary.json`, `status.json`, `metrics.txt`: original supervisor results.
- `pilot.mjs`, `terra-launcher.sh`: exact first-attempt harness and launcher.
- `pilot-retry.mjs`, `terra-launcher-v2.sh`: exact second-attempt workflow.
- `live-run/`: complete live collaboration results and analysis.
- `validation/provider-config-check.json`: metadata and digest of the no-inference
  configuration check. The full rendered prompt is intentionally kept out of Git.

The export captures observable CLI output, tool traffic, and durable coordination
state. It does not expose hidden model reasoning.

## Cleanup and remaining limits

The pilot listeners on ports 65151 and 49452 are gone and all workers were reaped.
The briefly started Colima VM was stopped after native macOS support became
available. Existing Assign services and unrelated previews were preserved.
The pilot database remains available for inspection; no shared database was
removed. Temporary copies are small and preserve the original evidence.

The data volume had about 15 GiB free at the last check, below the user's 50 GiB
cleanup threshold. This session's dependencies occupy about 96 MiB and its build
less than 1 MiB; they are retained so the application remains runnable. No
unrelated cache, project, VM disk, or database was pruned.

Post-session cleanup removed only the inactive review-generated
`/Users/bpstr/Github/mesh-exec/.codanna` and
`/Users/bpstr/Github/mesh-exec/.codannaignore`, reclaiming 636 KiB.
The data volume still has about 15 GiB free. The largest inspected candidates
outside this session are `/Users/bpstr/.colima` (1.2 GiB) and
`/Users/bpstr/.npm` (932 MiB); both were preserved. Broader cleanup would need
explicit user authorization. Docker's original `default` context was restored.
