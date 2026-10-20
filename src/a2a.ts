import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import express, { type Request, type Router } from 'express';
import {
  AgentCard,
  Message,
  Task,
  TaskState,
  Role,
  SendMessageRequest,
  type GetTaskRequest,
  type ListTasksRequest,
  type ListTasksResponse,
  type CancelTaskRequest,
  type StreamResponse,
} from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
  type A2ARequestHandler,
} from '@a2a-js/sdk/server';
import {
  RequestMalformedError,
  TaskNotFoundError,
  TaskNotCancelableError,
  UnsupportedOperationError,
  PushNotificationNotSupportedError,
  ExtendedAgentCardNotConfiguredError,
  ContentTypeNotSupportedError,
} from '@a2a-js/sdk/errors';
import {
  invariant,
  MeshError,
  type Database,
  type EventSink,
  type Principal,
  type Sql,
} from './types.js';

/** Protocol state and delivery records share the same transaction as their trace events. */
export const A2A_SCHEMA = `
CREATE TABLE IF NOT EXISTS a2a_tasks (
  task_id text PRIMARY KEY, mission_id text NOT NULL, recipient_id text NOT NULL,
  sender_id text NOT NULL, context_id text NOT NULL, state integer NOT NULL,
  task jsonb NOT NULL, trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS a2a_tasks_scope ON a2a_tasks(mission_id,recipient_id,sender_id,updated_at DESC,task_id DESC);
CREATE INDEX IF NOT EXISTS a2a_tasks_context ON a2a_tasks(mission_id,recipient_id,context_id,sender_id);
CREATE TABLE IF NOT EXISTS a2a_messages (
  mission_id text NOT NULL, sender_id text NOT NULL, recipient_id text NOT NULL, message_id text NOT NULL,
  task_id text NOT NULL REFERENCES a2a_tasks(task_id), run_id text NOT NULL, generation integer NOT NULL,
  payload_hash text NOT NULL, message jsonb NOT NULL, accepted_result jsonb NOT NULL,
  kind text NOT NULL, trace_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mission_id,sender_id,recipient_id,message_id)
);
CREATE INDEX IF NOT EXISTS a2a_messages_task_history ON a2a_messages(mission_id,task_id,sender_id,recipient_id,kind,created_at);
CREATE TABLE IF NOT EXISTS mailbox_deliveries (
  delivery_id text PRIMARY KEY, mission_id text NOT NULL, sender_id text NOT NULL,
  recipient_id text NOT NULL, message_id text NOT NULL, task_id text NOT NULL REFERENCES a2a_tasks(task_id),
  message jsonb NOT NULL, kind text NOT NULL, trace_id text NOT NULL,
  disposition text, disposition_reason text, handled_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(), handled_at timestamptz,
  UNIQUE(mission_id,sender_id,recipient_id,message_id)
);
CREATE INDEX IF NOT EXISTS mailbox_pending ON mailbox_deliveries(mission_id,recipient_id,created_at,delivery_id) WHERE handled_at IS NULL;
CREATE TABLE IF NOT EXISTS mailbox_offers (
  delivery_id text NOT NULL REFERENCES mailbox_deliveries(delivery_id), run_id text NOT NULL,
  offered_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(delivery_id,run_id)
);
CREATE TABLE IF NOT EXISTS a2a_outbox (
  outbox_id text PRIMARY KEY, mission_id text NOT NULL, sender_id text NOT NULL, recipient_id text NOT NULL,
  message_id text NOT NULL, principal jsonb NOT NULL, request jsonb NOT NULL, payload_hash text NOT NULL,
  trace_id text NOT NULL, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  attempt_id text, result jsonb, last_error jsonb,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
  UNIQUE(mission_id,sender_id,recipient_id,message_id)
);
CREATE INDEX IF NOT EXISTS a2a_outbox_pending ON a2a_outbox(next_attempt_at) WHERE state IN ('pending','sending');
CREATE TABLE IF NOT EXISTS a2a_outbox_attempts (
  attempt_id text PRIMARY KEY, outbox_id text NOT NULL REFERENCES a2a_outbox(outbox_id),
  started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, result jsonb, error jsonb
);
CREATE INDEX IF NOT EXISTS a2a_attempts_outbox_history ON a2a_outbox_attempts(outbox_id,started_at,attempt_id);
`;

export interface A2aOptions {
  db: Database;
  events: EventSink;
  authenticate: (token: string) => Promise<Principal>;
  validatePrincipal: (tx: Sql, principal: Principal) => Promise<void>;
  peerExists: (tx: Sql, missionId: string, agentId: string) => Promise<boolean>;
  baseUrl: string;
}

export interface SendInput {
  recipientId: string;
  messageId?: string;
  text?: string;
  data?: unknown;
  taskId?: string;
  contextId?: string;
  kind?: string;
  correlationId?: string;
  causationId?: string;
  references?: unknown[];
}

export interface ReplyInput {
  taskId: string;
  messageId?: string;
  /** Acknowledge this incoming request atomically with its reply. */
  deliveryId?: string;
  text?: string;
  data?: unknown;
  state?: 'completed' | 'working' | 'input-required' | 'rejected' | 'failed';
}

interface AckInput {
  deliveryId: string;
  disposition?: 'handled' | 'deferred' | 'rejected' | 'superseded';
  reason?: string;
}

export interface CancelInput {
  recipientId: string;
  taskId: string;
}

interface TaskRow {
  task_id: string;
  mission_id: string;
  recipient_id: string;
  sender_id: string;
  context_id: string;
  state: number;
  task: unknown;
  trace_id: string;
  updated_at: string;
}

interface OutboxRow {
  outbox_id: string;
  mission_id: string;
  sender_id: string;
  recipient_id: string;
  message_id: string;
  principal: Principal;
  request: unknown;
  payload_hash: string;
  trace_id: string;
  state: string;
  attempts: number;
  attempt_id: string | null;
  result: unknown;
  last_error: unknown;
}

interface DeliveryRow {
  delivery_id: string;
  mission_id: string;
  sender_id: string;
  recipient_id: string;
  message_id: string;
  task_id: string;
  message: unknown;
  kind: string;
  trace_id: string;
  disposition: string | null;
  created_at: string;
  handled_at: string | null;
}

interface CallIdentity {
  principal: Principal;
  persistedOutboxId?: string;
  signal?: AbortSignal;
  traceId?: string;
  taskId?: string;
}
interface Capability {
  outboxId: string;
  recipientId: string;
  payloadHash: string;
  requestHash: string;
}

const terminal = new Set<number>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);
const interrupted = new Set<number>([
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
]);
const replyStates = {
  completed: TaskState.TASK_STATE_COMPLETED,
  working: TaskState.TASK_STATE_WORKING,
  'input-required': TaskState.TASK_STATE_INPUT_REQUIRED,
  rejected: TaskState.TASK_STATE_REJECTED,
  failed: TaskState.TASK_STATE_FAILED,
};

/** A stable peer endpoint outlives each CLI run. No model is run by this service. */
export class A2aService {
  private readonly capabilities = new Map<string, Capability>();
  private readonly factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
    clientConfig: { polling: true },
  });
  private readonly baseUrl: string;

  constructor(private readonly options: A2aOptions) {
    const url = new URL(options.baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new MeshError(
        'INVALID_URL',
        'A2A base URL must be an HTTP(S) URL without credentials, query, or fragment.',
      );
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
  }

  card(principal: Principal, recipientId: string): AgentCard {
    return AgentCard.fromJSON({
      name: recipientId,
      description: 'An independent mesh peer with a durable consultation inbox.',
      version: '0.1.0',
      supportedInterfaces: [
        {
          url: `${this.baseUrl}/agents/${encodeURIComponent(recipientId)}/a2a`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
          tenant: principal.missionId,
        },
      ],
      capabilities: { streaming: false, pushNotifications: false },
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: [
        {
          id: 'consult',
          name: 'Consult a peer',
          description:
            'Discuss work, evidence, decisions, and reviews without assigning roadmap work centrally.',
          tags: ['coordination', 'consultation'],
        },
      ],
    });
  }

  /** The official SDK owns wire codecs, method dispatch, and protocol error envelopes. */
  router(): Router {
    const router = express.Router();
    router.use(express.json({ limit: '2mb', type: 'application/json' }));
    const cardHandler: express.RequestHandler = async (req, res) => {
      try {
        const recipientId = id(req.params.agentId, 'agentId');
        const identity = await this.authenticateRequest(req, recipientId, true);
        await this.requirePeer(this.options.db, identity.principal, recipientId);
        res.json(AgentCard.toJSON(this.card(identity.principal, recipientId)));
      } catch (error) {
        res.status(401).json({ error: publicError(error) });
      }
    };
    router.get('/agents/:agentId/agent-card.json', cardHandler);
    router.get('/agents/:agentId/.well-known/agent-card.json', cardHandler);
    router.post('/agents/:agentId/a2a', async (req, res) => {
      let identity: CallIdentity;
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      try {
        const recipientId = id(req.params.agentId, 'agentId');
        identity = await this.authenticateRequest(req, recipientId);
        identity.signal = controller.signal;
        const p = identity.principal;
        await this.requirePeer(this.options.db, p, recipientId);
        await this.correlateRequest(identity, recipientId, req.body);
        const requestId = randomUUID();
        await this.options.events({
          missionId: p.missionId,
          agentId: p.agentId,
          runId: p.runId,
          kind: 'a2a.request.received',
          spanId: requestId,
          traceId: identity.traceId,
          taskId: identity.taskId,
          messageId: rawMessageId(req.body),
          data: { recipientId, request: req.body, version: req.get('A2A-Version') ?? '0.3' },
        });
        let response: unknown;
        try {
          const mediaType = (req.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
          if (mediaType !== 'application/json')
            throw new ContentTypeNotSupportedError('JSON-RPC requires application/json.');
          validateVersion(req.get('A2A-Version') ?? '0.3', this.card(p, recipientId), 'JSONRPC');
          const context = new ServerCallContext({
            user: { isAuthenticated: true, userName: stableOwner(p) },
            requestedVersion: req.get('A2A-Version') ?? '0.3',
            state: new Map([['mesh.identity', identity]]),
          });
          const transport = new JsonRpcTransportHandler(this.handler(p, recipientId));
          const result = await transport.handle(req.body, context);
          if (Symbol.asyncIterator in result) {
            // Streaming is deliberately not advertised; asking for it returns the SDK error.
            await result.next();
            throw new UnsupportedOperationError('Streaming is not supported.');
          }
          response = result;
        } catch (error) {
          response = {
            jsonrpc: '2.0',
            id: rpcId(req.body),
            error: JsonRpcTransportHandler.mapToJSONRPCError(protocolError(error)),
          };
        }
        await this.options.events({
          missionId: p.missionId,
          agentId: p.agentId,
          runId: p.runId,
          kind: 'a2a.response.sent',
          parentSpanId: requestId,
          traceId: identity.traceId,
          taskId: identity.taskId,
          messageId: rawMessageId(req.body),
          data: { recipientId, response },
        });
        if (!res.destroyed) res.status(200).json(response);
      } catch (error) {
        if (!res.destroyed) res.status(401).json({ error: publicError(error) });
      }
    });
    return router;
  }

  /** Commit intent before making the actual A2A HTTP call. A timeout never discards it. */
  async send(principal: Principal, input: SendInput) {
    const recipientId = id(input.recipientId, 'recipientId');
    const messageId = id(input.messageId ?? randomUUID(), 'messageId');
    const message = Message.fromJSON({
      messageId,
      taskId: input.taskId,
      contextId: input.contextId,
      role: 'ROLE_USER',
      parts: contentParts(input),
      metadata: {
        mesh: {
          kind: input.kind ?? 'question',
          correlationId: input.correlationId,
          causationId: input.causationId,
          references: input.references,
        },
      },
    });
    validateMessage(message, Role.ROLE_USER);
    const request = SendMessageRequest.fromJSON({
      tenant: principal.missionId,
      message: Message.toJSON(message),
      configuration: { returnImmediately: true },
    });
    const wireRequest = SendMessageRequest.toJSON(request);
    invariant(
      Buffer.byteLength(json(wireRequest), 'utf8') <= 16_384,
      'CONSULTATION_TOO_LARGE',
      'Keep consultations under 16 KiB; reference artifacts instead of copying logs',
    );
    const payloadHash = hash(Message.toJSON(message));
    const outbox = await this.options.db.transaction(async (tx) => {
      await lockMission(tx, principal.missionId);
      await this.options.validatePrincipal(tx, principal);
      await this.requirePeer(tx, principal, recipientId);
      await messageLock(tx, principal, recipientId, messageId);
      const prior = (
        await tx.query<OutboxRow>(
          'SELECT * FROM a2a_outbox WHERE mission_id=$1 AND sender_id=$2 AND recipient_id=$3 AND message_id=$4 FOR UPDATE',
          [principal.missionId, principal.agentId, recipientId, messageId],
        )
      ).rows[0];
      if (prior) {
        requireSamePayload(prior.payload_hash, payloadHash);
        await this.trace(
          tx,
          principal,
          'message.send.replayed',
          prior.trace_id,
          messageId,
          undefined,
          { outboxId: prior.outbox_id },
        );
        return prior;
      }
      // A fresh message ID must not open a second identical consultation while
      // the original request is pending or its task is still actionable.
      if (!input.taskId) {
        const duplicate = (
          await tx.query<OutboxRow>(
            `SELECT o.* FROM a2a_outbox o WHERE o.mission_id=$1 AND o.sender_id=$2 AND o.recipient_id=$3
           AND ((o.request->'message')-'messageId')=(($4::jsonb->'message')-'messageId')
           AND (o.state IN ('pending','sending') OR (o.state='delivered' AND EXISTS (
             SELECT 1 FROM a2a_tasks t WHERE t.mission_id=o.mission_id AND t.task_id=o.result->>'id'
             AND t.sender_id=o.sender_id AND t.recipient_id=o.recipient_id AND NOT(t.state=ANY($5::integer[])))))
           ORDER BY o.created_at LIMIT 1`,
            [
              principal.missionId,
              principal.agentId,
              recipientId,
              json(wireRequest),
              [
                TaskState.TASK_STATE_COMPLETED,
                TaskState.TASK_STATE_FAILED,
                TaskState.TASK_STATE_CANCELED,
                TaskState.TASK_STATE_REJECTED,
              ],
            ],
          )
        ).rows[0];
        if (duplicate) return duplicate;
      }
      const outboxId = randomUUID();
      const traceId = randomUUID();
      const row = (
        await tx.query<OutboxRow>(
          `INSERT INTO a2a_outbox(outbox_id,mission_id,sender_id,recipient_id,message_id,principal,request,payload_hash,trace_id)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) RETURNING *`,
          [
            outboxId,
            principal.missionId,
            principal.agentId,
            recipientId,
            messageId,
            json(principal),
            json(wireRequest),
            payloadHash,
            traceId,
          ],
        )
      ).rows[0]!;
      await this.trace(tx, principal, 'message.send.accepted', traceId, messageId, undefined, {
        outboxId,
        recipientId,
        request: wireRequest,
      });
      return row;
    });
    if (outbox.state === 'pending' || outbox.state === 'sending')
      await this.dispatch(outbox.outbox_id);
    return {
      ...(await this.outboxReceipt(outbox.outbox_id)),
      reused: outbox.message_id !== messageId,
    };
  }

  async reply(principal: Principal, input: ReplyInput) {
    const messageId = id(input.messageId ?? randomUUID(), 'messageId');
    const taskId = id(input.taskId, 'taskId');
    const state = replyStates[input.state ?? 'completed'];
    if (state === undefined) throw new MeshError('INVALID_STATE', 'Invalid reply task state.');
    return this.options.db.transaction(async (tx) => {
      await lockMission(tx, principal.missionId);
      await this.options.validatePrincipal(tx, principal);
      const row = await this.taskRow(tx, principal, principal.agentId, taskId, true);
      if (row.recipient_id !== principal.agentId) throw new TaskNotFoundError();
      if (input.deliveryId) {
        const delivery = await tx.query(
          'SELECT delivery_id FROM mailbox_deliveries WHERE delivery_id=$1 AND mission_id=$2 AND recipient_id=$3 AND task_id=$4 AND sender_id=$5',
          [
            id(input.deliveryId, 'deliveryId'),
            principal.missionId,
            principal.agentId,
            taskId,
            row.sender_id,
          ],
        );
        if (!delivery.rowCount)
          throw new MeshError(
            'INVALID_REPLY_DELIVERY',
            'Delivery must be an incoming request for this task.',
          );
      }
      const message = Message.fromJSON({
        messageId,
        taskId,
        contextId: row.context_id,
        role: 'ROLE_AGENT',
        parts: contentParts(input),
        metadata: { mesh: { kind: 'answer' } },
      });
      validateMessage(message, Role.ROLE_AGENT);
      const wireMessage = Message.toJSON(message);
      const payloadHash = hash({
        message: wireMessage,
        state,
        ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
      });
      const prior = (
        await tx.query<{ payload_hash: string; accepted_result: unknown }>(
          'SELECT payload_hash,accepted_result FROM a2a_messages WHERE mission_id=$1 AND sender_id=$2 AND recipient_id=$3 AND message_id=$4',
          [principal.missionId, principal.agentId, row.sender_id, messageId],
        )
      ).rows[0];
      if (prior) {
        requireSamePayload(prior.payload_hash, payloadHash);
        if (input.deliveryId)
          await this.acknowledge(tx, principal, { deliveryId: input.deliveryId });
        await this.trace(tx, principal, 'message.reply.replayed', row.trace_id, messageId, taskId, {
          result: prior.accepted_result,
        });
        return {
          messageId,
          taskId,
          contextId: row.context_id,
          task: prior.accepted_result,
          replayed: true,
          ...(input.deliveryId ? { acknowledgedDeliveryId: input.deliveryId } : {}),
        };
      }
      if (terminal.has(row.state))
        throw new UnsupportedOperationError('A terminal task cannot receive another reply.');
      if (input.deliveryId) await this.acknowledge(tx, principal, { deliveryId: input.deliveryId });
      const task = Task.fromJSON(row.task);
      task.history.push(message);
      task.status = { state, message, timestamp: new Date().toISOString() };
      if (state === TaskState.TASK_STATE_COMPLETED) {
        task.artifacts.push({
          artifactId: messageId,
          name: 'Peer response',
          description: '',
          parts: message.parts,
          metadata: undefined,
          extensions: [],
        });
      }
      const wireTask = Task.toJSON(task);
      await tx.query(
        'UPDATE a2a_tasks SET task=$1::jsonb,state=$2,updated_at=now() WHERE task_id=$3',
        [json(wireTask), state, taskId],
      );
      await this.recordMessage(
        tx,
        principal,
        row.sender_id,
        message,
        payloadHash,
        wireTask,
        'answer',
        row.trace_id,
      );
      const deliveryId = await this.deliver(
        tx,
        principal,
        row.sender_id,
        message,
        'answer',
        row.trace_id,
      );
      await changed(tx, principal.missionId);
      await this.trace(tx, principal, 'message.reply.accepted', row.trace_id, messageId, taskId, {
        recipientId: row.sender_id,
        deliveryId,
        message: wireMessage,
        task: wireTask,
      });
      return {
        messageId,
        taskId,
        contextId: row.context_id,
        deliveryId,
        task: wireTask,
        replayed: false,
        ...(input.deliveryId ? { acknowledgedDeliveryId: input.deliveryId } : {}),
      };
    });
  }

  /** Withdraw an obsolete consultation through the same authenticated task transition as CancelTask. */
  async cancel(principal: Principal, input: CancelInput) {
    const task = await this.cancelTask(
      id(input.recipientId, 'recipientId'),
      {
        tenant: principal.missionId,
        id: id(input.taskId, 'taskId'),
        metadata: undefined,
      },
      { principal },
    );
    return { taskId: task.id, contextId: task.contextId, task: Task.toJSON(task) };
  }

  async poll(principal: Principal, input: { limit?: number; waitMs?: number } = {}) {
    const limit = boundedLimit(input.limit, 32, 128);
    const waitMs = input.waitMs ?? 0;
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000)
      throw new RequestMalformedError('waitMs must be an integer from 0 to 30000.');
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await this.options.validatePrincipal(this.options.db, principal);
      const pending = await this.options.db.query(
        'SELECT delivery_id FROM mailbox_deliveries WHERE mission_id=$1 AND recipient_id=$2 AND handled_at IS NULL LIMIT 1',
        [principal.missionId, principal.agentId],
      );
      if (pending.rowCount) break;
      await delay(Math.max(0, Math.min(250, deadline - Date.now())));
    }
    return this.options.db.transaction(async (tx) => {
      await lockMission(tx, principal.missionId);
      await this.options.validatePrincipal(tx, principal);
      const deliveries = (
        await tx.query<DeliveryRow>(
          'SELECT * FROM mailbox_deliveries WHERE mission_id=$1 AND recipient_id=$2 AND handled_at IS NULL ORDER BY created_at,delivery_id LIMIT $3',
          [principal.missionId, principal.agentId, limit],
        )
      ).rows;
      for (const row of deliveries) {
        const offered = await tx.query(
          'INSERT INTO mailbox_offers(delivery_id,run_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING delivery_id',
          [row.delivery_id, principal.runId],
        );
        if (offered.rows.length)
          await this.trace(
            tx,
            principal,
            'message.offered',
            row.trace_id,
            row.message_id,
            row.task_id,
            { deliveryId: row.delivery_id, senderId: row.sender_id, message: row.message },
          );
      }
      const result = {
        messages: deliveries.map(deliveryView),
        pending: await this.pendingCount(tx, principal),
        workRevision: await workRevision(tx, principal.missionId),
      };
      await this.trace(tx, principal, 'mailbox.polled', randomUUID(), undefined, undefined, result);
      return result;
    });
  }

  async notices(principal: Principal, input: { limit?: number } = {}) {
    const limit = boundedLimit(input.limit, 8, 8);
    return this.options.db.transaction(async (tx) => {
      await lockMission(tx, principal.missionId);
      await this.options.validatePrincipal(tx, principal);
      const rows = (
        await tx.query<DeliveryRow>(
          'SELECT delivery_id,message_id,task_id,sender_id,kind,trace_id FROM mailbox_deliveries WHERE mission_id=$1 AND recipient_id=$2 AND handled_at IS NULL ORDER BY created_at,delivery_id LIMIT $3',
          [principal.missionId, principal.agentId, limit],
        )
      ).rows;
      const messages = rows.map((row) => ({
        deliveryId: row.delivery_id,
        messageId: row.message_id,
        taskId: row.task_id,
        from: row.sender_id,
        kind: row.kind,
      }));
      // No peer-authored prose enters the privileged hook context.
      const notice = messages.length
        ? `Mesh inbox has pending deliveries: ${messages.map((m) => `${m.deliveryId} from ${m.from} for task ${m.taskId}`).join('; ')}. Read them with mesh_poll before dependent work.`
        : '';
      if (messages.length)
        await this.trace(tx, principal, 'mailbox.notice', randomUUID(), undefined, undefined, {
          messages,
        });
      return {
        messages,
        notice,
        pending: await this.pendingCount(tx, principal),
        workRevision: await workRevision(tx, principal.missionId),
      };
    });
  }

  async ack(principal: Principal, input: AckInput) {
    return this.options.db.transaction(async (tx) => {
      await lockMission(tx, principal.missionId);
      await this.options.validatePrincipal(tx, principal);
      return this.acknowledge(tx, principal, input);
    });
  }

  private async acknowledge(tx: Sql, principal: Principal, input: AckInput) {
    const disposition = input.disposition ?? 'handled';
    if (!['handled', 'deferred', 'rejected', 'superseded'].includes(disposition))
      throw new MeshError('INVALID_DISPOSITION', 'Invalid message disposition.');
    const row = (
      await tx.query<DeliveryRow>(
        'SELECT * FROM mailbox_deliveries WHERE delivery_id=$1 AND mission_id=$2 AND recipient_id=$3 FOR UPDATE',
        [id(input.deliveryId, 'deliveryId'), principal.missionId, principal.agentId],
      )
    ).rows[0];
    if (!row) throw new MeshError('NOT_FOUND', 'Mailbox delivery not found.');
    if (row.handled_at) {
      if (row.disposition !== disposition)
        throw new MeshError(
          'DISPOSITION_CONFLICT',
          'The delivery already has a final disposition.',
        );
      return { deliveryId: row.delivery_id, disposition, replayed: true };
    }
    await tx.query(
      `UPDATE mailbox_deliveries SET disposition=$1,disposition_reason=$2,handled_run_id=$3,
     handled_at=CASE WHEN $1='deferred' THEN NULL ELSE now() END WHERE delivery_id=$4`,
      [disposition, input.reason ?? null, principal.runId, row.delivery_id],
    );
    if (disposition !== 'deferred') await changed(tx, principal.missionId);
    await this.trace(
      tx,
      principal,
      'message.acknowledged',
      row.trace_id,
      row.message_id,
      row.task_id,
      { deliveryId: row.delivery_id, disposition, reason: input.reason ?? null },
    );
    return { deliveryId: row.delivery_id, disposition, replayed: false };
  }

  /** Called periodically and on daemon startup; expired attempts are safely replayed. */
  async reconcileOutbox(limit = 32): Promise<void> {
    const rows = (
      await this.options.db.query<{ outbox_id: string }>(
        "SELECT outbox_id FROM a2a_outbox WHERE state IN ('pending','sending') AND next_attempt_at<=now() ORDER BY next_attempt_at,outbox_id LIMIT $1",
        [boundedLimit(limit, 32, 128)],
      )
    ).rows;
    // Bound transport concurrency independently of the agent population.
    for (let start = 0; start < rows.length; start += 8) {
      const results = await Promise.allSettled(
        rows.slice(start, start + 8).map((row) => this.dispatch(row.outbox_id)),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure) throw failure.reason;
    }
  }

  private handler(principal: Principal, recipientId: string): A2ARequestHandler {
    return {
      getAgentCard: async () => this.card(principal, recipientId),
      getAuthenticatedExtendedAgentCard: async () => {
        throw new ExtendedAgentCardNotConfiguredError();
      },
      sendMessage: (params, context) => this.ingest(recipientId, params, callIdentity(context)),
      getTask: (params, context) => this.getTask(recipientId, params, callIdentity(context)),
      listTasks: (params, context) => this.listTasks(recipientId, params, callIdentity(context)),
      cancelTask: (params, context) => this.cancelTask(recipientId, params, callIdentity(context)),
      sendMessageStream: unsupportedStream,
      resubscribe: unsupportedStream,
      createTaskPushNotificationConfig: unsupportedPush,
      getTaskPushNotificationConfig: unsupportedPush,
      listTaskPushNotificationConfigs: unsupportedPush,
      deleteTaskPushNotificationConfig: unsupportedPush,
    };
  }

  private async ingest(
    recipientId: string,
    params: SendMessageRequest,
    identity: CallIdentity,
  ): Promise<Task> {
    const p = identity.principal;
    validateTenant(params.tenant, p);
    if (params.configuration?.taskPushNotificationConfig)
      throw new PushNotificationNotSupportedError();
    validateHistoryLength(params.configuration?.historyLength);
    if (!params.message) throw new RequestMalformedError('A message is required.');
    validateMessage(params.message, Role.ROLE_USER);
    const incoming = params.message;
    const payloadHash = hash(Message.toJSON(incoming));
    const accepted = await this.options.db
      .transaction(async (tx) => {
        await lockMission(tx, p.missionId);
        if (!identity.persistedOutboxId) await this.options.validatePrincipal(tx, p);
        await this.requirePeer(tx, p, recipientId);
        await messageLock(tx, p, recipientId, incoming.messageId);
        const previous = (
          await tx.query<{
            payload_hash: string;
            accepted_result: unknown;
            trace_id: string;
            task_id: string;
          }>(
            'SELECT payload_hash,accepted_result,trace_id,task_id FROM a2a_messages WHERE mission_id=$1 AND sender_id=$2 AND recipient_id=$3 AND message_id=$4',
            [p.missionId, p.agentId, recipientId, incoming.messageId],
          )
        ).rows[0];
        if (previous) {
          requireSamePayload(previous.payload_hash, payloadHash);
          identity.traceId = previous.trace_id;
          identity.taskId = previous.task_id;
          await this.trace(
            tx,
            p,
            'message.ingress.replayed',
            previous.trace_id,
            incoming.messageId,
            previous.task_id,
            { recipientId, result: previous.accepted_result },
          );
          return Task.fromJSON(previous.accepted_result);
        }
        let task: Task;
        let traceId: string = identity.traceId ?? randomUUID();
        if (identity.persistedOutboxId) {
          const row = (
            await tx.query<OutboxRow>('SELECT * FROM a2a_outbox WHERE outbox_id=$1', [
              identity.persistedOutboxId,
            ])
          ).rows[0];
          if (
            !row ||
            row.mission_id !== p.missionId ||
            row.sender_id !== p.agentId ||
            row.recipient_id !== recipientId ||
            row.payload_hash !== payloadHash
          ) {
            throw new RequestMalformedError(
              'The delivery does not match its accepted outbox intent.',
            );
          }
          traceId = row.trace_id;
        }
        if (incoming.taskId) {
          const row = await this.taskRow(tx, p, recipientId, incoming.taskId, true);
          if (row.sender_id !== p.agentId) throw new TaskNotFoundError();
          if (incoming.contextId && incoming.contextId !== row.context_id)
            throw new RequestMalformedError('The task and context do not match.');
          if (terminal.has(row.state))
            throw new UnsupportedOperationError('A terminal task cannot receive another message.');
          task = Task.fromJSON(row.task);
          traceId = row.trace_id;
        } else {
          if (incoming.contextId) {
            const existing = await tx.query(
              'SELECT task_id FROM a2a_tasks WHERE mission_id=$1 AND recipient_id=$2 AND sender_id=$3 AND context_id=$4 LIMIT 1',
              [p.missionId, recipientId, p.agentId, incoming.contextId],
            );
            if (!existing.rows.length)
              throw new RequestMalformedError(
                'The supplied context is not accessible at this peer.',
              );
          }
          task = Task.fromJSON({
            id: randomUUID(),
            contextId: incoming.contextId || randomUUID(),
            status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
            metadata: {
              mesh: { missionId: p.missionId, recipientId, senderId: p.agentId, traceId },
            },
          });
          await tx.query(
            'INSERT INTO a2a_tasks(task_id,mission_id,recipient_id,sender_id,context_id,state,task,trace_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
            [
              task.id,
              p.missionId,
              recipientId,
              p.agentId,
              task.contextId,
              TaskState.TASK_STATE_SUBMITTED,
              json(Task.toJSON(task)),
              traceId,
            ],
          );
        }
        const message = Message.fromJSON({
          ...asObject(Message.toJSON(incoming)),
          taskId: task.id,
          contextId: task.contextId,
        });
        task.history.push(message);
        const nextState = incoming.taskId
          ? TaskState.TASK_STATE_WORKING
          : TaskState.TASK_STATE_SUBMITTED;
        task.status = { state: nextState, message: undefined, timestamp: new Date().toISOString() };
        identity.traceId = traceId;
        identity.taskId = task.id;
        const wireTask = Task.toJSON(task);
        await tx.query(
          'UPDATE a2a_tasks SET task=$1::jsonb,state=$2,updated_at=now() WHERE task_id=$3',
          [json(wireTask), nextState, task.id],
        );
        const kind = messageKind(message);
        await this.recordMessage(tx, p, recipientId, message, payloadHash, wireTask, kind, traceId);
        const deliveryId = await this.deliver(tx, p, recipientId, message, kind, traceId);
        await changed(tx, p.missionId);
        await this.trace(tx, p, 'message.ingress.accepted', traceId, incoming.messageId, task.id, {
          recipientId,
          deliveryId,
          request: SendMessageRequest.toJSON(params),
          message: Message.toJSON(message),
          task: wireTask,
        });
        return task;
      })
      .catch((error) => {
        throw protocolError(error);
      });
    if (params.configuration?.returnImmediately)
      return historyView(accepted, params.configuration.historyLength);
    // The standard's default SendMessage mode waits for terminal/interrupted state.
    for (;;) {
      if (identity.signal?.aborted) throw new Error('A2A request disconnected.');
      const current = await this.getTask(
        recipientId,
        {
          tenant: p.missionId,
          id: accepted.id,
          historyLength: params.configuration?.historyLength,
        },
        identity,
      );
      const state = current.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
      if (terminal.has(state) || interrupted.has(state)) return current;
      await delay(256, undefined, { signal: identity.signal });
    }
  }

  private async getTask(
    recipientId: string,
    params: GetTaskRequest,
    identity: CallIdentity,
  ): Promise<Task> {
    validateTenant(params.tenant, identity.principal);
    validateHistoryLength(params.historyLength);
    const row = await this.taskRow(
      this.options.db,
      identity.principal,
      recipientId,
      id(params.id, 'id'),
    );
    return historyView(Task.fromJSON(row.task), params.historyLength);
  }

  private async listTasks(
    recipientId: string,
    params: ListTasksRequest,
    identity: CallIdentity,
  ): Promise<ListTasksResponse> {
    const p = identity.principal;
    validateTenant(params.tenant, p);
    validateHistoryLength(params.historyLength);
    const pageSize = boundedLimit(params.pageSize, 50, 100);
    const values: unknown[] = [p.missionId, recipientId, p.agentId];
    let filter = 'mission_id=$1 AND recipient_id=$2 AND (sender_id=$3 OR recipient_id=$3)';
    if (params.contextId) {
      values.push(params.contextId);
      filter += ` AND context_id=$${values.length}`;
    }
    if (params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      if (!Number.isInteger(params.status) || params.status < 1 || params.status > 8)
        throw new RequestMalformedError('Invalid task status.');
      values.push(params.status);
      filter += ` AND state=$${values.length}`;
    }
    if (params.statusTimestampAfter) {
      if (!Number.isFinite(Date.parse(params.statusTimestampAfter)))
        throw new RequestMalformedError('Invalid timestamp.');
      values.push(params.statusTimestampAfter);
      filter += ` AND (task->'status'->>'timestamp')::timestamptz>=$${values.length}::timestamptz`;
    }
    const total = (
      await this.options.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM a2a_tasks WHERE ${filter}`,
        values,
      )
    ).rows[0]!;
    const scope = hash([
      filter,
      values,
      pageSize,
      params.historyLength ?? null,
      params.includeArtifacts ?? false,
    ]);
    if (params.pageToken) {
      const cursor = decodeCursor(params.pageToken, scope);
      values.push(cursor.at, cursor.id);
      filter += ` AND (updated_at,task_id)<($${values.length - 1}::timestamptz,$${values.length})`;
    }
    values.push(pageSize + 1);
    const rows = (
      await this.options.db.query<TaskRow & { cursor_at: string }>(
        `SELECT *,updated_at::text AS cursor_at FROM a2a_tasks WHERE ${filter} ORDER BY updated_at DESC,task_id DESC LIMIT $${values.length}`,
        values,
      )
    ).rows;
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return {
      tasks: page.map((row) => {
        const task = historyView(Task.fromJSON(row.task), params.historyLength);
        if (!params.includeArtifacts) task.artifacts = [];
        return task;
      }),
      pageSize,
      totalSize: Number(total.count),
      nextPageToken:
        rows.length > pageSize && last
          ? Buffer.from(json({ v: 1, at: last.cursor_at, id: last.task_id, scope })).toString(
              'base64url',
            )
          : '',
    };
  }

  private async cancelTask(
    recipientId: string,
    params: CancelTaskRequest,
    identity: CallIdentity,
  ): Promise<Task> {
    const p = identity.principal;
    validateTenant(params.tenant, p);
    return this.options.db
      .transaction(async (tx) => {
        await lockMission(tx, p.missionId);
        await this.options.validatePrincipal(tx, p);
        const row = await this.taskRow(tx, p, recipientId, id(params.id, 'id'), true);
        if (row.state === TaskState.TASK_STATE_CANCELED) return Task.fromJSON(row.task);
        if (terminal.has(row.state)) throw new TaskNotCancelableError();
        const task = Task.fromJSON(row.task);
        const recipient = p.agentId === row.sender_id ? row.recipient_id : row.sender_id;
        const notice = Message.fromJSON({
          messageId: randomUUID(),
          taskId: task.id,
          contextId: task.contextId,
          role: p.agentId === row.sender_id ? 'ROLE_USER' : 'ROLE_AGENT',
          parts: [
            {
              text: 'The consultation was canceled. This does not terminate unrelated code execution.',
            },
          ],
          metadata: { mesh: { kind: 'cancellation' } },
        });
        task.history.push(notice);
        task.status = {
          state: TaskState.TASK_STATE_CANCELED,
          message: notice,
          timestamp: new Date().toISOString(),
        };
        const wireTask = Task.toJSON(task);
        await tx.query(
          'UPDATE a2a_tasks SET state=$1,task=$2::jsonb,updated_at=now() WHERE task_id=$3',
          [TaskState.TASK_STATE_CANCELED, json(wireTask), task.id],
        );
        await this.recordMessage(
          tx,
          p,
          recipient,
          notice,
          hash(Message.toJSON(notice)),
          wireTask,
          'cancellation',
          row.trace_id,
        );
        const deliveryId = await this.deliver(
          tx,
          p,
          recipient,
          notice,
          'cancellation',
          row.trace_id,
        );
        await changed(tx, p.missionId);
        await this.trace(tx, p, 'task.canceled', row.trace_id, notice.messageId, task.id, {
          task: wireTask,
          message: Message.toJSON(notice),
          deliveryId,
          recipientId: recipient,
          metadata: params.metadata,
        });
        return task;
      })
      .catch((error) => {
        throw protocolError(error);
      });
  }

  private async dispatch(outboxId: string): Promise<void> {
    const scope = (
      await this.options.db.query<{ mission_id: string }>(
        'SELECT mission_id FROM a2a_outbox WHERE outbox_id=$1',
        [outboxId],
      )
    ).rows[0];
    if (!scope) return;
    const row = await this.options.db.transaction(async (tx) => {
      await lockMission(tx, scope.mission_id);
      const current = (
        await tx.query<OutboxRow>(
          "SELECT * FROM a2a_outbox WHERE outbox_id=$1 AND state IN ('pending','sending') AND next_attempt_at<=now() FOR UPDATE SKIP LOCKED",
          [outboxId],
        )
      ).rows[0];
      if (!current) return undefined;
      const attemptId = randomUUID();
      await tx.query(
        "UPDATE a2a_outbox SET state='sending',attempts=attempts+1,attempt_id=$1,next_attempt_at=now()+interval '32 seconds' WHERE outbox_id=$2",
        [attemptId, outboxId],
      );
      await tx.query('INSERT INTO a2a_outbox_attempts(attempt_id,outbox_id) VALUES($1,$2)', [
        attemptId,
        outboxId,
      ]);
      await this.trace(
        tx,
        current.principal,
        'message.delivery.started',
        current.trace_id,
        current.message_id,
        undefined,
        {
          outboxId,
          attemptId,
          attempt: current.attempts + 1,
          request: current.request,
          recipientId: current.recipient_id,
        },
      );
      return { ...current, attempt_id: attemptId, attempts: current.attempts + 1 };
    });
    if (!row) return;
    // This ephemeral capability authorizes ONLY this already committed envelope. It
    // cannot authenticate a CLI or perform arbitrary requests with a retired run.
    const token = `mesh-outbox.${randomBytes(32).toString('base64url')}`;
    this.capabilities.set(token, {
      outboxId,
      recipientId: row.recipient_id,
      payloadHash: row.payload_hash,
      requestHash: hash(SendMessageRequest.toJSON(SendMessageRequest.fromJSON(row.request))),
    });
    try {
      const client = await this.factory.createFromAgentCard(
        this.card(row.principal, row.recipient_id),
      );
      const result = await client.sendMessage(SendMessageRequest.fromJSON(row.request), {
        signal: AbortSignal.timeout(16_000),
        serviceParameters: { Authorization: `Bearer ${token}` },
      });
      if (!('id' in result))
        throw new Error('Peer returned a Message instead of a durable consultation Task.');
      const wireResult = Task.toJSON(result);
      await this.options.db.transaction(async (tx) => {
        await lockMission(tx, row.mission_id);
        await tx.query(
          'UPDATE a2a_outbox_attempts SET ended_at=now(),result=$1::jsonb WHERE attempt_id=$2',
          [json(wireResult), row.attempt_id],
        );
        await tx.query(
          "UPDATE a2a_outbox SET state='delivered',result=$1::jsonb,last_error=NULL,delivered_at=now() WHERE outbox_id=$2 AND attempt_id=$3",
          [json(wireResult), outboxId, row.attempt_id],
        );
        await this.trace(
          tx,
          row.principal,
          'message.delivery.accepted',
          row.trace_id,
          row.message_id,
          result.id,
          { outboxId, attemptId: row.attempt_id, result: wireResult },
        );
      });
    } catch (error) {
      const permanent =
        error instanceof RequestMalformedError ||
        error instanceof TaskNotFoundError ||
        error instanceof UnsupportedOperationError ||
        error instanceof ContentTypeNotSupportedError;
      const failure = publicError(error, token);
      const backoffSeconds = Math.min(64, 2 ** Math.min(row.attempts, 6));
      await this.options.db.transaction(async (tx) => {
        await lockMission(tx, row.mission_id);
        await tx.query(
          'UPDATE a2a_outbox_attempts SET ended_at=now(),error=$1::jsonb WHERE attempt_id=$2',
          [json(failure), row.attempt_id],
        );
        await tx.query(
          "UPDATE a2a_outbox SET state=$1,last_error=$2::jsonb,next_attempt_at=now()+$3*interval '1 second' WHERE outbox_id=$4 AND attempt_id=$5",
          [
            permanent ? 'failed' : 'pending',
            json(failure),
            backoffSeconds,
            outboxId,
            row.attempt_id,
          ],
        );
        await this.trace(
          tx,
          row.principal,
          permanent ? 'message.delivery.rejected' : 'message.delivery.retry_scheduled',
          row.trace_id,
          row.message_id,
          undefined,
          {
            outboxId,
            attemptId: row.attempt_id,
            error: failure,
            retrySeconds: permanent ? null : backoffSeconds,
          },
        );
      });
    } finally {
      this.capabilities.delete(token);
    }
  }

  private async authenticateRequest(
    req: Request,
    recipientId: string,
    card = false,
  ): Promise<CallIdentity> {
    const authorization = req.get('Authorization') ?? '';
    const token = /^Bearer (\S+)$/i.exec(authorization)?.[1];
    if (!token) throw new MeshError('UNAUTHENTICATED', 'Bearer authentication is required.');
    const capability = this.capabilities.get(token);
    if (capability) {
      if (
        card ||
        capability.recipientId !== recipientId ||
        asObject(req.body).method !== 'SendMessage'
      ) {
        throw new MeshError(
          'UNAUTHORIZED',
          'This delivery credential cannot perform that operation.',
        );
      }
      const request = SendMessageRequest.fromJSON(asObject(req.body).params ?? {});
      if (
        !request.message ||
        hash(Message.toJSON(request.message)) !== capability.payloadHash ||
        hash(SendMessageRequest.toJSON(request)) !== capability.requestHash
      ) {
        throw new MeshError(
          'UNAUTHORIZED',
          'The envelope does not match this delivery credential.',
        );
      }
      const row = (
        await this.options.db.query<OutboxRow>('SELECT * FROM a2a_outbox WHERE outbox_id=$1', [
          capability.outboxId,
        ])
      ).rows[0];
      if (!row || row.recipient_id !== recipientId || row.payload_hash !== capability.payloadHash) {
        throw new MeshError('UNAUTHORIZED', 'Accepted delivery intent was not found.');
      }
      return { principal: row.principal, persistedOutboxId: row.outbox_id, traceId: row.trace_id };
    }
    return { principal: await this.options.authenticate(token) };
  }

  private async correlateRequest(identity: CallIdentity, recipientId: string, body: unknown) {
    const p = identity.principal;
    const params = asObject(asObject(body).params);
    const message = asObject(params.message);
    const taskId =
      typeof message.taskId === 'string'
        ? message.taskId
        : typeof params.id === 'string'
          ? params.id
          : undefined;
    const prior =
      typeof message.messageId === 'string'
        ? (
            await this.options.db.query<{ trace_id: string; task_id: string }>(
              'SELECT trace_id,task_id FROM a2a_messages WHERE mission_id=$1 AND sender_id=$2 AND recipient_id=$3 AND message_id=$4',
              [p.missionId, p.agentId, recipientId, message.messageId],
            )
          ).rows[0]
        : undefined;
    const task =
      !prior && taskId
        ? (
            await this.options.db.query<{ trace_id: string; task_id: string }>(
              'SELECT trace_id,task_id FROM a2a_tasks WHERE task_id=$1 AND mission_id=$2 AND recipient_id=$3 AND (sender_id=$4 OR recipient_id=$4)',
              [taskId, p.missionId, recipientId, p.agentId],
            )
          ).rows[0]
        : undefined;
    identity.traceId = prior?.trace_id ?? task?.trace_id ?? identity.traceId ?? randomUUID();
    identity.taskId = prior?.task_id ?? task?.task_id;
  }

  private async taskRow(
    tx: Sql,
    principal: Principal,
    recipientId: string,
    taskId: string,
    lock = false,
  ): Promise<TaskRow> {
    const row = (
      await tx.query<TaskRow>(
        `SELECT * FROM a2a_tasks WHERE task_id=$1 AND mission_id=$2 AND recipient_id=$3 AND (sender_id=$4 OR recipient_id=$4)${lock ? ' FOR UPDATE' : ''}`,
        [taskId, principal.missionId, recipientId, principal.agentId],
      )
    ).rows[0];
    if (!row) throw new TaskNotFoundError();
    return row;
  }

  private async recordMessage(
    tx: Sql,
    p: Principal,
    recipientId: string,
    message: Message,
    payloadHash: string,
    result: unknown,
    kind: string,
    traceId: string,
  ) {
    await tx.query(
      `INSERT INTO a2a_messages(mission_id,sender_id,recipient_id,message_id,task_id,run_id,generation,payload_hash,message,accepted_result,kind,trace_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
      [
        p.missionId,
        p.agentId,
        recipientId,
        message.messageId,
        message.taskId,
        p.runId,
        p.generation,
        payloadHash,
        json(Message.toJSON(message)),
        json(result),
        kind,
        traceId,
      ],
    );
  }

  private async deliver(
    tx: Sql,
    p: Principal,
    recipientId: string,
    message: Message,
    kind: string,
    traceId: string,
  ): Promise<string> {
    const deliveryId = randomUUID();
    await tx.query(
      `INSERT INTO mailbox_deliveries(delivery_id,mission_id,sender_id,recipient_id,message_id,task_id,message,kind,trace_id)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [
        deliveryId,
        p.missionId,
        p.agentId,
        recipientId,
        message.messageId,
        message.taskId,
        json(Message.toJSON(message)),
        kind,
        traceId,
      ],
    );
    await this.trace(
      tx,
      p,
      'message.mailbox.persisted',
      traceId,
      message.messageId,
      message.taskId,
      { deliveryId, recipientId, message: Message.toJSON(message) },
    );
    return deliveryId;
  }

  private async requirePeer(tx: Sql, p: Principal, recipientId: string): Promise<void> {
    if (!(await this.options.peerExists(tx, p.missionId, recipientId)))
      throw new TaskNotFoundError('Peer is not registered in this mission.');
  }

  private async pendingCount(tx: Sql, p: Principal): Promise<number> {
    const result = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM mailbox_deliveries WHERE mission_id=$1 AND recipient_id=$2 AND handled_at IS NULL',
      [p.missionId, p.agentId],
    );
    return Number(result.rows[0]!.count);
  }

  private async outboxReceipt(outboxId: string) {
    const row = (
      await this.options.db.query<OutboxRow>('SELECT * FROM a2a_outbox WHERE outbox_id=$1', [
        outboxId,
      ])
    ).rows[0]!;
    const task = row.result ? Task.fromJSON(row.result) : undefined;
    return {
      outboxId,
      messageId: row.message_id,
      recipientId: row.recipient_id,
      state: row.state,
      taskId: task?.id,
      contextId: task?.contextId,
      traceId: row.trace_id,
      task: row.result,
      attempts: row.attempts,
      error: row.last_error,
    };
  }

  private trace(
    tx: Sql,
    p: Principal,
    kind: string,
    traceId: string,
    messageId: string | undefined,
    taskId: string | undefined,
    data: unknown,
  ) {
    const detail = asObject(data);
    const message = asObject(detail.message ?? asObject(detail.request).message);
    const metadata = asObject(asObject(message.metadata).mesh);
    return this.options.events(
      {
        missionId: p.missionId,
        agentId: p.agentId,
        runId: p.runId,
        kind,
        traceId,
        messageId,
        taskId,
        correlationId: typeof metadata.correlationId === 'string' ? metadata.correlationId : taskId,
        causationId: typeof metadata.causationId === 'string' ? metadata.causationId : undefined,
        data,
      },
      tx,
    );
  }
}

function callIdentity(context: ServerCallContext): CallIdentity {
  const identity = context.state.get('mesh.identity') as CallIdentity | undefined;
  if (!identity || context.user?.userName !== stableOwner(identity.principal))
    throw new RequestMalformedError('Authenticated peer context is missing.');
  return identity;
}
function stableOwner(p: Principal): string {
  return json([p.missionId, p.agentId]);
}
async function lockMission(tx: Sql, missionId: string) {
  const result = await tx.query('SELECT id FROM missions WHERE id=$1 FOR UPDATE', [missionId]);
  if (!result.rows.length) throw new TaskNotFoundError('Mission does not exist.');
}
async function changed(tx: Sql, missionId: string) {
  await tx.query('UPDATE missions SET revision=revision+1 WHERE id=$1', [missionId]);
}
async function workRevision(tx: Sql, missionId: string): Promise<string> {
  return String(
    (await tx.query<{ revision: string }>('SELECT revision FROM missions WHERE id=$1', [missionId]))
      .rows[0]!.revision,
  );
}
async function messageLock(tx: Sql, p: Principal, recipientId: string, messageId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    json([p.missionId, p.agentId, recipientId, messageId]),
  ]);
}
function id(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new RequestMalformedError(`Invalid ${name}.`);
  return value;
}
function json(value: unknown): string {
  return JSON.stringify(value);
}
function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function hash(value: unknown): string {
  return createHash('sha256')
    .update(json(canonical(value)))
    .digest('hex');
}
function requireSamePayload(existing: string, incoming: string) {
  if (existing !== incoming)
    throw new RequestMalformedError('messageId was already used with a different payload.');
}
function contentParts(input: { text?: string; data?: unknown }): unknown[] {
  const parts: unknown[] = [];
  if (input.text !== undefined) {
    if (typeof input.text !== 'string' || !input.text.trim())
      throw new RequestMalformedError('Message text must not be empty.');
    parts.push({ text: input.text, mediaType: 'text/plain' });
  }
  if (input.data !== undefined) parts.push({ data: input.data, mediaType: 'application/json' });
  if (!parts.length) throw new RequestMalformedError('Supply message text or structured data.');
  return parts;
}
function validateMessage(message: Message, role: Role) {
  id(message.messageId, 'messageId');
  if (message.role !== role)
    throw new RequestMalformedError('Message role does not match the request direction.');
  if (!message.parts.length || message.parts.some((part) => !part.content))
    throw new RequestMalformedError('Messages require content parts.');
  if (message.parts.some((part) => !['text', 'data'].includes(part.content!.$case)))
    throw new ContentTypeNotSupportedError('This peer accepts text and JSON data.');
  if (Buffer.byteLength(json(Message.toJSON(message)), 'utf8') > 1_048_576)
    throw new RequestMalformedError('Message exceeds the 1 MiB limit.');
}
function messageKind(message: Message): string {
  const kind = asObject(asObject(message.metadata).mesh).kind;
  return typeof kind === 'string' &&
    ['question', 'answer', 'offer', 'proposal', 'challenge', 'correction', 'review'].includes(kind)
    ? kind
    : 'question';
}
function validateTenant(tenant: string, p: Principal) {
  if (tenant && tenant !== p.missionId)
    throw new TaskNotFoundError('Mission scope is not accessible.');
}
function validateHistoryLength(length: number | undefined) {
  if (length !== undefined && (!Number.isInteger(length) || length < 0))
    throw new RequestMalformedError('historyLength must be a nonnegative integer.');
}
function historyView(task: Task, length: number | undefined): Task {
  if (length !== undefined) task.history = length === 0 ? [] : task.history.slice(-length);
  return task;
}
function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new RequestMalformedError(`Limit must be an integer from 1 to ${max}.`);
  return value;
}
function decodeCursor(token: string, scope: string): { at: string; id: string } {
  try {
    if (token.length > 2048) throw new Error();
    const cursor = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (
      cursor.v !== 1 ||
      cursor.scope !== scope ||
      typeof cursor.at !== 'string' ||
      !Number.isFinite(Date.parse(cursor.at))
    )
      throw new Error();
    return { at: cursor.at, id: id(cursor.id, 'cursor id') };
  } catch {
    throw new RequestMalformedError('Invalid page token or changed query scope.');
  }
}
function deliveryView(row: DeliveryRow) {
  return {
    deliveryId: row.delivery_id,
    messageId: row.message_id,
    taskId: row.task_id,
    from: row.sender_id,
    to: row.recipient_id,
    kind: row.kind,
    message: row.message,
    traceId: row.trace_id,
    createdAt: row.created_at,
    disposition: row.disposition,
  };
}
function publicError(error: unknown, secret?: string) {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.replaceAll(secret, '[redacted]');
  return { name: error instanceof Error ? error.name : 'Error', message: message.slice(0, 4096) };
}
function protocolError(error: unknown): unknown {
  if (error instanceof MeshError) {
    if (['NOT_FOUND', 'UNAUTHORIZED', 'STALE_RUN', 'STALE_GENERATION'].includes(error.code))
      return new TaskNotFoundError(error.message);
    return new RequestMalformedError(error.message);
  }
  return error;
}
function rpcId(body: unknown): string | number | null {
  const value = asObject(body).id;
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
    ? value
    : null;
}
function rawMessageId(body: unknown): string | undefined {
  const value = asObject(asObject(asObject(body).params).message).messageId;
  return typeof value === 'string' ? value : undefined;
}
async function* unsupportedStream(): AsyncGenerator<StreamResponse, void, undefined> {
  throw new UnsupportedOperationError('Streaming is not supported; use GetTask polling.');
}
async function unsupportedPush(): Promise<never> {
  throw new PushNotificationNotSupportedError();
}
