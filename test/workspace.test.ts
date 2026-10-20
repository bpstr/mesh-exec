import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { TestDatabase } from './helpers.js';
import {
  Workspace,
  WORKSPACE_SCHEMA,
  contentHash,
  type WorkspaceOperation,
  type WorkspaceOptions,
} from '../src/workspace.js';
import {
  assertSandboxAvailable,
  buildSandboxInvocation,
  type SandboxOptions,
  type SandboxInvocation,
} from '../src/sandbox.js';
import type { Principal, TraceInput } from '../src/types.js';

const exec = promisify(execFile);
const principal: Principal = { missionId: 'mission', agentId: 'A1', runId: 'run-1', generation: 1 };
const pause = (milliseconds: number) =>
  new Promise<void>((accept) => setTimeout(accept, milliseconds));

/** Deliberately unenclosed test process: only tests supervision, never confinement. */
async function nativeTestCommand(options: SandboxOptions): Promise<SandboxInvocation> {
  return {
    command: options.argv[0],
    args: options.argv.slice(1),
    cwd: options.cwd ?? options.repo,
    env: { PATH: process.env.PATH, ...options.env },
    detached: true,
  };
}

async function fixture(extra: Partial<WorkspaceOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-workspace-test-'));
  const repo = join(directory, 'repo');
  const runtimeDir = join(directory, 'runtime');
  const lockDirectory = join(directory, 'locks');
  await mkdir(repo);
  await exec('git', ['init', '-q', repo]);
  const db = new TestDatabase();
  await db.query(WORKSPACE_SCHEMA);
  const events: TraceInput[] = [];
  const options: WorkspaceOptions = {
    repo,
    runtimeDir,
    lockDirectory,
    db,
    events: async (event) => {
      events.push(event);
      return {
        ...event,
        id: String(events.length),
        seq: String(events.length),
        at: new Date().toISOString(),
      };
    },
    authorize: async () => undefined,
    commandBuilder: nativeTestCommand,
    ...extra,
  };
  const workspace = await Workspace.open(options);
  return {
    directory,
    repo,
    runtimeDir,
    db,
    events,
    options,
    workspace,
    cleanup: async () => {
      await workspace.close();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function terminal(workspace: Workspace, operationId: string): Promise<WorkspaceOperation> {
  const deadline = Date.now() + 8192;
  while (Date.now() < deadline) {
    const operation = await workspace.operation(principal, operationId);
    if (!['prepared', 'running'].includes(operation.state)) return operation;
    await pause(8);
  }
  throw new Error(`Operation ${operationId} did not finish`);
}

test('competing writes, stale dependencies, idempotency, and symlink escapes are rejected without losing content', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'code.ts'), 'before');
    await writeFile(join(f.repo, 'contract.ts'), 'v1');
    const original = contentHash('before');
    const requests = [
      {
        operationId: 'write-1',
        changes: [{ path: 'code.ts', expectedHash: original, content: 'first' }],
      },
      {
        operationId: 'write-2',
        changes: [{ path: 'code.ts', expectedHash: original, content: 'second' }],
      },
    ];
    const results = await Promise.allSettled(
      requests.map((input) => f.workspace.patch(principal, input)),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const winner = results[0].status === 'fulfilled' ? 0 : 1;
    const winningText = requests[winner].changes[0].content;
    assert.equal(await readFile(join(f.repo, 'code.ts'), 'utf8'), winningText);
    const retry = await f.workspace.patch(principal, requests[winner]);
    assert.equal(retry.state, 'applied');
    await assert.rejects(
      f.workspace.patch(principal, {
        ...requests[winner],
        changes: [{ path: 'other.ts', expectedHash: null, content: 'changed arguments' }],
      }),
      (error: any) => error.code === 'operation_id_conflict',
    );
    await writeFile(join(f.repo, 'contract.ts'), 'v2');
    await assert.rejects(
      f.workspace.patch(principal, {
        operationId: 'stale-contract',
        changes: [
          { path: 'code.ts', expectedHash: contentHash(winningText), content: 'must not publish' },
        ],
        dependencies: { files: { 'contract.ts': contentHash('v1') } },
      }),
      (error: any) => error.code === 'stale_dependency',
    );
    assert.equal(await readFile(join(f.repo, 'code.ts'), 'utf8'), winningText);
    await writeFile(join(f.directory, 'outside.txt'), 'outside');
    await symlink(f.directory, join(f.repo, 'escape'));
    await assert.rejects(
      f.workspace.read(principal, ['escape/outside.txt']),
      (error: any) => error.code === 'symlink_path',
    );
    await assert.rejects(
      f.workspace.patch(principal, {
        operationId: 'escape',
        changes: [
          { path: 'escape/outside.txt', expectedHash: contentHash('outside'), content: 'bad' },
        ],
      }),
      (error: any) => error.code === 'symlink_path',
    );
    assert.equal(await readFile(join(f.directory, 'outside.txt'), 'utf8'), 'outside');
    await assert.rejects(
      f.workspace.canonicalPath('../outside.txt'),
      (error: any) => error.code === 'invalid_path',
    );
  } finally {
    await f.cleanup();
  }
});

test('the operating-system flock excludes another daemon, and releasing it permits restart', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      Workspace.open(f.options),
      (error: any) => error.code === 'workspace_owned',
    );
    await f.workspace.close();
    const replacement = await Workspace.open(f.options);
    await replacement.close();
  } finally {
    await f.cleanup();
  }
});

test('a failed prepared-record transaction never publishes a file', async () => {
  const f = await fixture({
    events: async (event) => {
      if (event.kind === 'workspace.patch.prepared')
        throw new Error('simulated durable trace failure');
      return { ...event, id: 'event', seq: '1', at: new Date().toISOString() };
    },
  });
  try {
    await writeFile(join(f.repo, 'code.ts'), 'before');
    await assert.rejects(
      f.workspace.patch(principal, {
        operationId: 'not-prepared',
        changes: [{ path: 'code.ts', expectedHash: contentHash('before'), content: 'after' }],
      }),
    );
    assert.equal(await readFile(join(f.repo, 'code.ts'), 'utf8'), 'before');
    const records = await f.db.query('SELECT * FROM workspace_operations');
    assert.equal(records.rowCount, 0);
  } finally {
    await f.cleanup();
  }
});

test('restart reconciles a partial journal and refuses an unexpected external edit', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'a.ts'), 'new-a');
    await writeFile(join(f.repo, 'b.ts'), 'old-b');
    const images = ['a', 'b'].map((name, index) => ({
      path: `${name}.ts`,
      beforeHash: contentHash(`old-${name}`),
      afterHash: contentHash(`new-${name}`),
      contentBase64: Buffer.from(`new-${name}`).toString('base64'),
      mode: 0o644,
      temporaryPath: `.${name}.recovery-${index}.tmp`,
    }));
    await f.db.query(
      `INSERT INTO workspace_operations
      (mission_id,operation_id,repo_id,agent_id,run_id,generation,kind,request_hash,state,request,journal)
      VALUES($1,$2,$3,$4,$5,$6,'patch','request','prepared','{}',$7::jsonb)`,
      [
        principal.missionId,
        'partial',
        f.workspace.repoId,
        principal.agentId,
        principal.runId,
        principal.generation,
        JSON.stringify({ changes: images }),
      ],
    );
    await f.workspace.close();
    const replacement = await Workspace.open(f.options);
    assert.equal(await readFile(join(f.repo, 'b.ts'), 'utf8'), 'new-b');
    assert.equal((await replacement.operation(principal, 'partial')).state, 'applied');
    await replacement.close();
    await writeFile(join(f.repo, 'b.ts'), 'user edit');
    await f.db.query(
      "UPDATE workspace_operations SET state='prepared' WHERE operation_id='partial'",
    );
    await assert.rejects(
      Workspace.open(f.options),
      (error: any) => error.code === 'recovery_conflict',
    );
    assert.equal(await readFile(join(f.repo, 'b.ts'), 'utf8'), 'user edit');
  } finally {
    await f.cleanup();
  }
});

test('command retries run once and full output survives bounded, redacted previews', async () => {
  const f = await fixture();
  try {
    const secret = 'secret-value-split-across-chunks';
    const script = `const fs=require('node:fs');fs.appendFileSync(process.env.MESH_OUTPUT_DIR+'/effect','x');process.stdout.write('q'.repeat(131072));process.stdout.write(process.env.API_KEY.slice(0,8));setTimeout(()=>{process.stdout.write(process.env.API_KEY.slice(8));process.stderr.write('done')},32)`;
    const input = {
      operationId: 'output',
      mode: 'read' as const,
      argv: [process.execPath, '-e', script],
      env: { API_KEY: secret },
    };
    await Promise.all([f.workspace.exec(principal, input), f.workspace.exec(principal, input)]);
    const operation = await terminal(f.workspace, input.operationId);
    assert.equal(operation.state, 'succeeded');
    const result = operation.result as any;
    const output = await readFile(result.stdout.path, 'utf8');
    assert.equal(output.length, 131072 + '[REDACTED]'.length);
    assert.equal(output, 'q'.repeat(131072) + '[REDACTED]');
    assert.ok(result.stdout.tail.length <= 16384);
    assert.equal(await readFile(join(result.stdout.path, '..', 'outputs', 'effect'), 'utf8'), 'x');
    assert.equal(await readFile(result.stderr.path, 'utf8'), 'done');
    assert.ok(!JSON.stringify(f.events).includes(secret));
    await f.workspace.exec(principal, input);
    assert.equal(await readFile(join(result.stdout.path, '..', 'outputs', 'effect'), 'utf8'), 'x');
    assert.ok(f.events.some((event) => event.kind === 'workspace.command.output'));
  } finally {
    await f.cleanup();
  }
});

test('source mutators block coherent reads and final verification retains the gate through acceptance', async () => {
  const f = await fixture({ maxCommands: 1 });
  try {
    await writeFile(join(f.repo, 'code.ts'), 'before');
    await f.workspace.exec(principal, {
      operationId: 'mutator',
      mode: 'mutate',
      argv: [
        process.execPath,
        '-e',
        `const fs=require('node:fs');fs.writeFileSync('code.ts','half');setTimeout(()=>fs.writeFileSync('code.ts','after'),128)`,
      ],
    });
    for (
      let index = 0;
      index < 128 && (await readFile(join(f.repo, 'code.ts'), 'utf8')) !== 'half';
      index++
    )
      await pause(8);
    const read = f.workspace.read(principal, ['code.ts']);
    const early = await Promise.race([
      read.then(() => 'resolved'),
      pause(32).then(() => 'waiting'),
    ]);
    assert.equal(early, 'waiting');
    assert.equal((await read).files[0].content, 'after');
    assert.equal((await terminal(f.workspace, 'mutator')).state, 'succeeded');
    let accepted = false;
    await f.workspace.withBarrier(async (barrier) => {
      const before = await barrier.manifest();
      const verification = await barrier.verify(
        [
          process.execPath,
          '-e',
          `if(require('node:fs').readFileSync('code.ts','utf8')!=='after')process.exit(1)`,
        ],
        { principal, operationId: 'final-check' },
      );
      assert.equal(verification.exitCode, 0);
      assert.equal((await barrier.manifest()).hash, before.hash);
      await assert.rejects(
        f.workspace.patch(principal, {
          operationId: 'late-write',
          changes: [{ path: 'code.ts', expectedHash: contentHash('after'), content: 'late' }],
        }),
        (error: any) => error.code === 'workspace_barrier',
      );
      accepted = true; // The real caller commits mission completion here.
    });
    assert.ok(accepted);
    assert.equal(await readFile(join(f.repo, 'code.ts'), 'utf8'), 'after');
  } finally {
    await f.cleanup();
  }
});

test('cancellation terminates the managed process group and revoked runs cannot publish', async () => {
  const f = await fixture();
  try {
    await f.workspace.exec(principal, {
      operationId: 'long-running',
      mode: 'read',
      argv: [
        process.execPath,
        '-e',
        `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1024)'],{stdio:'inherit'});setInterval(()=>{},1024)`,
      ],
    });
    for (
      let index = 0;
      index < 128 && (await f.workspace.operation(principal, 'long-running')).state !== 'running';
      index++
    )
      await pause(8);
    await f.workspace.cancelRun(principal.runId);
    assert.equal((await f.workspace.operation(principal, 'long-running')).state, 'cancelled');
    await assert.rejects(
      f.workspace.patch(principal, {
        operationId: 'stale-run',
        changes: [{ path: 'new.ts', expectedHash: null, content: 'no' }],
      }),
      (error: any) => error.code === 'run_revoked',
    );
  } finally {
    await f.cleanup();
  }
});

test('command admission bounds accepted work, preserves replays, and reuses cancelled queue capacity', async () => {
  const f = await fixture({ maxCommands: 1, maxQueuedCommands: 1 });
  try {
    const active = {
      operationId: 'capacity-active',
      mode: 'read' as const,
      argv: [process.execPath, '-e', 'setInterval(()=>{},1024)'],
    };
    await f.workspace.exec(principal, active);
    const queued = {
      operationId: 'capacity-queued',
      mode: 'read' as const,
      argv: [process.execPath, '-e', 'process.exit(0)'],
    };
    const duplicates = await Promise.all([
      f.workspace.exec(principal, queued),
      f.workspace.exec(principal, queued),
    ]);
    assert.ok(duplicates.every((operation) => operation.operation_id === queued.operationId));
    const rejected = { ...queued, operationId: 'capacity-overload' };
    await assert.rejects(
      f.workspace.exec(principal, rejected),
      (error: any) =>
        error.code === 'command_queue_full' &&
        error.details.acceptedCommands === 2 &&
        error.details.admissionLimit === 2 &&
        error.details.retryable === true,
    );
    assert.equal(
      (
        await f.db.query('SELECT operation_id FROM workspace_operations WHERE operation_id=$1', [
          rejected.operationId,
        ])
      ).rows.length,
      0,
    );
    assert.equal((await f.workspace.exec(principal, active)).operation_id, active.operationId);
    await assert.rejects(
      f.workspace.exec(principal, { ...queued, argv: [process.execPath, '-e', 'process.exit(1)'] }),
      (error: any) => error.code === 'operation_id_conflict',
    );
    assert.equal((await f.workspace.cancel(principal, queued.operationId)).state, 'cancelled');
    assert.equal((await f.workspace.exec(principal, queued)).state, 'cancelled');
    assert.equal((await f.workspace.exec(principal, rejected)).state, 'prepared');
    assert.equal(
      f.events.filter(
        (event) =>
          event.kind === 'workspace.command.admitted' && event.operationId === queued.operationId,
      ).length,
      1,
    );
    assert.ok(
      f.events.some(
        (event) =>
          event.kind === 'workspace.command.rejected' && event.operationId === rejected.operationId,
      ),
    );
    assert.ok(
      f.events.some(
        (event) =>
          event.kind === 'workspace.command.queued' && event.operationId === queued.operationId,
      ),
    );
    assert.ok(
      !f.events.some(
        (event) =>
          event.kind === 'workspace.command.running' && event.operationId === queued.operationId,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test('yield and run cancellation remove capacity waiters without waiting for another peer', async () => {
  const f = await fixture({ maxCommands: 1, maxQueuedCommands: 1 });
  const peer = { ...principal, agentId: 'A2', runId: 'run-2' };
  try {
    await f.workspace.exec(peer, {
      operationId: 'other-peer-active',
      mode: 'read',
      argv: [process.execPath, '-e', 'setInterval(()=>{},1024)'],
    });
    const queued = {
      operationId: 'queued-yield',
      mode: 'read' as const,
      argv: [process.execPath, '-e', 'process.exit(0)'],
    };
    await f.workspace.exec(principal, queued);
    await f.workspace.yieldRun(principal.runId, async () => {
      assert.equal((await f.workspace.operation(principal, queued.operationId)).state, 'cancelled');
    });
    assert.ok(
      ['prepared', 'running'].includes(
        (await f.workspace.operation(peer, 'other-peer-active')).state,
      ),
    );
    await f.workspace.exec(principal, { ...queued, operationId: 'queued-revoke' });
    await f.workspace.cancelRun(principal.runId);
    assert.equal((await f.workspace.operation(principal, 'queued-revoke')).state, 'cancelled');
    assert.ok(
      !f.events.some(
        (event) =>
          event.kind === 'workspace.command.running' && event.agentId === principal.agentId,
      ),
    );
    await f.workspace.cancel(peer, 'other-peer-active');
    const next = { ...queued, operationId: 'capacity-after-cancel' };
    await f.workspace.exec(peer, next);
    assert.equal((await terminal(f.workspace, next.operationId)).state, 'succeeded');
    const acquired = f.events.find(
      (event) =>
        event.kind === 'workspace.command.capacity_acquired' &&
        event.operationId === next.operationId,
    );
    assert.ok(acquired);
    assert.ok((acquired.data as { waitMs: number }).waitMs >= 0);
  } finally {
    await f.cleanup();
  }
});

test('zero queued capacity rejects additional work and permits final verification after drain', async () => {
  const f = await fixture({ maxCommands: 1, maxQueuedCommands: 0 });
  try {
    await f.workspace.exec(principal, {
      operationId: 'no-backlog-active',
      mode: 'read',
      argv: [process.execPath, '-e', 'setInterval(()=>{},1024)'],
    });
    await assert.rejects(
      f.workspace.exec(principal, {
        operationId: 'no-backlog-extra',
        mode: 'read',
        argv: [process.execPath, '-e', 'process.exit(0)'],
      }),
      (error: any) => error.code === 'command_queue_full',
    );
    await f.workspace.cancel(principal, 'no-backlog-active');
    await f.workspace.withBarrier(async (barrier) => {
      assert.equal(
        (await barrier.verify([process.execPath, '-e', 'process.exit(0)'], { principal })).exitCode,
        0,
      );
    });
  } finally {
    await f.cleanup();
  }
});

test('closing cancels every owner before draining commands waiting on another owners source gate', async () => {
  let releaseFirst!: () => void;
  const firstPaused = new Promise<void>((accept) => {
    releaseFirst = accept;
  });
  let firstAcquired!: () => void;
  const acquired = new Promise<void>((accept) => {
    firstAcquired = accept;
  });
  const peer = { ...principal, agentId: 'A2', runId: 'run-2' };
  const f = await fixture({
    maxCommands: 2,
    maxQueuedCommands: 0,
    events: async (event) => {
      if (
        event.kind === 'workspace.command.capacity_acquired' &&
        event.operationId === 'waiting-owner'
      ) {
        firstAcquired();
        await firstPaused;
      }
      return { ...event, id: '1', seq: '1', at: new Date().toISOString() };
    },
  });
  try {
    await f.workspace.exec(principal, {
      operationId: 'waiting-owner',
      mode: 'mutate',
      argv: [process.execPath, '-e', 'process.exit(0)'],
    });
    await acquired;
    await f.workspace.exec(peer, {
      operationId: 'gate-owner',
      mode: 'mutate',
      argv: [process.execPath, '-e', 'setInterval(()=>{},1024)'],
    });
    for (
      let index = 0;
      index < 128 && (await f.workspace.operation(peer, 'gate-owner')).state !== 'running';
      index++
    )
      await pause(8);
    assert.equal((await f.workspace.operation(peer, 'gate-owner')).state, 'running');
    releaseFirst();
    await pause(8);
    const outcome = await Promise.race([
      f.workspace.close().then(() => 'closed'),
      pause(2048).then(() => 'blocked'),
    ]);
    assert.equal(outcome, 'closed');
    const operations = await f.db.query<{ state: string }>(
      'SELECT state FROM workspace_operations',
    );
    assert.deepEqual(
      operations.rows.map((operation) => operation.state),
      ['cancelled', 'cancelled'],
    );
  } finally {
    releaseFirst();
    await f.workspace.cancelRun(peer.runId);
    await f.cleanup();
  }
});

test('cancelling a command waiting for the source gate preserves its predecessors gate', async () => {
  let releaseFirst!: () => void;
  const firstPaused = new Promise<void>((accept) => {
    releaseFirst = accept;
  });
  let firstAcquired!: () => void;
  const acquired = new Promise<void>((accept) => {
    firstAcquired = accept;
  });
  const peer = { ...principal, agentId: 'A2', runId: 'run-2' };
  const f = await fixture({
    maxCommands: 2,
    maxQueuedCommands: 0,
    events: async (event) => {
      if (
        event.kind === 'workspace.command.capacity_acquired' &&
        event.operationId === 'cancel-gate-wait'
      ) {
        firstAcquired();
        await firstPaused;
      }
      return { ...event, id: '1', seq: '1', at: new Date().toISOString() };
    },
  });
  try {
    await f.workspace.exec(principal, {
      operationId: 'cancel-gate-wait',
      mode: 'mutate',
      argv: [process.execPath, '-e', "require('node:fs').writeFileSync('should-not-exist','bad')"],
    });
    await acquired;
    await f.workspace.exec(peer, {
      operationId: 'keep-gate-owner',
      mode: 'mutate',
      argv: [process.execPath, '-e', 'setInterval(()=>{},1024)'],
    });
    for (
      let index = 0;
      index < 128 && (await f.workspace.operation(peer, 'keep-gate-owner')).state !== 'running';
      index++
    )
      await pause(8);
    assert.equal((await f.workspace.operation(peer, 'keep-gate-owner')).state, 'running');
    releaseFirst();
    await pause(8);
    const outcome = await Promise.race([
      f.workspace.cancel(principal, 'cancel-gate-wait').then((operation) => operation.state),
      pause(2048).then(() => 'blocked'),
    ]);
    assert.equal(outcome, 'cancelled');
    assert.equal((await f.workspace.operation(peer, 'keep-gate-owner')).state, 'running');
    let readFinished = false;
    const read = f.workspace.read(principal, ['should-not-exist']).then((result) => {
      readFinished = true;
      return result;
    });
    await pause(16);
    assert.equal(readFinished, false);
    await f.workspace.cancel(peer, 'keep-gate-owner');
    assert.equal((await read).files[0].content, null);
  } finally {
    releaseFirst();
    await f.workspace.cancelRun(peer.runId);
    await f.cleanup();
  }
});

test('an admission event failure rolls back the operation and retains capacity', async () => {
  let failAdmission = true;
  const f = await fixture({
    maxCommands: 1,
    maxQueuedCommands: 0,
    events: async (event) => {
      if (event.kind === 'workspace.command.admitted' && failAdmission) {
        failAdmission = false;
        throw new Error('Intentional admission event failure');
      }
      return { ...event, id: '1', seq: '1', at: new Date().toISOString() };
    },
  });
  try {
    const input = {
      operationId: 'retry-admission',
      mode: 'read' as const,
      argv: [process.execPath, '-e', 'process.exit(0)'],
    };
    await assert.rejects(
      f.workspace.exec(principal, input),
      /Intentional admission event failure/u,
    );
    assert.equal(
      (await f.db.query('SELECT operation_id FROM workspace_operations')).rows.length,
      0,
    );
    await f.workspace.exec(principal, input);
    assert.equal((await terminal(f.workspace, input.operationId)).state, 'succeeded');
  } finally {
    await f.cleanup();
  }
});

test('yield and revocation fence command admission already committing before registration', async () => {
  const pauses = new Map<string, { entered: () => void; resume: Promise<void> }>();
  const emitted: TraceInput[] = [];
  const f = await fixture({
    maxCommands: 1,
    maxQueuedCommands: 0,
    events: async (event) => {
      emitted.push(event);
      const paused = pauses.get(event.operationId ?? '');
      if (event.kind === 'workspace.command.admitted' && paused) {
        paused.entered();
        await paused.resume;
      }
      return { ...event, id: '1', seq: '1', at: new Date().toISOString() };
    },
  });
  try {
    for (const action of ['yield', 'revoke'] as const) {
      const owner = { ...principal, runId: `admission-${action}` };
      const operationId = `committing-${action}`;
      let unblock!: () => void;
      let entered!: () => void;
      const entering = new Promise<void>((accept) => {
        entered = accept;
      });
      const resume = new Promise<void>((accept) => {
        unblock = accept;
      });
      pauses.set(operationId, { entered, resume });
      const input = {
        operationId,
        mode: 'read' as const,
        argv: [process.execPath, '-e', 'process.exit(0)'],
      };
      const admission = f.workspace.exec(owner, input);
      try {
        await entering;
        if (action === 'yield') await f.workspace.yieldRun(owner.runId, async () => undefined);
        else await f.workspace.cancelRun(owner.runId);
      } finally {
        unblock();
      }
      assert.equal((await admission).state, 'cancelled');
      assert.ok(
        !emitted.some(
          (event) =>
            event.kind === 'workspace.command.running' && event.operationId === operationId,
        ),
      );
      const later = { ...input, operationId: `after-${action}` };
      if (action === 'yield') {
        await f.workspace.exec(owner, later);
        assert.equal((await terminal(f.workspace, later.operationId)).state, 'succeeded');
      } else {
        await assert.rejects(
          f.workspace.exec(owner, later),
          (error: any) => error.code === 'run_revoked',
        );
      }
    }
  } finally {
    await f.cleanup();
  }
});

test('yield drains commands, resumes admission, and cannot undo concurrent supervisor revocation', async () => {
  const f = await fixture();
  try {
    await f.workspace.exec(principal, {
      operationId: 'yield-command',
      mode: 'read',
      argv: [process.execPath, '-e', 'setInterval(()=>{},1024)'],
    });
    for (
      let index = 0;
      index < 128 && (await f.workspace.operation(principal, 'yield-command')).state !== 'running';
      index++
    )
      await pause(8);
    await f.workspace.yieldRun(principal.runId, async () => {
      assert.equal((await f.workspace.operation(principal, 'yield-command')).state, 'cancelled');
      await assert.rejects(
        f.workspace.patch(principal, {
          operationId: 'during-yield',
          changes: [{ path: 'new.ts', expectedHash: null, content: 'blocked' }],
        }),
        (error: any) => error.code === 'run_revoked',
      );
    });
    const resumed = await f.workspace.patch(principal, {
      operationId: 'after-yield',
      changes: [{ path: 'new.ts', expectedHash: null, content: 'resumed' }],
    });
    assert.equal(resumed.state, 'applied');
    await f.workspace.yieldRun(principal.runId, async () => {
      await f.workspace.cancelRun(principal.runId);
    });
    await assert.rejects(
      f.workspace.patch(principal, {
        operationId: 'after-permanent-revocation',
        changes: [{ path: 'other.ts', expectedHash: null, content: 'blocked' }],
      }),
      (error: any) => error.code === 'run_revoked',
    );
  } finally {
    await f.cleanup();
  }
});

test('a final barrier drains full command capacity without deadlocking queued source mutations', async () => {
  const f = await fixture({ maxCommands: 2 });
  try {
    await Promise.all(
      ['reader-1', 'reader-2'].map((operationId) =>
        f.workspace.exec(principal, {
          operationId,
          mode: 'read',
          argv: [process.execPath, '-e', 'setTimeout(()=>{},64)'],
        }),
      ),
    );
    await f.workspace.exec(principal, {
      operationId: 'queued-writer',
      mode: 'mutate',
      argv: [process.execPath, '-e', `require('node:fs').writeFileSync('result.ts','ready')`],
    });
    await f.workspace.withBarrier(async (barrier) => {
      assert.equal(
        (await barrier.verify([process.execPath, '-e', 'process.exit(0)'], { principal })).exitCode,
        0,
      );
      assert.ok((await barrier.manifest()).files.some((file) => file.path === 'result.ts'));
    });
    assert.equal((await f.workspace.operation(principal, 'queued-writer')).state, 'succeeded');
  } finally {
    await f.cleanup();
  }
});

test('an admission delayed by sandbox qualification cannot cross a final barrier', async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>((accept) => {
    unblock = accept;
  });
  let entered!: () => void;
  const entering = new Promise<void>((accept) => {
    entered = accept;
  });
  const f = await fixture({
    commandBuilder: async (options) => {
      entered();
      await blocked;
      return nativeTestCommand(options);
    },
  });
  try {
    const admission = f.workspace
      .exec(principal, {
        operationId: 'late-admission',
        mode: 'read',
        argv: [process.execPath, '-e', 'process.exit(0)'],
      })
      .catch((error) => error);
    await entering;
    await f.workspace.withBarrier(async () => {
      unblock();
      // Admission queues behind the barrier and must not spawn inside it.
      await pause(32);
      assert.equal((await f.db.query('SELECT * FROM workspace_operations')).rowCount, 0);
    });
    // It may proceed after the barrier if the mission remained active. The real
    // completion transaction revokes that authority before releasing the gate.
    const response = await admission;
    if (response instanceof Error) assert.equal((response as any).code, 'workspace_barrier');
    else assert.equal((await terminal(f.workspace, 'late-admission')).state, 'succeeded');
  } finally {
    unblock();
    await f.cleanup();
  }
});

test('real OS sandbox forbids source writes and does not silently fall back', async (t) => {
  try {
    await assertSandboxAvailable();
  } catch (error: any) {
    if (process.env.MESH_REQUIRE_SANDBOX === '1') throw error;
    t.skip(`Host namespace support unavailable: ${error.message}`);
    return;
  }
  const f = await fixture({ commandBuilder: buildSandboxInvocation });
  try {
    await writeFile(join(f.repo, 'code.ts'), 'before');
    await f.workspace.exec(principal, {
      operationId: 'forbidden-write',
      mode: 'read',
      argv: [process.execPath, '-e', `require('node:fs').writeFileSync('code.ts','bad')`],
    });
    assert.equal((await terminal(f.workspace, 'forbidden-write')).state, 'failed');
    assert.equal(await readFile(join(f.repo, 'code.ts'), 'utf8'), 'before');
  } finally {
    await f.cleanup();
  }
});
