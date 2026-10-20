import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import express, { type RequestHandler, type Router } from 'express';
import {
  AgentCard,
  Message,
  SendMessageRequest,
  GetTaskRequest,
  ListTasksRequest,
  CancelTaskRequest,
  TaskState,
} from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { A2A_SCHEMA, A2aService } from '../src/a2a.js';
import { MeshError, type EventSink, type Principal, type TraceEvent } from '../src/types.js';
import { TestDatabase } from './helpers.js';

async function harness() {
  const db = new TestDatabase();
  await db.query(`
    CREATE TABLE missions(id text PRIMARY KEY,revision bigint NOT NULL DEFAULT 0);
    CREATE TABLE test_trace(id text PRIMARY KEY,event jsonb NOT NULL);
    INSERT INTO missions(id) VALUES ('mission-a'),('mission-b');
    ${A2A_SCHEMA}
  `);
  const active = new Map<string, Principal>();
  const tokens = new Map<string, Principal>();
  const principals: Record<string, Principal> = {};
  const tokenFor = new Map<string, string>();
  for (const missionId of ['mission-a', 'mission-b']) {
    for (const agentId of ['A1', 'A2', 'A3']) {
      const p = { missionId, agentId, runId: randomUUID(), generation: 1 };
      active.set(`${missionId}:${agentId}`, p);
      const token = randomUUID();
      tokens.set(token, p);
      tokenFor.set(p.runId, token);
      principals[`${missionId}:${agentId}`] = p;
    }
  }
  function current(agentId: string, missionId = 'mission-a') {
    return active.get(`${missionId}:${agentId}`)!;
  }
  function rotate(agentId: string, missionId = 'mission-a') {
    const old = current(agentId, missionId);
    const next = { ...old, runId: randomUUID(), generation: old.generation + 1 };
    const token = randomUUID();
    active.set(`${missionId}:${agentId}`, next);
    tokens.set(token, next);
    tokenFor.set(next.runId, token);
    return next;
  }
  let failEvent: string | undefined;
  let seq = 0;
  const events: EventSink = async (input, tx = db) => {
    if (input.kind === failEvent) {
      failEvent = undefined;
      throw new Error('Injected trace transaction failure');
    }
    const event: TraceEvent = {
      ...input,
      id: randomUUID(),
      seq: String(++seq),
      at: new Date().toISOString(),
    };
    await tx.query('INSERT INTO test_trace(id,event) VALUES($1,$2::jsonb)', [
      event.id,
      JSON.stringify(event),
    ]);
    return event;
  };
  const validatePrincipal = async (_tx: unknown, p: Principal) => {
    if (current(p.agentId, p.missionId)?.runId !== p.runId)
      throw new MeshError('STALE_RUN', 'Retired run');
  };
  const authenticate = async (token: string) => {
    const p = tokens.get(token);
    if (!p) throw new MeshError('UNAUTHORIZED', 'Invalid token');
    await validatePrincipal(db, p);
    return p;
  };
  let route: Router;
  let dropReplyFor: string | undefined;
  const app = express();
  app.use(express.json());
  const dropResponse: RequestHandler = (req, res, next) => {
    if (
      req.body?.method === 'SendMessage' &&
      req.body?.params?.message?.messageId === dropReplyFor
    ) {
      dropReplyFor = undefined;
      const original = res.json.bind(res);
      res.json = ((body: unknown) => {
        if ((body as { result?: unknown })?.result) {
          res.destroy();
          return res;
        }
        return original(body);
      }) as typeof res.json;
    }
    next();
  };
  app.use(dropResponse, (req, res, next) => route(req, res, next));
  const server: Server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  function makeService() {
    const service = new A2aService({
      db,
      events,
      authenticate,
      validatePrincipal,
      peerExists: async (_tx, missionId, agentId) => active.has(`${missionId}:${agentId}`),
      baseUrl,
    });
    route = service.router();
    return service;
  }
  let service = makeService();
  async function client(p: Principal, recipientId: string, polling = true) {
    const response = await fetch(`${baseUrl}/agents/${recipientId}/agent-card.json`, {
      headers: { Authorization: `Bearer ${tokenFor.get(p.runId)!}` },
    });
    assert.equal(response.status, 200);
    const card = AgentCard.fromJSON(await response.json());
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory()],
      clientConfig: { polling },
    });
    const c = await factory.createFromAgentCard(card);
    return {
      c,
      options: { serviceParameters: { Authorization: `Bearer ${tokenFor.get(p.runId)!}` } },
    };
  }
  return {
    db,
    current,
    rotate,
    client,
    principals,
    baseUrl,
    get service() {
      return service;
    },
    restart() {
      service = makeService();
    },
    failNextEvent(kind: string) {
      failEvent = kind;
    },
    loseNextResponse(messageId: string) {
      dropReplyFor = messageId;
    },
    async traceEvents() {
      return (await db.query<{ event: TraceEvent }>('SELECT event FROM test_trace')).rows.map(
        (row) => row.event,
      );
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await db.close();
    },
  };
}

function request(messageId: string, text: string, extra: Record<string, unknown> = {}) {
  return SendMessageRequest.fromJSON({
    message: { messageId, role: 'ROLE_USER', parts: [{ text }], ...extra },
    configuration: { returnImmediately: true },
  });
}

test('reply and request acknowledgment commit atomically and replay without duplicate mail', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const sender = h.current('A1');
  const receiver = h.current('A2');
  const first = await h.service.send(sender, {
    recipientId: 'A2',
    messageId: 'request-one',
    text: 'Compare options.',
  });
  await h.service.send(sender, {
    recipientId: 'A2',
    messageId: 'request-two',
    text: 'A separate question.',
  });
  const inbox = await h.service.poll(receiver);
  const input = {
    taskId: first.taskId!,
    messageId: 'atomic-answer',
    deliveryId: inbox.messages.find((m) => m.messageId === 'request-one')!.deliveryId,
    text: 'First option is clearer because it separates decisions.',
    state: 'completed' as const,
  };
  await assert.rejects(
    h.service.reply(receiver, {
      ...input,
      deliveryId: inbox.messages.find((m) => m.messageId === 'request-two')!.deliveryId,
    }),
    (error: any) => error.code === 'INVALID_REPLY_DELIVERY',
  );
  h.failNextEvent('message.reply.accepted');
  await assert.rejects(h.service.reply(receiver, input));
  assert.equal((await h.service.poll(receiver)).messages.length, 2);
  assert.equal((await h.service.poll(sender)).messages.length, 0);
  const reply = await h.service.reply(receiver, input);
  assert.equal(reply.acknowledgedDeliveryId, input.deliveryId);
  assert.equal((await h.service.reply(receiver, input)).replayed, true);
  assert.equal((await h.service.poll(receiver)).messages.length, 1);
  assert.equal((await h.service.poll(sender)).messages.length, 1);
  await assert.rejects(
    h.service.reply(receiver, { ...input, deliveryId: undefined }),
    /different payload|different content|different message/i,
  );
});

test('inbox waits wake for mail, time out empty, and stop when the run is fenced', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  let settled = false;
  const waiting = h.service.poll(h.current('A2'), { waitMs: 2000 }).then((result) => {
    settled = true;
    return result;
  });
  await h.db.query("UPDATE missions SET revision=revision+1 WHERE id='mission-a'");
  await delay(40);
  assert.equal(settled, false);
  await h.service.send(h.current('A1'), {
    recipientId: 'A2',
    messageId: 'wake',
    text: 'Question after waiting.',
  });
  assert.equal((await waiting).messages.length, 1);
  assert.equal((await h.traceEvents()).filter((e) => e.kind === 'mailbox.polled').length, 1);
  assert.equal((await h.service.poll(h.current('A3'), { waitMs: 5 })).messages.length, 0);
  await assert.rejects(h.service.poll(h.current('A3'), { waitMs: -1 }), /waitMs/);
  const fenced = h.service.poll(h.current('A3'), { waitMs: 2000 });
  const rejection = assert.rejects(fenced, (error: any) => error.code === 'STALE_RUN');
  h.rotate('A3');
  await rejection;
});

test('independent A2A SDK client, durable replies, participant scope, and complete message trace', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const a1 = h.current('A1');
  const a2 = h.current('A2');
  const { c, options } = await h.client(a1, 'A2');
  const content =
    'Review src/kernel.ts\nPreserve this complete message: árvíztűrő tükörfúrógép.\nEvidence: commit 128.';
  const sent = await c.sendMessage(
    request('M128', content, {
      parts: [{ text: content }, { data: { files: ['src/kernel.ts'], revision: 128 } }],
    }),
    options,
  );
  assert('id' in sent);
  assert.equal(sent.status?.state, TaskState.TASK_STATE_SUBMITTED);
  const first = await h.service.poll(a2);
  assert.equal(first.messages.length, 1);
  assert.equal(first.workRevision, '1');
  const wire = first.messages[0]!.message as { parts: Array<{ text?: string; data?: unknown }> };
  assert.equal(wire.parts[0]!.text, content);
  assert.deepEqual(wire.parts[1]!.data, { files: ['src/kernel.ts'], revision: 128 });
  const notice = await h.service.notices(a2);
  assert(!notice.notice.includes(content));
  assert(notice.notice.includes(first.messages[0]!.deliveryId));
  await h.service.poll(a2);
  assert.equal(
    (await h.db.query<{ count: string }>('SELECT count(*)::text AS count FROM mailbox_offers'))
      .rows[0]!.count,
    '1',
  );
  await h.service.ack(a2, {
    deliveryId: first.messages[0]!.deliveryId,
    disposition: 'deferred',
    reason: 'Checking evidence',
  });
  assert.equal((await h.service.poll(a2)).pending, 1);
  const reply = await h.service.reply(a2, {
    taskId: sent.id,
    messageId: 'R128',
    text: 'Checked the interface. Keep the ordering invariant.',
    data: { verified: true, source: 'kernel.ts:128' },
  });
  assert.equal(reply.taskId, sent.id);
  assert.equal(
    (
      await h.service.reply(a2, {
        taskId: sent.id,
        messageId: 'R128',
        text: 'Checked the interface. Keep the ordering invariant.',
        data: { source: 'kernel.ts:128', verified: true },
      })
    ).replayed,
    true,
  );
  await assert.rejects(
    h.service.reply(a2, { taskId: sent.id, messageId: 'R128', text: 'A conflicting reply.' }),
    /different payload/,
  );
  const received = await h.service.poll(a1);
  assert.equal(received.messages[0]!.messageId, 'R128');
  const completed = await c.getTask(GetTaskRequest.fromJSON({ id: sent.id }), options);
  assert.equal(completed.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed.history.length, 2);
  assert.equal(completed.artifacts.length, 1);
  assert.equal(
    (await c.getTask(GetTaskRequest.fromJSON({ id: sent.id, historyLength: 0 }), options)).history
      .length,
    0,
  );
  const replayed = await c.sendMessage(
    request('M128', content, {
      parts: [{ text: content }, { data: { revision: 128, files: ['src/kernel.ts'] } }],
    }),
    options,
  );
  assert('id' in replayed);
  assert.equal(replayed.id, sent.id);
  await assert.rejects(
    c.sendMessage(request('M128', 'A changed payload'), options),
    /different payload/,
  );
  await assert.rejects(
    c.sendMessage(request('M129', 'A follow-up on a terminal task', { taskId: sent.id }), options),
    /terminal task/,
  );
  const stranger = await h.client(h.current('A3'), 'A2');
  await assert.rejects(
    stranger.c.getTask(GetTaskRequest.fromJSON({ id: sent.id }), stranger.options),
    /[Tt]ask/,
  );
  assert.equal(
    (await stranger.c.listTasks(ListTasksRequest.fromJSON({}), stranger.options)).tasks.length,
    0,
  );
  const otherMission = await h.client(h.current('A1', 'mission-b'), 'A2');
  await assert.rejects(
    otherMission.c.getTask(GetTaskRequest.fromJSON({ id: sent.id }), otherMission.options),
    /[Tt]ask/,
  );
  await h.service.ack(a2, { deliveryId: first.messages[0]!.deliveryId });
  assert.equal((await h.service.poll(a2)).pending, 0);
  const successor = h.rotate('A1');
  const continued = await h.client(successor, 'A2');
  assert.equal(
    (await continued.c.getTask(GetTaskRequest.fromJSON({ id: sent.id }), continued.options)).id,
    sent.id,
  );
  const events = await h.traceEvents();
  for (const kind of [
    'a2a.request.received',
    'a2a.response.sent',
    'message.ingress.accepted',
    'message.mailbox.persisted',
    'message.offered',
    'message.reply.accepted',
    'message.acknowledged',
  ]) {
    assert(
      events.some((event) => event.kind === kind),
      `Missing trace ${kind}`,
    );
  }
  assert(
    events.some(
      (event) =>
        event.kind === 'message.ingress.accepted' &&
        JSON.stringify(event.data).includes(content.replaceAll('\n', '\\n')),
    ),
  );
  assert.equal(
    new Set(events.filter((event) => event.messageId === 'M128').map((event) => event.traceId))
      .size,
    1,
  );
  assert.equal(
    (
      await h.db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM a2a_messages WHERE message_id=$1',
        ['M128'],
      )
    ).rows[0]!.count,
    '1',
  );
});

test('outbox retries survive a lost response and retired sender without duplicate tasks', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const original = h.current('A1');
  h.loseNextResponse('M256');
  const initial = await h.service.send(original, {
    recipientId: 'A2',
    messageId: 'M256',
    text: 'Keep this consultation across both process restarts.',
  });
  assert.equal(initial.state, 'pending');
  const taskId = (
    await h.db.query<{ task_id: string }>('SELECT task_id FROM a2a_messages WHERE message_id=$1', [
      'M256',
    ])
  ).rows[0]!.task_id;
  await h.service.poll(h.current('A2'));
  const successor = h.rotate('A1');
  h.rotate('A2');
  h.restart();
  await assert.rejects(
    h.service.send(original, { recipientId: 'A2', text: 'Retired run cannot create new work.' }),
    /Retired/,
  );
  await h.db.query('UPDATE a2a_outbox SET next_attempt_at=now() WHERE outbox_id=$1', [
    initial.outboxId,
  ]);
  await h.service.reconcileOutbox();
  const retried = await h.service.send(successor, {
    recipientId: 'A2',
    messageId: 'M256',
    text: 'Keep this consultation across both process restarts.',
  });
  assert.equal(retried.state, 'delivered');
  assert.equal(retried.taskId, taskId);
  assert.equal(retried.attempts, 2);
  const inbox = await h.service.poll(h.current('A2'));
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0]!.taskId, taskId);
  assert.equal(
    (await h.db.query<{ count: string }>('SELECT count(*)::text AS count FROM a2a_tasks')).rows[0]!
      .count,
    '1',
  );
  assert.equal(inbox.workRevision, '1', 'Transport retries must not create work revisions.');
  assert.equal(
    (await h.db.query<{ count: string }>('SELECT count(*)::text AS count FROM mailbox_offers'))
      .rows[0]!.count,
    '2',
    'A successor is offered unacknowledged mail again.',
  );
  assert.equal(
    (
      await h.service.reply(h.current('A2'), {
        taskId,
        messageId: 'R256',
        text: 'A successor can answer the original task.',
      })
    ).taskId,
    taskId,
  );
  const stored = (
    await h.db.query<{ principal: Principal }>(
      'SELECT principal FROM a2a_outbox WHERE outbox_id=$1',
      [initial.outboxId],
    )
  ).rows[0]!;
  assert.equal(stored.principal.runId, original.runId);
  const events = await h.traceEvents();
  assert(events.some((event) => event.kind === 'message.delivery.retry_scheduled'));
  assert(events.some((event) => event.kind === 'message.ingress.replayed'));
  assert(
    !JSON.stringify(events).includes('mesh-outbox.'),
    'Internal delivery capabilities must never enter trace data.',
  );
});

test('concurrent duplicate sends produce one task, and an ingress trace failure rolls back acceptance', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const input = {
    recipientId: 'A2',
    messageId: 'M512',
    text: 'One request from eight concurrent retries.',
  };
  const receipts = await Promise.all(
    Array.from({ length: 8 }, () => h.service.send(h.current('A1'), input)),
  );
  assert.equal(new Set(receipts.map((receipt) => receipt.outboxId)).size, 1);
  assert.equal((await h.service.poll(h.current('A2'))).messages.length, 1);
  const peer = await h.client(h.current('A1'), 'A2');
  h.failNextEvent('message.ingress.accepted');
  await assert.rejects(
    peer.c.sendMessage(request('M513', 'This transaction must roll back.'), peer.options),
  );
  assert.equal(
    (
      await h.db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM a2a_messages WHERE message_id=$1',
        ['M513'],
      )
    ).rows[0]!.count,
    '0',
  );
  assert.equal(
    (
      await h.db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM mailbox_deliveries WHERE message_id=$1',
        ['M513'],
      )
    ).rows[0]!.count,
    '0',
  );
  const recovered = await peer.c.sendMessage(
    request('M513', 'This transaction must roll back.'),
    peer.options,
  );
  assert('id' in recovered);
  assert.equal((await h.service.poll(h.current('A2'))).messages.length, 2);
});

test('default SendMessage waits, list pagination is scoped, and unsupported streaming is explicit', async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const caller = await h.client(h.current('A1'), 'A2', false);
  let finished = false;
  const waiting = caller.c
    .sendMessage(
      SendMessageRequest.fromJSON({
        message: Message.toJSON(request('M1024', 'I need clarification.').message!),
      }),
      caller.options,
    )
    .then((value) => {
      finished = true;
      return value;
    });
  let incoming: Awaited<ReturnType<A2aService['poll']>> | undefined;
  for (let attempt = 0; attempt < 128; attempt++) {
    incoming = await h.service.poll(h.current('A2'));
    if (incoming.messages.length) break;
    await delay(16);
  }
  assert(incoming?.messages.length);
  assert.equal(finished, false);
  await h.service.reply(h.current('A2'), {
    taskId: incoming.messages[0]!.taskId,
    text: 'Which API revision?',
    state: 'input-required',
  });
  const result = await waiting;
  assert('id' in result);
  assert.equal(result.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  const c = await h.client(h.current('A1'), 'A2');
  const resumed = await c.c.sendMessage(
    request('M1024-followup', 'Use API revision 1.', {
      taskId: result.id,
      contextId: result.contextId,
    }),
    c.options,
  );
  assert('id' in resumed);
  assert.equal(resumed.id, result.id);
  assert.equal(resumed.status?.state, TaskState.TASK_STATE_WORKING);
  const canceled = await c.c.cancelTask(CancelTaskRequest.fromJSON({ id: result.id }), c.options);
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
  assert.equal(
    (await h.service.cancel(h.current('A1'), { recipientId: 'A2', taskId: result.id })).taskId,
    result.id,
  );
  await assert.rejects(
    h.service.cancel(h.current('A3'), { recipientId: 'A2', taskId: result.id }),
    /[Tt]ask/,
  );
  assert.equal(
    (await c.c.cancelTask(CancelTaskRequest.fromJSON({ id: result.id }), c.options)).history.length,
    canceled.history.length,
  );
  assert(
    (await h.service.poll(h.current('A2'))).messages.some(
      (delivery) => delivery.kind === 'cancellation' && delivery.taskId === result.id,
    ),
  );
  assert.equal(
    (
      await c.c.listTasks(
        ListTasksRequest.fromJSON({
          status: 'TASK_STATE_CANCELED',
          statusTimestampAfter: canceled.status?.timestamp,
        }),
        c.options,
      )
    ).tasks[0]?.id,
    canceled.id,
  );
  await c.c.sendMessage(request('M1025', 'Additional question.'), c.options);
  await c.c.sendMessage(request('M1026', 'Another question.'), c.options);
  const first = await c.c.listTasks(ListTasksRequest.fromJSON({ pageSize: 2 }), c.options);
  assert.equal(first.tasks.length, 2);
  assert(first.nextPageToken);
  const next = await c.c.listTasks(
    ListTasksRequest.fromJSON({ pageSize: 2, pageToken: first.nextPageToken }),
    c.options,
  );
  assert.equal(next.tasks.length, 1);
  assert.equal(new Set([...first.tasks, ...next.tasks].map((task) => task.id)).size, 3);
  await assert.rejects(
    c.c.listTasks(
      ListTasksRequest.fromJSON({ pageSize: 3, pageToken: first.nextPageToken }),
      c.options,
    ),
    /scope|token/,
  );
  const response = await fetch(`${h.baseUrl}/agents/A2/a2a`, {
    method: 'POST',
    headers: {
      ...c.options.serviceParameters,
      'Content-Type': 'application/json',
      'A2A-Version': '1.0',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'stream',
      method: 'SubscribeToTask',
      params: { id: result.id },
    }),
  });
  const unsupported = (await response.json()) as { error?: { message: string } };
  assert.match(unsupported.error?.message ?? '', /[Ss]treaming/);
});
