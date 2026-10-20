# Shared coordination

The board defaults to `detail: "summary"` for routine coordination. Requirements
retain their criteria, revision, author and state, with `evidenceCount` in place
of repeated evidence. Passing review reasoning is omitted; objection reasoning
remains visible. Use `mesh_board` with `detail: "full"` before reviewing evidence
or investigating review reasoning. This explicit request bypasses
`sinceRevision` suppression. Durable records and final acceptance use the full
evidence regardless of the display mode.

After acceptance or elapsed-budget exhaustion, a still-leased peer can call `mesh_board` or `mesh_yield`
to receive terminal participation state. The terminal board has `terminal: true`
and contains mission state, work revision and participation, without discovery
lists. Terminal yield is a no-op. Both remain fenced by run identity and lease;
neither reopens work or changes the accepted revision.

Every mission receives the same [runner instructions](../src/coordination.ts).
The roadmap supplies product scope and acceptance criteria. It does not need
agent assignments, a prescribed requirement ID, or a task-specific messaging
recipe.

Peers select their own contributions. One peer claims `resource:integration`
to steward the definition and final acceptance; this claim grants no additional
authority. Requirement authors and independent reviewers retain their existing
responsibilities. The steward collects evidence before requesting final reviews
and remains available through acceptance.

File claims use repository-relative paths or `subtree/**`. A `file:` prefix is
rejected with a corrective error; `resource:` is reserved for named coordination
resources. `mesh_yield` cancels the peer's outstanding commands and releases its
claims while preserving the live process's ability to reclaim paths and correct
work. Admission pauses during the drain and claim release. Supervisor
cancellation permanently revokes the run, including when it races with a yield.

Implementation participation lasts through mission acceptance or an operator
stop, even when a peer has finished its files and its inbox is empty.
`mesh_yield` returns `mayExit: false` while the mission is active or closing.
It releases claims for review; peers then use `mesh_wait` to remain reachable in
their existing authenticated process. This applies to every implementation
mission, independently of its topic, agent count, time budget, or replacement
policy. The bounded discussion profile retains its separate contribution rules.

`mesh_wait` accepts an optional `sinceRevision` and a `waitMs` of 0–300,000
(default 120,000). It returns a compact participation state and wakes for pending
mail, shared changes, timeout, or a terminal mission. Incoming messages are
returned without implicit acknowledgment. On timeout, wait again; on a shared
change, inspect the board and undertake available work. Closing acceptance keeps
`mayExit` false. Waiting revalidates run leases so fenced processes cannot remain
participants. The supervisor can stop the process at its deadline.

Board `participation.livePeerIds` includes only current, leased generations.
Arrange reviews with live independent peers before local contributors become
idle; available contributors can also inspect and review ready work proactively.
A waiting peer wakes on messages without spending another launch or losing its
context. A process that has already exited requires the runner's replacement
path; a durable message alone cannot revive that process. These protocol rules
guide agents but cannot prevent a crash or an agent ignoring the exit policy.
The acceptance barrier remains the authority for completion in either case.

After successful acceptance, the runner closes launch admission and drains the
existing processes for up to `completionGraceMs` (default 30,000 milliseconds),
capped by the original mission deadline. It keeps leases and output capture
active so peers can finish their structured handoffs and emit CLI usage receipts.
`mesh_wait` returns the terminal outcome and `mayExit: true`; `mesh_operation`
can read an existing result, and `mesh_checkpoint` can save final audit metadata.
Other tools, including operation cancellation, remain closed. Final checkpoints
do not change the accepted evidence. Expired or fenced runs cannot use this
access. A2A messaging is also closed: consultations and acknowledgments must
already be settled before acceptance. The grace period ends early when every
peer exits; operator cancellation and existing per-run timeouts still apply.

Checkpoints require a nonempty object. Omitted or malformed bodies are rejected
at the tool boundary before persistence.

Elapsed-budget exhaustion reserves the smaller of `completionGraceMs` and ten
percent of the wall-clock budget for final handoffs. The mission becomes
`resource-limit` before the hard deadline; final status and checkpoints remain
available to live leased peers, while new work stays closed. This window does
not accept partial work or extend the hard deadline. A forced kill can still
lose the CLI's final usage receipt; missing usage remains unknown.

An identical `mesh_requirement` update, with the current expected revision,
returns `unchanged: true`. It preserves the author, requirement revision, and
coordination revision. A changed criterion, source evidence, title, anchor, or
state creates a new revision and requires current reviews. Stale expected
revisions still fail. This prevents repeated publication from invalidating useful
review evidence while preserving the correction path.

`mesh_join` includes the board and inbox. `mesh_board` adds pending deliveries,
open consultations, review records, and compact operation summaries to the
existing requirements, claims, knowledge, and peer handoffs. Command summaries
include arguments, exit status, and the resulting source manifest so peers can
discover reusable verification evidence. Inspect full results with
`mesh_operation`; summaries alone do not establish test coverage.

Pass `sinceRevision` to suppress an unchanged board. Optional `waitMs`, up to
30 seconds, waits for a coordination revision change. A changed board includes
its initial revision so concurrent updates remain visible to a later refresh.
Checkpoints now advance that revision. Knowledge searches return a full filtered
snapshot regardless of `sinceRevision`. Review, operation, and consultation lists
are bounded and disclose their limits; they are discovery views, not exhaustive
acceptance proofs.

Knowledge includes a `knowledgePage` count summary across all matching records.
When `hasMore` is true, pass `nextCursor` as `mesh_board`'s `knowledgeCursor`,
keeping the same search query, to retrieve older findings and resolved decisions.
Use `knowledgeLimit` (1–100; default 50) to adjust page size. Explicit page
requests return records even with an unchanged `sinceRevision`. Pages are live;
restart from the first page if `workRevision` changes during the scan.

`mesh_ack` accepts either one `deliveryId` or up to 128 `deliveryIds` sharing a
disposition. Acknowledgments apply individually and can be safely replayed after
a partial batch failure. Acknowledging a delivery does not close its consultation:
the recipient must reply with a terminal state when the request is resolved.
Routine status belongs in claims and checkpoints, avoiding unnecessary tasks.

The completion barrier remains authoritative. It checks all records, exact
requirement revisions, independent reviews, current evidence, released claims,
closed consultations, handled mail, and controlled final verification. A peer
yielding or exiting does not complete a mission. Generic guidance reduces
coordination overhead but does not guarantee a particular model will follow it.

The [Sol comparison evidence](../artifacts/coordination-2026-10-20/REPORT.md)
records a separately authorized manual run. Automated tests remain deterministic.
Its tool-call ceiling bounds mesh activity, not provider requests or tokens.
The live run exposed the yield and path-claim problems described above; their
corrections have deterministic regression evidence, not a second live result.
