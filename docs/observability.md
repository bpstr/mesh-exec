# Observability and message history

The mesh records what agents send, receive, publish, run, and acknowledge. Full internal A2A text and structured parts are durable data, not just metrics or short summaries. Complete Codex and command stdout/stderr streams are retained in runtime files, while PostgreSQL stores lifecycle events and indexes into those files.

The implementation is in [trace.ts](../src/trace.ts), [observer.ts](../src/observer.ts), [runner.ts](../src/runner.ts), and [a2a.ts](../src/a2a.ts). This is an observable execution record. It does not expose hidden model reasoning or content that the Codex CLI never emitted.

## Start with mission status

Set the same `MESH_DATABASE_URL` used by the runner. The following commands query the database directly and do not require a live daemon:

```bash
mesh status --mission MISSION_ID
mesh messages --mission MISSION_ID --pending
mesh trace --mission MISSION_ID --follow
```

Status includes the recorded roadmap, mission state and revision, slot generations and active run IDs, run-state counts, requirement-state counts, inbox counts and oldest pending age, outgoing delivery state, workspace-operation counts, and any final acceptance record.

Use this to distinguish a busy population from one waiting for coordination. A parked slot is a persistent identity with a handoff, not a lost agent. A resource-limit or stopped mission is not a completed roadmap.

## Read the actual internal messages

```bash
mesh messages --mission MISSION_ID --agent A1
mesh messages --mission MISSION_ID --task TASK_ID
mesh messages --mission MISSION_ID --message MESSAGE_ID
mesh messages --mission MISSION_ID --pending --limit 500
```

`--agent` matches either the sender or recipient. Results contain full stored message parts and metadata, stable sender/recipient IDs, task and delivery IDs, creation time, disposition, handling run/time, and the recorded per-run exposures. Results are newest first. The CLI defaults to a bounded result set; use a complete export for an entire large mission.

An internal exchange has several distinct events:

| Event/state                                                | What it establishes                                              | What it does not establish                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `message.send.accepted`                                    | The outgoing request is committed to the durable outbox          | Recipient acceptance                       |
| `message.delivery.started`                                 | A particular HTTP attempt began                                  | Successful delivery                        |
| `a2a.request.received`                                     | The authenticated endpoint received a wire request               | Durable task acceptance                    |
| `message.ingress.accepted` and `message.mailbox.persisted` | Task, message, inbox, and their trace committed together         | An agent has read the message              |
| `message.delivery.accepted`                                | The sender received the recipient's accepted task result         | Semantic handling                          |
| `message.offered`                                          | A poll exposed the full delivery to a particular run             | Understanding or agreement                 |
| `message.acknowledged`                                     | A run explicitly recorded its handling disposition               | A task answer or completion                |
| `message.reply.accepted`                                   | The recipient advanced the task and created an answer delivery   | The original sender has handled the answer |
| `task.canceled`                                            | The consultation was canceled and a counterpart notice persisted | Unrelated process termination              |

`mailbox.notice` is a bounded notification containing identifiers. `mailbox.polled` records the tool-level poll result. Neither event acknowledges a message. Each successor run can receive a fresh exposure for an unhandled delivery. `deferred` leaves it pending; `handled`, `rejected`, and `superseded` are final dispositions.

Retries are visible as `message.delivery.retry_scheduled`; permanent rejection is `message.delivery.rejected`. A replay of accepted ingress produces `message.ingress.replayed` with the original result. This is how to distinguish two HTTP attempts from two logical questions.

## Filter the durable trace

```bash
mesh trace --mission MISSION_ID --agent A1 --follow
mesh trace --mission MISSION_ID --run RUN_ID
mesh trace --mission MISSION_ID --task TASK_ID
mesh trace --mission MISSION_ID --message MESSAGE_ID
mesh trace --mission MISSION_ID --operation OPERATION_ID
mesh trace --mission MISSION_ID --correlation CORRELATION_ID
mesh trace --mission MISSION_ID --kind message.ingress.accepted
mesh trace --mission MISSION_ID --after 1000 --limit 500
```

Filters combine with AND. `--after` is an exclusive event-sequence cursor, not a timestamp. A non-following invocation returns one bounded batch; `--follow` advances the cursor through subsequent batches and waits for new events. Interrupt following with `Ctrl-C`.

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

`workRevision` is separate. It advances for meaningful coordination changes, such as a newly accepted message, released claim, source change, or changed decision. Polling, trace insertion, and a transport retry alone do not create new work. This distinction keeps tracing from waking idle agents indefinitely.

### What is captured

The durable trace includes MCP tool arguments/results, A2A wire requests/responses, full accepted internal messages and replies, outbox attempts and errors, claim conflicts, knowledge revisions/invalidation, requirement/review records, checkpoints, source-operation lifecycle, completion-proposal lifecycle, and mission acceptance. Codex JSON events are indexed with their exposed event content; ordinary stdout/stderr is indexed as text or file segments.

Known run/operator credentials, bearer credentials, credential-named fields, and recognized API-key/database-credential patterns are redacted. Message bodies otherwise remain available. Redaction is deliberate filtering, not a claim that every application-specific secret can be recognized automatically. Treat the database, logs, and exports as private project artifacts.

## Complete stdout and stderr

```bash
mesh logs --mission MISSION_ID --run RUN_ID
mesh logs --mission MISSION_ID --run RUN_ID --stream stderr --follow
mesh logs --mission MISSION_ID --operation OPERATION_ID
mesh logs --mission MISSION_ID --operation OPERATION_ID --stream stderr
```

The default stream is stdout. Codex stdout is stored as `stdout.jsonl`; stderr is `stderr.log`. Daemon-managed command logs are separate stdout/stderr files. These commands stream the complete retained file from its beginning, with `--follow` continuing to read appended bytes. They require the original log files to remain present, even if the PostgreSQL records still exist. An operation log becomes discoverable through its result metadata when that metadata is available; use the live trace for an operation still starting.

Run logs live under the private runtime directory, outside the shared source checkout. The worker receives its own writable `worker` directory for generated run files, while the parent retains the audit copy of the prompt and captured logs outside every worker-writable mount. Command stdout/stderr similarly live beside, rather than inside, the command's writable output directory. Workers cannot edit the parent's captured history through the supported execution boundary.

Capture streams are drained and synced on normal completion. Literal known-credential filtering handles secrets split across pipe chunks and preserves UTF-8. Long output records remain in the complete file even when their database index uses segments instead of a full inline record. Command output previews and status tails are intentionally bounded; they are not the complete log. Process exit, file presence, and trace completeness should be inspected together after a crash or storage failure.

## Export an investigation bundle

Choose a new destination directory:

```bash
mesh export --mission MISSION_ID --out ./mission-export
```

The directory contains:

| File/directory    | Contents                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `mission.json`    | Mission status snapshot and acceptance, when present                                                      |
| `events.jsonl`    | The complete durable event history, exported in pages                                                     |
| `runs.json`       | Run identities, state, results, and artifact references                                                   |
| `operations.json` | Workspace operation requests, state, results, and errors                                                  |
| `tasks.json`      | A2A tasks and their durable state/history                                                                 |
| `messages.json`   | Durable mailbox deliveries and full message content                                                       |
| `runs/`           | Available captured run logs, prompt, handoff, and other recognized run artifacts                          |
| `operations/`     | Available command stdout/stderr logs                                                                      |
| `export.json`     | Export time, event count, included artifact paths, redaction description, and a `missing` artifact report |

An export does not silently assert that every referenced runtime file survived. Inspect `export.json.missing` for expected artifacts that were absent or could not be copied. It is an investigation bundle, not a replacement for a PostgreSQL backup or a source checkout backup. Export after the mission stops for a stable investigation snapshot; an export during activity can include records from different moments as the mission continues.

For a trace-only JSONL export, optionally filtered:

```bash
mesh export --mission MISSION_ID --out ./events.jsonl --events-only
mesh export --mission MISSION_ID --out ./A1-events.jsonl --events-only --agent A1
```

Trace-only export follows all matching pages instead of stopping at the display limit. Both export modes require a new destination; they do not overwrite an existing archive/file. Credential filtering is applied again during export. Source files and arbitrary generated output artifacts are not automatically copied into the bundle.

## Metrics and local HTTP access

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

While the daemon runs, it also exposes `/observer/status`, `/observer/events`, `/observer/messages`, and `/metrics` over loopback HTTP. These require the separate operator bearer credential recorded in the private `daemon.json`; agent run tokens do not authorize operator observation. `/health` reports readiness. The HTTP server accepts direct local clients and rejects browser-origin requests. The CLI observation commands use the database connection instead of this operator HTTP credential.

## Useful investigations

For a missing answer, inspect the outgoing message's trace, then its task and mailbox deliveries. Establish whether it is pending transmission, persisted but unoffered, offered to a retired run, deferred, replied to, or still unhandled by the caller.

For duplicate-looking messages, compare `messageId`, `taskId`, outbox attempt IDs, and `deliveryId`. An accepted replay should preserve the original task; two different message IDs represent two logical intents even when their prose is similar.

For a failed completion attempt, inspect its operation ID and `completion.proposal.*` events, the current requirement/coverage evidence, unhandled mail, open consultations, and verification logs. Completion failure and budget exhaustion remain recorded outcomes rather than being converted into success.

For a parked population, check the semantic revision and pending messages before interpreting low CPU usage as a failure. A run that cannot find independent work should park. Source-publication or process-recovery quarantine needs investigation before new writers can be admitted.
