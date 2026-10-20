# Workload boundaries and bounded command admission

Mesh-exec has separate capacity controls for agent processes, command execution,
and accepted command backlog. Peers choose their own roadmap contributions and
consultation partners. The daemon enforces resource and publication rules.

## Responsibilities in the current single-host runtime

| Boundary                    | Implementation                                             | Responsibility                                                             |
| --------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Operator and protocol entry | CLI, loopback MCP/A2A endpoints, observer routes           | Configuration, authenticated requests, status and explicit stop/resume     |
| Agent execution             | Runner and independent Codex CLI processes                 | Finite run generations, population/time budgets, handoffs, process cleanup |
| Durable coordination        | PostgreSQL store, A2A inbox/outbox, trace                  | Accepted consultations, claims, revisions, evidence, recoverable outcomes  |
| Effects and artifacts       | Workspace service, sandbox adapters, private runtime files | Guarded writes, command lifecycle, source verification, retained output    |

These responsibilities share one daemon where appropriate. They are not four
deployable services, and the supervisor does not assign roadmap work. The
coordination store remains authoritative; live notifications and SSE are views
over retained state. See [protocol](protocol.md) and [observability](observability.md).

## Three independent limits

```bash
mesh run --repo /path/to/repo --roadmap ROADMAP.md \
  --agents 8 --heavy-commands 2 --queued-commands 32 \
  --config /path/to/mesh.config.json
```

| Setting                                | Default | What it counts                                                       |
| -------------------------------------- | ------: | -------------------------------------------------------------------- |
| `--agents` / `agents`                  |      10 | Managed Codex processes; a new mission's stable peer population      |
| `--heavy-commands` / `heavyCommands`   |       2 | Command execution permits held by the workspace service              |
| `--queued-commands` / `queuedCommands` |      32 | Additional accepted nonterminal commands beyond the execution budget |

The workspace admits at most `heavyCommands + queuedCommands` nonterminal
commands. That count includes prepared operations, permit holders waiting for
the source gate, and operations still finalizing. It is deliberately
conservative: a process exit does not immediately make its accounting complete.
`queuedCommands: 0` disables the additional backlog; it does not promise that a
command will never wait briefly for source access or persistence.

The two command settings apply to each daemon invocation, including resume.
They do not resize an existing mission's peer slots. The `daemon.ready` trace
event records the effective command settings so later inspection can distinguish
invocations with different budgets. CLI flags override the corresponding JSON
settings.

## Admission, replay, and overload

Admission checks the operation's identity and arguments under the workspace
gate. A matching accepted replay returns its existing handle even when the
backlog is full. A conflicting reuse of the ID remains an error. A new accepted
operation commits its prepared journal and admission event together.

When the limit is reached, `mesh_exec` returns an MCP error with code
`command_queue_full`, `retryable: true`, and the observed admission counts. The
rejection has a trace event but creates no durable workspace operation. A peer
can inspect existing operations, do other useful work, or retry the same intent
with bounded backoff after capacity becomes available. The daemon does not
automatically resubmit rejected commands. Once an intent has been accepted,
reuse its ID to retrieve the original outcome rather than repeat its effects.

Commands waiting for an execution permit or a pre-execution source gate are
removed from that wait when canceled, yielded, or revoked. Removing a gate
waiter preserves the previous holder and the order of subsequent access.
Registered commands are terminalized during draining. An admission epoch also
fences requests that were still committing when a yield or revocation finished;
if preparation committed, the caller receives a canceled handle and no process
starts. Shutdown signals all owners before waiting for their drains. Running
commands retain the existing termination, source-accounting, and quarantine
rules. Final verification drains accepted work before taking its source barrier.

The command execution timeout still applies to execution; this change does not
introduce queue expiry or a shared end-to-end deadline. An operator stop and
generation revocation remain explicit lifecycle events. A canceled operation
does not imply that a previously running command's effects were rolled back.

## Inspect pressure and wait time

```bash
mesh trace --mission MISSION_ID --kind-prefix workspace.command. --follow
mesh trace --mission MISSION_ID --operation OPERATION_ID
mesh trace --mission MISSION_ID --kind daemon.ready
```

| Event                                 | Meaning                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `workspace.command.admitted`          | Prepared operation accepted, with execution/backlog limits and accepted count       |
| `workspace.command.rejected`          | No operation accepted; `command_queue_full` and observed pressure recorded          |
| `workspace.command.queued`            | The accepted operation had to wait for an execution permit                          |
| `workspace.command.capacity_acquired` | Permit acquired; `waitMs` measures that permit wait and `waited` records contention |
| `workspace.command.running`           | Subprocess execution recorded; distinct from admission and permit acquisition       |
| `workspace.command.cancel_requested`  | Explicit operation cancellation requested; terminal state confirms its result       |

All events retain operation/run/agent correlation. `waitMs` uses a monotonic
clock inside one process and excludes subsequent source-gate waiting. Event
counts and operation states remain inspectable after the daemon stops. An
admission event is not evidence that a command ran or that the mission passed.

## What the limit does not cover

The bound covers daemon-accepted workspace commands. It does not bound all
concurrent HTTP requests, pre-admission sandbox qualification, retained logs,
database storage, native Codex tools, or provider-level model requests. Rejected
requests may have created their private output directory during qualification;
no command is spawned for them. The existing request-size and filesystem rules
continue to apply. Per-peer fairness, storage quotas, and deadline propagation
are separate follow-up work; a global FIFO permit queue does not prove fairness.

The qualified sandbox adapters enforce read-only source access for agent
processes, guarded source mutation, and protected runtime files. The documented
Linux/macOS process-cleanup differences still apply. A component boundary or
broker hop alone is not a security guarantee.

## Design source

The [Solace workload model](https://docs.solace.com/Agent-Mesh/Framework/concepts/managing-workloads.htm)
separates interaction, agent execution, and remote-tool execution. Its
[architecture overview](https://docs.solace.com/Agent-Mesh/Framework/concepts/architecture.htm)
also separates management and persistence responsibilities. Those distinctions
motivated checking each local resource budget independently.

Its [messaging documentation](https://docs.solace.com/Agent-Mesh/Framework/concepts/event-driven-mesh.htm)
distinguishes durable queues from direct subscriptions, and its
[configuration reference](https://docs.solace.com/Agent-Mesh/Framework/reference/config-schema.htm)
distinguishes direct tool execution from enforced sandboxing. These are
documentation observations consulted on 2026-10-20, not a Solace compatibility
claim. Mesh-exec keeps its current PostgreSQL, A2A HTTP, MCP, and sandbox
implementation. No new broker or central LLM dispatcher is introduced.
