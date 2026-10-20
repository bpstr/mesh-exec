import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
if (mode === 'hang') setInterval(() => {}, 1000);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();
if (!prompt.includes('Consult with the other mesh peers')) process.exit(44);
if (mode === 'hang') { console.log(JSON.stringify({ type: 'thread.started', thread_id: 'hung-thread' })); }
else {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-' + process.env.MESH_RUN_ID }) + '\\n');
  const event = JSON.stringify({ type: 'item.completed', item: { id: 'item-1', type: 'mcp_tool_call', server: mode === 'rogue' ? 'unmanaged' : 'mesh', tool: 'mesh_poll', arguments: {}, result: { content: [{ text: '🙂 ' + token }] } } }) + '\\n';
  const bytes = Buffer.from(event);
  process.stdout.write(bytes.subarray(0, bytes.length - 25));
  await delay(2);
  process.stdout.write(bytes.subarray(bytes.length - 25));
  process.stderr.write('diagnostic ' + token + '\\n');
  await delay(mode === 'closing-workers' && process.env.MESH_SLOT_ID === 'A2' ? 100 : Number(process.env.MESH_TEST_DELAY ?? 3));
  const outcome = (mode === 'idle' || (mode === 'idle-first-slot' && process.env.MESH_SLOT_ID === 'A1')) && generation === 1 ? 'idle' : 'continue';
  const result = { outcome, summary: 'handoff ' + token, checkpoint_id: null, waiting_on: outcome === 'idle' ? ['decision-1'] : [], work_revision: outcome === 'idle' ? '1' : null };
  const path = process.argv[process.argv.indexOf('--output-last-message') + 1];
  await writeFile(path, JSON.stringify(result));
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

test('idle peers park at the mesh_yield cursor and see work arriving during exit', async () => {
  const f = await fixture('idle');
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

test('parked populations honor the hard elapsed limit without repeated idle runs', async () => {
  const f = await fixture('idle');
  try {
    f.options.maxRuns = 8;
    f.options.maxElapsedMs = 300;
    const summary = await runMesh(f.options);
    assert.equal(summary.state, 'resource-limit');
    assert.equal(summary.runsStarted, 1);
    assert.ok(f.events.some((event) => event.kind === 'slot.parked'));
  } finally {
    await f.cleanup();
  }
});

test('a slot already parked exits when another slot exhausts the shared run budget', async () => {
  const f = await fixture('idle-first-slot');
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
