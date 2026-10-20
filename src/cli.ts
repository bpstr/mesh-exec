#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, open, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { PgDatabase } from './db.js';
import { startDaemon } from './daemon.js';
import { runMesh } from './runner.js';
import { mailboxHookMain } from './mailbox-hook.js';
import { preflightCodex } from './codex.js';
import { assertSandboxAvailable } from './sandbox.js';
import { hash } from './store.js';
import { readEvents, redact, registerSecret, type TraceFilter } from './trace.js';
import { status, messages, metrics, logPath, exportEvents, exportMission } from './observer.js';
import { invariant } from './types.js';

const HELP = `mesh-exec — independent Codex peers in one shared checkout

Run:
  mesh doctor --repo /path/to/repo
  mesh run --repo /path/to/repo --roadmap ROADMAP.md --agents 10
  mesh run --repo /path/to/repo --resume <mission-id>
  mesh daemon --repo /path/to/repo --roadmap ROADMAP.md --agents 10

Observe (works after the runner stops):
  mesh status --mission <id>
  mesh trace --mission <id> --follow [--agent A1] [--run <id>] [--task <id>]
  mesh messages --mission <id> [--agent A1] [--task <id>] [--pending]
  mesh logs --mission <id> --run <id> [--stream stderr] [--follow]
  mesh logs --mission <id> --operation <id> [--stream stderr]
  mesh export --mission <id> --out ./mission-export
  mesh export --mission <id> --out ./events.jsonl --events-only
  mesh metrics --mission <id>

Runtime options:
  --config <json>          Optional settings file (see examples/mesh.config.json)
  --agents <n>             Maximum managed CLI processes; default 10
  --max-runs <n>           Total run budget; default 100
  --max-minutes <n>        Mission wall-clock budget; default 120
  --timeout <duration>     Wall-clock limit, e.g. 30m; replaces the default run budget
  --run-minutes <n>        Per-run time limit; default 20
  --heavy-commands <n>     Concurrent tool commands; default 2
  --model <name>           Use the specified Codex model
  --effort <level>         Set Codex reasoning effort, e.g. high
  --codex <path>           Codex executable; default codex
  --verify '<JSON argv>'   Required final check; repeatable
  --state-dir <path>      Private runtime directory outside the repository
  --port <n>               Local daemon port; default 7331 (0 chooses a free port)

Database: set MESH_DATABASE_URL to a PostgreSQL connection URL.
Authentication: uses your existing Codex CLI login; no API key setup by mesh.
All commands use one physical checkout. No worktrees or parent LLM dispatcher.
`;

type Config = Record<string, unknown>;
export function codexSettings(
  cli: { model?: string; effort?: string },
  config: Config = {},
  saved: Config = {},
): { model?: string; effort?: string } {
  const model = cli.model ?? config.model ?? saved.model;
  const effort = cli.effort ?? config.effort ?? saved.effort;
  invariant(
    model === undefined || (typeof model === 'string' && model.length > 0 && model.length <= 200),
    'INVALID_OPTION',
    'model must be a nonempty string of at most 200 characters',
  );
  invariant(
    effort === undefined || (typeof effort === 'string' && /^[a-z][a-z0-9_-]{0,49}$/u.test(effort)),
    'INVALID_OPTION',
    'effort must be a lowercase reasoning level, e.g. high',
  );
  return { model, effort };
}

function numberOption(value: unknown, fallback: number, name: string): number {
  const n = value === undefined ? fallback : Number(value);
  invariant(
    Number.isSafeInteger(n) && n > 0,
    'INVALID_OPTION',
    `${name} must be a positive integer`,
  );
  return n;
}
export function runnerBudget(input: {
  timeout?: string;
  maxRuns?: unknown;
  maxMinutes?: unknown;
}): { maxRuns: number; maxElapsedMs: number } {
  let maxElapsedMs = numberOption(input.maxMinutes, 120, 'max-minutes') * 60_000;
  if (input.timeout !== undefined) {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u.exec(input.timeout);
    invariant(match, 'INVALID_OPTION', 'timeout must be a positive duration, e.g. 30m');
    const unit = match[2] ?? 'm';
    const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!;
    maxElapsedMs = Number(match[1]) * multiplier;
  }
  invariant(
    Number.isSafeInteger(maxElapsedMs) && maxElapsedMs > 0 && maxElapsedMs <= 2_147_483_647,
    'INVALID_OPTION',
    'Runner timeout must be between 1ms and 2147483647ms',
  );
  return {
    maxElapsedMs,
    // An explicit duration should run until its deadline unless a run cap is supplied.
    maxRuns: numberOption(
      input.maxRuns,
      input.timeout === undefined ? 100 : Number.MAX_SAFE_INTEGER,
      'max-runs',
    ),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === 'mailbox-hook') {
    await mailboxHookMain();
    return;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      config: { type: 'string' },
      repo: { type: 'string' },
      roadmap: { type: 'string' },
      agents: { type: 'string' },
      resume: { type: 'string' },
      mission: { type: 'string' },
      'max-runs': { type: 'string' },
      'max-minutes': { type: 'string' },
      timeout: { type: 'string' },
      'run-minutes': { type: 'string' },
      'heavy-commands': { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      codex: { type: 'string' },
      'state-dir': { type: 'string' },
      port: { type: 'string' },
      verify: { type: 'string', multiple: true },
      follow: { type: 'boolean', short: 'f' },
      agent: { type: 'string' },
      run: { type: 'string' },
      task: { type: 'string' },
      message: { type: 'string' },
      operation: { type: 'string' },
      correlation: { type: 'string' },
      kind: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      pending: { type: 'boolean' },
      stream: { type: 'string' },
      out: { type: 'string' },
      'events-only': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const command = positionals[0] ?? 'help';
  if (values.version) {
    const { version } = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    process.stdout.write(`mesh-exec ${version}\n`);
    return;
  }
  if (values.help || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  let config: Config = {};
  if (values.config) {
    const parsed = JSON.parse(await readFile(resolve(values.config), 'utf8'));
    invariant(
      parsed && typeof parsed === 'object' && !Array.isArray(parsed),
      'INVALID_CONFIG',
      'Config must be a JSON object',
    );
    config = parsed;
  }
  const repo = resolve(values.repo ?? String(config.repo ?? '.'));
  const databaseUrl = process.env.MESH_DATABASE_URL;
  if (databaseUrl) registerSecret(databaseUrl);
  const codexBinary = values.codex ?? (config.codexBinary as string | undefined);
  if (command === 'doctor') {
    const results = await Promise.allSettled([
      preflightCodex({ codexBinary, repository: repo }),
      assertSandboxAvailable(),
      realpath(repo),
    ]);
    const checks = results.map((result, index) => ({
      check: ['codex', 'os-sandbox', 'repository'][index],
      ok: result.status === 'fulfilled',
      ...(result.status === 'fulfilled'
        ? { detail: result.value }
        : {
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          }),
    }));
    if (databaseUrl) {
      const db = new PgDatabase(databaseUrl);
      try {
        await db.query('SELECT 1');
        checks.push({ check: 'postgresql', ok: true, detail: undefined });
      } catch (error) {
        checks.push({
          check: 'postgresql',
          ok: false,
          error: String(redact((error as Error).message)),
        });
      } finally {
        await db.close();
      }
    } else checks.push({ check: 'postgresql', ok: false, error: 'Set MESH_DATABASE_URL' });
    process.stdout.write(
      JSON.stringify(
        {
          checks,
          hookDelivery:
            'Explicit mesh_poll is the default. Optional mailbox-hook requires separate local qualification.',
          managedPopulation: 'Built-in subagents disabled; wrapper limits its own Codex processes.',
        },
        null,
        2,
      ) + '\n',
    );
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
    return;
  }
  invariant(
    databaseUrl,
    'DATABASE_REQUIRED',
    'Set MESH_DATABASE_URL to your PostgreSQL connection URL',
  );
  const db = new PgDatabase(databaseUrl);
  const shutdown = new AbortController();
  const onSignal = () => shutdown.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    if (command === 'run' || command === 'daemon') {
      const launch = codexSettings(values, config);
      const budget = runnerBudget({
        timeout: values.timeout,
        maxRuns: values['max-runs'] ?? config.maxRuns,
        maxMinutes: values['max-minutes'] ?? config.maxMinutes,
      });
      if (command === 'run') {
        await assertSandboxAvailable();
        const qualification = await preflightCodex({ codexBinary, repository: repo });
        process.stderr.write(`Codex qualified: ${qualification.version}\n`);
      }
      const canonicalRepo = await realpath(repo);
      const runtimeDir = resolve(
        values['state-dir'] ??
          String(
            config.stateDir ??
              join(
                process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
                'mesh-exec',
                hash(canonicalRepo).slice(0, 16),
              ),
          ),
      );
      const agents = numberOption(values.agents ?? config.agents, 10, 'agents');
      const verification =
        values.verify?.map((v) => JSON.parse(v)) ?? (config.verification as string[][] | undefined);
      if (verification)
        invariant(
          Array.isArray(verification) &&
            verification.every(
              (c) => Array.isArray(c) && c.length && c.every((a) => typeof a === 'string'),
            ),
          'INVALID_CHECK',
          'Verification commands must be JSON argument arrays',
        );
      const port = Number(values.port ?? config.port ?? 7331);
      invariant(
        Number.isInteger(port) && port >= 0 && port <= 65535,
        'INVALID_PORT',
        'Port must be between 0 and 65535',
      );
      const daemon = await startDaemon({
        db,
        repo: canonicalRepo,
        runtimeDir,
        roadmapPath: values.roadmap ?? (config.roadmap as string | undefined),
        agents,
        resume: values.resume,
        port,
        maxCommands: numberOption(
          values['heavy-commands'] ?? config.heavyCommands,
          2,
          'heavy-commands',
        ),
        config: {
          workflow: config.workflow ?? 'implementation',
          verification: verification ?? [],
          ...launch,
          codexBinary: codexBinary ?? 'codex',
        },
      });
      process.stdout.write(
        JSON.stringify(
          {
            missionId: daemon.missionId,
            url: daemon.url,
            runtimeDir,
            statusCommand: `mesh status --mission ${daemon.missionId}`,
          },
          null,
          2,
        ) + '\n',
      );
      try {
        if (command === 'daemon') {
          await new Promise<void>((accept) => {
            if (shutdown.signal.aborted) accept();
            else shutdown.signal.addEventListener('abort', () => accept(), { once: true });
          });
          await daemon.store.stopMission(daemon.missionId, 'stopped', 'Operator stopped daemon');
        } else {
          const mission = await daemon.store.mission(daemon.missionId);
          const summary = await runMesh({
            missionId: daemon.missionId,
            repository: canonicalRepo,
            roadmapPath: mission.roadmap_path,
            mcpUrl: `${daemon.url}/mcp`,
            logRoot: join(runtimeDir, 'runs'),
            store: daemon.store,
            events: daemon.store.events,
            stopOperations: (p) => daemon.workspace.cancelRun(p.runId),
            concurrency: Number(mission.config.agents),
            ...budget,
            runTimeoutMs:
              numberOption(values['run-minutes'] ?? config.runMinutes, 20, 'run-minutes') * 60_000,
            completionGraceMs: numberOption(config.completionGraceMs, 30_000, 'completionGraceMs'),
            codexBinary,
            ...codexSettings(values, config, mission.config),
            hiddenPaths: [runtimeDir],
            signal: shutdown.signal,
          });
          process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
          if (summary.state !== 'completed') process.exitCode = 2;
        }
      } finally {
        await daemon.close();
      }
      return;
    }
    const missionId = values.mission;
    invariant(missionId, 'MISSION_REQUIRED', 'Specify --mission <id>');
    if (command === 'status') {
      process.stdout.write(JSON.stringify(redact(await status(db, missionId)), null, 2) + '\n');
      return;
    }
    if (command === 'metrics') {
      process.stdout.write(await metrics(db, missionId));
      return;
    }
    const filter: TraceFilter = {
      after: values.after ?? '0',
      limit: values.limit ? numberOption(values.limit, 200, 'limit') : 200,
      agent: values.agent,
      run: values.run,
      task: values.task,
      message: values.message,
      operation: values.operation,
      correlation: values.correlation,
      kind: values.kind,
    };
    if (command === 'trace') {
      do {
        const batch = await readEvents(db, missionId, filter);
        for (const event of batch) {
          process.stdout.write(JSON.stringify(event) + '\n');
          filter.after = event.seq;
        }
        if (!values.follow) break;
        if (batch.length < (filter.limit ?? 200))
          await delay(500, undefined, { signal: shutdown.signal }).catch(() => {});
      } while (!shutdown.signal.aborted);
      return;
    }
    if (command === 'messages') {
      process.stdout.write(
        JSON.stringify(
          await messages(db, missionId, {
            agent: values.agent,
            task: values.task,
            message: values.message,
            pending: values.pending,
            limit: filter.limit,
          }),
          null,
          2,
        ) + '\n',
      );
      return;
    }
    if (command === 'logs') {
      invariant(
        !values.stream || ['stdout', 'stderr'].includes(values.stream),
        'INVALID_STREAM',
        'Stream must be stdout or stderr',
      );
      const path = await logPath(db, missionId, {
        run: values.run,
        operation: values.operation,
        stream: values.stream as 'stdout' | 'stderr' | undefined,
      });
      const file = await open(path, 'r');
      let offset = 0;
      try {
        do {
          const buffer = Buffer.alloc(64 * 1024);
          let read;
          do {
            read = await file.read(buffer, 0, buffer.length, offset);
            if (read.bytesRead) {
              process.stdout.write(buffer.subarray(0, read.bytesRead));
              offset += read.bytesRead;
            }
          } while (read.bytesRead);
          if (!values.follow) break;
          await delay(500, undefined, { signal: shutdown.signal }).catch(() => {});
        } while (!shutdown.signal.aborted);
      } finally {
        await file.close();
      }
      return;
    }
    if (command === 'export') {
      invariant(
        values.out,
        'OUTPUT_REQUIRED',
        'Specify a new --out directory (or a new JSONL file with --events-only)',
      );
      const result = values['events-only']
        ? await exportEvents(db, missionId, resolve(values.out), filter)
        : await exportMission(db, missionId, resolve(values.out));
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }
    throw new Error(`Unknown command ${command}; run mesh --help`);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await db.close();
  }
}

const entrypoint = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => resolve(process.argv[1]))
  : undefined;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify(
        redact({
          error: error instanceof Error ? error.message : String(error),
          code: error?.code,
          details: error?.details,
        }),
      ) + '\n',
    );
    process.exitCode = 1;
  });
}
