import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  runMesh,
  type MissionObservation,
  type RunAllocation,
  type RunEnd,
  type RunMeshOptions,
  type RunnerStore,
  type SupervisorIdentity,
  type RunCaptureManifest,
} from '../src/runner.js';
import type { MissionState, Principal, TraceInput } from '../src/types.js';

class MemoryRunnerStore implements RunnerStore {
  state: MissionState = 'active';
  revision = '1';
  stopReason = '';
  allocations: RunAllocation[] = [];
  ends: { principal: Principal; end: RunEnd }[] = [];
  order: string[] = [];
  waitedRevisions: string[] = [];
  leases = 0;
  live = new Set<string>();
  generations = new Map<string, number>();
  beforeEnd?: (principal: Principal, result: RunEnd) => void | Promise<void>;
  afterWait?: () => void | Promise<void>;
  setPidDelayMs = 0;
  async acquireSupervisor(): Promise<{ epoch: number }> {
    this.order.push('acquire');
    return { epoch: 1 };
  }
  async renewSupervisor(): Promise<void> {
    this.leases++;
  }
  async releaseSupervisor(): Promise<void> {
    this.order.push('release');
  }
  async observe(): Promise<MissionObservation> {
    return { state: this.state, workRevision: this.revision };
  }
  async waitForRevision(
    _mission: string,
    revision: string,
    timeout: number,
    signal: AbortSignal,
  ): Promise<MissionObservation> {
    this.waitedRevisions.push(revision);
    if (this.afterWait) {
      const callback = this.afterWait;
      this.afterWait = undefined;
      await callback();
    }
    if (revision === this.revision && this.state === 'active')
      await delay(Math.min(timeout, 5), undefined, { signal });
    return this.observe();
  }
  async allocateRun(input: SupervisorIdentity & { agentId: string }): Promise<RunAllocation> {
    assert.equal(this.state, 'active');
    assert.ok(
      !this.live.has(input.agentId),
      'previous generation must be released before replacement',
    );
    const generation = (this.generations.get(input.agentId) ?? 0) + 1;
    this.generations.set(input.agentId, generation);
    const principal = {
      missionId: input.missionId,
      agentId: input.agentId,
      runId: `${input.agentId}-run-${generation}`,
      generation,
    };
    const run = {
      principal,
      token: `run-secret-${input.agentId}-${generation}-sufficient-entropy`,
    };
    this.allocations.push(run);
    this.live.add(input.agentId);
    this.order.push(`allocate:${principal.runId}`);
    return run;
  }
  async setPid(principal: Principal): Promise<void> {
    if (this.setPidDelayMs) await delay(this.setPidDelayMs);
    this.order.push(`pid:${principal.runId}`);
  }
  async heartbeat(principal: Principal): Promise<void> {
    assert.ok(this.live.has(principal.agentId));
  }
  async endRun(principal: Principal, end: RunEnd): Promise<void> {
    assert.ok(
      this.order.includes(`operations:${principal.runId}`),
      'daemon commands must stop before generation release',
    );
    this.order.push(`end:${principal.runId}`);
    this.ends.push({ principal, end });
    if (end.reaped) this.live.delete(principal.agentId);
    await this.beforeEnd?.(principal, end);
  }
  async stopMission(
    _mission: string,
    state: 'stopped' | 'resource-limit' | 'stalled',
    reason: string,
  ): Promise<void> {
    this.state = state;
    this.stopReason = reason;
  }
}

const WORKER = `
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const mode = process.env.MESH_TEST_MODE;
const generation = Number(process.env.MESH_RUN_GENERATION);
const token = process.env.MESH_RUN_TOKEN;
if (mode === 'large') process.stdout.write('X'.repeat(128 * 1024) + '\\n');
if (mode === 'oversized') process.stdout.write('X'.repeat(1024 * 1024 + 3) + '\\n');
if (mode === 'hang') setInterval(() => {}, 1000);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();
if (!prompt.includes('mesh_join')) process.exit(44);
if (mode === 'hang') { console.log(JSON.stringify({ type: 'thread.started', thread_id: 'hung-thread' })); }
else if (mode === 'index-failure') {
  const path = process.argv[process.argv.indexOf('--output-last-message') + 1];
  await writeFile(path, JSON.stringify({ outcome: 'continue', summary: 'saved before index failure ' + token, checkpoint_id: null, waiting_on: [], work_revision: null }));
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-index-failure' }) + '\\n' + JSON.stringify({ type: 'item.completed', item: { id: 'final-1', type: 'agent_message', text: 'final assistant ' + token } }) + '\\n' + 'retained tail 🙂 ' + token);
  process.stderr.write('saved stderr ' + token);
}
else {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-' + process.env.MESH_RUN_ID }) + '\\n');
  if (mode === 'native-turn') process.stdout.write(JSON.stringify({ type: 'turn.started', turn_id: 'turn-native-1' }) + '\\n');
  const event = JSON.stringify({ type: 'item.completed', item: { id: 'item-1', type: 'mcp_tool_call', server: mode === 'rogue' ? 'unmanaged' : 'mesh', tool: 'mesh_poll', arguments: mode === 'native-turn' ? { messageId: 'mesh-message-1', taskId: 'mesh-task-1', operationId: 'mesh-operation-1' } : {}, result: { content: [{ text: '🙂 ' + token }] } } }) + '\\n';
  const bytes = Buffer.from(event);
  process.stdout.write(bytes.subarray(0, bytes.length - 25));
  await delay(2);
  process.stdout.write(bytes.subarray(bytes.length - 25));
  process.stderr.write('diagnostic ' + token + '\\n');
  await delay(mode === 'closing-workers' && process.env.MESH_SLOT_ID === 'A2' ? 100 : Number(process.env.MESH_TEST_DELAY ?? 3));
  const outcome = mode === 'idle-always' ? 'idle' : generation === 1 && (mode === 'blocked' || (mode === 'blocked-first-slot' && process.env.MESH_SLOT_ID === 'A1')) ? 'blocked' : mode === 'idle' && generation === 1 ? 'idle' : 'continue';
  const result = { outcome, summary: 'handoff ' + token, checkpoint_id: null, waiting_on: ['idle', 'blocked'].includes(outcome) ? ['decision-1'] : [], work_revision: ['idle', 'blocked'].includes(outcome) ? '1' : null };
  const path = process.argv[process.argv.indexOf('--output-last-message') + 1];
  if (mode !== 'missing-result') await writeFile(path, mode === 'invalid-result' ? 'invalid final output 🙂 ' + token : JSON.stringify(result));
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }) + '\\n');
}
`;

async function fixture(mode = 'normal'): Promise<{
  options: RunMeshOptions;
  store: MemoryRunnerStore;
  events: TraceInput[];
  children: ChildProcessWithoutNullStreams[];
  cleanup: () => Promise<void>;
}> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mesh-runner-')));
  const repository = join(base, 'repository');
  const home = join(base, 'codex-home');
  await Promise.all([mkdir(repository), mkdir(home)]);
  const worker = join(base, 'worker.mjs');
  await writeFile(worker, WORKER);
  await writeFile(join(repository, 'ROADMAP.md'), 'Implement the example mission.');
  const store = new MemoryRunnerStore();
  const events: TraceInput[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const options: RunMeshOptions = {
    missionId: 'mission-test',
    repository,
    roadmapPath: 'ROADMAP.md',
    mcpUrl: 'http://127.0.0.1:9000/mcp',
    logRoot: join(base, 'runtime', 'runs'),
    store,
    events: async (event) => {
      events.push(event);
      return {
        ...event,
        id: `event-${events.length}`,
        seq: String(events.length),
        at: new Date().toISOString(),
      };
    },
    stopOperations: async (principal) => {
      store.order.push(`operations:${principal.runId}`);
    },
    environment: {
      PATH: process.env.PATH,
      HOME: base,
      CODEX_HOME: home,
      MESH_TEST_MODE: mode,
      OPENAI_API_KEY: 'model-auth-secret-for-redaction',
    },
    concurrency: 1,
    maxRuns: 1,
    maxElapsedMs: 5000,
    runTimeoutMs: 3000,
    heartbeatMs: 20,
    leaseMs: 100,
    idlePollMs: 10,
    restartBackoffMs: 1,
    preflight: async () => ({ binary: 'fake-codex', version: 'fixture-only', requiredFlags: [] }),
    sandbox: async (input) => {
      assert.equal(input.sourceWritable, false);
      assert.equal(input.network, true);
      assert.ok(input.hiddenPaths?.includes(options.logRoot));
      assert.ok(input.writablePaths.every((path) => !path.startsWith(repository)));
      assert.ok(
        input.writablePaths.every(
          (path) => !path.startsWith(options.logRoot) || path.endsWith('/worker'),
        ),
        'audit logs must stay outside writable mounts',
      );
      return {
        command: process.execPath,
        args: [worker, ...input.argv.slice(1)],
        cwd: repository,
        env: input.env!,
        detached: true,
      };
    },
    spawn: (command, args, settings) => {
      const child = spawn(command, args, settings) as ChildProcessWithoutNullStreams;
      children.push(child);
      return child;
    },
  };
  return {
    options,
    store,
    events,
    children,
    cleanup: async () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          const closed = once(child, 'close').catch(() => undefined);
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
          await closed;
        }
      }
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function capturedRun(f: Awaited<ReturnType<typeof fixture>>): Promise<RunCaptureManifest> {
  const principal = f.store.allocations[0].principal;
  return JSON.parse(
    await readFile(
      join(
        f.options.logRoot,
        principal.missionId,
        principal.agentId,
        principal.runId,
        'capture.json',
      ),
      'utf8',
    ),
  ) as RunCaptureManifest;
}

test('run capture manifest proves retained prompt, schema, streams and final handoff integrity', async () => {
  const f = await fixture();
  try {
    await runMesh(f.options);
    const capture = await capturedRun(f);
    assert.equal(capture.schemaVersion, 1);
    assert.equal(capture.status, 'complete');
    assert.equal(capture.runId, f.store.allocations[0].principal.runId);
    assert.equal(capture.stdin.completed, true);
    assert.ok(capture.finalizedAt);
    for (const artifact of [
      capture.prompt,
      capture.schema,
      capture.stdout,
      capture.stderr,
      capture.result,
    ]) {
      const retained = await readFile(artifact.path);
      assert.equal(artifact.bytes, retained.length);
      assert.equal(artifact.sha256, createHash('sha256').update(retained).digest('hex'));
      const newlineCount = [...retained].filter((byte) => byte === 10).length;
      assert.equal(
        artifact.lines,
        newlineCount + (retained.length && retained.at(-1) !== 10 ? 1 : 0),
      );
      assert.equal(artifact.synced, true);
      assert.deepEqual(artifact.failures, []);
    }
    assert.equal(capture.stdout.eof, true);
    assert.equal(capture.stderr.eof, true);
    assert.equal(capture.stdout.indexComplete, true);
    assert.equal(capture.stdout.indexedEvents, 3);
    assert.equal(capture.stderr.indexedEvents, 1);
    assert.ok(
      capture.stdout.sourceBytes > capture.stdout.bytes,
      'incoming bytes differ from known-credential-redacted bytes',
    );
    const prompt = f.events.find((event) => event.kind === 'run.prompt')!.data as { text: string };
    assert.equal(prompt.text, await readFile(capture.prompt.path, 'utf8'));
    const handoff = f.events.find((event) => event.kind === 'run.handoff')!.data as {
      status: string;
      result: unknown;
      text: string;
    };
    assert.equal(handoff.status, 'valid');
    assert.equal(handoff.text, await readFile(capture.result.path, 'utf8'));
    assert.deepEqual(handoff.result, f.store.ends[0].end.result);
    assert.ok(f.events.some((event) => event.kind === 'run.capture.completed'));
    assert.ok(!JSON.stringify(capture).includes(f.store.allocations[0].token));
  } finally {
    await f.cleanup();
  }
});

test('a failed event index still drains pipes and archives the final assistant output', async () => {
  const f = await fixture('index-failure');
  try {
    const normalSink = f.options.events;
    f.options.events = async (event) => {
      if (event.kind === 'codex.item.completed')
        throw Object.assign(new Error('index unavailable'), { code: 'TRACE_INDEX_FAILURE' });
      return normalSink(event);
    };
    await assert.rejects(runMesh(f.options), /index unavailable/u);
    const capture = await capturedRun(f);
    assert.equal(capture.status, 'incomplete');
    assert.equal(capture.stdout.indexComplete, false);
    assert.ok(
      capture.stdout.failures.some(
        (failure) => failure.stage === 'index' && failure.code === 'TRACE_INDEX_FAILURE',
      ),
    );
    assert.equal(capture.stdout.eof, true);
    assert.equal(capture.stdout.synced, true);
    const stdout = await readFile(capture.stdout.path, 'utf8');
    assert.ok(stdout.endsWith('retained tail 🙂 [REDACTED]'));
    assert.equal(capture.stdout.bytes, Buffer.byteLength(stdout));
    assert.equal(capture.stdout.sha256, createHash('sha256').update(stdout).digest('hex'));
    assert.equal(capture.result.status, 'valid');
    assert.match(
      await readFile(capture.result.path, 'utf8'),
      /saved before index failure \[REDACTED\]/u,
    );
    assert.ok(f.events.some((event) => event.kind === 'run.handoff'));
    assert.ok(f.events.some((event) => event.kind === 'run.capture.incomplete'));
  } finally {
    await f.cleanup();
  }
});

test('a manifest trace failure is reflected in the retained manifest and stops replacement', async () => {
  const f = await fixture();
  try {
    f.options.maxRuns = 3;
    const normalSink = f.options.events;
    f.options.events = async (event) => {
      if (event.kind === 'run.capture.completed')
        throw Object.assign(new Error('capture index failed'), { code: 'TRACE_INDEX_FAILURE' });
      return normalSink(event);
    };
    await assert.rejects(runMesh(f.options), /capture index failed/u);
    const capture = await capturedRun(f);
    assert.equal(capture.status, 'incomplete');
    assert.equal(capture.stdout.indexComplete, true);
    assert.ok(
      capture.failures.some(
        (failure) => failure.stage === 'manifest-index' && failure.code === 'TRACE_INDEX_FAILURE',
      ),
    );
    assert.equal(f.store.ends[0].end.status, 'failed');
    assert.equal(f.store.allocations.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('invalid and missing final handoffs have explicit capture status and preserve available text', async () => {
  for (const mode of ['invalid-result', 'missing-result']) {
    const f = await fixture(mode);
    try {
      await runMesh(f.options);
      const capture = await capturedRun(f);
      assert.equal(capture.status, 'incomplete');
      assert.equal(capture.result.status, mode === 'invalid-result' ? 'invalid' : 'missing');
      assert.equal(f.store.ends[0].end.status, 'failed');
      if (mode === 'invalid-result') {
        assert.equal(
          await readFile(capture.result.path, 'utf8'),
          'invalid final output 🙂 [REDACTED]',
        );
        assert.ok(capture.result.sha256);
        assert.ok(
          capture.result.failures.some((failure) => failure.code === 'RESULT_INVALID_JSON'),
        );
      } else {
        assert.equal(capture.result.sha256, null);
        assert.ok(capture.result.failures.some((failure) => failure.code === 'ENOENT'));
      }
    } finally {
      await f.cleanup();
    }
  }
});

test('oversized stdout lines retain complete byte coverage and trustworthy final counters', async () => {
  const f = await fixture('oversized');
  try {
    await runMesh(f.options);
    const capture = await capturedRun(f);
    assert.equal(capture.status, 'complete');
    const indexed = f.events.filter(
      (event) => (event.data as { channel?: string })?.channel === 'stdout',
    );
    let offset = 0;
    for (const event of indexed) {
      const range = event.data as { offset: number; length: number };
      assert.equal(range.offset, offset);
      offset += range.length;
    }
    assert.equal(offset, capture.stdout.bytes);
    assert.equal(capture.stdout.lines, 4);
    assert.equal(capture.stdout.indexedEvents, indexed.length);
    assert.ok(indexed.some((event) => event.kind === 'codex.output.segment'));
  } finally {
    await f.cleanup();
  }
});

test('native thread and turn correlation follows CLI items and preserves explicit mesh handles', async () => {
  const f = await fixture('native-turn');
  try {
    await runMesh(f.options);
    const item = f.events.find((event) => event.kind === 'codex.item.completed')!;
    assert.equal(item.correlationId, `thread-${f.store.allocations[0].principal.runId}`);
    assert.equal(item.spanId, 'item-1');
    assert.equal(item.parentSpanId, 'turn-native-1');
    assert.equal(item.messageId, 'mesh-message-1');
    assert.equal(item.taskId, 'mesh-task-1');
    assert.equal(item.operationId, 'mesh-operation-1');
    assert.deepEqual((item.data as { codex: unknown }).codex, {
      threadId: item.correlationId,
      turnId: 'turn-native-1',
      itemId: 'item-1',
    });
    const completed = f.events.find((event) => event.kind === 'codex.turn.completed')!;
    assert.equal(completed.correlationId, item.correlationId);
    assert.equal(completed.spanId, 'turn-native-1');
    assert.equal(
      f.events.find((event) => event.kind === 'run.handoff')!.correlationId,
      item.correlationId,
    );
  } finally {
    await f.cleanup();
  }
});

test('N peers use fresh generations, enforce population/run limits and retain redacted complete output', async () => {
  const f = await fixture();
  try {
    f.options.concurrency = 3;
    f.options.maxRuns = 7;
    let peak = 0;
    let live = 0;
    const spawnWorker = f.options.spawn!;
    f.options.spawn = (command, args, options) => {
      const child = spawnWorker(command, args, options);
      peak = Math.max(peak, ++live);
      child.once('close', () => {
        live--;
      });
      return child;
    };
    const summary = await runMesh(f.options);
    assert.equal(summary.runsStarted, 7);
    assert.equal(summary.runsFinished, 7);
    assert.equal(summary.state, 'resource-limit');
    assert.equal(peak, 3, JSON.stringify(f.store.ends.map((run) => run.end.error)));
    assert.equal(live, 0);
    assert.ok(f.store.allocations.some((run) => run.principal.generation > 1));
    assert.equal(new Set(f.store.allocations.map((run) => run.token)).size, 7);
    for (const { principal, token } of f.store.allocations) {
      const base = join(f.options.logRoot, principal.missionId, principal.agentId, principal.runId);
      const stdout = await readFile(join(base, 'stdout.jsonl'), 'utf8');
      const stderr = await readFile(join(base, 'stderr.log'), 'utf8');
      const schema = JSON.parse(await readFile(join(base, 'result.schema.json'), 'utf8'));
      assert.ok(schema.required.includes('work_revision'));
      const result = await readFile(join(base, 'result.json'), 'utf8');
      assert.equal(stdout.trim().split('\n').length, 3);
      assert.match(stdout, /🙂 \[REDACTED\]/u);
      assert.equal(stderr, 'diagnostic [REDACTED]\n');
      for (const content of [stdout, stderr, result, JSON.stringify(f.events)])
        assert.ok(!content.includes(token));
      assert.equal(
        f.store.ends.find((end) => end.principal.runId === principal.runId)!.end.reaped,
        true,
      );
    }
    assert.equal(f.events.filter((event) => event.kind === 'codex.item.completed').length, 7);
    assert.equal(f.events.filter((event) => event.kind === 'run.process.ended').length, 7);
    assert.equal(f.store.order.at(-1), 'release');
  } finally {
    await f.cleanup();
  }
});

test('output capture is attached before asynchronous PID persistence for a short noisy worker', async () => {
  const f = await fixture('large');
  try {
    f.store.setPidDelayMs = 100;
    const summary = await runMesh(f.options);
    assert.equal(summary.runsFinished, 1);
    const principal = f.store.allocations[0].principal;
    const stdout = await readFile(
      join(
        f.options.logRoot,
        principal.missionId,
        principal.agentId,
        principal.runId,
        'stdout.jsonl',
      ),
      'utf8',
    );
    assert.equal(stdout.slice(0, 128 * 1024), 'X'.repeat(128 * 1024));
    assert.ok(stdout.endsWith('"output_tokens":3}}\n'));
  } finally {
    await f.cleanup();
  }
});

test('idle exits replace every slot without a work revision and stop at the elapsed limit', async () => {
  const f = await fixture('idle-always');
  try {
    f.options.concurrency = 5;
    f.options.maxRuns = 1000;
    f.options.maxElapsedMs = 1500;
    let peak = 0;
    const spawnWorker = f.options.spawn!;
    f.options.spawn = (command, args, options) => {
      peak = Math.max(peak, f.store.live.size);
      assert.ok(f.store.live.size <= 5);
      return spawnWorker(command, args, options);
    };
    const started = Date.now();
    const summary = await runMesh(f.options);
    assert.equal(summary.state, 'resource-limit');
    assert.equal(f.store.stopReason, 'Maximum elapsed time reached');
    assert.ok(Date.now() - started < 5000);
    assert.equal(peak, 5);
    assert.equal(f.store.generations.size, 5);
    for (const generation of f.store.generations.values()) assert.ok(generation >= 2);
    assert.equal(f.store.revision, '1');
    assert.deepEqual(f.store.waitedRevisions, []);
    assert.equal(summary.runsStarted, summary.runsFinished);
    assert.equal(f.store.live.size, 0);
    assert.ok(f.store.ends.every(({ end }) => end.reaped));
    assert.ok(f.children.every((child) => child.exitCode !== null || child.signalCode !== null));
    assert.ok(!f.events.some((event) => event.kind === 'slot.parked'));
  } finally {
    await f.cleanup();
  }
});

test('blocked peers park at the mesh_yield cursor and see work arriving during exit', async () => {
  const f = await fixture('blocked');
  try {
    f.options.maxRuns = 2;
    f.store.beforeEnd = (principal) => {
      if (principal.generation === 1) f.store.revision = '2';
    };
    const summary = await runMesh(f.options);
    assert.equal(summary.runsStarted, 2);
    assert.equal(f.store.waitedRevisions[0], '1');
    assert.ok(f.events.some((event) => event.kind === 'slot.awakened'));
  } finally {
    await f.cleanup();
  }
});

test('completion closing pauses admission while heartbeats continue, then resumes on rejection', async () => {
  const f = await fixture();
  let reopen: ReturnType<typeof setTimeout> | undefined;
  try {
    f.options.maxRuns = 2;
    f.store.beforeEnd = (principal) => {
      if (principal.generation !== 1) return;
      f.store.state = 'closing';
      reopen = setTimeout(() => {
        f.store.state = 'active';
        f.store.revision = '2';
      }, 100);
    };
    const summary = await runMesh(f.options);
    assert.equal(summary.runsStarted, 2);
    assert.ok(f.store.leases >= 3);
    assert.ok(f.events.some((event) => event.kind === 'admission.paused'));
    assert.ok(f.events.some((event) => event.kind === 'admission.resumed'));
    assert.ok(f.store.ends.every((run) => run.end.status === 'exited'));
  } finally {
    if (reopen) clearTimeout(reopen);
    await f.cleanup();
  }
});

test('run timeout stops and reaps the process before releasing the generation', async () => {
  const f = await fixture('hang');
  try {
    f.options.runTimeoutMs = 100;
    const summary = await runMesh(f.options);
    assert.equal(summary.runsStarted, 1);
    assert.equal(f.store.ends[0].end.status, 'timed-out');
    assert.equal(f.store.ends[0].end.reaped, true);
    assert.ok(f.children[0].signalCode);
    assert.ok(f.events.some((event) => event.kind === 'run.stop.requested'));
  } finally {
    await f.cleanup();
  }
});

test('closing preserves already-running peers and waits for mission acceptance without replacement', async () => {
  const f = await fixture('closing-workers');
  let complete: ReturnType<typeof setTimeout> | undefined;
  try {
    f.options.concurrency = 2;
    f.options.maxRuns = 8;
    f.store.beforeEnd = (principal) => {
      if (principal.agentId !== 'A1') return;
      f.store.state = 'closing';
      complete = setTimeout(() => {
        f.store.state = 'completed';
        f.store.revision = '2';
      }, 200);
    };
    const summary = await runMesh(f.options);
    assert.equal(summary.state, 'completed');
    assert.equal(summary.runsStarted, 2);
    assert.ok(f.store.ends.every((run) => run.end.status === 'exited'));
    assert.ok(!f.events.some((event) => event.kind === 'run.stop.requested'));
  } finally {
    if (complete) clearTimeout(complete);
    await f.cleanup();
  }
});

test('acceptance drains existing peers, retains handoffs and usage, and never replaces them', async () => {
  const f = await fixture();
  try {
    f.options.concurrency = 2;
    f.options.maxRuns = 8;
    f.options.completionGraceMs = 1000;
    f.options.environment!.MESH_TEST_DELAY = '200';
    const record = f.options.events;
    let starts = 0;
    let leasesAtDrain = 0;
    f.options.events = async (event) => {
      const result = await record(event);
      if (event.kind === 'codex.thread.started' && ++starts === 2) {
        f.store.state = 'completed';
        f.store.revision = '2';
      }
      if (event.kind === 'supervisor.draining') leasesAtDrain = f.store.leases;
      return result;
    };
    const summary = await runMesh(f.options);
    assert.equal(summary.state, 'completed');
    assert.equal(summary.runsStarted, 2);
    assert.equal(summary.runsFinished, 2);
    assert.equal(f.events.filter((e) => e.kind === 'supervisor.draining').length, 1);
    assert.equal(f.events.filter((e) => e.kind === 'codex.turn.completed').length, 2);
    assert.ok(f.store.leases > leasesAtDrain, 'leases must renew during drain');
    assert.ok(!f.events.some((e) => e.kind === 'run.stop.requested'));
    for (const { principal, end } of f.store.ends) {
      assert.equal(end.status, 'exited');
      assert.equal(end.result?.outcome, 'continue');
      const file = join(
        f.options.logRoot,
        principal.missionId,
        principal.agentId,
        principal.runId,
        'result.json',
      );
      assert.equal(JSON.parse(await readFile(file, 'utf8')).outcome, 'continue');
    }
  } finally {
    await f.cleanup();
  }
});

for (const stop of ['grace', 'elapsed', 'external'] as const) {
  test(`completed mission stops an unresponsive peer at the ${stop} boundary`, async () => {
    const f = await fixture('hang');
    const controller = new AbortController();
    try {
      f.options.signal = controller.signal;
      f.options.maxRuns = 8;
      f.options.maxElapsedMs = stop === 'elapsed' ? 600 : 5000;
      f.options.runTimeoutMs = 5000;
      f.options.completionGraceMs = stop === 'grace' ? 80 : 5000;
      const record = f.options.events;
      f.options.events = async (event) => {
        const result = await record(event);
        // Short stdout records can remain in the streaming redactor until EOF.
        // Synchronize acceptance with process startup, independently of output.
        if (event.kind === 'run.started') f.store.state = 'completed';
        if (event.kind === 'supervisor.draining' && stop === 'external') controller.abort();
        return result;
      };
      const began = Date.now();
      const summary = await runMesh(f.options);
      assert.equal(summary.state, 'completed', 'shutdown must not erase acceptance');
      assert.equal(summary.runsStarted, 1);
      assert.equal(f.store.ends[0].end.status, 'aborted');
      assert.equal(f.store.ends[0].end.reaped, true);
      assert.ok(Date.now() - began < 2500, 'must not wait for the five-second grace');
      const ended = f.events.find((e) => e.kind === 'supervisor.ended')!;
      assert.equal(
        (ended.data as { shutdownReason: string }).shutdownReason,
        stop === 'grace'
          ? 'Completion drain deadline reached'
          : stop === 'elapsed'
            ? 'Maximum elapsed time reached'
            : 'User stopped the runner',
      );
      const drain = f.events.find((e) => e.kind === 'supervisor.draining')!.data as {
        graceMs: number;
        remainingMs: number;
      };
      assert.ok(drain.graceMs <= drain.remainingMs);
    } finally {
      controller.abort();
      await f.cleanup();
    }
  });
}

test('blocked populations honor the hard elapsed limit without repeated runs', async () => {
  const f = await fixture('blocked');
  try {
    f.options.maxRuns = 8;
    f.options.maxElapsedMs = 1000;
    const summary = await runMesh(f.options);
    assert.equal(summary.state, 'resource-limit');
    assert.equal(summary.runsStarted, 1);
    assert.ok(f.events.some((event) => event.kind === 'slot.parked'));
  } finally {
    await f.cleanup();
  }
});

test('a slot already parked exits when another slot exhausts the shared run budget', async () => {
  const f = await fixture('blocked-first-slot');
  try {
    f.options.concurrency = 2;
    f.options.maxRuns = 3;
    const summary = await runMesh(f.options);
    assert.equal(summary.runsStarted, 3);
    assert.equal(summary.state, 'resource-limit');
    assert.equal(f.store.stopReason, 'Maximum run count reached');
  } finally {
    await f.cleanup();
  }
});

test('unconfirmed termination quarantines the generation without a replacement or close-wait deadlock', async () => {
  const f = await fixture('hang');
  try {
    f.options.maxRuns = 3;
    f.options.runTimeoutMs = 80;
    f.options.terminate = async () => {
      throw new Error('termination_unconfirmed');
    };
    await assert.rejects(runMesh(f.options), /termination_unconfirmed/u);
    assert.equal(f.store.allocations.length, 1);
    assert.equal(f.store.ends[0].end.reaped, false);
    assert.equal(f.store.state, 'stalled');
  } finally {
    await f.cleanup();
  }
});

test('unexpected configured MCP use fails closed with evidence and no replacement', async () => {
  const f = await fixture('rogue');
  try {
    f.options.maxRuns = 3;
    await assert.rejects(runMesh(f.options), /Unexpected MCP server/u);
    assert.equal(f.store.allocations.length, 1);
    assert.ok(f.events.some((event) => event.kind === 'codex.item.completed'));
    assert.equal(f.store.state, 'stalled');
  } finally {
    await f.cleanup();
  }
});

test('trace-store failures cannot be misclassified as malformed CLI JSON', async () => {
  const f = await fixture();
  try {
    f.options.maxRuns = 3;
    const normalSink = f.options.events;
    f.options.events = async (event) => {
      if (event.kind === 'codex.item.completed') throw new SyntaxError('trace-store-broken');
      return normalSink(event);
    };
    await assert.rejects(runMesh(f.options), /trace-store-broken/u);
    assert.equal(f.store.allocations.length, 1);
    assert.equal(f.store.state, 'stalled');
    assert.ok(f.store.order.some((entry) => entry.startsWith('operations:')));
  } finally {
    await f.cleanup();
  }
});
