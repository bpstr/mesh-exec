# Observability and message history

The mesh records what agents send, receive, publish, run, and acknowledge. Full internal A2A text and structured parts are durable data, not just metrics or short summaries. Complete Codex and command stdout/stderr streams are retained in runtime files, while PostgreSQL stores lifecycle events and indexes into those files.

The implementation is in [trace.ts](../src/trace.ts), [observer.ts](../src/observer.ts), [conversations.ts](../src/conversations.ts), [artifacts.ts](../src/artifacts.ts), [runner.ts](../src/runner.ts), and [a2a.ts](../src/a2a.ts). This is an observable execution record. It does not expose hidden model reasoning or content that the Codex CLI never emitted.

## Start with mission status

Set the same `MESH_DATABASE_URL` used by the runner. The following commands query the database directly and do not require a live daemon:

```bash
mesh status --mission MISSION_ID
mesh digest --mission MISSION_ID
mesh digest --mission MISSION_ID --after CURSOR
mesh messages --mission MISSION_ID --pending
mesh trace --mission MISSION_ID --follow
```

Status includes the recorded roadmap, mission state and revision, slot generations and active run IDs, run-state counts, requirement-state counts, inbox counts and oldest pending age, outgoing delivery state, workspace-operation counts, and any final acceptance record.

`digest` provides compact coordination counts, recent artifact locations, usage, and a sequence cursor. Pass that cursor with `--after` to check for relevant changes since the previous digest. It is an operator summary; use message history or an export when you need the underlying records and a consistent database snapshot.

Use this to distinguish a busy population from one waiting for coordination. A parked slot is a persistent identity with a handoff, not a lost agent. A resource-limit or stopped mission is not a completed roadmap.

Command admission has its own trace: `workspace.command.admitted`, `workspace.command.rejected`, `workspace.command.queued`, and `workspace.command.capacity_acquired`. The last records execution-permit `waitMs`; it excludes subsequent source-gate waiting. `daemon.ready` records the effective execution and backlog limits for that invocation. Filter with `--kind-prefix workspace.command.` or an operation ID; see [workload boundaries](workloads.md) for counting and cancellation semantics.

## Read the actual internal messages

```bash
mesh messages --mission MISSION_ID --agent A1
mesh messages --mission MISSION_ID --task TASK_ID
mesh messages --mission MISSION_ID --message MESSAGE_ID
mesh messages --mission MISSION_ID --pending --limit 500
```

`--agent` matches either the sender or recipient. Results contain full stored message parts and metadata, stable sender/recipient IDs, task and delivery IDs, creation time, disposition, handling run/time, and the recorded per-run exposures. Results are newest first. The CLI defaults to a bounded result set; use a complete export for an entire large mission.

An internal exchange has several distinct events:

| Event/state                                                | What it establishes                                                           | What it does not establish                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| `message.send.accepted`                                    | The outgoing request is committed to the durable outbox                       | Recipient acceptance                                   |
| `message.delivery.started`                                 | A particular HTTP attempt began                                               | Successful delivery                                    |
| `a2a.request.received`                                     | The authenticated endpoint received a wire request                            | Durable task acceptance                                |
| `message.ingress.accepted` and `message.mailbox.persisted` | Task, message, inbox, and their trace committed together                      | An agent has read the message                          |
| `message.delivery.accepted`                                | The sender received the recipient's accepted task result                      | Semantic handling                                      |
| `message.offered`                                          | A poll exposed the full delivery to a particular run                          | Understanding or agreement                             |
| `message.acknowledged`                                     | A run explicitly recorded its handling disposition                            | A task answer or completion                            |
| `message.uptake.recorded`                                  | The authenticated receiver declared an assessment of selected message content | Verified understanding, correctness, or performed work |
| `message.reply.accepted`                                   | The recipient advanced the task and created an answer delivery                | The original sender has handled the answer             |
| `task.canceled`                                            | The consultation was canceled and a counterpart notice persisted              | Unrelated process termination                          |

`mailbox.notice` is a bounded notification containing identifiers. `mailbox.polled` records the tool-level poll result. Neither event acknowledges a message. Each successor run can receive a fresh exposure for an unhandled delivery. `deferred` leaves it pending; `handled`, `rejected`, and `superseded` are final dispositions.

Receiver [uptake records](semantic-memory.md) preserve interpretation separately
from this lifecycle. They pin a selected message value and retain append-only
revisions with declared evidence/dependency references. `conversation` includes
bounded uptake history, its total, and truncation. Uptake is an attributed
assertion; the daemon does not infer agreement or verify the cited evidence.

Retries are visible as `message.delivery.retry_scheduled`; permanent rejection is `message.delivery.rejected`. A replay of accepted ingress produces `message.ingress.replayed` with the original result. This is how to distinguish two HTTP attempts from two logical questions.

### Inspect outgoing intents and the conversation timeline

```bash
mesh messages --mission MISSION_ID --all
mesh messages --mission MISSION_ID --all --agent A1
mesh messages --mission MISSION_ID --all --outbox OUTBOX_ID
mesh conversation --mission MISSION_ID --task TASK_ID
mesh conversation --mission MISSION_ID --message MESSAGE_ID
```

The delivered-mailbox view remains useful for pending work. The `--all` view also includes outgoing intents that are queued, retrying, or rejected before an inbox delivery exists. Each entry retains the full outgoing envelope and accepted payload when available, sender/run provenance, attempts, exposure and acknowledgement summaries, task state, and measured lifecycle timings. Transport and mailbox state are reported independently; a received answer can still be unhandled.

`conversation` returns the linked event timeline in durable sequence order, including transport attempts, mailbox events, and related replies. It connects evidence across replacement runs. Message IDs are scoped by mission, sender, and recipient; use an outbox ID to select one outgoing intent unambiguously when multiple peers reuse the same message ID.

Both commands return `nextCursor`, `snapshotSeq`, and `observedAt`. Pass a non-null cursor back with the same selectors using `--cursor` to retrieve the next page. Cursors belong to their command and query; start a fresh query to observe new messages after the captured boundary. Payloads are retained in full within each returned record, while page sizes bound the number of records.

Message enumeration and event history are fenced at `snapshotSeq`; current lifecycle fields and state-filter membership can advance between page requests. Use an export for a transactionally consistent database snapshot. Message pages default to 50 records and allow up to 200; timeline pages default to 100 and allow up to 1000. Nested attempt, exposure, and acknowledgement histories include their latest 20 records with `total` and `truncated`; the timeline and export retain the complete history.

`messages --all --state` accepts `queued`, `sending`, `retrying`, `delivery-rejected`, `accepted`, `received`, `offered`, `deferred`, `handled`, `rejected`, or `superseded`. For example, `mesh messages --mission MISSION_ID --all --state retrying` isolates outgoing messages whose transport has not succeeded. Timing fields use recorded wall-clock timestamps and report negative intervals explicitly if a clock adjustment produces one; they do not measure model understanding.

## Filter the durable trace

```bash
mesh trace --mission MISSION_ID --agent A1 --follow
mesh trace --mission MISSION_ID --run RUN_ID
mesh trace --mission MISSION_ID --task TASK_ID
mesh trace --mission MISSION_ID --message MESSAGE_ID
mesh trace --mission MISSION_ID --operation OPERATION_ID
mesh trace --mission MISSION_ID --correlation CORRELATION_ID
mesh trace --mission MISSION_ID --trace-id TRACE_ID
mesh trace --mission MISSION_ID --span-id SPAN_ID
mesh trace --mission MISSION_ID --kind-prefix message. --follow
mesh trace --mission MISSION_ID --kind message.ingress.accepted
mesh trace --mission MISSION_ID --after 1000 --limit 500
mesh trace --mission MISSION_ID --after 128 --until 256
```

Filters combine with AND. `--after` is an exclusive event-sequence cursor, not a timestamp; `--until` is an inclusive upper boundary. `--kind-prefix` matches a literal event-kind prefix. A non-following invocation returns one bounded batch; `--follow` advances the cursor through subsequent batches and waits for new events. With `--until`, following ends after the bounded history has been drained. Interrupt following with `Ctrl-C`. Output respects consumer backpressure when piping a large trace to another process.

Every event includes a mission, unique event ID, sequence, time, kind, and JSON data. Applicable events additionally include:

| Field                                | Use                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `agentId`, `runId`                   | Attribute work to a stable peer and a particular process                |
| `traceId`                            | Join related message/task or tool execution records                     |
| `spanId`, `parentSpanId`             | Relate operations within a request or tool span                         |
| `correlationId`                      | Connect a conversation, Codex thread, run, task, or workspace operation |
| `causationId`                        | Identify an explicit causal predecessor when available                  |
| `messageId`, `taskId`, `operationId` | Follow a logical message, consultation, or durable operation directly   |

Identifiers are not all interchangeable. A stable slot may have many runs; one A2A task may have many messages; one message can have multiple delivery attempts and multiple per-run exposures. Use task/message filters for consultations and operation filters for commands and patches.

### Why the sequence cursor is safe

Trace sequence allocation locks the mission row and commits the event in that same transaction. A higher committed sequence cannot overtake a lower uncommitted sequence from another writer. This prevents the late-commit gap that a naïve independent sequence allocation can create in a polling event reader. The sequence is mission-local, and wall-clock timestamps are descriptive rather than the ordering authority.

`workRevision` is separate. It advances for meaningful coordination changes, such as a newly accepted message, released claim, source change, or changed decision. Polling, trace insertion, and a transport retry alone do not create new work. This distinction keeps tracing from waking blocked agents indefinitely.

### What is captured

The durable trace includes MCP tool arguments/results, A2A wire requests/responses, full accepted internal messages and replies, outbox attempts and errors, claim conflicts, knowledge revisions/invalidation, requirement/review records, checkpoints, source-operation lifecycle, completion-proposal lifecycle, and mission acceptance. Codex JSON events are indexed with their exposed event content; ordinary stdout/stderr is indexed as text or file segments.

Known run/operator credentials, bearer credentials, credential-named fields, and recognized API-key/database-credential patterns are redacted. Message bodies otherwise remain available. Redaction is deliberate filtering, not a claim that every application-specific secret can be recognized automatically. Treat the database, logs, and exports as private project artifacts.

## Run history and capture completeness

```bash
mesh runs --mission MISSION_ID --agent A1
mesh runs --mission MISSION_ID --run RUN_ID
```

Run history exposes generations, lifecycle timestamps, handoffs/results, event counts, and artifact locations without credential hashes. It is newest first, with `nextCursor` for the next page. Cursor keys retain PostgreSQL timestamp precision and an ID tie-breaker. Selecting a particular run also reads its protected `capture.json`; a missing manifest is explicit rather than being interpreted as an empty successful capture.

Each finalized manifest has `schemaVersion: 1` and separates the prompt, result schema, stdout, stderr, final handoff, and stdin transmission. Artifact metadata includes byte and line counts, SHA-256, synchronization status, and stage-specific failures. Output streams additionally record source bytes, EOF, indexed-event counts, and index completeness. The final handoff is reported as valid, invalid, or missing. A run may fail its coding task while its emitted output is completely captured; an indexing failure may leave full output files with an incomplete event index.

`run.prompt`, `run.handoff`, and `run.capture.completed` / `run.capture.incomplete` make those artifacts discoverable through the durable trace. The native handoff is archived during cleanup after process quiescence, including failure paths. Stdin completion records pipe transmission; it does not prove that a model understood the prompt. Native thread and turn identifiers, when emitted by Codex, remain associated with subsequent item events.

## Complete stdout and stderr

```bash
mesh logs --mission MISSION_ID --run RUN_ID
mesh logs --mission MISSION_ID --run RUN_ID --stream stderr --follow
mesh logs --mission MISSION_ID --operation OPERATION_ID
mesh logs --mission MISSION_ID --operation OPERATION_ID --stream stderr
mesh logs --mission MISSION_ID --run RUN_ID --offset 65536
```

The default stream is stdout. Codex stdout is stored as `stdout.jsonl`; stderr is `stderr.log`. Daemon-managed command logs are separate stdout/stderr files. These commands stream the complete retained file from its beginning, with `--follow` continuing to read appended bytes and `--offset` resuming at an exact byte position. Output remains byte-oriented across UTF-8 boundaries and respects slow consumers. A non-following replay stops at the file size observed when it opened. They require the original log files to remain present, even if the PostgreSQL records still exist. Command logs can also be discovered from the durable operation journal while an operation is active or interrupted.

Run logs live under the private runtime directory, outside the shared source checkout. The worker receives its own writable `worker` directory for generated run files, while the parent retains the audit copy of the prompt and captured logs outside every worker-writable mount. Command stdout/stderr similarly live beside, rather than inside, the command's writable output directory. Workers cannot edit the parent's captured history through the supported execution boundary.

Capture streams are drained and synced on normal completion. Literal known-credential filtering handles secrets split across pipe chunks and preserves UTF-8. Long output records remain in the complete file even when their database index uses segments instead of a full inline record. Command output previews and status tails are intentionally bounded; they are not the complete log. Process exit, file presence, and trace completeness should be inspected together after a crash or storage failure.

## Export an investigation bundle

Choose a new destination directory:

```bash
mesh export --mission MISSION_ID --out ./mission-export
mesh verify-export ./mission-export
```

The directory contains:

| File/directory                 | Contents                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `mission.json`                 | Mission status snapshot and acceptance, when present                                                      |
| `work.json`                    | Peer-authored work ledger and admission state from the same database snapshot                             |
| `events.jsonl`                 | The complete durable event history, exported in pages                                                     |
| `runs.json`                    | Run identities, state, results, and artifact references                                                   |
| `operations.json`              | Workspace operation requests, state, results, and errors                                                  |
| `tasks.json`                   | A2A tasks and their durable state/history                                                                 |
| `messages.json`                | Durable mailbox deliveries and full message content                                                       |
| `a2a-messages.json`            | Accepted message records with payload and sender provenance                                               |
| `outbox.json`, `attempts.json` | Full outgoing intents and individual transmission attempts                                                |
| `exposures.json`               | Which run was offered each mailbox delivery                                                               |
| `uptakes.json`                 | Complete receiver-owned assessment history, including superseded revisions and declared references        |
| `runs/`                        | Available captured run logs, prompt, handoff, and other recognized run artifacts                          |
| `operations/`                  | Available command stdout/stderr logs                                                                      |
| `export.json`                  | Export time, event count, included artifact paths, redaction description, and a `missing` artifact report |

An export does not silently assert that every referenced runtime file survived. Inspect `export.json` for missing or partial artifacts. Database records use a read-only repeatable-read snapshot, and `upperEventSeq` fixes the inclusive trace boundary. Streaming copies then read only each artifact's initial byte length, so active output cannot extend an export indefinitely. File copies occur after the database snapshot; the manifest identifies captures that are still incomplete or whose finality cannot be established. Export after a mission stops for the most complete investigation bundle.

The versioned manifest records archive paths, original source paths, byte counts, SHA-256 hashes, and whether original trace offsets still match the exported file. Reapplying credential filtering can change byte positions; an artifact with `offsetsPreserved: false` must be read as the exported content, not addressed using its source file's offsets. JSON table arrays and artifact files are written incrementally instead of loading an entire large mission or log into memory.

`verify-export` works without a database or running daemon. It checks the recorded file hashes and sizes and reports missing files, mismatches, unsafe paths, errors, and declared partial captures. Verification establishes archive integrity relative to its manifest; capture completeness is a separate reported property. The bundle does not replace a PostgreSQL backup or source checkout backup.

New bundles include `work.json` and include `uptakes.json` when the database has
the uptake ledger table. Read-only export of an older database omits the uptake
file and its table count; this means unavailable, rather than an empty ledger.
Conversation inspection similarly reports `uptakes.available: false` with a
warning. Verification also accepts earlier format-version 1 bundles that predate
either optional ledger file.

For a trace-only JSONL export, optionally filtered:

```bash
mesh export --mission MISSION_ID --out ./events.jsonl --events-only
mesh export --mission MISSION_ID --out ./A1-events.jsonl --events-only --agent A1
```

Trace-only export follows all matching pages instead of stopping at the display limit. Both export modes require a new destination; they do not overwrite an existing archive/file. Credential filtering is applied again during export. Source files and arbitrary generated output artifacts are not automatically copied into the bundle.

## Metrics and local HTTP access

Status and exported `mission.json` include `usage`: valid and malformed
`codex.turn.completed` receipt counts, runs with and without a valid receipt,
and reported input, cached input, output, and total tokens. Cached input is
already included in input; total is input plus output. These are observed
receipts, not an estimate of missing usage or a monetary charge. A killed worker
may have consumed tokens without emitting a receipt.

Metrics expose the same evidence as `mesh_usage_runs`, `mesh_usage_receipts`,
and `mesh_reported_tokens`. Always read the receipt coverage alongside the
token totals; zero reported tokens does not prove zero consumption.

```bash
mesh metrics --mission MISSION_ID
```

The output is Prometheus-compatible text with these metric families:

| Metric                                | Meaning                                              |
| ------------------------------------- | ---------------------------------------------------- |
| `mesh_runs`                           | Run counts by lifecycle state                        |
| `mesh_requirements`                   | Requirement counts by state                          |
| `mesh_outbox`                         | Outgoing interactions by delivery state              |
| `mesh_messages_pending`               | Number of unhandled inbox deliveries                 |
| `mesh_message_oldest_pending_seconds` | Age of the oldest pending delivery                   |
| `mesh_operations`                     | Workspace operations by kind and state               |
| `mesh_events_total`                   | Selected durable event counts, labeled by event kind |

Metric labels contain identifiers/state, not message bodies or credentials. Metrics summarize the trace; they do not establish that a question was understood or a roadmap was fulfilled.

While the daemon runs, it also exposes `/observer/status`, `/observer/runs`, `/observer/events`, `/observer/messages`, `/observer/conversations/messages`, `/observer/conversations/events`, and `/metrics` over loopback HTTP. These require the separate operator bearer credential recorded in the private `daemon.json`; agent run tokens do not authorize operator observation. `/health` reports readiness. The HTTP server accepts direct local clients and rejects browser-origin requests. The CLI observation commands use the database connection instead of this operator HTTP credential.

### Resumable live event feed

`GET /observer/events/stream` is an authenticated SSE feed of the durable trace. It accepts the event filters above using query names such as `traceId`, `spanId`, `kindPrefix`, `after`, and `until`. Each `mesh.trace` event has an SSE ID equal to its mission-local event sequence. Resume a connection with `Last-Event-ID`; an explicit `after` query takes precedence. Heartbeats keep idle connections active, and slow clients apply backpressure. Query errors return HTTP 400 before streaming begins; a later read failure is emitted as `mesh.error` before the stream ends.

```bash
curl -N \
  -H "Authorization: Bearer $MESH_OPERATOR_TOKEN" \
  -H 'Last-Event-ID: 128' \
  'http://127.0.0.1:7331/observer/events/stream?kindPrefix=message.'
```

Use the operator credential from the private daemon metadata. Observing or replaying this feed does not acknowledge mailbox deliveries or change coordination state.

## Useful investigations

For a missing answer, inspect the outgoing message's trace, then its task and mailbox deliveries. Establish whether it is pending transmission, persisted but unoffered, offered to a retired run, deferred, replied to, or still unhandled by the caller.

For duplicate-looking messages, compare `messageId`, `taskId`, outbox attempt IDs, and `deliveryId`. An accepted replay should preserve the original task; two different message IDs represent two logical intents even when their prose is similar.

For a failed completion attempt, inspect its operation ID and `completion.proposal.*` events, the current requirement/coverage evidence, unhandled mail, open consultations, and verification logs. Completion failure and budget exhaustion remain recorded outcomes rather than being converted into success.

After acceptance, `supervisor.draining` records the allowed `graceMs`, remaining
mission budget in `remainingMs`, and unchanged wall-clock `deadlineAt`. During
this phase, final checkpoints, `result.json` handoffs and `codex.turn.completed`
usage events can still arrive from existing peers. No new run is admitted.
`supervisor.ended.shutdownReason` distinguishes grace expiry, the original
deadline and operator cancellation when shutdown interrupts a peer. These
interruptions preserve the completed mission state; inspect `run.process.ended`
to distinguish a normal exit from a terminated peer. Missing usage receipts
remain unknown, including after a crash or deadline; acceptance alone does not
establish token totals. Historical runs retain their original missing receipts.

For a parked population, check the semantic revision and pending messages before interpreting low CPU usage as a failure. Blocked runs park; an idle exit starts a fresh generation while admission remains open. Source-publication or process-recovery quarantine needs investigation before new writers can be admitted.
