# General participation fix and five-Terra result

**The mission was accepted.** All five peers remained active through acceptance.
The generated slugifier passes its six tests and four independent checks.
Every consultation is terminal and all eighteen message deliveries are handled.

The change applies to all implementation missions. It does not depend on this
example, five agents, or a five-minute budget.

## General implementation

- Added `mesh_wait`: a bounded server-side wait inside the existing authenticated
  process. Inbox deliveries, shared changes, or mission termination wake it.
  It returns compact participation state and pending mail without acknowledging
  that mail. Timeout means wait again, not exit.
- Added `participation` to the board, including `mayExit` and `livePeerIds`.
  Availability checks current generations, supervisor epochs, and run leases.
- `mesh_yield` still drains commands and releases claims, but implementation
  peers now receive explicit participation state. An active or closing mission
  returns `mayExit: false`.
- Replaced the bootstrap's early idle-handoff guidance with general participation
  rules. Peers arrange reviewers early, review ready independent work proactively,
  handle messages, and stay available through acceptance.
- Required nonempty checkpoint objects at the tool boundary. Clarified relative
  command working directories and wait limits.

The discussion profile retains its separate bounded-contribution rules. Existing
generation replacement remains separate from same-process waiting. A live waiting
peer can be awakened without another launch or losing context; an exited process
cannot be revived by a message alone.

This is a protocol and tool lifecycle, not a guarantee against a model ignoring
instructions or a process crashing. The acceptance barrier still decides whether
the mission is actually complete.

## What happened

Mission: `7027ca64-f521-4476-ad5d-4ae12215bddb`.
Model: `gpt-5.6-terra`, low reasoning.
Authorization: five launches, five minutes, no tool-call ceiling, no replacement
generations or provider retries. No additional live attempt followed.

Acceptance was recorded at **20:06:08.475 Europe/Budapest on 20 October 2026**.
All five processes ended about 1.7 seconds later. Total process elapsed time was
**120.723 seconds**, comfortably inside the deadline. There were zero provider
error events.

| Peer | Contribution | Recorded reviews | Admitted calls |
| --- | --- | ---: | ---: |
| A1 | README; independent API reviews | 3 | 40 |
| A2 | API; independent CLI/tests/coverage reviews | 5 | 34 |
| A3 | Test suite; independent API review | 1 | 22 |
| A4 | CLI; independent tests/docs reviews | 2 | 23 |
| A5 | Integration, evidence, review requests, acceptance | 0 | 47 |

Roles emerged from shared claims and work. The roadmap contains the same
functional slugifier requirements as the previous run, without a coordination
recipe or assigned roles.

A5 arranged reviews while contributors were still active. Four implemented
requirements reached revision 2. Reviewers refreshed their evidence against the
final manifest, producing nine requirement reviews and two coverage reviews.
The final manifest was
`f9e68a95d0a0faadfecd28fb7772ce81c4299a99c5f77cf8872a9e51e079ec5a`.

Seven consultations were created: five completed, and two were explicitly
canceled when their work was superseded. All eighteen deliveries, including
cancellation notifications, were acknowledged.

There were 33 `mesh_wait` calls. They returned for actual inbox deliveries and
shared-work changes; two observed the terminal mission. Run identities remained
unchanged. None of the five peers ended its process before acceptance.

The first two completion proposals were rejected because replies/corrections
were still pending. The team processed the remaining mail and tried again.
The third proposal passed the real acceptance barrier, including controlled
`node --test slugify.test.mjs` verification. No operator bypass was used.

## Comparison

| Measurement | Original Terra run | Previous rerun | Participation fix |
| --- | ---: | ---: | ---: |
| Mission accepted | No | No | **Yes** |
| Elapsed seconds | 224.396 | 207.746 | 120.723 |
| Admitted mesh calls | 205 | 62 | 166 |
| CLI-recorded tool attempts | 208 | 67 | 167 |
| Message deliveries | 36 | 2 | 18 |
| Unhandled deliveries | 4 | 2 | **0** |
| Terminal usage receipts | 5 | 5 | **0** |
| Total reported tokens | 4,198,594 | 1,925,885 | **Unknown** |

The previous run used fewer calls by leaving review work unfinished. This run
performed the reviews and closed acceptance. Different application revisions and
instructions prevent treating these observations as a controlled causal
benchmark. No token-saving claim can be made for the current run.

## Remaining errors and evidence limits

The run recovered from five handler/protocol errors: two stale review attempts,
one reused reply ID with changed content, one send to a terminal task, and one
reply to a terminal task. Two reads of rejected completion proposals also returned
failed outcomes. A final wait attempt received HTTP 401 after mission completion
revoked run access. These eight unsuccessful CLI outcomes remain in the raw logs.

The runner's existing completion behavior aborts active CLI processes immediately
after acceptance. Consequently all five runs are recorded as `aborted`, despite
the mission being completed first. They wrote neither final handoff files nor
terminal `turn.completed` usage receipts. **Usage is unknown, not zero.**
The export records five missing `result.json` files; other exported artifacts
are present. Durable checkpoints, messages, reviews, operations, and acceptance
evidence remain available.

A future accounting improvement should capture usage before teardown or provide
a bounded completion-drain phase within the same wall-clock deadline. This run
does not implement or validate that extension.

## Verification and preserved results

The build and thirteen affected offline checks pass, including same-run delayed
review, real acceptance, run fencing, closing/terminal state behavior, and schema
validation. Generated app tests pass **6/6**; independent checks pass **4/4**.
Supplied inputs are unchanged and exactly the four requested files were added.
No native command or file-edit action bypassed the mesh.

- [Exact eighteen-message transcript](MESSAGES.md), with timestamps and acknowledgment state.
- [Original message JSON](terra-run/export/messages.json).
- [Generated app](terra-run/task-result/README.md).
- [Analysis data](analysis.json), generated offline by `analyze.py`.
- [Validation record](VALIDATION.md), candidate hashes, source diff, and test logs.
- `terra-run/export/`: prompts, schemas, raw agent output, tasks, operations, and events.
- `terra-run/coordination.json`: requirements, reviews, claims, and checkpoints.

The live candidate and shared application changes are preserved separately from
earlier failed trials. No historical failure evidence was replaced.

Cleanup removed only
`/private/tmp/mesh-exec-participation-20261020/candidate/dist` (588,700 file bytes).
The pilot listener is closed and no trial processes remain. Sources, runtime
evidence, databases, and other chats' services are preserved. The data volume had
13.89 GiB free after cleanup; exact measurements are in `validation/cleanup.json`.
