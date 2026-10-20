# Validation record

Date: 2026-10-20. Baseline: `bf8e10c`.
Scope: runner completion lifecycle, post-acceptance MCP authorization, final
checkpoint persistence, CLI configuration wiring. All checks are offline.

## Selected checks

1. `npm run build`
   - Passed; [build.log](validation/build.log).
2. `node --import tsx --test --test-concurrency=1 test/runner.test.ts test/daemon.test.ts test/store.test.ts test/cli.test.ts`
   - Initial result: 33 cases, 29 passed, 4 failed, 0 skipped, 0 cancelled.
   - [Initial complete log](validation/initial-affected-tests.log).
   - Retained the 29 passing cases. Product source did not change after this run.
3. `node --import tsx --test --test-concurrency=1 --test-name-pattern='completed mission stops an unresponsive peer|blocked populations honor' test/runner.test.ts`
   - After fixture corrections: 4 cases, 4 passed, 0 failed, 0 skipped,
     0 cancelled. [Focused complete log](validation/shutdown-boundaries.log).

The four files were selected because the runner owns process shutdown, the daemon
and store own post-acceptance credentials and writes, and the CLI forwards the new
configuration. No full-suite or live-model rerun was needed.

## Initial failures and fixture corrections

Three new timeout cases used a short `thread.started` output record to simulate
acceptance. The streaming secret redactor buffered that record until process
exit, so acceptance was only injected after timeout. Synchronizing on the runner's
`run.started` lifecycle event fixes the test without changing production output
redaction or shutdown behavior.

An existing blocked-population test allowed only 300 ms for process startup,
result capture and parking. It reached its deadline before parking on this host.
The fixture budget is now 1,000 ms; the test still checks deadline termination,
exactly one launch and the parked state. The focused run finished in approximately
1.02 seconds.

Before the initial run, the shared worker fixture's obsolete bootstrap substring
check was updated to recognize `mesh_join` in the current generic instructions.
The new successful-drain case passed in the initial run; it was not rerun.

## Evidence interpretation

The fake CLI emits synthetic usage and final-result records. Tests assert capture
and lifecycle behavior, not provider quality or token consumption. Temporary
worker directories are cleaned in fixture teardown; logs here preserve the full
test output, including failures. Product changes are captured in
[implementation.diff](validation/implementation.diff).

Formatting passed for all changed source, tests, documentation and reports
([log](validation/final-format.log)); `git diff --check` also passed
([log](validation/diff-check.log)). Test execution used approximately 48 seconds
for the initial selection and 3.6 seconds for the focused correction run.

Fixture teardown left no runner processes. No browser or development server was
started; the existing database listeners were preserved. The build output is
696 KiB and was retained. The data volume has about 9 GiB free; no unrelated
cleanup was attempted. See [hygiene.txt](validation/hygiene.txt).
