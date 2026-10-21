# meshmem 0.1.0: integration evaluation

Date: 2026-10-21. Status: **defer enabling; candidate for an optional, self-hosted derived-memory adapter after qualification**.

## Decision

`meshmem` could supply cross-session observation storage and recall for mesh-exec. Its published installer is not a drop-in integration: managed workers explicitly disable global plugins, hooks, and built-in memory. Keep mesh-exec's PostgreSQL coordination records, claims, message lifecycle, publication gates, and completion authority authoritative. A memory integration should be a daemon-controlled projection and retrieval service, with explicit provenance and independently evaluated uptake.

Do not add `meshmem` to the default installation or enable its global hooks to make this work. First resolve the published client/server contract discrepancies described below, obtain a traceable source/build, and qualify an operator-controlled server. This evaluation does not install the package or propose sending mission data to its default hosted service.

The npm package and the [Mesh Memory Protocol paper](https://arxiv.org/html/2604.19540v1) are separate artifacts. The package identifies itself as a wrapper around a mesh-mem fork derived from claude-mem; its inspected manifests and API do not establish an implementation of SYM.BOT's CAT7/SVAF/remix protocol. Similar names are not interoperability evidence.

## Audited artifact and method

Primary distribution sources:

- [npm registry metadata](https://registry.npmjs.org/meshmem) and [version metadata](https://registry.npmjs.org/meshmem/0.1.0).
- [Published meshmem 0.1.0 tarball](https://registry.npmjs.org/meshmem/-/meshmem-0.1.0.tgz). All package paths below are relative to its `package/` directory.
- [User-supplied npm.io listing](https://npm.io/package/meshmem), used as the discovery page; implementation conclusions come from the tarball.

The registry reported only version `0.1.0`, tagged `latest`, published `2026-09-10T21:18:08.015Z`. It declared Apache-2.0, 97 files and 9,266,765 unpacked bytes. The top-level manifest has a CLI binary and no declared dependencies; the vendored plugin manifest identifies version `13.18.0` and declares **26 runtime dependencies**. Installation also adds Bun `1.4.2`. The listing's zero dependency count therefore does not describe the installed runtime.

The tarball's bytes were verified against the registry's SHA-512 integrity value before extraction:

```text
sha512-C73wuH5ESdwtKuwTYgGBGhyeaiuQE9yMwOOONzNQCkCr8KEXa4OJjKRcMXd3Y7pjJMmZgGCu+wZChH3GttjP0Q==
```

This was a static audit. No installer, package runtime, hooks, enrollment, hosted memory requests, AI generation, or live Codex integration was executed. No throughput, reliability, tenant-isolation or recall-quality result is claimed. A registry integrity match identifies the inspected bytes; it does not establish source provenance or runtime safety.

### Source and license provenance

The npm version metadata omits `repository` and `homepage`. The embedded `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` point to `https://github.com/thedotmack/mesh-mem`; the GitHub API returned 404 when checked. That establishes that the advertised source was not available through those checks, not whether it is private, renamed or deleted.

The tarball includes Apache-2.0 `LICENSE` and `NOTICE`, and the README attributes code and skills to claude-mem and a mesh-mem fork. Treat Apache-2.0 as the distribution's declared license. A source revision and dependency/attribution inventory are still needed before vendoring or redistributing it; this audit does not assert a license violation. Build/test scripts refer to unshipped `scripts/` and `test/` directories, while the README references sibling repositories. This package alone is not a reproducible source checkout.

## What is implemented

| Capability                         | Static evidence                                                                                                                                              | Consequence for mesh-exec                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native CLI integration             | Installer generates SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop hooks; registers a local plugin marketplace and MCP launcher.           | Useful for ordinary interactive sessions, but incompatible with mesh-exec's current managed launch policy.                                        |
| Persistent observations and recall | Bundled server has `/v1/memories`, `/v1/search`, `/v1/context`, `/v1/context/inject` and a read-oriented `/v1/mcp` endpoint.                                 | Possible secondary memory service. The inspected search path uses PostgreSQL full-text search; do not assume every recall route is vector search. |
| Durable server ingestion           | PostgreSQL event rows and generation-job outbox rows are inserted in one transaction; unique idempotency keys and generation status transitions are present. | A substantive ingestion foundation. It is not proof of reliable end-to-end hook capture or mesh-exec coordination semantics.                      |
| Background generation              | Server includes BullMQ/Redis lanes, job status and provider configuration.                                                                                   | Generation adds a queue service and model configuration beyond mesh-exec's current PostgreSQL-only service requirement.                           |
| Scoped access                      | Device settings require team/project identifiers and memory read/write scopes; server handlers enforce team/project lookup restrictions.                     | Promising isolation structure, still requiring negative authorization tests. Agent role and mission authority must remain separate.               |
| Deletion                           | Server exposes observation deletion and project-memory purge paths.                                                                                          | Retention and correction workflows can be investigated; deletion behavior under concurrent generation is not qualified.                           |

These capabilities persist observations. They do not implement mesh-exec's resource claims, atomic source publication, cancellation authority, independent acceptance checks, or evidence that a recipient used a particular message. The package must not become a second source of truth for those operations.

## Concrete compatibility and data-flow findings

### 1. The installer changes user-wide CLI configuration

`bin/meshmem.mjs` uses `https://mesh.journeymanit.com` as the new-device default and saves a connection under `~/.mesh-mem/settings.json`. `lib/install.mjs` installs the runtime under `~/.meshmem/client`, registers plugins for detected/selected CLIs, enables Codex hooks and disables competing mesh-mem plugin variants. It can install missing official CLIs under `~/.meshmem/tools`. The README explicitly requires separate Codex hook review/trust.

In contrast, [src/codex.ts](../src/codex.ts) constructs workers with `--ignore-user-config`, `--strict-config`, `features.plugins=false`, `features.hooks=false`, and `features.memories=false`, then supplies the mesh MCP connection explicitly. Installing meshmem globally would not activate it for those workers. Removing these boundaries simply to load a memory plugin would also alter the runner's reproducibility and credential exposure.

### 2. The remote observation hook sends tool arguments and results

The server-mode PostToolUse handler in `worker-service.cjs` builds a payload containing `tool_name`, `tool_input`, `tool_response`, `cwd`, agent information and platform source, then sends it through `recordEvent`. The inspected path passes the tool arguments/results directly. It does not call the private-tag stripping helper used in other paths before making this request.

This means repository text, commands and their outputs can enter the remote observer and its configured generation provider. The presence of logging scrubbers or a private-tag helper elsewhere is not evidence of an egress filter on this path. mesh-exec's existing credential redaction does not automatically protect a separate hook that captures the original tool payload.

A proposed adapter must apply its own payload allowlist, redaction, repository/mission scoping, size bounds and explicit destination configuration before transmission. Raw logs and complete code should not be the default projection. Remote memory responses are untrusted context: they cannot grant permissions, override instructions, or count as independent source evidence merely because another agent's summary repeats them.

### 3. Three client/server contract discrepancies are visible

| Published client path                                                                                                                                                                                                   | Bundled server expectation                                                                                            | Required qualification                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `lib/connection.mjs:42–50` verifies `/v1/context/inject` with query key `project_id`.                                                                                                                                   | `server-service.cjs:372` reads `projectId` and returns a bad request when it is missing.                              | Run installer verification against the selected server version; align the query contract.                             |
| `buildAddObservationPayload` in the worker/MCP clients emits `narrative` and `type`, plus `kind`.                                                                                                                       | `POST /v1/memories`, at server line 370, requires `content`.                                                          | Prove `observation_add` writes and reads back the exact observation and metadata.                                     |
| Event repository logic accepts `sourceEventId`, and the route's mapper attempts to read it. The public event schema at server line 66 does not declare it or `metadata`; the MCP event wrapper also omits these fields. | Repository-level deduplication prefers an explicit source-event identity, otherwise hashes session/type/time/payload. | Prove an externally supplied identity survives the public API. Do not assume repository support implies wire support. |

These are static discrepancies between components shipped in the same tarball. They are not claims that the uncontacted hosted deployment uses that server bundle or fails in the same way. No network request was sent to test them.

For the event path, preserving the original timestamp and canonical payload offers a possible fallback deduplication input. It is weaker than a documented event-ID contract: a replay that uses a new timestamp, a changed payload, or different session linkage can become a distinct event. A timeout after successful server commit is the essential retry case to test.

### 4. Server durability does not make hook delivery durable

The server-mode PostToolUse handler catches an event-request failure and, with strict mode enabled, returns continuation/success without writing to the local fallback store. The inspected client request path performs a timed fetch; no durable client retry outbox was found on this hook path. Strict mode avoids divergent local state, but an outage can leave an observation uncaptured.

The hook constructs `occurredAtEpoch` with `Date.now()` and does not carry a stable source-event ID. Re-emitting a hook later is therefore not a demonstrated exactly-once operation. Server transaction/outbox behavior helps after admission; mesh-exec still needs its own projection checkpoint, retry record and export status before treating a memory export as complete.

### 5. Self-hosting is plausible but not yet qualified

The tarball includes `server-service.cjs`; it is not merely a thin client with no server code. The bundled server requires `MESH_MEM_SERVER_DATABASE_URL` for PostgreSQL. Its provider-generation path requires the BullMQ queue engine, Redis/Valkey, and a configured model provider. The static provider selector includes Anthropic/Claude, Gemini and OpenRouter; availability and billing were not assessed.

`--server-url` permits selecting another server, but it does not provision a server, queue, project, key or identity provider. The README also says browser enrollment must be activated on the host. A maintained deployment recipe, source revision, migration process, operator credentials, provider configuration and recovery test are prerequisites. Use a separate database or deliberately isolated schema for the service, rather than assuming its generic table names can share mesh-exec's tables safely.

## Proposed integration boundary

The first experiment should use a small daemon-owned adapter against an operator-controlled server, with all global CLI hooks remaining disabled.

1. **Project deliberate knowledge.** Select explicit findings, decisions, reviewed handoffs and their references from mesh-exec. Keep raw durable messages and event history in mesh-exec. Avoid generating another memory for every poll, heartbeat or repeated MCP response.
2. **Preserve identity before exporting.** Record repository identity, mission, stable slot, run/generation, original event/message IDs, source revision, evidence references, schema version and payload digest locally. A generated summary derives from these sources; it is not an independent confirmation.
3. **Maintain a durable export ledger.** Store pending/sent/failed state, attempt count, original timestamp, stable export ID and remote result ID. Apply bounded retries and backpressure. Memory outages must not change the truth of work claims or mission completion.
4. **Expose selective recall.** Offer a bounded, explicit mesh tool or join-context supplement. Return source IDs and freshness along with content, then let the receiving peer accept, contest or defer individual claims. Retrieval itself is not acknowledgement or uptake.
5. **Keep corrections traceable.** A newer observation can supersede an older conclusion without erasing its historical role. Recalled stale data must not silently revive an invalidated decision. Changes to the source revision should make that mismatch visible.
6. **Measure incremental value.** Compare with the existing board, dependency links, handoffs and PostgreSQL search at the same task budget. An extra memory service should earn its operational and model cost by reducing lost context or repeated investigation.

A first read-only recall pilot could avoid observation-generation complexity, but only after selecting a qualified source of memories. Write integration remains blocked by the client/server contract and replay questions above. No adapter or remote service is enabled by this document.

## Qualification gates

| Gate         | Required evidence before adoption                                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distribution | Traceable source commit matching the pinned package, build instructions and dependency/attribution inventory.                                                                |
| Contract     | Direct tests for verify, manual write, search, context, event identity, metadata round-trip and job status; client/server versions pinned together.                          |
| Delivery     | Crash after remote commit, retry after timeout, queue outage and process replacement preserve one logical export and visible failure status.                                 |
| Isolation    | Wrong-project/team credentials fail; a mission cannot accidentally read another repository's memories; secrets are removed before egress.                                    |
| Correction   | A superseded conclusion is identified on recall, including after reindex/restart; original evidence remains available in mesh-exec.                                          |
| Concurrency  | Begin with 8 peers, then 32 if successful; measure event loss/duplicates, backlog, p95 latency and server/model cost. These are proposed test sizes, not performance claims. |
| Value        | Restarted peers recover useful decisions more accurately than the baseline; context tokens and repeated investigations decrease without hiding dissent.                      |
| Operations   | Restore/export/purge, server upgrade and generation-worker failure are exercised; the operator chooses the destination and retention.                                        |

## Evidence index

The following SHA-256 hashes identify critical extracted members. Line numbers refer to the original published files; bundled files have very long lines, so a search anchor is also given. This makes the audit reproducible without vendoring the package into mesh-exec.

| Member                                      | SHA-256                                                            | Relevant lines / search anchors                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                              | `34bd2a3d57725f059fecce4b00be3cf481f37142aa6b41d6410ae19a5ba96be9` | 1–15: package identity, CLI, engine, files and scripts.                                                                                                                         |
| `bin/meshmem.mjs`                           | `d679fd31b4b6c36a8d1a767d670af2eb2e8c68f2e9a2a5bfdd53211a6983be02` | 28–36, 54–75: default origin, settings and enrollment/install flow.                                                                                                             |
| `lib/install.mjs`                           | `f0057150e460f635a0e4be233b365d90d328c225e1e0f624f5b6eb9147b78ece` | 37–69: CLI bootstrap; 94–102: hooks; 104–172: runtime, marketplace and config changes.                                                                                          |
| `lib/connection.mjs`                        | `0b3f1a6dc4d14bc12ecd6eeacd0b2791c854c5539040222245a7b7c04220bc1b` | 30–50: credential requirements and `project_id` verification request.                                                                                                           |
| `lib/launcher.cjs`                          | `10b8a27062fa0b90bebf00c4ab4a830acd5a1ace5c9a5100a86285495638cac3` | 10–21: settings copied into environment; forced server/strict mode.                                                                                                             |
| `payload/plugin/package.json`               | `a6c52aab02480ef5160c86221ad64f3200d3e1ecb2c17cb6352f5d4900911058` | 1–45: vendored version and dependencies.                                                                                                                                        |
| `payload/plugin/.codex-plugin/plugin.json`  | `7f749c2d7923b571425108c4676186824754c9af78446dea70864436c5c4cb51` | 1–20: source URL, author and declared license.                                                                                                                                  |
| `payload/plugin/scripts/worker-service.cjs` | `fed718707c345e542efd7e65e494deb69c73a65faeb252a60ac9ea7054066ea8` | 57: `async function xu`; 87: `buildAddObservationPayload`, `buildEventPayload`; 137: private-tag helper `function Mo`; 231: `PostToolUse:` payload and failure handling.        |
| `payload/plugin/scripts/server-service.cjs` | `a33d23ace92feede29f14343cc4c3888a41520994b50e7d13891404560e5869e` | 66–80: `iM=e$e`, `function hZ`, deduplication SQL; 353: `async ingestOne`; 370–372: memory/context/event contracts; 9995: `function fXt`, `function MOe`, server prerequisites. |
| `payload/plugin/scripts/mcp-server.cjs`     | `7825738ec23888e9b1c3cbbd82264842429b8d5d520608784acdbaf4e1b5f269` | 214: `buildAddObservationPayload`, `observation_record_event` wrapper; 234: advertised tools and input schemas.                                                                 |

The evidence supports a controlled evaluation, not immediate adoption. The useful idea is reusable observations across agent lifetimes; mesh-exec must retain the durable event identities and explicit decisions needed to tell who accepted which claim, why, and with what effect.
