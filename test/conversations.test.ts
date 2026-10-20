import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { A2A_SCHEMA } from '../src/a2a.js';
import {
  CONVERSATION_STATES,
  conversationTimeline,
  listConversationMessages,
} from '../src/conversations.js';
import { CORE_SCHEMA } from '../src/schema.js';
import { registerSecret } from '../src/trace.js';
import type { TraceInput } from '../src/types.js';
import { TestDatabase } from './helpers.js';

const at = (milliseconds = 0) =>
  new Date(Date.parse('2026-01-01T00:00:00.000Z') + milliseconds).toISOString();
type RecordValue = Record<string, unknown>;
interface Envelope {
  missionId: string;
  senderId: string;
  recipientId: string;
  messageId: string;
  outboxId: string;
  traceId: string;
  request: RecordValue;
  principal: RecordValue;
  taskId?: string;
  deliveryId?: string;
}

async function fixture() {
  const db = new TestDatabase();
  await db.query(CORE_SCHEMA + A2A_SCHEMA);
  for (const missionId of ['m1', 'm2']) {
    await db.query(
      `INSERT INTO missions(id,repo,roadmap_path,roadmap_text,roadmap_hash,baseline)
      VALUES($1,$2,'ROADMAP.md','A roadmap','hash','{}'::jsonb)`,
      [missionId, `/checkout/${missionId}`],
    );
  }
  async function event(input: TraceInput, milliseconds = 0) {
    return db.transaction(async (tx) => {
      const seq = (
        await tx.query<{ seq: string }>(
          'UPDATE missions SET next_event_seq=next_event_seq+1 WHERE id=$1 RETURNING next_event_seq::text AS seq',
          [input.missionId],
        )
      ).rows[0]!.seq;
      const id = randomUUID();
      await tx.query(
        `INSERT INTO trace_events(id,mission_id,seq,at,kind,agent_id,run_id,trace_id,span_id,message_id,task_id,data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          id,
          input.missionId,
          seq,
          at(milliseconds),
          input.kind,
          input.agentId ?? null,
          input.runId ?? null,
          input.traceId ?? null,
          input.spanId ?? null,
          input.messageId ?? null,
          input.taskId ?? null,
          JSON.stringify(input.data ?? {}),
        ],
      );
      return { id, seq };
    });
  }
  async function intent(
    messageId: string,
    options: {
      missionId?: string;
      senderId?: string;
      recipientId?: string;
      state?: string;
      attempts?: number;
      result?: unknown;
      error?: unknown;
      parts?: unknown[];
      taskId?: string;
    } = {},
  ): Promise<Envelope> {
    const missionId = options.missionId ?? 'm1';
    const senderId = options.senderId ?? 'A1';
    const recipientId = options.recipientId ?? 'A2';
    const outboxId = randomUUID();
    const traceId = randomUUID();
    const principal = {
      missionId,
      agentId: senderId,
      runId: `${missionId}-${senderId}-run1`,
      generation: 1,
    };
    const request = {
      tenant: missionId,
      configuration: { returnImmediately: true },
      message: {
        messageId,
        role: 'ROLE_USER',
        parts: options.parts ?? [{ text: `Question ${messageId}` }],
        metadata: { mesh: { kind: 'question' } },
        ...(options.taskId ? { taskId: options.taskId } : {}),
      },
    };
    await db.query(
      `INSERT INTO a2a_outbox(outbox_id,mission_id,sender_id,recipient_id,message_id,principal,request,payload_hash,
      trace_id,state,attempts,result,last_error,created_at,next_attempt_at,delivered_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'hash',$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15)`,
      [
        outboxId,
        missionId,
        senderId,
        recipientId,
        messageId,
        JSON.stringify(principal),
        JSON.stringify(request),
        traceId,
        options.state ?? 'pending',
        options.attempts ?? 0,
        JSON.stringify(options.result ?? null),
        JSON.stringify(options.error ?? null),
        at(),
        at(3000),
        options.state === 'delivered' ? at(300) : null,
      ],
    );
    await event({
      missionId,
      agentId: senderId,
      runId: String(principal.runId),
      traceId,
      messageId,
      kind: 'message.send.accepted',
      data: { outboxId, recipientId, request },
    });
    return { missionId, senderId, recipientId, outboxId, traceId, messageId, request, principal };
  }
  async function accept(
    envelope: Envelope,
    options: { taskId?: string; milliseconds?: number; kind?: string } = {},
  ) {
    const taskId = options.taskId ?? randomUUID();
    const contextId = `context-${taskId}`;
    const deliveryId = randomUUID();
    const ms = options.milliseconds ?? 100;
    const message = { ...(envelope.request.message as RecordValue), taskId, contextId };
    const task = {
      id: taskId,
      contextId,
      status: { state: 'TASK_STATE_WORKING' },
      history: [message],
    };
    await db.query(
      `INSERT INTO a2a_tasks(task_id,mission_id,recipient_id,sender_id,context_id,state,task,trace_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,2,$6::jsonb,$7,$8,$8) ON CONFLICT(task_id) DO NOTHING`,
      [
        taskId,
        envelope.missionId,
        envelope.recipientId,
        envelope.senderId,
        contextId,
        JSON.stringify(task),
        envelope.traceId,
        at(ms),
      ],
    );
    await db.query(
      `INSERT INTO a2a_messages(mission_id,sender_id,recipient_id,message_id,task_id,run_id,generation,payload_hash,
      message,accepted_result,kind,trace_id,created_at) VALUES($1,$2,$3,$4,$5,$6,1,'hash',$7::jsonb,$8::jsonb,$9,$10,$11)`,
      [
        envelope.missionId,
        envelope.senderId,
        envelope.recipientId,
        envelope.messageId,
        taskId,
        envelope.principal.runId,
        JSON.stringify(message),
        JSON.stringify(task),
        options.kind ?? 'question',
        envelope.traceId,
        at(ms),
      ],
    );
    await db.query(
      `INSERT INTO mailbox_deliveries(delivery_id,mission_id,sender_id,recipient_id,message_id,task_id,message,kind,trace_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
      [
        deliveryId,
        envelope.missionId,
        envelope.senderId,
        envelope.recipientId,
        envelope.messageId,
        taskId,
        JSON.stringify(message),
        options.kind ?? 'question',
        envelope.traceId,
        at(ms),
      ],
    );
    await event(
      {
        missionId: envelope.missionId,
        agentId: envelope.senderId,
        runId: String(envelope.principal.runId),
        traceId: envelope.traceId,
        messageId: envelope.messageId,
        taskId,
        kind: 'message.mailbox.persisted',
        data: { deliveryId, recipientId: envelope.recipientId, message },
      },
      ms,
    );
    await event(
      {
        missionId: envelope.missionId,
        agentId: envelope.senderId,
        runId: String(envelope.principal.runId),
        traceId: envelope.traceId,
        messageId: envelope.messageId,
        taskId,
        kind: options.kind === 'answer' ? 'message.reply.accepted' : 'message.ingress.accepted',
        data: { deliveryId, recipientId: envelope.recipientId, message, task },
      },
      ms,
    );
    Object.assign(envelope, { taskId, deliveryId });
    return { taskId, deliveryId, message, task };
  }
  async function attempt(
    envelope: Envelope,
    number: number,
    options: { error?: unknown; result?: unknown; unfinished?: boolean } = {},
  ) {
    const attemptId = randomUUID();
    await db.query(
      `INSERT INTO a2a_outbox_attempts(attempt_id,outbox_id,started_at,ended_at,result,error)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [
        attemptId,
        envelope.outboxId,
        at(number * 10),
        options.unfinished ? null : at(number * 10 + 5),
        JSON.stringify(options.result ?? null),
        JSON.stringify(options.error ?? null),
      ],
    );
    await event(
      {
        missionId: envelope.missionId,
        agentId: envelope.senderId,
        runId: String(envelope.principal.runId),
        traceId: envelope.traceId,
        messageId: envelope.messageId,
        kind: 'message.delivery.started',
        data: {
          outboxId: envelope.outboxId,
          attemptId,
          attempt: number,
          request: envelope.request,
          recipientId: envelope.recipientId,
        },
      },
      number * 10,
    );
    if (!options.unfinished)
      await event(
        {
          missionId: envelope.missionId,
          agentId: envelope.senderId,
          runId: String(envelope.principal.runId),
          traceId: envelope.traceId,
          messageId: envelope.messageId,
          kind: options.error ? 'message.delivery.retry_scheduled' : 'message.delivery.accepted',
          data: {
            outboxId: envelope.outboxId,
            attemptId,
            result: options.result ?? null,
            error: options.error ?? null,
          },
        },
        number * 10 + 5,
      );
  }
  async function offer(envelope: Envelope, runId: string, milliseconds: number) {
    await db.query('INSERT INTO mailbox_offers(delivery_id,run_id,offered_at) VALUES($1,$2,$3)', [
      envelope.deliveryId,
      runId,
      at(milliseconds),
    ]);
    await event(
      {
        missionId: envelope.missionId,
        agentId: envelope.recipientId,
        runId,
        traceId: envelope.traceId,
        taskId: envelope.taskId,
        messageId: envelope.messageId,
        kind: 'message.offered',
        data: {
          deliveryId: envelope.deliveryId,
          senderId: envelope.senderId,
          message: envelope.request.message,
        },
      },
      milliseconds,
    );
  }
  async function ack(
    envelope: Envelope,
    runId: string,
    milliseconds: number,
    disposition = 'handled',
  ) {
    await db.query(
      `UPDATE mailbox_deliveries SET disposition=$1,disposition_reason='recorded reason',handled_run_id=$2,handled_at=$3
      WHERE delivery_id=$4`,
      [
        disposition,
        runId,
        disposition === 'deferred' ? null : at(milliseconds),
        envelope.deliveryId,
      ],
    );
    return event(
      {
        missionId: envelope.missionId,
        agentId: envelope.recipientId,
        runId,
        traceId: envelope.traceId,
        taskId: envelope.taskId,
        messageId: envelope.messageId,
        kind: 'message.acknowledged',
        data: { deliveryId: envelope.deliveryId, disposition, reason: 'recorded reason' },
      },
      milliseconds,
    );
  }
  return { db, event, intent, accept, attempt, offer, ack };
}

test('conversation inspection includes undelivered intents, full bodies, failures, and independently redacted output', async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const secret = 'conversation-fixture-credential';
  registerSecret(secret);
  const parts = [
    { text: `Line one\n相談: Δ🙂\n${'long payload '.repeat(1000)}\nBearer ${secret}` },
    { data: { nested: [false, 0, null, { exact: '✓' }], password: 'remove-me' } },
    { file: { name: 'example.bin', bytes: 'AAECA/8=', mimeType: 'application/octet-stream' } },
  ];
  const queued = await f.intent('queued', { parts });
  const retry = await f.intent('retry', {
    attempts: 1,
    error: { message: `transport ${secret}`, code: 'TIMEOUT' },
  });
  await f.attempt(retry, 1, { error: { message: `transport ${secret}`, code: 'TIMEOUT' } });
  const sending = await f.intent('sending', { state: 'sending', attempts: 1 });
  await f.attempt(sending, 1, { unfinished: true });
  const failed = await f.intent('failed', {
    state: 'failed',
    attempts: 1,
    error: { message: 'Task not found', code: -32001 },
  });
  await f.attempt(failed, 1, { error: { code: -32001 } });
  const other = await f.intent('other-mission', { missionId: 'm2' });
  const result = await listConversationMessages(f.db, 'm1');
  assert.equal(result.messages.length, 4);
  const byId = new Map(result.messages.map((m) => [m.messageId, m]));
  assert.equal(byId.get('queued')!.lifecycle.state, 'queued');
  assert.equal(byId.get('retry')!.lifecycle.state, 'retrying');
  assert.equal(byId.get('sending')!.lifecycle.state, 'sending');
  assert.equal(byId.get('failed')!.lifecycle.state, 'delivery-rejected');
  assert.equal(byId.get('queued')!.delivery, null);
  assert.equal(byId.get('queued')!.taskId, null);
  assert.deepEqual(byId.get('queued')!.outbox!.originalPrincipal, queued.principal);
  const visibleParts = (byId.get('queued')!.message as { parts: typeof parts }).parts;
  assert.equal(visibleParts[0]!.text, parts[0]!.text!.replace(secret, '[REDACTED]'));
  assert.deepEqual(visibleParts[1]!.data, {
    nested: [false, 0, null, { exact: '✓' }],
    password: '[REDACTED]',
  });
  assert.deepEqual(visibleParts[2], parts[2]);
  assert.equal(byId.get('retry')!.outbox!.history.items[0]!.durationMs, 5);
  assert.equal(
    (byId.get('retry')!.outbox!.lastError as RecordValue).message,
    'transport [REDACTED]',
  );
  assert.equal(byId.get('sending')!.outbox!.history.items[0]!.durationMs, null);
  assert.match(byId.get('sending')!.warnings.join(' '), /no recorded end/);
  assert.equal(byId.get('queued')!.timings.firstExposureMs, null);
  assert.equal(byId.get('failed')!.timings.pendingAgeMs, null);
  assert.equal(
    (await listConversationMessages(f.db, 'm1', { state: 'retrying' })).messages[0]!.messageId,
    'retry',
  );
  assert.equal(
    (await listConversationMessages(f.db, 'm1', { outbox: other.outboxId })).messages.length,
    0,
  );
  const stored = (
    await f.db.query<{ request: unknown }>('SELECT request FROM a2a_outbox WHERE outbox_id=$1', [
      queued.outboxId,
    ])
  ).rows[0]!.request;
  assert.deepEqual(stored, queued.request, 'inspection never mutates stored protocol content');
  assert.equal(CONVERSATION_STATES.includes('delivery-rejected'), true);
  await assert.rejects(listConversationMessages(f.db, 'm1', { state: 'not-a-state' }), {
    code: 'INVALID_FILTER',
  });
});

test('conversation timeline correlates delivery, exposure, deferred/final acknowledgement, and replies without run-wide leakage', async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const q = await f.intent('shared-id', { state: 'delivered', attempts: 2 });
  const received = await f.accept(q);
  await f.db.query('UPDATE a2a_outbox SET result=$1::jsonb WHERE outbox_id=$2', [
    JSON.stringify(received.task),
    q.outboxId,
  ]);
  await f.attempt(q, 1, { error: { message: 'Reply lost after persistence' } });
  await f.attempt(q, 2, { result: received.task });
  await f.offer(q, 'A2-run1', 400);
  await f.ack(q, 'A2-run1', 500, 'deferred');
  await f.offer(q, 'A2-run2', 600);
  await f.ack(q, 'A2-run2', 800);
  const reply: Envelope = {
    ...q,
    senderId: 'A2',
    recipientId: 'A1',
    messageId: 'answer',
    principal: { missionId: 'm1', agentId: 'A2', runId: 'A2-run2', generation: 2 },
    request: {
      message: {
        messageId: 'answer',
        role: 'ROLE_AGENT',
        parts: [{ text: 'Detailed answer\nIncluding context.' }],
      },
    },
  };
  await f.accept(reply, { taskId: received.taskId, milliseconds: 700, kind: 'answer' });
  await f.db.query('UPDATE a2a_tasks SET state=3 WHERE task_id=$1', [received.taskId]);
  const polled = await f.event(
    {
      missionId: 'm1',
      agentId: 'A2',
      runId: 'A2-run2',
      traceId: 'poll-trace',
      spanId: 'poll-span',
      kind: 'mailbox.polled',
      data: { messages: [{ deliveryId: q.deliveryId, messageId: q.messageId }] },
    },
    600,
  );
  const pollWrapper = await f.event(
    {
      missionId: 'm1',
      agentId: 'A2',
      runId: 'A2-run2',
      traceId: 'mcp-poll-wrapper',
      spanId: 'poll-span',
      kind: 'tool.mesh_poll.completed',
      data: { result: { messages: [{ deliveryId: q.deliveryId }] } },
    },
    600,
  );
  const unrelated = await f.intent('shared-id', { senderId: 'A1', recipientId: 'A3' });
  await f.accept(unrelated);
  const invalidReference = await f.intent('invalid-task-reference', {
    senderId: 'A3',
    recipientId: 'A2',
    state: 'failed',
    taskId: received.taskId,
  });
  await f.event(
    {
      missionId: 'm1',
      agentId: 'A1',
      runId: String(q.principal.runId),
      traceId: 'unrelated-write',
      kind: 'tool.unrelated.completed',
      data: { privateTopic: 'outside this conversation' },
    },
    900,
  );
  const foreign = await f.intent('shared-id', { missionId: 'm2' });
  await f.accept(foreign);

  const messages = await listConversationMessages(f.db, 'm1', { task: received.taskId });
  assert.equal(messages.messages.length, 2);
  const original = messages.messages.find((m) => m.messageId === q.messageId)!;
  const answer = messages.messages.find((m) => m.messageId === 'answer')!;
  assert.equal(original.lifecycle.state, 'handled');
  assert.equal(original.lifecycle.transport, 'delivered');
  assert.equal(original.lifecycle.task, 'completed');
  assert.equal(original.lifecycle.taskReplyCount, 1);
  assert.equal(
    answer.lifecycle.state,
    'received',
    'task completion does not assert mailbox handling',
  );
  assert.equal(answer.lifecycle.transport, 'none');
  assert.equal(original.delivery!.exposures.total, 2);
  assert.deepEqual(
    original.delivery!.acknowledgements.items.map((a) => a.disposition),
    ['deferred', 'handled'],
  );
  assert.deepEqual(original.timings, {
    unit: 'milliseconds',
    basis: 'recorded-wall-clock',
    transportReceiptMs: 300,
    recipientPersistenceMs: 100,
    firstExposureMs: 300,
    firstAcknowledgementMs: 400,
    finalAcknowledgementMs: 700,
    firstTaskReplyMs: 700,
    pendingAgeMs: null,
    negativeIntervals: [],
  });
  assert.equal(original.outbox!.history.total, 2);
  assert.equal(
    original.ingress!.message && (original.ingress!.message as RecordValue).contextId,
    `context-${received.taskId}`,
  );
  const timeline = await conversationTimeline(f.db, 'm1', { outbox: q.outboxId });
  assert(timeline.events.some((e) => e.messageId === 'answer'));
  assert(timeline.events.some((e) => e.id === polled.id));
  assert(timeline.events.some((e) => e.id === pollWrapper.id));
  assert(timeline.events.every((e) => e.missionId === 'm1'));
  assert(
    !timeline.events.some(
      (e) => e.traceId === unrelated.traceId || e.traceId === 'unrelated-write',
    ),
  );
  assert(timeline.events.some((e) => e.kind === 'message.delivery.retry_scheduled'));
  assert(
    timeline.events.some(
      (e) =>
        e.kind === 'message.reply.accepted' &&
        JSON.stringify(e.data).includes('Detailed answer\\nIncluding context.'),
    ),
  );
  const invalid = await listConversationMessages(f.db, 'm1', { outbox: invalidReference.outboxId });
  assert.equal(
    invalid.messages[0]!.taskId,
    null,
    'an unauthorized requested task is not an accepted conversation link',
  );
  assert.equal(
    (invalid.messages[0]!.outbox!.request as { message: { taskId: string } }).message.taskId,
    received.taskId,
  );
  const invalidTimeline = await conversationTimeline(f.db, 'm1', {
    outbox: invalidReference.outboxId,
  });
  assert(!invalidTimeline.events.some((e) => e.taskId === received.taskId));
});

test('native task/message handles include the selected item without expanding its whole run or another run with the same item ID', async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const q = await f.intent('native-message');
  await f.accept(q);
  const runId = String(q.principal.runId);
  const started = await f.event({
    missionId: 'm1',
    agentId: 'A1',
    runId,
    traceId: runId,
    spanId: 'item_0',
    messageId: q.messageId,
    kind: 'codex.item.started',
    data: {
      event: {
        item: {
          id: 'item_0',
          server: 'mesh',
          tool: 'mesh_send',
          arguments: { recipientId: 'A2', messageId: q.messageId },
        },
      },
    },
  });
  const completed = await f.event({
    missionId: 'm1',
    agentId: 'A1',
    runId,
    traceId: runId,
    spanId: 'item_0',
    taskId: q.taskId,
    kind: 'codex.item.completed',
    data: { event: { item: { id: 'item_0', result: { taskId: q.taskId } } } },
  });
  const progress = await f.event({
    missionId: 'm1',
    agentId: 'A1',
    runId,
    traceId: runId,
    spanId: 'item_0',
    kind: 'codex.item.updated',
    data: { event: { item: { id: 'item_0', progress: 'Waiting on transport' } } },
  });
  const unrelated = await f.event({
    missionId: 'm1',
    agentId: 'A1',
    runId,
    traceId: runId,
    spanId: 'item_1',
    kind: 'codex.item.completed',
    data: { event: { item: { id: 'item_1', text: 'Unrelated work' } } },
  });
  const otherRun = await f.event({
    missionId: 'm1',
    agentId: 'A3',
    runId: 'A3-run1',
    traceId: 'A3-run1',
    spanId: 'item_0',
    kind: 'codex.item.completed',
    data: { event: { item: { id: 'item_0', text: 'Other peer work' } } },
  });
  const timeline = await conversationTimeline(f.db, 'm1', { outbox: q.outboxId });
  const ids = new Set(timeline.events.map((event) => event.id));
  assert(ids.has(started.id));
  assert(ids.has(completed.id));
  assert(ids.has(progress.id));
  assert(!ids.has(unrelated.id));
  assert(!ids.has(otherRun.id));

  const queued = await f.intent('native-still-queued');
  const queuedNative = await f.event({
    missionId: 'm1',
    agentId: 'A1',
    runId,
    traceId: runId,
    spanId: 'item_2',
    messageId: queued.messageId,
    kind: 'codex.item.started',
    data: {
      event: {
        item: {
          id: 'item_2',
          server: 'mesh',
          tool: 'mesh_send',
          arguments: { recipientId: 'A2', messageId: queued.messageId },
        },
      },
    },
  });
  const toolStarted = await f.event({
    missionId: 'm1',
    agentId: 'A1',
    runId,
    traceId: 'tool-send-trace',
    spanId: 'tool-send-span',
    kind: 'tool.mesh_send.started',
    data: { arguments: { recipientId: 'A2' } },
  });
  const toolCompleted = await f.event({
    missionId: 'm1',
    agentId: 'A1',
    runId,
    traceId: 'tool-send-trace',
    spanId: 'tool-send-span',
    kind: 'tool.mesh_send.completed',
    data: { result: { outboxId: queued.outboxId, messageId: queued.messageId, state: 'pending' } },
  });
  const pendingTimeline = await conversationTimeline(f.db, 'm1', { outbox: queued.outboxId });
  const pendingIds = new Set(pendingTimeline.events.map((event) => event.id));
  assert(
    pendingIds.has(queuedNative.id),
    'native recipient arguments correlate before the task exists',
  );
  assert(pendingIds.has(toolStarted.id));
  assert(
    pendingIds.has(toolCompleted.id),
    'generated message IDs correlate through the returned outbox ID',
  );
  assert(!pendingIds.has(started.id));
  assert(!pendingIds.has(unrelated.id));
});

test('keyset cursors are mission/filter/kind bound, bigint safe, and exclude later arrivals while merging outbox/ingress identity', async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.db.query("UPDATE missions SET next_event_seq=9007199254740992 WHERE id='m1'");
  const a = await f.intent('a');
  const b = await f.intent('b');
  const c = await f.intent('c');
  const page1 = await listConversationMessages(f.db, 'm1', { agent: 'A1', limit: 1 });
  assert.equal(page1.messages[0]!.messageId, 'c');
  assert.equal(page1.messages[0]!.firstSeq, '9007199254740995');
  assert.equal(page1.snapshotSeq, '9007199254740995');
  assert(page1.nextCursor);
  await f.accept(b);
  await f.intent('later');
  const page2 = await listConversationMessages(f.db, 'm1', {
    agent: 'A1',
    cursor: page1.nextCursor,
    limit: 1,
  });
  assert.equal(page2.messages[0]!.messageId, 'b');
  assert.equal(page2.messages[0]!.lifecycle.state, 'received');
  assert.equal(page2.snapshotSeq, page1.snapshotSeq);
  const page3 = await listConversationMessages(f.db, 'm1', {
    agent: 'A1',
    cursor: page2.nextCursor!,
    limit: 1,
  });
  assert.equal(page3.messages[0]!.messageId, 'a');
  assert.equal(page3.nextCursor, null);
  assert.equal(
    (await listConversationMessages(f.db, 'm1', { message: b.messageId })).messages.length,
    1,
  );
  await assert.rejects(
    listConversationMessages(f.db, 'm2', { agent: 'A1', cursor: page1.nextCursor! }),
    { code: 'INVALID_CURSOR' },
  );
  await assert.rejects(
    listConversationMessages(f.db, 'm1', { agent: 'A2', cursor: page1.nextCursor! }),
    { code: 'INVALID_CURSOR' },
  );
  await assert.rejects(
    conversationTimeline(f.db, 'm1', { agent: 'A1', cursor: page1.nextCursor! }),
    { code: 'INVALID_CURSOR' },
  );
  await assert.rejects(listConversationMessages(f.db, 'm1', { cursor: 'invalid_opaque_cursor' }), {
    code: 'INVALID_CURSOR',
  });
  await assert.rejects(listConversationMessages(f.db, 'm1', { limit: 201 }), {
    code: 'INVALID_LIMIT',
  });
  await assert.rejects(conversationTimeline(f.db, 'm1', { limit: 1001 }), {
    code: 'INVALID_LIMIT',
  });
  const events1 = await conversationTimeline(f.db, 'm1', { outbox: b.outboxId, limit: 1 });
  assert(events1.nextCursor);
  const late = await f.event({
    missionId: 'm1',
    agentId: 'A1',
    traceId: b.traceId,
    messageId: b.messageId,
    kind: 'message.send.replayed',
    data: { outboxId: b.outboxId },
  });
  const events2 = await conversationTimeline(f.db, 'm1', {
    outbox: b.outboxId,
    cursor: events1.nextCursor!,
  });
  assert(events2.events.every((e) => BigInt(e.seq) > BigInt(events1.events[0]!.seq)));
  assert(!events2.events.some((e) => e.id === late.id));
  assert.equal(events2.snapshotSeq, events1.snapshotSeq);
  assert.equal(events2.nextCursor, null);
  assert(a.outboxId && c.outboxId);
});

test('bounded per-message histories advertise truncation while the timeline retains every exposure and acknowledgement', async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const q = await f.intent('many-exposures');
  await f.accept(q);
  for (let i = 1; i <= 23; i++) {
    await f.offer(q, `A2-run${i}`, 100 + i * 10);
    await f.ack(q, `A2-run${i}`, 105 + i * 10, 'deferred');
  }
  const result = (await listConversationMessages(f.db, 'm1', { outbox: q.outboxId })).messages[0]!;
  assert.equal(result.lifecycle.state, 'deferred');
  assert.equal(result.delivery!.exposures.total, 23);
  assert.equal(result.delivery!.exposures.items.length, 20);
  assert.equal(result.delivery!.exposures.items[0]!.runId, 'A2-run4');
  assert.equal(result.delivery!.exposures.truncated, true);
  assert.equal(result.delivery!.acknowledgements.total, 23);
  assert.equal(result.delivery!.acknowledgements.truncated, true);
  assert.equal(
    result.timings.firstExposureMs,
    10,
    'first exposure uses full history, not the retained summary window',
  );
  assert.equal(result.timings.firstAcknowledgementMs, 15);
  let cursor: string | undefined;
  const ids: string[] = [];
  const kinds: string[] = [];
  do {
    const page = await conversationTimeline(f.db, 'm1', { task: q.taskId, cursor, limit: 7 });
    ids.push(...page.events.map((e) => e.id));
    kinds.push(...page.events.map((e) => e.kind));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(kinds.filter((kind) => kind === 'message.offered').length, 23);
  assert.equal(kinds.filter((kind) => kind === 'message.acknowledged').length, 23);
});
