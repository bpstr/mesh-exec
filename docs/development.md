# Development and qualification

The automated suite exercises the coordination service, runner lifecycle,
workspace ownership, and trace persistence with controlled agents and commands.
A recorded live pilot is still required to qualify a particular Codex version,
login, model, host, and target repository.

## Local development

Use Node.js 22.16 or later and npm. Running actual coding workers requires Linux with working bubblewrap namespaces,
or macOS with `sandbox-exec` and Python 3. On Ubuntu install `bubblewrap` and
`util-linux`; macOS uses Python's `fcntl.flock` for the same OS-held writer lock.
The macOS sandbox enforces file access for descendants, while process cleanup
requires cooperative commands that do not detach into a new process group.

From the mesh-exec checkout:

```sh
npm ci
npm run build
npm test
node dist/cli.js --help
```

Tests do not require a Codex login or invoke a paid model. Runner tests launch
temporary Node.js fixtures through injected process adapters. The real
OS sandbox test reports an explicit skip on a local host without namespace
support. Require that test to pass when qualifying an execution host:

```sh
MESH_REQUIRE_SANDBOX=1 npm test
```

### PostgreSQL for local work

The supplied Compose file runs PostgreSQL 17 with a named data volume. Its host
port binds only to `127.0.0.1`, with port `55432` chosen to avoid occupying the
usual local PostgreSQL port.

```sh
docker compose up -d --wait postgres
export MESH_DATABASE_URL='postgresql://mesh:mesh-local-development@127.0.0.1:55432/mesh'
```

These are local development credentials. `MESH_POSTGRES_PASSWORD` and
`MESH_POSTGRES_PORT` customize the initial password and published port; update
the connection URL accordingly. PostgreSQL initialization variables apply to
an empty data volume. A later environment change does not change an existing
database user's password. The PostgreSQL 17 volume is mounted at
`/var/lib/postgresql/data`, following the [official image documentation](https://hub.docker.com/_/postgres).

Stop the service while preserving its data with `docker compose stop postgres`.
Keep a dedicated test database separate from missions whose history you want to
retain. The PostgreSQL test adapter creates and drops isolated test schemas.

```sh
TEST_DATABASE_URL='postgresql://mesh:mesh-local-development@127.0.0.1:55432/mesh' npm test
```

Without `TEST_DATABASE_URL`, the shared database fixture uses PGlite. With it,
the store and daemon integration tests use the real PostgreSQL connection.
Tests that construct their own PGlite instances retain that backend. This is
not a claim that every test exercises the production connection pool.

## CI gates

The workflow in [ci.yml](../.github/workflows/ci.yml) runs on Ubuntu 22.04 with a
Node.js 22/24 matrix and a PostgreSQL 17 service. It installs bubblewrap, runs
`npm ci`, builds the package, runs the suite, and checks the built CLI's help.
`TEST_DATABASE_URL` selects PostgreSQL for the shared database fixture.
`MESH_REQUIRE_SANDBOX=1` makes missing confinement a failure instead of a skip.

CI has repository read permissions and uses no Codex authentication secrets.
The workflow uses the documented [checkout](https://github.com/actions/checkout)
and [setup-node](https://github.com/actions/setup-node) actions. A green CI run
establishes the automated checks above; it does not establish model quality,
provider capacity, or 50/100-agent throughput.

## Configure a mission

Copy [mesh.config.json](../examples/mesh.config.json) to a local configuration
file and replace both absolute paths. `stateDir` must be outside the target
repository and outside a directory made writable for the worker's Codex state.
The roadmap path is relative to the target repository. Config file paths are
resolved from the current working directory; shell-style `~` expansion is not
performed inside JSON values.

Set `verification` to argument arrays that actually validate the target
repository. These are the daemon's final verification commands. For a bounded
exercise, adapt [ROADMAP.md](../examples/ROADMAP.md) to an ordinary Git checkout
with the stated Node.js tooling. All peers in a mission use that one checkout.

Use the Codex CLI installation and login already selected by the operator.
The runner preserves Codex authentication and supplies its own isolated
configuration. It does not install a profile into the user's configuration.
Before launching workers, run:

```sh
node dist/cli.js doctor --config /absolute/path/to/mesh.local.json
```

The doctor checks the installed CLI's advertised flags, repository access,
PostgreSQL connectivity, and OS sandbox availability. It does not start a model turn
or prove that authentication and every model capability work together. Explicit
`mesh_poll` is the default mailbox integration. The separate `mailbox-hook`
adapter requires local hook configuration and trust qualification before use;
the runner does not enable inherited hooks.

## Record a 10-agent pilot

Use a roadmap small enough to inspect fully and large enough for several useful
contributions. Save the target repository's starting commit and existing dirty
state, the mesh-exec commit, the Codex version, selected model, host resources,
PostgreSQL version, and configured budgets with the pilot record.

```sh
node dist/cli.js run --config /absolute/path/to/mesh.local.json --agents 10
```

The command prints the mission ID and state directory. From a second terminal
with the same database URL, substitute that ID in these commands:

```sh
node dist/cli.js status --mission MISSION_ID
node dist/cli.js messages --mission MISSION_ID
node dist/cli.js trace --mission MISSION_ID --follow
```

Review whether agents read the original roadmap, discover peers, choose their
own opportunities, consult on dependencies, claim resources, and reach useful
checkpoints. A run ending is only a handoff. In the trace, distinguish message
acceptance, mailbox offering, and explicit handling acknowledgments; receiving
a notice does not establish that a model incorporated its contents.

The pilot should exercise a worker interruption, an idle peer waking for new
work, and a runner stop followed by an explicit resume. Inspect the recorded
process identity before interrupting a worker. Confirm that its old generation
is reaped before replacement, that stale credentials and claims fail, and that
the replacement recovers its checkpoint through the mesh. Stop the runner with
Ctrl-C and resume the same mission using the original target and runtime path:

```sh
node dist/cli.js run --config /absolute/path/to/mesh.local.json --resume MISSION_ID
```

Confirm that final acceptance pauses new admissions while verification runs,
that a failed check reopens the mission, and that a passing result corresponds
to the verified repository revision. After the pilot, save its durable record:

```sh
node dist/cli.js export --mission MISSION_ID --out /absolute/path/to/new-pilot-export
node dist/cli.js metrics --mission MISSION_ID
```

Keep the export together with the final diff, verification evidence, and an
assessment of roadmap coverage. Review failed or timed-out runs and unresolved
messages as part of that assessment. A configured run budget or elapsed limit
can stop a mission before it is complete; the CLI reports that distinct state.

## Qualify larger populations

Qualify 50 agents after a successful recorded 10-agent pilot, then qualify 100
if useful for the workload. Choose each limit and model budget deliberately;
these are separate operator runs, not CI jobs.

For each size, record peak live managed processes, resident memory and CPU,
database connection and lock pressure, command-gate wait time, message delivery
and handling delay, claim conflicts, failed restarts, model rate-limit errors,
and verified roadmap progress per unit of elapsed time. Use the same acceptance
criteria and comparable work when comparing runs. Inspect both quality and
resource use before changing the default population.

The cap applies to wrapper-managed Codex processes. Built-in subagents are
disabled, and the bootstrap contract forbids nested agent CLIs. The cooperative
runner is not an arbitrary-network client containment system. Report measured
results for the qualified host and workload; support for a numeric `--agents`
value alone is not a throughput result.
