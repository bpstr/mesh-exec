# Mesh efficiency improvements and Sol 6.1 result

The authorized five-peer Sol 6.1 run completed the unchanged original slugifier
task. Its first completion proposal passed the acceptance barrier and all 12
generated tests. All five workers exited normally, with five final handoffs and
five valid usage receipts. The export has no missing artifacts.

This supports trying a bounded real-project pilot. It does not establish general
production readiness, sustained throughput, optional-hook reliability, or
10/50/100-peer capacity. The transient transport failure below also prevents
claiming error-free operation.

## Findings and implementation

The preceding successful Terra run used 167 CLI-recorded tool attempts and
returned 532,785 tool-result bytes. Its 33 board responses accounted for 378,604
bytes (71.1%). Repeated requirement evidence and review reasoning dominated those
boards. Its workers were forcibly stopped after acceptance, leaving usage unknown.

Changes made before this run:

- Boards default to a summary that retains requirement criteria, author, state,
  revision and evidence count. Full evidence and passing review reasoning are
  available through `detail: "full"`, which bypasses unchanged-revision suppression.
  Objection reasoning remains visible in summaries. Acceptance still uses all
  durable records.
- Coordination guidance asks peers to review implemented revisions and reuse an
  existing independent pass for the same revision and manifest.
- Status, exports and metrics expose receipt coverage, invalid receipts and
  reported tokens. Cached input is not added twice; absent receipts remain unknown.
- The existing, separately tested 30-second completion grace was preserved in the
  live candidate. It allowed peers to finish without replacements or forced aborts.

Projecting the compact view onto the prior run's recorded boards reduces board
JSON bytes by **34.8%**. This deterministic projection is not a token-saving
measurement.

## Live outcome and comparison

Mission: `ceeedb33-848d-4129-a921-6bc37295349f`.
Model: `gpt-6.1-sol`, low reasoning; Codex CLI 0.160.0.
The model and reasoning setting follow the
[official model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.1-sol).

| Measurement                  | Previous successful Terra run | Sol 6.1 run |
| ---------------------------- | ----------------------------: | ----------: |
| Mission accepted             |                           Yes |         Yes |
| Worker launches              |                             5 |           5 |
| CLI tool attempts            |                           167 |         130 |
| Admitted mesh calls          |                           166 |         127 |
| Tool-result bytes            |                       532,785 |     279,342 |
| Board calls                  |                            33 |          32 |
| Message deliveries           |                            18 |           6 |
| Unhandled deliveries         |                             0 |           0 |
| Recorded independent reviews |                            11 |           2 |
| Final handoffs               |                             0 |           5 |
| Usage receipts               |                             0 |           5 |
| Supervisor elapsed seconds   |                       120.723 |     147.428 |

Sol used **22.2% fewer tool attempts** and **47.6% fewer result bytes**. It did not
finish faster. Acceptance took 130.049 seconds from supervisor start; normal
worker shutdown took another 17.379 seconds. Startup and export time are excluded
from that supervisor duration. No provider-error events were recorded.

The peers chose one requirement with four criteria covering the four deliverables,
and A5 independently reviewed both that requirement and roadmap coverage. All
three consultations completed. Of 32 board attempts, 16 requested full detail.
The model, requirements and review strategy differ from the baseline, so these
observations do not isolate the effect of the compact board.

All completed tool items used the mesh; no native command or file-edit bypass
appears in the worker traces. The accepted manifest is
`e515958535523b75adb7f5de6ded886915f13713c656f0cccb6256172207eadf`.
The four generated files were inspected against the original task. The final
acceptance suite passed 12/12 with zero failures or skips and unchanged source.
Its passing result was retained rather than running that suite again.

## Usage

| Peer      |  Input tokens |  Cached input |     Output |         Total |
| --------- | ------------: | ------------: | ---------: | ------------: |
| A1        |       480,813 |       443,264 |      2,375 |       483,188 |
| A2        |       723,685 |       683,904 |      1,887 |       725,572 |
| A3        |       674,687 |       635,648 |      2,701 |       677,388 |
| A4        |       633,092 |       594,816 |      1,553 |       634,645 |
| A5        |       617,575 |       579,968 |      2,155 |       619,730 |
| **Total** | **3,129,852** | **2,937,600** | **10,671** | **3,140,523** |

Cached input is 93.86% of input. Uncached input is 192,252 tokens. Total tokens
equal input plus output; the cached column is a subset of input. These are CLI
receipts from Codex account usage, not a reported monetary charge. Provider
request counts are not available from these receipts. The previous successful
run has no receipts, so no successful-run token reduction can be established.
Five peers still represent substantial coordination and context usage for this
small task; this is not evidence that five peers outperform one on such work.

## Recovered errors and final corrections

The complete CLI traces contain three unsuccessful tool attempts:

1. A1's first integration claim encountered an HTTP transport error. The same
   idempotent claim succeeded on replay. No provider retry or replacement launch
   occurred. Its underlying transport cause is not established.
2. After observing acceptance and checkpointing, A3 called `mesh_yield`, then
   `mesh_board`; both returned `STALE_RUN`. A3 still exited successfully.

After the live run, terminal board/yield calls were changed to return completion
participation state for a current leased peer. They do not enter closed workspace
or messaging services or mutate the accepted revision. Expired credentials still
fail. This final correction passed the focused offline acceptance/fencing test;
it was not included in the live candidate and has not had another live run.

A3 also started a test command and immediately yielded, which canceled that
command. It then ran the test successfully. The coordination instructions now
explicitly require inspecting command completion before claiming success or
yielding. The canceled operation is retained as evidence. This instruction
clarification is also post-run and has no new live effectiveness claim.

## Validation, authorization and cleanup

See [VALIDATION.md](VALIDATION.md) for affected checks and retained evidence.
The one allowance was five launches, five minutes, no replacement launches or
provider retries, and stop on acceptance, provider error or deadline. Existing
peers could drain inside the original deadline. The exclusive grant marker is
consumed; no further live run is authorized by it. Existing Codex authentication
was reused without loading API keys or `.secrets`.

All workers were reaped and pilot port 62402 closed. Existing PostgreSQL and
other tasks' services/browsers were preserved. Removed only the inactive
`/private/tmp/mesh-exec-efficiency-20261020/candidate/dist` copy: 600,205 file bytes.
The data volume had 47.68 GiB free afterward; concurrent cleanup elsewhere also
changed free space. Candidate source, runtime evidence, generated files, and the
current project build remain. No unrelated disk cleanup was attempted.

Evidence: [analysis](sol-analysis.json), [comparison](comparison.json),
[baseline projection](baseline-summary.json), [raw export](sol-run/export/export.json),
[generated app](sol-run/task-result/README.md), [candidate hashes](validation/candidate.json),
[post-run source diff](validation/post-run-source.diff),
[cleanup record](validation/cleanup.json). The full shared-checkout diff includes
pre-existing shutdown work, not only changes authored in this session.
