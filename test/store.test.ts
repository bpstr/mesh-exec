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

test('knowledge pages retain old resolved findings and paginate timestamp ties without loss', async (t) => {
  const s = await setup();
  t.after(() => s.db.close());
  for (let i = 0; i < 53; i++) {
    await s.store.remember(s.a.principal, {
      id: `finding-${String(i).padStart(2, '0')}`,
      kind: 'finding',
      title: i === 0 ? 'Historical solution' : 'Current finding',
      body: 'Evidence retained for every agent.',
      status: i === 0 ? 'resolved' : 'open',
    });
  }
  // Preserve sub-millisecond precision in cursors and break ties by ID.
  await s.db.query(
    "UPDATE knowledge SET updated_at='2026-01-01 00:00:00.123456+00' WHERE mission_id=$1",
    [s.mission.id],
  );
  const first = (await s.store.board(s.b.principal)) as any;
  assert.equal(first.knowledge.length, 50);
  assert.equal(first.knowledgePage.hasMore, true);
  assert.deepEqual(first.knowledgePage.summary, {
    total: 53,
    findings: 53,
    decisions: 0,
    offers: 0,
    blockers: 0,
    resolved: 1,
    stale: 0,
  });
  const second = (await s.store.board(s.b.principal, undefined, {
    knowledgeCursor: first.knowledgePage.nextCursor,
  })) as any;
  assert.equal(second.knowledge.length, 3);
  assert.equal(second.knowledgePage.hasMore, false);
  assert.equal(second.knowledgePage.nextCursor, null);
  const entries = [...first.knowledge, ...second.knowledge];
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 53);
  assert.equal(entries.at(-1).status, 'resolved');
  assert.equal(entries.at(-1).id, 'finding-00');
  const search = (await s.store.board(s.b.principal, 'Historical', { knowledgeLimit: 1 })) as any;
  assert.equal(search.knowledgePage.summary.total, 1);
  assert.equal(search.knowledge[0].id, 'finding-00');
  assert.equal(search.knowledgePage.hasMore, false);
  const empty = (await s.store.board(s.b.principal, 'nonexistent')) as any;
  assert.equal(empty.knowledgePage.summary.total, 0);
  assert.equal(empty.knowledgePage.nextCursor, null);
  await assert.rejects(
    s.store.board(s.b.principal, undefined, { knowledgeLimit: 0 }),
    /knowledgeLimit/,
  );
});

test('identical requirement publication preserves revision, author, reviews, and work revision', async (t) => {
  const s = await setup();
  t.after(() => s.db.close());
  const requirement = {
    id: 'R1',
    anchor: 'Implement a shared counter.',
    title: 'Counter',
    criteria: ['Starts at zero'],
    state: 'implemented' as const,
    evidence: [{ criterion: 0, description: 'Inspected source' }],
  };
  await s.store.requirement(s.a.principal, requirement);
  await s.store.review(s.b.principal, {
    id: 'review',
    kind: 'requirement',
    targetId: 'R1',
    targetRevision: 1,
    manifestHash: 'a'.repeat(64),
    verdict: 'pass',
    reasoning: 'Inspected implementation',
  });
  const before = await s.store.observe(s.mission.id);
  assert.deepEqual(
    await s.store.requirement(s.b.principal, { ...requirement, expectedRevision: 1 }),
    { id: 'R1', revision: 1, unchanged: true },
  );
  assert.deepEqual(await s.store.observe(s.mission.id), before);
  const stored = await s.db.query('SELECT author_agent,revision FROM requirements WHERE id=$1', [
    'R1',
  ]);
  assert.equal(stored.rows[0].author_agent, s.a.principal.agentId);
  assert.equal(stored.rows[0].revision, 1);
  assert.equal((await s.db.query('SELECT id FROM reviews WHERE target_revision=1')).rowCount, 1);
  await assert.rejects(
    s.store.requirement(s.b.principal, { ...requirement, expectedRevision: 2 }),
    /current requirement revision/,
  );
  assert.deepEqual(
    await s.store.requirement(s.a.principal, {
      ...requirement,
      expectedRevision: 1,
      criteria: ['Starts at one'],
    }),
    { id: 'R1', revision: 2 },
  );
  assert.notEqual((await s.store.observe(s.mission.id)).workRevision, before.workRevision);
});

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
