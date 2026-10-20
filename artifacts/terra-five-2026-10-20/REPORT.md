# Five-Terra slugifier rerun

The generated app works under the recorded checks. Shared mission acceptance
still fails: the integration peer requested reviews from peers that had already
exited. No independent reviews or completion proposal were recorded.

Five Terra processes exited normally after **207.746 seconds**, before the
five-minute cutoff. There were no replacement launches. The supervisor reported
`resource-limit` because its five-launch allowance was exhausted, not because
time or tool calls ran out.

The user removed the tool-call ceiling during execution. That change was applied
to the active grant without restarting agents. Both authorization records and the
operator amendment are preserved. No further live run followed.

## Product checks

The output contains exactly the four requested deliverables: `slugify.mjs`,
`cli.mjs`, `slugify.test.mjs`, and `README.md`. Supplied `package.json` and
`ROADMAP.md` are unchanged.

- Generated test suite: **6 passed, 0 failed, 0 skipped**.
- Independent checks: **4 passed, 0 failed, 0 skipped**, covering Unicode NFKD,
  combining marks beyond the basic block, separators, empty input, non-string
  errors, CLI argument joining and missing arguments, and import side effects.
- README inspection confirms API, examples, CLI usage, and `npm test` coverage.
- All four file patches applied. No native commands or edits bypassed the mesh.
- All five terminal usage receipts and all exported artifacts are present.

Logs are in `validation/generated-tests.log` and
`validation/independent-tests.log`. Independent checks ran against the exported
result after agents finished; they were not supplied to the agents.

## Comparison with the first live Terra run

| Measurement | First Terra run | This rerun |
| --- | ---: | ---: |
| Launched peers / terminal usage receipts | 5 / 5 | 5 / 5 |
| Elapsed seconds | 224.396 | 207.746 |
| Admitted mesh calls | 205 | 62 |
| All CLI-recorded mesh attempts | 208 | 67 |
| Failed/rejected CLI tool outcomes | 15 | 8 |
| Consultation tasks | 26 | 2 |
| Message deliveries | 36 | 2 |
| Unhandled deliveries | 4 | 2 |
| Reported total tokens | 4,198,594 | 1,925,885 |
| Cached input tokens | 3,877,888 | 1,720,832 |
| Uncached input tokens | 295,506 | 194,730 |
| Output tokens | 25,200 | 10,323 |
| Mission accepted | No | No |

Reported total tokens fell **54.1%**, uncached input **34.1%**, and admitted calls
**69.8%**. These are observed differences, not evidence of a causal improvement:
instructions and code changed, and reduced interaction also left essential
reviews undone. Two unanswered messages are not successful communication.

The broader outcome scan includes schema rejections and failed/rejected result
payloads, not just failed trace spans. This explains why the baseline failure
count differs from its original report's seven explicit protocol errors.
Schema rejections occur before the traced tool handler, explaining 67 raw
attempts versus 62 admitted calls in this rerun.

Usage remains substantial for this task. About 90% of input was cached, but the
194,730 uncached input tokens and 10,323 output tokens are still material.
Reasoning tokens (2,141) are already included in output. Receipts are CLI usage,
not a monetary bill. The evidence does not isolate the token contribution of
system instructions, tool schemas, board results, and reasoning.

## What the peers actually did

| Peer | Contribution | Lifetime | Admitted calls |
| --- | --- | ---: | ---: |
| A1 | Wrote CLI; checked its syntax | 37.2 s | 10 |
| A3 | Wrote README | 30.1 s | 8 |
| A4 | Wrote API; checked examples and type errors | 64.6 s | 12 |
| A5 | Wrote tests; ran the shared suite successfully | 77.7 s | 11 |
| A2 | Coordinated requirement evidence; requested final reviews | 207.7 s | 21 |

Claims separated work successfully: four peers published different files and A2
handled integration. The six admitted command attempts consisted of two rejected
absolute working-directory requests and four successful commands: discovery,
CLI syntax, API examples, and the shared tests. Only one agent ran the full test
suite. Five checkpoints were eventually recorded.

The critical ordering was:

1. A3 exited at **17:49:01 UTC**; A1 exited at **17:49:08 UTC**.
2. A4 exited at **17:49:35 UTC**; A5 exited at **17:49:48 UTC**.
3. A2 requested A1's requirement review at **17:49:51 UTC** and A3's
   whole-roadmap coverage review at **17:49:54 UTC**.
4. Neither recipient had a live process, and no replacement generation was
   permitted. Both tasks remained submitted and both deliveries unhandled.
5. A2 waited, then exited idle at **17:51:58 UTC**. One implemented requirement
   remained at revision 2, with zero reviews and zero completion proposals.

This run avoided the first run's late evidence revision after reviews, but stopped
earlier in acceptance: there were no reviews to invalidate. The main unresolved
issue is keeping review capacity available under a fixed launch budget.

## Errors and next improvements

Eight failed tool outcomes were observed:

- Two `mesh_exec` calls used the absolute repository path as `cwd`.
- A board wait requested 60,000 ms, exceeding the schema's 30,000 ms maximum.
- One claim used `paths`/`reason` instead of `id`/`resources`/`description`.
- Empty arguments were supplied to patch, exec, checkpoint, and yield.
- The empty checkpoint reached PostgreSQL and failed its non-null constraint,
  rather than being rejected at the tool boundary.

The next changes should remain general:

1. Expose remaining launch capacity and live peer availability in the shared
   workflow. When replacements are unavailable, preserve participants for
   outstanding acceptance work using bounded event-driven waits. An empty inbox
   is not enough evidence that a peer's participation is finished.
2. Arrange review participation before contributors leave. Validate reviewer
   availability when routing consultations, and report a concrete blocker when
   no live independent reviewer remains.
3. Validate checkpoint bodies before database writes; make required fields,
   relative `cwd`, and wait limits explicit in schemas and tool descriptions.
4. Record pre-handler schema rejections in the same observability stream as
   handler failures. Keep raw CLI inspection as an independent cross-check.
5. Remove the saved candidate's unsupported pagination instruction, or pair it
   with the matching implementation. No cursor calls occurred here, so this is a
   configuration mismatch rather than an established cause of this failure.

These are findings and recommendations; this rerun did not modify application
code or run another provider attempt.

## Reproduction and evidence

Mission: `01691e7c-e5f6-4235-9060-95b1a40f7a55`.
Model: `gpt-5.6-terra`, low reasoning, existing Codex launcher/authentication.
The functional roadmap matches the previous Sol input and original slugifier
requirements. General implementation instructions supply coordination; there is
no task-specific role assignment or acceptance recipe in the roadmap.

`validation/candidate.json` identifies the frozen candidate. It matches the last
saved communication refinement, while excluding unfinished runner and board
implementation changes in the shared checkout. See `VALIDATION.md` for the
incidental pagination-instruction mismatch and retained offline validation.

`analysis.json` and `analyze.py` preserve the comparison; `terra-run/export/`
contains source-bound prompts, schemas, raw CLI events, messages, tasks, and
operations. `terra-run/coordination.json` contains requirements, reviews, claims,
and checkpoints. `terra-run/task-result/` contains the working generated app.

The pilot and temporary inspector listeners are closed; all five agents exited.
Cleanup removed only
`/private/tmp/mesh-exec-terra-five-20261020/candidate/dist` (575,635 file bytes).
Source, runtime evidence, databases, and other chats' services remain. The data
volume had 13.99 GiB free after cleanup; details are in `validation/cleanup.json`.
