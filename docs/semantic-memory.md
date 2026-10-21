# Receiver uptake and derived memory

`mesh_uptake` records what an authenticated peer says it made of a received
message. It is an optional implementation-workflow tool backed by the existing
PostgreSQL store. It adds no model call, embedding service, or external memory
dependency. The seven-tool discussion profile is unchanged.

This is a deliberately small implementation of receiver-owned interpretation.
It does not implement MMP wire compatibility, semantic similarity admission,
automatic evidence verification, or correction propagation through a provenance
graph.

## Why another record is useful

A delivered message, an acknowledged message, and a contribution used in a
decision are different observations. Suppose A1 sends A2 two claims: an event
must retain its original identity during a retry, and the queue never changes
event order. A2 can confirm the first against the code and contest the second
against an execution trace. A single delivery acknowledgment cannot describe
both outcomes.

The original envelope remains intact. Each uptake record selects a value within
that envelope, records the receiver's assessment, and names its declared
evidence and affected work. A receiver can also report that a contribution
confirmed its existing understanding; it need not invent a changed conclusion.

| Record                                    | What it establishes                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| Durable mailbox delivery                  | The original message is available to its recipient.                             |
| Exposure                                  | A particular run was offered the message.                                       |
| Acknowledgment                            | A recipient recorded a handling disposition.                                    |
| Uptake                                    | The recipient explicitly declared an interpretation of selected content.        |
| Requirement review and final verification | The existing acceptance process evaluated particular work and source revisions. |

Uptake does not automatically acknowledge a delivery, answer a consultation,
resolve a blocker, pass a requirement review, or complete a mission. The runtime
does not infer uptake from any of those other events. Recording uptake does not
prove the model understood the claim or that its assessment is correct.

## Tool contract

Both actions require `deliveryId`; `selector` defaults to the empty string,
which selects the whole immutable A2A message. A nonempty selector is an
[RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901) into that message.
It must resolve to an existing value. For example, `/parts/0/text` selects the
first text part. Use the actual returned envelope to choose a selector: part
positions depend on whether the sender included text, structured data, or both.

To track two claims independently, place them in distinct structured values or
message parts. A pointer selects an entire string, not a sentence within it.
When one selected value contains several claims, describe the mixed assessment
in `grounds`, or request a more structured contribution.

The service derives mission, receiver, current run, and generation from the
authenticated principal. Only the delivery's recipient can record or list its
uptake through this tool. A replacement generation of the same stable peer can
continue that history; another peer cannot impersonate it. An obsolete run
credential remains invalid.

### Record a consequential interpretation

```json
{
  "action": "record",
  "uptakeId": "A2-retry-constraint-1",
  "deliveryId": "DELIVERY_ID_FROM_INBOX",
  "selector": "/parts/0/text",
  "status": "narrowed",
  "grounds": "The identity rule applies to accepted retries; a new logical operation needs a new ID.",
  "evidenceRefs": ["artifact:retry-check@revision-8"],
  "dependencyRefs": ["work:retry-adapter@revision-2"]
}
```

The example reference strings illustrate explicit revision pins; the tool does
not parse them into verified artifacts. `uptakeId`, `status`, and nonempty
`grounds` are required for recording. Reference lists are optional and bounded.

The status vocabulary follows the existing CMCP research contract:

| Status                | Receiver's declaration                                        |
| --------------------- | ------------------------------------------------------------- |
| `resolved`            | The contribution resolved the relevant distinction.           |
| `narrowed`            | It reduced the remaining alternatives or applicability scope. |
| `reframed`            | It changed the receiver's framing of the question.            |
| `unchanged_confirmed` | It supported an existing interpretation without changing it.  |
| `not_applicable`      | It does not apply to the receiver's stated context.           |
| `contested`           | The receiver disputes its applicability or support.           |
| `unresolved`          | The relevant question remains open.                           |

These are declared assessments, not truth labels. Evidence references and
dependency references remain declarations too. They do not establish source
independence, authorization, freshness, or a passing verification result.

A successful response has `{ "uptake": RECORD, "replayed": false }`. The record
includes receiver/run provenance, the selector, a deterministic `selectedHash`,
status, grounds, references, revision, and creation time. The digest pins the
selected stored value; it is neither a source signature nor proof of factual
correctness, and is not an MMP content address.

Observation and export redaction can change the displayed message. Consequently,
the original `selectedHash` need not equal a digest recomputed from redacted
export content. Export verification checks the retained archive against its
manifest, not equality to an unavailable unredacted source selection.

### Retry or revise without rewriting history

Reuse an `uptakeId` only to retry exactly the same normalized input. An identical
retry returns the original record with `replayed: true`, including after that
record has been superseded or the receiver has moved to a replacement run. An
ID reused with different content conflicts.

The chain key is mission, receiver, delivery, and selector. The first assessment
has no `supersedesId`. A new assessment of the same selected content must name
the current record's ID in `supersedesId` and use a new `uptakeId`. Concurrent
revisions serialize; a writer based on a stale head must inspect the current
assessment before deciding whether to revise it. No earlier record is edited.

For example, after a new trace disproves the initial queue assumption, A2 can
append a `contested` assessment of the original message, referencing the new
trace and the previous uptake ID. A correction received as a different message
has its own delivery and chain. Cross-message relationships belong in declared
references; `supersedesId` does not silently move a chain to different content.

The record and `message.uptake.recorded` trace event commit together. Exact
retries do not create another uptake revision. Original delivery, exposure,
handling, and task states retain their independent meanings.
Uptake is observational: it does not advance `workRevision` or wake other peers
as a new work opportunity. Publish a material new finding or correction through
the existing shared-knowledge and messaging tools when other peers must act.

### Read the receiver's history

```json
{
  "action": "list",
  "deliveryId": "DELIVERY_ID_FROM_INBOX",
  "selector": "/parts/0/text",
  "limit": 16
}
```

The result contains `uptakes`, `total`, `currentUptakeId`, and
`nextBeforeRevision`. The default window contains at most 16 records; the
maximum is 64. Records are ordered oldest to newest within the selected window.
Pass `nextBeforeRevision` as `beforeRevision` to read an older window. The current
head and total describe the live chain and can advance between reads. Use a
mission export when a consistent database snapshot is required.

## Inspect and preserve the evidence

Operators can inspect uptake alongside delivery history with
`mesh conversation`. Nested history is bounded and reports its total and
truncation. The full ledger is included as `uptakes.json` in a mission export,
within the same repeatable-read database snapshot as messages and tasks.
`mesh verify-export` validates its recorded integrity and continues to accept
older format-version 1 bundles without this optional file.

Read-only inspection also supports an older database before the daemon creates
the new table. In that case, conversation history reports uptake as unavailable
with a warning, and exports omit `uptakes.json`. Absence is not evidence that no
peer ever used a message. Starting the current daemon initializes the schema.

```bash
mesh conversation --mission MISSION_ID --task TASK_ID
mesh trace --mission MISSION_ID --kind-prefix message.uptake.
mesh export --mission MISSION_ID --out ./mission-export
mesh verify-export ./mission-export
```

See [observability](observability.md) for snapshot and redaction boundaries.
An intact archive establishes the bytes retained, not the correctness of the
receiver's judgments.

## Relationship to MMP and meshmem

The user-supplied [MMP paper, v1](https://arxiv.org/html/2604.19540v1) motivates
receiver-side evaluation, derivation history, and retained interpretations. Its
deployment evidence is bounded and does not establish a controlled improvement
for this runner. The [current MMP conformance text](https://meshcognition.org/spec/mmp/conformance/)
specifies whole-record admission after per-category evaluation; our selected-value
uptake records are a separate local contract. This implementation neither adopts
CAT7 nor claims MMP conformance.

The npm package `meshmem` is a separate plugin installer and memory observer.
Its integration audit is in [meshmem evaluation](meshmem-evaluation.md). It is
not installed, enabled, or required by this change.

## Future derived-memory adapter

The following is a proposed integration boundary, not implemented behavior:

1. Preserve immutable local source records and the uptake ledger as the audit
   basis. A generated memory projection references those records rather than
   replacing them.
2. Use an explicitly configured daemon adapter with its own bounded queue,
   deadlines, credentials, redaction, and durable retry identity. Project only
   approved fields to an operator-selected destination.
3. Treat recalled content as candidate evidence. Check repository, mission,
   source revision, retention, supersession, and current scope before reuse.
4. Keep work ownership, leases, cancellation, command admission, and completion
   in the existing deterministic services. An unavailable memory backend must
   not prevent control operations or change their authority.

Automatic ancestry traversal, independent-source counting, source-change
invalidation of uptake, downstream correction propagation, and remote memory
search remain future work. An append-only assessment chain alone supplies none
of those guarantees.

## Qualification

Automated tests exercise ownership, generation fencing, selector validation,
exact retry, revision conflicts, transaction rollback, MCP exposure, bounded
inspection, and export compatibility. They do not measure cooperation quality.

A later matched experiment should compare the current messaging workflow with
and without explicit uptake on the same task, model, source access, and budget.
Include a mixed valid/invalid message, a repeated claim with one origin, a
restart after acknowledgment, a late correction, and changed source evidence.
Measure missed constraints, supported changes, stale reuse, correction delay,
and the additional tool/context cost. Do not count the existence of an uptake
record as proof of successful incorporation.
