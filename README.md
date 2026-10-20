# mesh-exec

Run independent Codex CLI peers against one roadmap and one shared Git checkout. The wrapper manages a bounded population; the agents discover work, consult each other, and decide how to contribute.

Each stable slot, such as `A1`, runs successive finite Codex processes. A new process receives a fresh credential and generation, then recovers its context from the roadmap, shared board, inbox, and handoffs. PostgreSQL holds coordination memory and durable A2A state. There is no parent LLM assigning work, no queue of roadmap fragments, and no worktree per agent.

**Status: experimental implementation.** Automated tests exercise the protocol, persistence, process lifecycle, and workspace controls. The required help/version flags were checked against the real **Codex CLI 0.163.0** binary. An authenticated live Codex population has not yet been exercised by this project, and 50/100-agent throughput has not been measured. Start with a small controlled pilot on a qualified Linux host. See [development and qualification](docs/development.md) for the validation workflow.

## How it works

```mermaid
flowchart TD
    A["Independent Codex CLI peers"] -->|MCP tools| B["Mesh daemon and runner"]
    B -->|"A2A HTTP between stable peer endpoints"| B
    B --- C["PostgreSQL memory, inbox, and trace"]
    B -->|"Claims, hashes, and publication gate"| D["One shared checkout"]
    A -.->|"Read-only source access"| D
    B --> E["Private runtime logs"]
```

The common instruction is: **implement this roadmap in this repository; consult the other peers.** Every peer can read the same roadmap and board. It announces an intention, claims the resources it chooses, asks relevant peers for context or review, and publishes evidence as it works. A conflicting claim returns its current owners so the agent can coordinate or choose another opportunity.

The wrapper starts up to the configured number of Codex processes, enforces time and run budgets, and replaces finished generations. Idle or blocked slots park until a meaningful coordination revision changes. A stopped process is not an empty mailbox: its successor inherits the stable slot's unhandled messages and existing tasks.

Long commands run behind durable operation handles. Source changes go through one guarded publication service. Completion requires recorded requirements, evidence, independent reviews, handled messages, and final checks against an unchanged source manifest. A model's final message is a handoff, not the completion authority.

## Requirements

| Component      | Requirement                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Host           | Linux with working bubblewrap namespaces and `flock`                                             |
| Runtime        | Node.js **22.16 or newer**, npm, and Git                                                         |
| Agent CLI      | An installed Codex CLI with the flags checked by `mesh doctor`                                   |
| Authentication | An existing usable Codex CLI login                                                               |
| Database       | PostgreSQL, reachable through `MESH_DATABASE_URL`                                                |
| Target         | One existing Git checkout, its roadmap, and the dependencies needed by its verification commands |

PostgreSQL is the only additional service. It stores the message board, versioned knowledge and dependency links, task and delivery state, leases, operation metadata, and trace events. PostgreSQL full-text search powers board queries; this version does not require an embedding service or separate graph database.

The enforced worker boundary requires `bwrap`, not merely an installed executable with that name. `mesh doctor` actually attempts to create the required namespace. Restricted containers or hosts may reject this. The runner stops when qualification fails; it does not fall back to unrestricted execution.

### Install the host dependencies

For a Debian/Ubuntu host with Node.js already installed:

```bash
sudo apt-get update
sudo apt-get install bubblewrap util-linux git postgresql
```

Install and sign in to Codex using the [official installation guidance](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex#quickstart-using-goals) and [authentication instructions](https://learn.chatgpt.com/docs/auth):

```bash
npm install -g @openai/codex@latest
codex login
codex login status
```

Mesh reuses that login. It does not provision an OpenAI account or request a separate API key. The managed invocation ignores user configuration and disables built-in multi-agent, app, plugin, hook, and memory features; it supplies the mesh MCP connection explicitly. `mesh doctor` checks local CLI help and version output, not a live model turn or account capacity.

### Prepare PostgreSQL

Use an existing PostgreSQL database, the repository's [local PostgreSQL Compose setup](docs/development.md), or create a dedicated local role and database:

```bash
sudo -u postgres createuser --pwprompt mesh_exec
sudo -u postgres createdb --owner=mesh_exec mesh_exec
export MESH_DATABASE_URL='postgresql://mesh_exec:YOUR_PASSWORD@127.0.0.1:5432/mesh_exec'
```

Replace the password placeholder, URL-encoding special characters as needed. The role needs permission to create and update the mesh tables in this database. The application initializes its schema on startup. Keep the connection URL in the operator's environment; the worker environment does not inherit it.

### Build the wrapper

```bash
git clone https://github.com/bpstr/mesh-exec.git
cd mesh-exec
npm ci
npm run build
npm link
```

The examples below use the `mesh` executable installed by `npm link`. You can instead invoke `node /absolute/path/to/mesh-exec/dist/cli.js` with the same arguments. Install the target repository's dependencies before starting a mission.

## Run a mission

First qualify the host and target checkout:

```bash
mesh doctor --repo /absolute/path/to/target-repository
```

Then start ten slots. The following example assumes the target is a Node repository with suitable `typecheck` and `test` scripts; replace these argument arrays with the target project's actual verification commands:

```bash
mesh run \
  --repo /absolute/path/to/target-repository \
  --roadmap ROADMAP.md \
  --agents 10 \
  --max-runs 100 \
  --max-minutes 120 \
  --run-minutes 20 \
  --heavy-commands 2 \
  --verify '["npm","run","typecheck"]' \
  --verify '["npm","test"]'
```

`--verify` is repeatable and accepts a JSON argument array. It is not shell command text. Final checks run with source mounted read-only and network disabled. Configure tools that normally write caches or build output into the source tree to use `MESH_OUTPUT_DIR`, which is a dedicated writable output directory. Source-generating work must happen before final acceptance.

The command prints the mission ID, local daemon URL, and runtime directory. Keep the mission ID for observation and resume. The roadmap text and hash are stored at mission creation, along with the initial source manifest. Existing checkout changes become part of that recorded baseline.

No predefined task decomposition is required. Peers interpret the roadmap into a requirement ledger and review its coverage. The runner does not assign roles or choose the next requirement for a peer.

### Budgets and population

| Option             | Default                                                 | Meaning                                                                         |
| ------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `--agents`         | `10`                                                    | Maximum managed Codex processes at once; creates stable slots for a new mission |
| `--max-runs`       | `100`                                                   | Total run starts permitted during this invocation, across all slots             |
| `--max-minutes`    | `120`                                                   | Wall-clock budget for this runner invocation                                    |
| `--run-minutes`    | `20`                                                    | Maximum duration of an individual Codex run                                     |
| `--heavy-commands` | `2`                                                     | Separate capacity for daemon-managed commands                                   |
| `--port`           | `7331`                                                  | Loopback HTTP port; `0` selects a free port                                     |
| `--model`          | CLI default                                             | Model name passed to Codex                                                      |
| `--codex`          | `codex`                                                 | Codex executable path                                                           |
| `--state-dir`      | Per-checkout directory under the user's state directory | Runtime state and logs, outside the checkout                                    |

For a new mission, the same interface accepts larger populations:

```bash
mesh run --repo /path/to/repo --roadmap ROADMAP.md --agents 50 --max-runs 500 --config /path/to/mesh.config.json
```

Set `--agents 100 --max-runs 1000` to configure a hundred slots and ten generations per slot on average. These are capacity settings, not measured performance guarantees. The run budget is global, so fast-finishing slots can use more generations than slow ones. PostgreSQL contention, verification capacity, machine resources, and Codex account limits can constrain useful concurrency. The heavy-command limit remains independent of the agent limit.

The optional [configuration example](examples/mesh.config.json) uses the same settings in JSON. Explicit command-line values take precedence for the corresponding invocation settings.

### Stop and resume

Press `Ctrl-C` to stop admission and terminate managed processes. Budget exhaustion, failure, and operator stop leave a non-completed mission with its durable history available.

```bash
mesh run \
  --repo /absolute/path/to/target-repository \
  --resume MISSION_ID \
  --max-runs 100 \
  --max-minutes 120
```

Resume uses the same database and physical checkout. Retain the original runtime directory, or pass the original `--state-dir`. The stored roadmap, slot capacity, and mission verification configuration remain associated with that mission; `--agents` does not resize an existing mission. A completed mission cannot be resumed. Interrupted process and publication records are reconciled before replacement workers are admitted; uncertain recovery blocks admission for inspection.

`mesh run` exits with code `0` when the mission completes, `2` when it stops without completion, and `1` for a command/setup error. The run and time budgets apply anew to a resumed invocation; they do not erase prior runs from the mission history.

`mesh daemon` starts the coordination service without a Codex population. It is useful for adapter development and controlled integration work. `mesh run` is the normal complete workflow.

## Observe what the agents do

Observation commands query PostgreSQL directly, so they remain usable after the runner stops. File logs additionally require the original runtime artifacts to remain available.

```bash
mesh status --mission MISSION_ID
mesh trace --mission MISSION_ID --follow
mesh messages --mission MISSION_ID --agent A1 --pending
mesh logs --mission MISSION_ID --run RUN_ID --stream stderr
mesh export --mission MISSION_ID --out ./mission-export
mesh metrics --mission MISSION_ID
```

Full internal A2A text and structured message parts are retained, with receipt, exposure, acknowledgement, reply, and task state recorded separately. Complete stdout/stderr streams are captured in private runtime files outside worker-writable output directories. Known credentials are redacted. The trace records the outputs the CLI exposes; it does not promise access to hidden model reasoning.

See [observability](docs/observability.md) for filters, correlation IDs, exports, metric names, and the difference between delivery and handling.

## Working contract and current boundaries

The [protocol reference](docs/protocol.md) describes every MCP tool, the A2A transport, file publication, and acceptance rules.

The supported baseline uses explicit `mesh_poll` calls at bootstrap, work transitions, before dependent changes, and before exit. A `mesh mailbox-hook` helper is shipped, but hooks are disabled in managed Codex invocations. Enabling a hook adapter requires separate local qualification; it is not required for message delivery.

The source manifest includes Git-tracked paths and untracked paths that are not ignored, with content hashes, types, and modes. Ignored dependencies, ignored generated outputs, external services, and arbitrary host state are outside that source basis. `mesh_patch` publishes complete UTF-8 file replacements or deletions; it is not a binary-file editing API. All agent writes use the guarded workspace service, and only one daemon owns the checkout. An unrelated host process writing into the checkout is outside this coordination contract.

The automated suite uses PGlite for PostgreSQL-compatible datastore fixtures, actual local A2A HTTP with the official SDK, real MCP clients, and controlled worker-process substitutes. The local environment denied bubblewrap namespace creation, so the namespace-dependent check was explicitly skipped; production execution still fails closed on that host. The checked-in CI workflow provides a separate Linux/PostgreSQL qualification path, but a passing CI result has not yet been established. Live Codex authentication, the installed CLI's runtime isolation behavior, optional hooks, and sustained 10/50/100-agent operation still need qualification on the deployment host.
