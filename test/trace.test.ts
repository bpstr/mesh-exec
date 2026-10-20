import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Store } from '../src/store.js';
import { readEvents, redact } from '../src/trace.js';
import { listRuns } from '../src/runs.js';
import { streamLog, traceEvents, writeOutput } from '../src/streams.js';
import { TestDatabase } from './helpers.js';

async function fixture() {
  const db = new TestDatabase();
  const store = new Store(db);
  await store.initialize();
  const mission = await store.createMission({
    repo: '/trace-tests',
    roadmapPath: 'ROADMAP.md',
    roadmapText: 'Track the consultation.',
    baseline: {},
    agents: 2,
  });
  const { epoch } = await store.acquireSupervisor({
    missionId: mission.id,
    supervisorId: 'trace',
    pid: 1,
    hostname: 'test',
    leaseMs: 60_000,
  });
  const a = await store.allocateRun({
    missionId: mission.id,
    agentId: 'A1',
    supervisorId: 'trace',
    epoch,
  });
  const b = await store.allocateRun({
    missionId: mission.id,
    agentId: 'A2',
    supervisorId: 'trace',
    epoch,
  });
  return { db, store, mission, a, b };
}

test('native trace filters and fixed upper cursors retain replay order while writers continue', async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const first = await f.store.events({
    ...f.a.principal,
    kind: 'message.send.accepted',
    traceId: 'native-thread',
    spanId: 'native-item',
    data: { text: 'A full question\nwith context.' },
  });
  const second = await f.store.events({
    ...f.b.principal,
    kind: 'message.reply.accepted',
    traceId: 'native-thread',
    spanId: 'answer-item',
    data: { text: 'A full answer.' },
  });
  await f.store.events({
    ...f.a.principal,
    kind: 'message.acknowledged',
    traceId: 'native-thread',
    data: { text: 'Committed after the chosen export boundary.' },
  });
  const found = await readEvents(f.db, f.mission.id, {
    traceId: 'native-thread',
    spanId: 'native-item',
    kindPrefix: 'message.',
  });
  assert.deepEqual(
    found.map((e) => e.id),
    [first.id],
  );
  const history = [];
  for await (const event of traceEvents(
    f.db,
    f.mission.id,
    { traceId: 'native-thread', until: second.seq, limit: 1 },
    { follow: true },
  ))
    history.push(event);
  assert.deepEqual(
    history.map((e) => e.id),
    [first.id, second.id],
  );
  const resumed = await readEvents(f.db, f.mission.id, { after: first.seq, until: second.seq });
  assert.deepEqual(
    resumed.map((e) => e.id),
    [second.id],
  );
  await assert.rejects(readEvents(f.db, f.mission.id, { after: '1 OR 1=1' }), /event sequence/);
  await assert.rejects(readEvents(f.db, f.mission.id, { limit: Number.NaN }), /positive integer/);
});

test('run history retains timestamp ties, excludes credentials, and surfaces capture state', async (t) => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'mesh-run-inspection-'));
  t.after(async () => {
    await f.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  await f.db.query(
    "UPDATE runs SET started_at='2026-10-20 16:00:00.123456+00'::timestamptz WHERE mission_id=$1",
    [f.mission.id],
  );
  const first = await listRuns(f.db, f.mission.id, { limit: 1 });
  assert.ok(first.nextCursor);
  const second = await listRuns(f.db, f.mission.id, { limit: 1, cursor: first.nextCursor! });
  assert.equal(second.nextCursor, null);
  assert.notEqual((first.runs as any[])[0].id, (second.runs as any[])[0].id);
  assert.equal((first.runs as any[])[0].started_at, '2026-10-20T16:00:00.123Z');
  assert.ok(!JSON.stringify(first).includes('token_hash'));
  await assert.rejects(
    listRuns(f.db, f.mission.id, { agent: 'A1', cursor: first.nextCursor! }),
    /another query/,
  );
  await f.db.query('UPDATE runs SET log_dir=$2 WHERE id=$1', [f.a.principal.runId, directory]);
  const missing = await listRuns(f.db, f.mission.id, { run: f.a.principal.runId });
  assert.equal((missing.runs as any[])[0].capture.status, 'in-progress');
  await writeFile(
    join(directory, 'capture.json'),
    JSON.stringify({
      schemaVersion: 1,
      status: 'incomplete',
      stdout: { eof: true, indexComplete: false },
    }),
  );
  const captured = await listRuns(f.db, f.mission.id, { run: f.a.principal.runId });
  assert.equal((captured.runs as any[])[0].capture.manifest.status, 'incomplete');
});

test('log replay preserves split UTF-8, respects slow sinks, and resumes from an exact byte offset', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-log-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'stdout.jsonl');
  const expected = Buffer.from(
    'x'.repeat(65535) + '🤖 Árvíztűrő tükörfúrógép\n' + 'y'.repeat(131072),
  );
  await writeFile(path, expected);
  const received: Buffer[] = [];
  let peak = 0;
  const slow = new Writable({
    highWaterMark: 32,
    write(chunk, _encoding, callback) {
      peak = Math.max(peak, this.writableLength);
      setTimeout(() => {
        received.push(Buffer.from(chunk));
        callback();
      }, 2);
    },
  });
  const result = await streamLog(path, slow);
  assert.deepEqual(Buffer.concat(received), expected);
  assert.equal(result.offset, expected.length);
  assert.ok(peak <= 65536, `Queued ${peak} bytes in a slow sink`);
  const tail: Buffer[] = [];
  const sink = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      tail.push(Buffer.from(chunk));
      callback();
    },
  });
  await streamLog(path, sink, { offset: 65535 });
  assert.deepEqual(Buffer.concat(tail), (await readFile(path)).subarray(65535));
});

test(
  'a slow consumer closing without drain cannot leave an observer waiting forever',
  { timeout: 1000 },
  async () => {
    const sink = new Writable({
      highWaterMark: 1,
      write() {
        setImmediate(() => this.destroy());
      },
    });
    assert.equal(await writeOutput(sink, Buffer.alloc(65536)), false);
    assert.equal(sink.listenerCount('drain'), 0);
    assert.equal(sink.listenerCount('close'), 0);
  },
);
test('redaction preserves PostgreSQL Date values while removing nested credentials', () => {
  const at = new Date('2026-10-20T16:00:00.000Z');
  assert.deepEqual(
    redact({ started_at: at, messages: [{ created_at: at, token: 'private-token' }] }),
    {
      started_at: '2026-10-20T16:00:00.000Z',
      messages: [{ created_at: '2026-10-20T16:00:00.000Z', token: '[REDACTED]' }],
    },
  );
  assert.equal(redact(new Date('invalid')), null);
});
