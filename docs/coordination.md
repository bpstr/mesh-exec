# Shared coordination

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
