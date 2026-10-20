# Five live Terra agents: working sample, incomplete acceptance

Five ChatGPT-authenticated Codex processes using `gpt-5.6-terra` produced the
requested slugifier API, CLI, tests, and documentation. All six sample tests
passed in four recorded verification commands. The mission nevertheless ended
as **`resource-limit`**, without a completion proposal or acceptance.

The run lasted **224.4 seconds**, from **18:37:01 to 18:40:46 Europe/Budapest**
on 20 October 2026. All five processes exited normally with an `idle` handoff.
The five-launch budget was exhausted; the five-minute wall-clock cutoff was not
reached. There were no replacement processes, provider-error events, or missing
export artifacts. The explicitly approved second allowance is now exhausted.

Mission: `57ac2a53-a8d0-42e0-b16a-24f2709f1112`.
Runner revision: see `authorization-consumed.json`; PRs
[#1](https://github.com/bpstr/mesh-exec/pull/1) and
[#2](https://github.com/bpstr/mesh-exec/pull/2) were merged before this run.

## Contributions and cooperation

The supervisor supplied the same roadmap to every peer. It did not assign roles.
The following roles emerged through board reads, messages, and file claims:

| Agent | Observed contribution | Runtime | Mesh tool calls |
| --- | --- | ---: | ---: |
| A1 | Wrote the six tests, ran them, checked documentation, updated requirement evidence | 162.0 s | 36 |
| A2 | Wrote the CLI, ran tests, independently reviewed requirement revision 2 | 173.5 s | 44 |
| A3 | Performed independent whole-roadmap coverage review and ran tests | 174.5 s | 47 |
| A4 | Wrote usage documentation, coordinated ownership conflicts, released its claim | 112.5 s | 32 |
| A5 | Wrote the API, created the shared requirement, ran tests, revised evidence and requested final review | 224.4 s | 46 |

There were **205 mesh tool calls**, **36 message deliveries**, **26 A2A tasks**,
and **five rejected competing claims**. All four file patches were applied
successfully. The final implementation contains only the four requested new
files, alongside the supplied roadmap and package file.

Seven tool calls failed with explicit protocol errors: three command admissions
(two invalid paths and one temporary workspace barrier), two requirement revision
conflicts, and two invalid reviews. These were observable coordination mistakes
or transient conflicts, not provider failures. No rejected write lost a peer's
published content.

Three workers logged a nonfatal system-skill installation permission error during
Codex startup. All five subsequently started model turns, used the mesh, and
returned structured handoffs. This diagnostic remains in the exported stderr;
the run does not establish that all Codex extensions work inside this sandbox.

## Why acceptance was unfinished

The final source manifest was
`9c47a2cb53e5292eea9b7d72dee13a2d6e63fca61d54d7729892e519c1672c68`.
The source stopped changing before the four successful verification commands.
The failure occurred in the final requirement/review handoff:

| Local time | Recorded event |
| --- | --- |
| 18:37:57 | A5 created shared requirement `slugifier`, revision 1 |
| 18:39:26 | A1 updated it to revision 2 with evidence |
| 18:39:33 | A3 recorded a coverage review against the final source |
| 18:39:38 | A2 recorded an independent requirement review for revision 2 |
| 18:39:55–56 | A2 and A3 exited with idle handoffs |
| 18:39:58 | A5 revised the requirement again, creating revision 3 |
| Before 18:40:46 | A5 attempted a self-review, was correctly rejected, and requested a new review from the already exited A2 |
| 18:40:46 | A5 exited idle; the supervisor stopped at the maximum run count |

The requirement remained implemented at revision 3, but its independent review
covered revision 2. Four deliveries remained unhandled, and sixteen A2A tasks
remained submitted rather than terminal. Acknowledging a message and closing its
consultation are separate operations.

No peer called `mesh_propose_completion`. Consequently, the final acceptance
barrier did not run. The observations support an incomplete coordination
workflow; they do not show a submitted proposal being rejected. The runner
correctly avoided declaring completion from the agents' optimistic summaries.

This exposes a mismatch between finite peer handoffs and a one-generation
budget: a peer may leave useful work for its successor, but this run explicitly
allowed no successor. A5 also revised shared acceptance state after its reviewers
left. Keeping the source unchanged alone was insufficient.

## Sample verification

The recorded commands `a2-final-test-1`, `A1-final-test`,
`a3-final-node-test-b`, and `A5-final-test` each ran
`node --test slugify.test.mjs` and passed **6/6 tests**, with zero failures or
skips. Their full logs are in `export/operations/`; each command exited 0.
Those passing results were retained rather than rerunning identical checks.

Source inspection also confirms the requested string validation, NFKD
normalization, combining-mark removal, ASCII slug formatting, side-effect-free
API import, CLI argument joining, and no-argument exit status. No external
dependency was added. The resulting files and their hashes are retained in
`task-result/` and `analysis.json`.

The sample is usable. The mesh mission is **not accepted** and should not be
represented as a successful end-to-end completion.

## Usage and efficiency

Five terminal Codex usage receipts report:

- Input: **4,173,394 tokens**, including **3,877,888 cached input tokens**.
- Output: **25,200 tokens**, including reported reasoning output.
- Aggregate input plus output: **4,198,594 tokens**.
- Uncached input: **295,506 tokens**.

These are cumulative model-request counters, including repeatedly supplied
context, not unique prompt sizes. Approximately 92.9% of input was cached.
The run used the existing ChatGPT login; no API key was loaded by the pilot.
These counters do not establish a monetary charge or billing settlement.
Per-agent receipts are in `analysis.json` and the raw turn-completion events.

The tiny task incurred substantial coordination overhead: five competing claims,
36 messages, 205 tool calls, and four runs of the same six-test suite. The sample
alone does not justify a throughput claim. It suggests that five peers are
excessive for this amount of implementation work.

For a future separately authorized experiment:

1. Agree on a final requirement revision before requesting reviews, and refresh
   reviews after any evidence/requirement change.
2. Keep a peer responsible for acceptance active until the final proposal
   succeeds; reviewers should not exit while their review is still needed.
3. Use shared board entries for status announcements. Reserve A2A consultations
   for exchanges that will receive a terminal reply or cancellation.
4. Reuse successful verification evidence against the unchanged manifest where
   independent review does not require another execution.
5. Either allow bounded replacement generations or explicitly qualify a
   one-generation completion handshake. Do not weaken the acceptance checks to
   make this failed workflow appear successful.

These are recommendations from this run, not changes proven by another live
experiment. No further model launches are authorized by this report.

## Navigating the evidence

- `analysis.json`: counts, timing, per-agent token receipts, handoffs, source hashes.
- `coordination.json`: exact requirement revisions, reviews, claims, checkpoints.
- `export/events.jsonl`: all **1,312** correlated events in sequence order.
- `export/messages.json` and `export/tasks.json`: full conversations and delivery/
  task state, including the unresolved handoff.
- `export/runs/`: each agent's full observable stdout/stderr, prompt, result schema,
  and structured final handoff.
- `export/operations/`: verification output.
- `export/export.json`: export inventory; **zero missing artifacts**.
- `task-result/`: usable sample code, tests, and documentation.

The captured output contains observable actions and communication, not hidden
model reasoning.
