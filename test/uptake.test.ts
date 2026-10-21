import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { A2A_SCHEMA, A2aService, type UptakeInput } from '../src/a2a.js';
import { listConversationMessages, conversationTimeline } from '../src/conversations.js';
import { CORE_SCHEMA } from '../src/schema.js';
import { Tracer } from '../src/trace.js';
import { MeshError, type Principal, type Sql } from '../src/types.js';
import { TestDatabase } from './helpers.js';

async function fixture() {
  const db = new TestDatabase();
  await db.query(CORE_SCHEMA + A2A_SCHEMA);
  for (const missionId of ['m1', 'm2'])
    await db.query(
      `INSERT INTO missions(id,repo,roadmap_path,roadmap_text,roadmap_hash,baseline)
       VALUES($1,'/fixture/'||$1,'ROADMAP.md','Fixture','hash','{}')`,
      [missionId],
    );
  const active = new Map<string, Principal>();
  for (const missionId of ['m1', 'm2'])
    for (const agentId of ['A1', 'A2', 'A3'])
      active.set(`${missionId}:${agentId}`, {
        missionId,
        agentId,
        runId: `${missionId}-${agentId}-1`,
        generation: 1,
      });
  const principal = (agentId = 'A2', missionId = 'm1') => active.get(`${missionId}:${agentId}`)!;
  const tracer = new Tracer(db);
  let failTrace = false;
  const service = new A2aService({
    db,
    baseUrl: 'http://127.0.0.1:1',
    authenticate: async () => {
      throw new Error('No transport in this fixture');
    },
    peerExists: async (_tx, missionId, agentId) => active.has(`${missionId}:${agentId}`),
    validatePrincipal: async (_tx, p) => {
      if (principal(p.agentId, p.missionId)?.runId !== p.runId)
        throw new MeshError('STALE_RUN', 'Retired run');
    },
    events: async (input, tx) => {
      if (input.kind === 'message.uptake.recorded' && failTrace) {
        failTrace = false;
        throw new Error('Injected uptake trace failure');
      }
      return tracer.emit(input, tx);
    },
  });
  const message = {
    messageId: 'message-1',
    role: 'ROLE_USER',
    parts: [
      {
        data: { constraints: { retry: 'Preserve the original message identity.', 'a/b~c': null } },
      },
    ],
  };
  for (const recipient of ['A2', 'A3']) {
    await db.query(
      `INSERT INTO a2a_tasks(task_id,mission_id,recipient_id,sender_id,context_id,state,task,trace_id)
       VALUES($1,'m1',$2,'A1','context',1,'{}',$3)`,
      [`task-${recipient}`, recipient, `trace-${recipient}`],
    );
    await db.query(
      `INSERT INTO mailbox_deliveries(delivery_id,mission_id,sender_id,recipient_id,message_id,task_id,message,kind,trace_id)
       VALUES($1,'m1','A1',$2,'message-1',$3,$4::jsonb,'question',$5)`,
      [
        `delivery-${recipient}`,
        recipient,
        `task-${recipient}`,
        JSON.stringify(message),
        `trace-${recipient}`,
      ],
    );
    await tracer.emit({
      missionId: 'm1',
      agentId: 'A1',
      kind: 'message.mailbox.persisted',
      messageId: 'message-1',
      taskId: `task-${recipient}`,
      traceId: `trace-${recipient}`,
      data: { recipientId: recipient, deliveryId: `delivery-${recipient}` },
    });
  }
  const input = (change: Partial<UptakeInput> = {}): UptakeInput => ({
    uptakeId: 'u1',
    deliveryId: 'delivery-A2',
    selector: '/parts/0/data/constraints/retry',
    status: 'unchanged_confirmed',
    grounds: 'The requirement already matches this plan.',
    evidenceRefs: ['spec:retries@revision-4'],
    dependencyRefs: ['work:delivery'],
    ...change,
  });
  return {
    db,
    service,
    principal,
    input,
    message,
    failNextTrace() {
      failTrace = true;
    },
    rotate() {
      const old = principal();
      const next = { ...old, generation: old.generation + 1, runId: `${old.runId}-next` };
      active.set(`${old.missionId}:${old.agentId}`, next);
      return next;
    },
    close: () => db.close(),
  };
}

test('uptake is receiver-owned, survives run replacement and is independent from handling', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const p = f.principal();
  assert.equal((await f.service.listUptakes(p, f.input())).total, 0);
  await f.service.poll(p);
  await f.service.ack(p, { deliveryId: 'delivery-A2' });
  assert.equal((await f.service.listUptakes(p, f.input())).total, 0);
  const before = (await f.db.query('SELECT revision FROM missions WHERE id=$1', ['m1'])).rows[0];
  const recorded = await f.service.recordUptake(p, f.input());
  assert.equal(recorded.replayed, false);
  assert.equal(recorded.uptake.receiverId, 'A2');
  assert.equal(
    recorded.uptake.selectedHash,
    createHash('sha256')
      .update(JSON.stringify(f.message.parts[0].data.constraints.retry))
      .digest('hex'),
  );
  assert.equal(recorded.uptake.status, 'unchanged_confirmed');
  assert.deepEqual(recorded.uptake.evidenceRefs, ['spec:retries@revision-4']);
  assert.deepEqual(
    (await f.db.query('SELECT revision FROM missions WHERE id=$1', ['m1'])).rows[0],
    before,
  );
  assert.deepEqual(
    (
      await f.db.query('SELECT message,disposition FROM mailbox_deliveries WHERE delivery_id=$1', [
        'delivery-A2',
      ])
    ).rows[0],
    { message: f.message, disposition: 'handled' },
  );
  assert.equal(
    (await f.db.query('SELECT state FROM a2a_tasks WHERE task_id=$1', ['task-A2'])).rows[0].state,
    1,
  );
  for (const other of [f.principal('A1'), f.principal('A3'), f.principal('A2', 'm2')]) {
    await assert.rejects(f.service.recordUptake(other, f.input()), { code: 'NOT_FOUND' });
    await assert.rejects(f.service.listUptakes(other, f.input()), { code: 'NOT_FOUND' });
  }
  // Another receiver may use the same local ID for its own delivered copy.
  await f.service.recordUptake(f.principal('A3'), f.input({ deliveryId: 'delivery-A3' }));
  const next = f.rotate();
  await assert.rejects(f.service.recordUptake(p, f.input()), { code: 'STALE_RUN' });
  await assert.rejects(f.service.listUptakes(p, f.input()), { code: 'STALE_RUN' });
  assert.deepEqual(await f.service.recordUptake(next, f.input()), { ...recorded, replayed: true });
  assert.equal((await f.service.listUptakes(next, f.input())).uptakes[0].runId, p.runId);
});

test('reconsideration appends one current-head successor, including racing proposals and old retries', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const p = f.principal();
  await f.service.recordUptake(p, f.input());
  const contenders = ['u2', 'u3'].map((uptakeId) =>
    f.service.recordUptake(
      p,
      f.input({
        uptakeId,
        supersedesId: 'u1',
        status: 'contested',
        grounds: 'A new source conflicts with the premise.',
      }),
    ),
  );
  const outcomes = await Promise.allSettled(contenders);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = outcomes.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failed.reason.code, 'UPTAKE_HEAD_CONFLICT');
  const history = await f.service.listUptakes(p, f.input());
  assert.equal(history.total, 2);
  assert.equal(history.uptakes[0].status, 'unchanged_confirmed');
  assert.equal(history.uptakes[1].status, 'contested');
  assert.equal(history.uptakes[1].supersedesId, 'u1');
  assert.equal((await f.service.recordUptake(p, f.input())).replayed, true);
  await assert.rejects(f.service.recordUptake(p, f.input({ grounds: 'Changed content' })), {
    code: 'UPTAKE_CONFLICT',
  });
  await assert.rejects(f.service.recordUptake(p, f.input({ uptakeId: 'u4', supersedesId: 'u1' })), {
    code: 'UPTAKE_HEAD_CONFLICT',
  });
  await assert.rejects(
    f.service.recordUptake(
      p,
      f.input({ uptakeId: 'u4', selector: '', supersedesId: history.currentUptakeId! }),
    ),
    { code: 'UPTAKE_HEAD_CONFLICT' },
  );
  const rows = await f.db.query('SELECT data FROM trace_events WHERE kind=$1 ORDER BY seq', [
    'message.uptake.recorded',
  ]);
  assert.equal(rows.rowCount, 2);
  assert.equal((rows.rows[0].data as any).status, 'unchanged_confirmed');
});

test('selectors pin real JSON values and malformed or unbounded declarations are rejected', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const p = f.principal();
  for (const selector of [
    'parts',
    '/parts/01',
    '/parts/-1',
    '/parts/1',
    '/parts/0/constructor',
    '/parts/0/~2',
    '/missing',
    '/parts/0/data/constraints/retry/nope',
  ])
    await assert.rejects(f.service.recordUptake(p, f.input({ selector })), {
      code: 'INVALID_UPTAKE_SELECTOR',
    });
  for (const invalid of [
    { status: 'adopted' },
    { grounds: ' ' },
    { grounds: 'a'.repeat(4097) },
    { evidenceRefs: Array(17).fill('ref') },
    { dependencyRefs: [''] },
  ])
    await assert.rejects(f.service.recordUptake(p, f.input(invalid as Partial<UptakeInput>)), {
      code: 'INVALID_UPTAKE',
    });
  await assert.rejects(
    f.service.listUptakes(p, { deliveryId: 'delivery-A2', beforeRevision: NaN }),
    { code: 'INVALID_UPTAKE' },
  );
  const escaped = await f.service.recordUptake(
    p,
    f.input({ selector: '/parts/0/data/constraints/a~1b~0c' }),
  );
  assert.equal(escaped.uptake.selectedHash, createHash('sha256').update('null').digest('hex'));
  // A source can be selected before poll; a record does not pretend to prove exposure or understanding.
  assert.equal((await f.db.query('SELECT * FROM mailbox_offers')).rowCount, 0);
  assert.equal(
    (
      await f.db.query('SELECT disposition FROM mailbox_deliveries WHERE delivery_id=$1', [
        'delivery-A2',
      ])
    ).rows[0].disposition,
    null,
  );
});

test('uptake persistence rolls back with its trace event', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.failNextTrace();
  await assert.rejects(
    f.service.recordUptake(f.principal(), f.input()),
    /Injected uptake trace failure/,
  );
  assert.equal((await f.db.query('SELECT * FROM message_uptakes')).rowCount, 0);
  assert.equal(
    (await f.db.query('SELECT * FROM trace_events WHERE kind=$1', ['message.uptake.recorded']))
      .rowCount,
    0,
  );
  assert.equal((await f.service.recordUptake(f.principal(), f.input())).replayed, false);
});

test('uptake history pages without losing superseded records and conversation inspection is bounded', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (let revision = 1; revision <= 32; revision++)
    await f.service.recordUptake(
      f.principal(),
      f.input({
        uptakeId: `u${revision}`,
        supersedesId: revision === 1 ? undefined : `u${revision - 1}`,
        status: revision === 32 ? 'unresolved' : 'narrowed',
      }),
    );
  const last = await f.service.listUptakes(f.principal(), { ...f.input(), limit: 16 });
  assert.equal(last.total, 32);
  assert.equal(last.currentUptakeId, 'u32');
  assert.deepEqual(
    last.uptakes.map((u) => u.revision),
    Array.from({ length: 16 }, (_, i) => i + 17),
  );
  assert.equal(last.nextBeforeRevision, 17);
  const older = await f.service.listUptakes(f.principal(), {
    ...f.input(),
    beforeRevision: last.nextBeforeRevision!,
  });
  assert.deepEqual(
    older.uptakes.map((u) => u.revision),
    Array.from({ length: 16 }, (_, i) => i + 1),
  );
  assert.equal(older.nextBeforeRevision, null);
  const page = await listConversationMessages(f.db, 'm1', { agent: 'A2' });
  assert.equal(page.messages.length, 1);
  const message = page.messages[0];
  assert.equal(message.lifecycle.state, 'received');
  assert.equal(message.delivery!.acknowledgements.total, 0);
  assert.equal(message.delivery!.uptakes.total, 32);
  assert.equal(message.delivery!.uptakes.items.length, 20);
  assert.equal(message.delivery!.uptakes.truncated, true);
  assert.equal(message.delivery!.uptakes.items.at(-1)!.status, 'unresolved');
  const timeline = await conversationTimeline(f.db, 'm1', { task: 'task-A2' });
  assert.equal(timeline.events.filter((e) => e.kind === 'message.uptake.recorded').length, 32);
  assert.equal((await listConversationMessages(f.db, 'm2')).messages.length, 0);
});

test('read-only conversation inspection reports legacy schema absence and propagates real read failures', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.db.query('DROP TABLE message_uptakes');
  const legacy = await listConversationMessages(f.db, 'm1', { agent: 'A2' });
  assert.equal(legacy.messages[0].delivery!.uptakes.available, false);
  assert.equal(legacy.messages[0].delivery!.uptakes.total, 0);
  assert.match(legacy.messages[0].warnings.join(' '), /Uptake history is unavailable/);
  assert.equal(
    (await f.db.query("SELECT to_regclass('message_uptakes') AS relation")).rows[0].relation,
    null,
  );
  await f.db.query(A2A_SCHEMA);
  const failing: Sql = {
    query: async (sql, args) => {
      if (sql.includes('FROM message_uptakes')) throw new Error('Deliberate uptake read failure');
      return f.db.query(sql, args);
    },
  };
  await assert.rejects(listConversationMessages(failing, 'm1'), /Deliberate uptake read failure/);
});
