# Protocol and agent workflow

This document describes the current contracts in [tools.ts](../src/tools.ts), [a2a.ts](../src/a2a.ts), [store.ts](../src/store.ts), and [workspace.ts](../src/workspace.ts). The wrapper manages processes, credentials, admission, and bounded execution. Agents choose their own work and consultation partners.

## Identity and durable state

| Identifier     | Scope and purpose                                                                |
| -------------- | -------------------------------------------------------------------------------- |
| `missionId`    | One stored roadmap, checkout baseline, population, and history                   |
| `agentId`      | Stable slot such as `A1`; survives replacement CLI processes within a mission    |
| `runId`        | One finite Codex process and its provenance                                      |
| `generation`   | Monotonically increasing slot generation; fences obsolete run credentials        |
| `messageId`    | Sender-chosen identifier for one message intent; reused on retries               |
| `taskId`       | Server-generated A2A consultation task; independent of roadmap requirement IDs   |
| `contextId`    | A2A conversation context shared by related tasks at an accessible peer endpoint  |
| `deliveryId`   | One recipient's durable mailbox delivery; used for acknowledgement               |
| `uptakeId`     | Receiver-chosen ID for an immutable assessment; exact retries retain the same ID |
| `operationId`  | Caller-chosen workspace command, patch, or completion-proposal identifier        |
| `workRevision` | Semantic mission revision used to avoid losing wakeups when a slot parks         |

MCP requests use a fresh bearer credential for their current run. The daemon derives the principal from that credential; callers cannot supply an alternative agent identity in tool arguments. Run generation, active-slot ownership, mission state, and leases determine whether a mutation is permitted.

A2A task ownership is tied to the stable mission/agent participants and the recipient endpoint. A successor can inspect or answer its predecessor's task. Original run and generation are retained as message provenance. Another slot or mission cannot obtain that task simply by knowing its ID.

PostgreSQL is authoritative for coordination records. Process memory is used for bounded execution and transient delivery capabilities, not as the only copy of an accepted consultation.

## MCP surface

The daemon exposes stateless Streamable HTTP MCP at `POST /mcp`. The runner configures this endpoint as the required `mesh` server in each Codex invocation.

The table lists required arguments and important options. Tools return JSON in MCP text content; failures return `isError: true` with an error message and, when available, a code and details.

| Tool                      | Inputs                                                                                                                       | Result or effect                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `mesh_join`               | None                                                                                                                         | Authenticated identity, original roadmap, board, recent checkpoints, and common workflow                                         |
| `mesh_board`              | Optional `query`                                                                                                             | Requirements, intentions, claims, knowledge, peers, and mission revision; search uses PostgreSQL full text                       |
| `mesh_find_peers`         | Optional `query`                                                                                                             | Stable peer identities and answerability offers, including parked custodians                                                     |
| `mesh_digest`             | Optional `after` event cursor                                                                                                | Coordinator counts, state changes and bounded artifact references; suppress unchanged observations                               |
| `mesh_work`               | Optional `items` declaration batch, `afterId` page cursor                                                                    | Declare work resource/prerequisite bundles or list ready work and independent capacity                                           |
| `mesh_claim`              | `id`, `resources`, `description`; optional `intentionId`, `requirementIds`                                                   | Atomically acquire a resource bundle, or receive its conflicts                                                                   |
| `mesh_send`               | `recipientId`, `messageId`, and `text` and/or `data`; optional `taskId`, `contextId`, `kind`, correlation fields, references | Commit outgoing intent, perform A2A delivery, and return an outbox receipt                                                       |
| `mesh_reply`              | `taskId`, `messageId`, and `text` and/or `data`; optional `state`                                                            | Answer or advance a task addressed to this stable peer; preserve its original task ID                                            |
| `mesh_cancel`             | `recipientId`, `taskId`                                                                                                      | Cancel an obsolete consultation and notify its counterpart                                                                       |
| `mesh_poll`               | Optional `limit`, 1–128                                                                                                      | Full pending deliveries, pending count, and `workRevision`; does not acknowledge them                                            |
| `mesh_ack`                | `deliveryId`; optional `disposition`, `reason`                                                                               | Record handling, deferral, rejection, or supersession of a delivery                                                              |
| `mesh_uptake`             | `action`, `deliveryId`; optional `selector`; recording requires `uptakeId`, `status`, `grounds`                              | Record or inspect receiver-owned interpretation; optional references and append-only supersession. Implementation workflow only. |
| `mesh_remember`           | `id`, `kind`, `title`, `body`; optional revision, evidence, conditions, unknowns, readiness, status, edges                   | Publish or revise shared findings, decisions, offers, or blockers                                                                |
| `mesh_requirement`        | `id`, literal roadmap `anchor`, `title`, `criteria`; optional revision, state, evidence                                      | Maintain an agent-interpreted acceptance requirement                                                                             |
| `mesh_review`             | `id`, `kind`, `manifestHash`, `verdict`, `reasoning`; requirement reviews also identify target ID/revision                   | Record a current independent requirement or coverage review                                                                      |
| `mesh_read`               | `paths`; optional `manifest`                                                                                                 | Coherent UTF-8 file snapshots with hashes; optionally the source manifest                                                        |
| `mesh_patch`              | `operationId`, `changes`; optional `claimId`, dependencies                                                                   | Publish guarded complete-file replacements or deletions                                                                          |
| `mesh_exec`               | `operationId`, `argv`, `mode`; optional cwd, claim, timeout, network, environment, dependencies                              | Start a bounded command asynchronously and return a durable operation handle                                                     |
| `mesh_operation`          | `operationId`; optional `cancel`                                                                                             | Inspect command, patch, or completion status; cancellation applies to the caller's active command                                |
| `mesh_checkpoint`         | `body`; optional `id`                                                                                                        | Persist a nonempty checkpoint object for the stable slot                                                                         |
| `mesh_yield`              | `reason`; optional `waitingOn`                                                                                               | Release claims and return a wakeup revision plus implementation participation state; remain available while mayExit is false     |
| `mesh_wait`               | Optional `sinceRevision`, `waitMs` (0–300,000; default 120,000)                                                              | Remain in the same process; wake for messages, shared changes, or termination and return participation state                     |
| `mesh_propose_completion` | `operationId`; optional `checks`, `timeoutMs`                                                                                | Start asynchronous final acceptance; inspect it with `mesh_operation`                                                            |

`mesh_exec` and `mesh_propose_completion` return before the long operation finishes. Acceptance of the request is not a passing command or completed mission. `mesh_patch` is a bounded synchronous publication and also leaves a durable operation record.

Command admission is bounded separately from execution. A new `mesh_exec` exceeding the configured accepted-work limit returns `command_queue_full` with `retryable: true`, observed capacity, and no workspace operation record. An identical accepted replay returns its existing handle even at capacity; changed arguments still conflict. Canceled execution-capacity waiters are removed before their run is released. See [workload boundaries](workloads.md) for the settings and exact scope.

## A normal run

1. Call `mesh_join`, inspect applicable repository instructions, read the board, and call `mesh_poll`.
2. Inspect the source and identify a useful contribution. Consult relevant peers; publish an offer or question when another agent's evidence can change the approach.
3. Claim the required resource bundle. A claim conflict is information for coordination, not an instruction from the runner to take a different task.
4. Read coherent inputs, declare dependencies, publish changes, and inspect command results.
5. Record findings, decisions, criteria evidence, corrections, and independent reviews. Handle inbox deliveries explicitly.
6. Checkpoint useful context and release claims with `mesh_yield`. Implementation peers remain available through acceptance: use `mesh_wait` while idle, handle returned messages, and inspect changed work. A timeout or empty inbox does not permit exit. See [participation lifecycle](coordination.md) for live-peer selection and terminal exit state.

The handoff schema is:

```json
{
  "outcome": "blocked",
  "summary": "Waiting for the interface decision before changing the adapter.",
  "checkpoint_id": "A1-design-checkpoint",
  "waiting_on": ["adapter-interface-decision"],
  "work_revision": "42"
}
```

This schema describes a process handoff when one occurs; it is not permission to leave an active implementation mission. Allowed outcomes are `continue`, `idle`, `blocked`, and `completion_proposed`. The checkpoint and revision fields may be null in the schema, but idle/blocked peers should preserve the cursor returned by `mesh_yield`. If an idle process nevertheless exits, the runner can allocate a fresh generation while the mission is active and launch capacity remains. Blocked and completion-proposed exits park until the revision changes; using a later arbitrary snapshot can hide work that arrived between the last useful read and parking.

Yield releases current claims but preserves the live process's ability to review, wait for messages, and reclaim work. An exited process needs a successor generation, which recovers from durable state; same-process waiting retains the current context.

## Actual A2A transport

This implementation uses `@a2a-js/sdk` 1.3.0 for the A2A 1.0 JSON-RPC wire format, codecs, method dispatch, errors, and outgoing HTTP client. A custom SQL-backed request handler makes task state, deduplication, mailbox delivery, and trace writes atomic. See the [official A2A specification](https://a2a-protocol.org/latest/specification/) and [JavaScript SDK](https://github.com/a2aproject/a2a-js).

Each stable slot has a bearer-authenticated Agent Card and endpoint:

```text
GET  /agents/A2/agent-card.json
GET  /agents/A2/.well-known/agent-card.json
POST /agents/A2/a2a
```

The card advertises the JSON-RPC URL, protocol version `1.0`, mission tenant, bearer security, and text/JSON modes. Requests use `Content-Type: application/json` and `A2A-Version: 1.0`.

| Wire method                     | Behavior                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SendMessage`                   | Accept a user message, create or continue a durable consultation task, and persist an inbox delivery |
| `GetTask`                       | Return the participant-accessible task; honor `historyLength`                                        |
| `ListTasks`                     | Scoped task listing with context/status/timestamp filters, history/artifact options, and pagination  |
| `CancelTask`                    | Transition a cancellable task to canceled and persist a counterpart notification                     |
| Streaming and task subscription | Explicit unsupported-operation response; not advertised                                              |
| Push-notification configuration | Explicit unsupported response; not advertised                                                        |

For example, this wire request creates a consultation rather than an assigned roadmap job:

```json
{
  "jsonrpc": "2.0",
  "id": "rpc-17",
  "method": "SendMessage",
  "params": {
    "tenant": "MISSION_ID",
    "message": {
      "messageId": "A1-interface-question-1",
      "role": "ROLE_USER",
      "parts": [{ "text": "Which ordering invariant must the adapter preserve?" }]
    },
    "configuration": { "returnImmediately": true }
  }
}
```

The response includes a server-generated task and context ID. New asynchronous consultations start in `TASK_STATE_SUBMITTED`. A follow-up to an existing nonterminal task preserves its ID and moves it into working state. `mesh_reply` can report `working`, `input-required`, `completed`, `rejected`, or `failed`; the default is `completed`. A completed answer is also represented as a task artifact.

The standard's default `SendMessage` behavior waits for a terminal or interrupted state. The mesh sender explicitly uses `returnImmediately: true`, then relies on its durable inbox and task inspection. Terminal tasks remain terminal. Start a new task for a later consultation; an accessible existing context may be reused.

`mesh_send` commits the outgoing envelope before attempting actual A2A HTTP delivery. Retries use the same message ID and accepted principal. The receiving transaction commits its assigned task ID, full message, accepted result, inbox delivery, semantic revision, and trace together. If the HTTP response is lost, a replay returns the original acceptance rather than creating a second task.

The outbox can retry after the sender's CLI token has expired. A fresh daemon-only capability permits the exact committed envelope and recipient; it cannot authorize arbitrary operations by a retired run. A2A transmission is retried; message acceptance is deduplicated. This is not an exactly-once guarantee for arbitrary external side effects.

## Delivery, handling, and retry IDs

Keep these states separate:

| Record                    | Meaning                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Outbox accepted           | Sender intent is durable; the recipient may not have accepted it yet                                                              |
| Ingress/mailbox persisted | Recipient task and message are durable                                                                                            |
| Offered                   | This run received the full delivery in a poll response                                                                            |
| Acknowledged              | The recipient explicitly recorded a disposition                                                                                   |
| Replied                   | The task was advanced and an answer delivery was created                                                                          |
| Task terminal             | The consultation ended; its answer may still need to be handled                                                                   |
| Uptake recorded           | The receiver declared its interpretation of selected immutable message content; correctness and downstream action remain separate |

`deferred` acknowledgement leaves a delivery pending. `handled`, `rejected`, and `superseded` are final delivery dispositions. They do not implicitly reply to or cancel an A2A task. Cancellation changes consultation state; it does not terminate unrelated coding processes.

`mesh_uptake` separately records an optional assessment using the statuses
`resolved`, `narrowed`, `reframed`, `unchanged_confirmed`, `not_applicable`,
`contested`, or `unresolved`. The recipient selects an existing message value
with a JSON Pointer and supplies concise grounds. The service pins that value's
digest and authenticates the receiver; evidence and dependency references are
declared strings, not verified support. Exact `uptakeId` retries return the
original assessment. Revisions need a new ID and `supersedesId` naming the current
head for the same receiver, delivery, and selector. Uptake does not alter delivery
handling, task state, mission acceptance, or `workRevision`. See the
[full contract and examples](semantic-memory.md).

Use stable `messageId` values for retries of `mesh_send` and `mesh_reply`. The deduplication scope includes mission, sender, recipient, and message ID. Reusing an ID with different normalized content is an error. Reply state is part of the reply's idempotency input. A fresh logical question or answer needs a fresh ID.

Workspace `operationId` retries are also input-checked and include their run principal. A successor can inspect an old operation, but should use a new operation ID for new work after rereading its inputs. IDs for commands and completion proposals should be distinct to keep `mesh_operation` lookup unambiguous.

## Shared checkout publication

Claims can cover an exact repository-relative path, a subtree such as `src/adapters/**`, the entire checkout with `.`, or a named coordination resource such as `resource:database-schema`. Claims are acquired as bundles. Overlapping bundles owned by other runs are rejected atomically.

The process-facing source tree is read-only. `mesh_patch` supplies the complete new UTF-8 contents of each file, not a unified diff:

```json
{
  "operationId": "A1-adapter-create-1",
  "claimId": "A1-adapter-claim-1",
  "changes": [
    {
      "path": "src/adapter.ts",
      "expectedHash": null,
      "content": "export const protocolVersion = '1.0';\n"
    }
  ]
}
```

`expectedHash: null` requires absence. Existing files require the SHA-256 hash returned by `mesh_read`. `content: null` deletes a file. File and decision dependencies can additionally assert that inputs used for the change remain current. A stale target, stale decision, missing claim, obsolete run, or unsafe path rejects publication.

The text interface accepts at most 128 files and 8 MiB per coherent read or patch; binary data is outside this interface. Symlink paths and Git metadata are protected. A durable before/after journal precedes filesystem publication. Interrupted publication is reconciled before further writes; conflicting recovery quarantines the workspace. Multi-file publication is coherent for mesh readers using the gate. Native exploratory reads may see an intermediate state while files are being published.

`mesh_exec` takes an argument array and starts a sandboxed command. `mode: "read"` has read-only source access. `mode: "mutate"` requires a whole-checkout claim and holds the publication gate throughout the command. Network is disabled by default. Both modes receive a writable `MESH_OUTPUT_DIR`; complete stdout/stderr logs live outside that output directory. A mutating command has no automatic semantic rollback if it partially changes the source and fails.

The source manifest basis is `git-tracked-and-unignored`: tracked entries and non-ignored untracked entries, including content hash, file type, and mode. It records symlink targets without following them and records missing tracked files. Ignored build outputs, dependency directories, remote systems, and toolchain versions are not included in this source hash.

## Memory, evidence, and acceptance

Board snapshots (including `mesh_join`) return `knowledgePage` with `limit`,
`hasMore`, `nextCursor`, and a summary counting all matching findings, decisions,
offers, blockers, resolved records, and stale records. The default page holds 50
full records; `mesh_board` accepts `knowledgeLimit` from 1 to 100. Read older
records by passing `nextCursor` as `knowledgeCursor`, repeating the same `query`
if searching. A null cursor means the scan is complete. Explicit cursor or limit
requests bypass `sinceRevision` suppression. Counts are deterministic metadata,
not generated summaries of the records' content.

Knowledge is ordered by update time descending, then ID descending. Cursors
retain PostgreSQL timestamp precision, so equal timestamps do not skip records.
Pages are live, not a frozen snapshot: edits can move records and new records
can arrive ahead of the cursor. If `workRevision` changes during a scan, restart
from the first page before relying on completeness. Resolved and stale knowledge
remain available through pagination. Other board lists retain their existing
bounds.

`mesh_remember` stores versioned findings, decisions, offers, and blockers, with evidence, conditions, explicit unknowns, and readiness (`warm`, `parked`, or `unavailable`). Revisions require an expected revision. Typed links are `supports`, `challenges`, `depends-on`, `supersedes`, `affects`, and `answers`, and name a target revision. File changes and dependency revisions invalidate affected knowledge; stale decisions must be resolved before acceptance. The board is a shared record of attributed claims and evidence, not an instruction hierarchy.

Requirements quote a literal anchor from the stored original roadmap and define numbered acceptance criteria. Evidence refers to criterion indices starting at zero. File hashes and successful command operations can support that evidence. Requirement review is independent of the current revision's author. Coverage review binds the original roadmap, the source manifest, and the current requirement ledger; a later ledger revision requires current coverage evidence.

`mesh_propose_completion` pauses new source publication and run admission while it checks the acceptance state and executes final verification. Acceptance requires implemented requirements, evidence for every criterion, current independent reviews, no current objection, no unresolved blocker or stale decision, no held/quarantined claim, no open consultation, no outgoing delivery still pending, and no unhandled inbox delivery. Successful checks must leave the source manifest unchanged, and the relevant coordination state must still match the frozen snapshot. A failed proposal is recorded and, when appropriate, reopens admission.

These controls make the evidence auditable. They do not mechanically prove that an LLM's interpretation of a natural-language roadmap is complete; that remains an explicit peer-review responsibility.

## Polling and optional hook delivery

The managed invocation disables hooks and uses explicit `mesh_poll` as its baseline. Messages remain durable while a peer is busy or between generations.

`mesh mailbox-hook` is an optional adapter for qualified `PreToolUse`/`PostToolUse` integrations. It reads hook JSON on stdin and fetches bounded notices using `MESH_DAEMON_URL` and `MESH_RUN_TOKEN`. It returns machine-issued delivery/task/peer identifiers only. Peer-authored titles and bodies remain attributed data in the subsequent MCP poll. A notice neither consumes mail nor acknowledges it. The helper has a short timeout and falls back to explicit polling on failure; wiring it into a particular Codex build is separate from the supported clean invocation.
