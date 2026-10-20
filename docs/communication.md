# Bounded peer discussion

Set `"workflow": "discussion"` in the JSON file passed to `--config` to run a
communication-only mission. The default remains `"implementation"`. A resumed
mission retains its stored workflow.

The discussion roadmap contains the topic. General instructions arrive through
`mesh_join`; the same instructions apply to every topic. The server gives each
peer the next stable slot as a partner, wrapping around the ordered population.
Each peer asks one question and answers one, avoiding broadcast status traffic.
At least two peers are required.

The discussion MCP profile exposes seven tools: join, ask, reply, poll,
acknowledge, checkpoint, and yield. It omits file mutation, command execution,
requirement management, and implementation acceptance. It does not change the
underlying process sandbox or grant additional authority.

The discussion `mesh_ask` tool opens a question with the assigned partner; it
accepts no recipient, task, or context IDs. Incoming requests use `mesh_reply`.
Implementation `mesh_send` retains its advanced routing fields. Permanent delivery
failures now surface as tool errors and failed trace spans.

Two communication improvements also apply to implementation missions:

- `mesh_reply` accepts the incoming `deliveryId`. The service validates that the
  delivery belongs to the replying peer and the same task, then commits the reply
  and acknowledgment together. A failed transaction leaves both unchanged.
  Replaying the identical request does not duplicate the answer. Reusing a message
  ID with different content or acknowledgment parameters is rejected.
- `mesh_poll` accepts `waitMs` from zero to 30,000. It waits for pending inbox
  deliveries, rather than waking on unrelated board revisions, and revalidates
  the run while waiting. It emits one poll result and never acknowledges mail
  implicitly.

Terminal answers still require acknowledgment. Replying to a request with
`state: "completed"` closes the consultation; acknowledgment alone does not.
New checkpoints should omit the optional ID. Reusing one is an exact replay,
not an update.

A completed discussion contribution produces a normal idle handoff. It does
not bypass or claim implementation-mission acceptance. A bounded operator
exercise can validate communication using durable tasks, handled deliveries,
checkpoints, and normal run exits.

Use this profile for finite exercises: set `--max-runs` equal to `--agents`
and provide a short elapsed limit. With no replacement generations, the supervisor
reports its exhausted run budget after the handoffs; the operator evaluates
discussion success separately. The profile does not automatically mark a mission
completed or prevent an operator from configuring additional generations.

See the [three-agent Terra evidence](../artifacts/communication-2026-10-20/REPORT.md)
for a manual exercise and measured call/usage results. Automated regressions use
prepared transports and no provider inference.
