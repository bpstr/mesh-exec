# Validation record

Scope: compact/full board responses, reusable review instructions, receipt
accounting in status/metrics/exports, and post-acceptance terminal board/yield.
Automated checks use prepared workers and local database/HTTP fixtures. No test
runner was given provider credentials, `.secrets`, a proxy, or live model access.
The separately authorized one-shot manual run is recorded in REPORT.md.

## Affected checks

- TypeScript build passed before the live run (`validation/build.log`).
- `node --import tsx --test --test-concurrency=1 test/daemon.test.ts test/codex.test.ts`
  produced 13 passes, one failure, zero skipped/cancelled. Full original output:
  `validation/affected-tests.log`.
- The failure was the existing 2-second acceptance wait expiring before sandboxed
  final verification completed on the loaded host. Mission acceptance itself
  succeeded. The test wait was raised to 10 seconds and now includes the returned
  participation object in failure diagnostics.
- Reran only the failed case:
  `node --import tsx --test --test-name-pattern='independent MCP peers consult' test/daemon.test.ts`.
  One passed, zero failed/skipped/cancelled (`validation/acceptance-recheck.log`).
  The other 13 passing cases were retained.
- After the live run, extended that same integration case for terminal board/yield
  responses, unchanged accepted revision, and expired-lease rejection. The
  affected case passed again (`validation/terminal-recheck.log`). Build passed
  (`validation/post-run-build.log`).
- The final command-lifecycle instruction clarification required a build and
  focused formatting/document checks, not another application-suite run.
  Final build: `validation/final-build.log`.

All 14 selected behaviors have passing evidence. Repeated executions of the
same acceptance case are not counted as additional behaviors. No full-suite rerun
was needed: the runner, store, A2A and sandbox implementation remained unchanged
by this session. Existing shutdown-boundary evidence is retained in
`../shutdown-2026-10-20/VALIDATION.md`.

The new receipt test covers missing usage, multiple turns from one run, malformed
receipts, impossible cached counts, cached-input inclusion, and metrics. The
acceptance test covers summary omission, full-detail retrieval even at the same
revision, and the existing complete acceptance barrier.

## Manual sample evidence

The unchanged original input hashes and all frozen candidate source/build hashes
are in `validation/candidate.json`. The one-shot launcher uses low reasoning and
zero request/stream retries. `sol-run/authorization-consumed.json` prevents replay.
Five workers started and five exited normally. All five final handoffs and usage
receipts are present. No provider errors or missing exported artifacts occurred.

The acceptance barrier's generated test result is retained at
`validation/accepted-generated-tests.log` and in the original event/command
export: 12 passed, zero failed/skipped/cancelled, source unchanged. That suite was
not rerun after acceptance. Generated source inspection checked the deliverable
set, API transformation, type rejection, CLI behavior, import isolation, tests
and documentation.

The live candidate excludes the subsequent terminal board/yield correction and
command-lifecycle wording. `validation/post-run-source.diff` records that
difference; `validation/final-source.json` identifies final source. The live
candidate includes pre-existing shutdown work already present in the checkout.

## Resource boundary

The recorded live run consumed the single authorized allowance. There was no
second model run after post-run corrections. All remaining checks were offline.
The pilot daemon and workers exited; port 62402 is closed. Candidate `dist` was
the only removed directory. Detailed process/listener inventories and exact
cleanup measurements remain under `validation/`.
