# Repository review and five-agent pilot — 20 October 2026

PR [#1](https://github.com/bpstr/mesh-exec/pull/1) was reviewed, corrected, tested,
and merged as `d152d12c79321e97607913acbd0b9c7d44e96e5b`.
The original reviewed head was `c607ba1a63c3152f69319fb38126b5a716c2ca0e`.

The application passes deterministic protocol, persistence, process supervision,
workspace, and completion checks. **Live Terra collaboration is not yet
qualified.** The authorized five processes all failed at CLI configuration
loading, before reaching model execution. No successful agent collaboration,
model usage, or completed sample implementation is claimed.

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

Build results and failed intermediate checks are retained in `validation/`.
Passing evidence was carried forward; local full suites were not repeatedly
rerun after unrelated changes. Automated checks used deterministic subprocess
fixtures and local databases, without model inference.

## Authorized pilot and outcome

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

The original launch allowance is exhausted. A fresh five-launch/five-minute
allowance was requested; the prepared `pilot-retry.mjs` must not be executed
without that explicit authorization. Its exclusive grant file prevents reuse
once launched. No authorization is inferred from this report or from the
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
- `pilot-retry.mjs`, `terra-launcher-v2.sh`: prepared corrected workflow; see the
  authorization restriction above.
- `validation/provider-config-check.json`: metadata and digest of the no-inference
  configuration check. The full rendered prompt is intentionally kept out of Git.

The export captures observable CLI output, tool traffic, and durable coordination
state. It does not expose hidden model reasoning.

## Cleanup and remaining limits

The first pilot's listener on port 65151 is gone and its workers were reaped.
The briefly started Colima VM was stopped after native macOS support became
available. Existing Assign services and unrelated previews were preserved.
The pilot database remains available for inspection; no shared database was
removed. Temporary copies are small and preserve the original evidence.

The data volume had about 15 GiB free at the last check, below the user's 50 GiB
cleanup threshold. This session's dependencies occupy about 96 MiB and its build
less than 1 MiB; they are retained so the application remains runnable. No
unrelated cache, project, VM disk, or database was pruned.
