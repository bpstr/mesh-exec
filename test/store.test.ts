import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, covers, overlaps } from '../src/store.js';
import { readEvents, redact } from '../src/trace.js';
import { TestDatabase } from './helpers.js';

test('yield preserves work that arrived after the last observation without self-waking on claim release', async (t) => {
  const s = await setup();
  t.after(() => s.db.close());
  await s.store.claim(s.a.principal, {
    id: 'release-me',
    resources: ['counter.txt'],
    description: 'counter',
  });
  await s.store.board(s.a.principal);
  const yielded = await s.store.yield(s.a.principal, 'No remaining work');
  assert.equal(yielded.workRevision, (await s.store.observe(s.mission.id)).workRevision);
  await s.store.board(s.a.principal);
  const lastSeen = await s.store.observe(s.mission.id);
  await s.store.remember(s.b.principal, {
    id: 'new-work',
    kind: 'finding',
    title: 'New opportunity',
    body: 'A relevant dependency changed.',
  });
  const raced = await s.store.yield(s.a.principal, 'Waiting');
  assert.equal(raced.workRevision, lastSeen.workRevision);
  assert.notEqual(raced.workRevision, (await s.store.observe(s.mission.id)).workRevision);
});

async function setup() {
  const db = new TestDatabase();
  const store = new Store(db);
  await store.initialize();
  const mission = await store.createMission({
    repo: '/test',
    roadmapPath: 'ROADMAP.md',
    roadmapText: 'Implement a shared counter.',
    baseline: {},
    agents: 2,
  });
  const { epoch } = await store.acquireSupervisor({
    missionId: mission.id,
    supervisorId: 's',
    pid: 1,
    hostname: 'test',
    leaseMs: 60_000,
  });
  const a = await store.allocateRun({
    missionId: mission.id,
    agentId: 'A1',
    supervisorId: 's',
    epoch,
  });
  const b = await store.allocateRun({
    missionId: mission.id,
    agentId: 'A2',
    supervisorId: 's',
    epoch,
  });
  return { db, store, mission, a, b, epoch };
}

test('atomic overlapping claim bundles have one winner; stale generations cannot write', async (t) => {
  const s = await setup();
  t.after(() => s.db.close());
  const results = (await Promise.all([
    s.store.claim(s.a.principal, {
      id: 'C1',
      description: 'counter',
      resources: ['src/**', 'package.json'],
    }),
    s.store.claim(s.b.principal, {
      id: 'C2',
      description: 'review implementation',
      resources: ['src/counter.ts', 'other.ts'],
    }),
  ])) as { granted: boolean }[];
  assert.equal(results.filter((r) => r.granted).length, 1);
  const claims = await s.db.query('SELECT * FROM claims');
  assert.equal(claims.rows.length, 1);
  const winner = results[0].granted ? s.a : s.b;
  const claimId = results[0].granted ? 'C1' : 'C2';
  await s.store.authorize(winner.principal, ['src/counter.ts'], 'op', claimId);
  const revision = await s.store.observe(s.mission.id);
  await s.store.endRun(winner.principal, {
    status: 'failed',
    exitCode: 1,
    signal: null,
    result: null,
    reaped: true,
  });
  assert.notEqual((await s.store.observe(s.mission.id)).workRevision, revision.workRevision);
  const successor = await s.store.allocateRun({
    missionId: s.mission.id,
    agentId: winner.principal.agentId,
    supervisorId: 's',
    epoch: s.epoch,
  });
  assert.equal(successor.principal.generation, 2);
  await assert.rejects(s.store.authenticate(winner.token), /finished|expired|fenced/);
  await assert.rejects(
    s.store.authorize(winner.principal, ['src/counter.ts'], 'stale', claimId),
    /finished|expired|fenced/,
  );
  assert.ok(covers('src/**', 'src/counter.ts'));
  assert.ok(!covers('src/**', 'src2/counter.ts'));
  assert.ok(overlaps('src', 'src/counter.ts'));
});

test('knowledge revisions invalidate transitive dependants and preserve history', async (t) => {
  const s = await setup();
  t.after(() => s.db.close());
  await s.store.remember(s.a.principal, {
    id: 'D1',
    kind: 'decision',
    title: 'Counter',
    body: 'Use a transaction.',
  });
  await s.store.remember(s.b.principal, {
    id: 'D2',
    kind: 'finding',
    title: 'Implementation',
    body: 'Depends on D1',
    edges: [{ toId: 'D1', toRevision: 1, kind: 'depends-on' }],
  });
  await s.store.remember(s.a.principal, {
    id: 'D3',
    kind: 'offer',
    title: 'Tests',
    body: 'Knows D2',
    edges: [{ toId: 'D2', toRevision: 1, kind: 'depends-on' }],
  });
  await s.store.remember(s.a.principal, {
    id: 'D1',
    kind: 'decision',
    title: 'Counter',
    body: 'Use a fenced transaction.',
    expectedRevision: 1,
  });
  const r = await s.db.query<{ id: string; freshness: string }>(
    'SELECT id,freshness FROM knowledge ORDER BY id',
  );
  assert.deepEqual(
    r.rows.map((r) => r.freshness),
    ['current', 'stale', 'stale'],
  );
  assert.equal((await s.db.query('SELECT * FROM knowledge_history')).rows.length, 1);
});

test('trace replay is committed, correlated, complete, and secret-redacted; heartbeats do not wake slots', async (t) => {
  const s = await setup();
  t.after(() => s.db.close());
  const before = await s.store.observe(s.mission.id);
  await s.store.heartbeat(s.a.principal);
  await s.store.tracer.span(
    s.a.principal,
    'tool.mesh_send',
    { text: 'full question', authorization: 'Bearer confidential' },
    async () => ({ reply: 'full answer', run_token: s.a.token }),
  );
  assert.deepEqual(await s.store.observe(s.mission.id), before);
  const events = await readEvents(s.db, s.mission.id, { run: s.a.principal.runId });
  const start = events.find((e) => e.kind === 'tool.mesh_send.started')!;
  const end = events.find((e) => e.kind === 'tool.mesh_send.completed')!;
  assert.equal(end.causationId, start.id);
  assert.equal(end.traceId, start.traceId);
  assert.equal(start.correlationId, s.a.principal.runId);
  assert.ok(JSON.stringify(events).includes('full question'));
  assert.ok(!JSON.stringify(events).includes(s.a.token));
  assert.equal((start.data as any).authorization, '[REDACTED]');
  assert.ok(BigInt(end.seq) > BigInt(start.seq));
  const tail = await readEvents(s.db, s.mission.id, { after: start.seq });
  assert.ok(tail.some((e) => e.id === end.id));
  assert.deepEqual(redact({ access_token: 'secret', token_count: 500 }), {
    access_token: '[REDACTED]',
    token_count: 500,
  });
});
