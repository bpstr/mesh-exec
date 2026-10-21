import { createHash } from 'node:crypto';
import { uptakeView, uptakeLedgerAvailable, type UptakeRecord, type UptakeRow } from './a2a.js';
import { redact } from './trace.js';
import { MeshError, type Sql, type TraceEvent } from './types.js';

/** Delivery and task state are separate; a completed task can still have unread mail. */
export const CONVERSATION_STATES = [
  'queued',
  'sending',
  'retrying',
  'delivery-rejected',
  'accepted',
  'received',
  'offered',
  'deferred',
  'handled',
  'rejected',
  'superseded',
] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export interface ConversationFilter {
  agent?: string;
  task?: string;
  message?: string;
  outbox?: string;
  /** Validated against CONVERSATION_STATES, including for raw HTTP/CLI input. */
  state?: string;
  cursor?: string;
  limit?: number;
}

export interface HistoryWindow<T> {
  total: number;
  /** Most recent records, in chronological order. Use the timeline for the complete history. */
  items: T[];
  truncated: boolean;
}

export interface DeliveryAttempt {
  attemptId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  result: unknown;
  error: unknown;
}

export interface MessageExposure {
  runId: string;
  offeredAt: string;
}
export interface MessageAcknowledgement {
  eventId: string;
  seq: string;
  at: string;
  runId: string | null;
  disposition: string | null;
  reason: unknown;
}

export interface ConversationMessage {
  missionId: string;
  messageId: string;
  senderId: string;
  recipientId: string;
  senderRunId: string | null;
  senderGeneration: number | null;
  kind: string;
  createdAt: string;
  firstSeq: string | null;
  traceIds: string[];
  taskId: string | null;
  contextId: string | null;
  /** Full accepted message, or the original submitted message before recipient acceptance. */
  message: unknown;
  lifecycle: {
    state: ConversationState;
    transport: 'none' | 'queued' | 'sending' | 'retrying' | 'delivered' | 'rejected';
    mailbox: 'absent' | 'pending' | 'offered' | 'deferred' | 'handled' | 'rejected' | 'superseded';
    task: string | null;
    taskTerminal: boolean;
    taskReplyCount: number;
  };
  outbox: null | {
    outboxId: string;
    state: string;
    attempts: number;
    acceptedAt: string;
    nextAttemptAt: string;
    deliveredAt: string | null;
    originalPrincipal: unknown;
    request: unknown;
    result: unknown;
    lastError: unknown;
    history: HistoryWindow<DeliveryAttempt>;
  };
  ingress: null | {
    acceptedAt: string;
    runId: string;
    generation: number;
    message: unknown;
    acceptedResult: unknown;
  };
  delivery: null | {
    deliveryId: string;
    persistedAt: string;
    disposition: string | null;
    reason: string | null;
    handledAt: string | null;
    handledByRunId: string | null;
    exposures: HistoryWindow<MessageExposure>;
    acknowledgements: HistoryWindow<MessageAcknowledgement>;
    /** Receiver assertions, independent of delivery/handling/task states. */
    uptakes: HistoryWindow<UptakeRecord> & { available: boolean };
  };
  timings: {
    unit: 'milliseconds';
    basis: 'recorded-wall-clock';
    transportReceiptMs: number | null;
    recipientPersistenceMs: number | null;
    firstExposureMs: number | null;
    firstAcknowledgementMs: number | null;
    finalAcknowledgementMs: number | null;
    firstTaskReplyMs: number | null;
    pendingAgeMs: number | null;
    /** Negative values are retained and named, rather than silently clamped. */
    negativeIntervals: string[];
  };
  warnings: string[];
}

export interface ConversationMessagePage {
  messages: ConversationMessage[];
  nextCursor: string | null;
  snapshotSeq: string;
  observedAt: string;
}

export interface ConversationTimelinePage {
  events: TraceEvent[];
  nextCursor: string | null;
  snapshotSeq: string;
  observedAt: string;
}

type JsonObject = Record<string, unknown>;
interface MessageRow {
  mission_id: string;
  sender_id: string;
  recipient_id: string;
  message_id: string;
  outbox: JsonObject | null;
  ingress: JsonObject | null;
  delivery: JsonObject | null;
  task: JsonObject | null;
  task_id: string | null;
  context_id: string | null;
  message: unknown;
  kind: string;
  created_at: string;
  first_seq: string;
  trace_ids: string[];
  state: ConversationState;
  exposure_count: string;
  first_exposure_at: string | null;
  acknowledgement_count: string;
  first_acknowledgement_at: string | null;
  reply_count: string;
  first_reply_at: string | null;
}

interface Cursor {
  v: 1;
  kind: 'messages' | 'events';
  scope: string;
  snapshotSeq: string;
  snapshotAt: string;
  last: { seq: string; sender?: string; recipient?: string; message?: string };
}

const HISTORY_LIMIT = 20;
const MAX_SEQUENCE = 9_223_372_036_854_775_807n;
const taskStates: Record<number, string> = {
  1: 'submitted',
  2: 'working',
  3: 'completed',
  4: 'failed',
  5: 'canceled',
  6: 'input-required',
  7: 'rejected',
  8: 'auth-required',
};

// UNION identities first, rather than starting from the inbox: an outgoing
// question is inspectable even if no recipient has ever accepted it.
const SOURCES = `
WITH identities AS (
  SELECT mission_id,sender_id,recipient_id,message_id FROM a2a_outbox WHERE mission_id=$1
  UNION
  SELECT mission_id,sender_id,recipient_id,message_id FROM a2a_messages WHERE mission_id=$1
  UNION
  SELECT mission_id,sender_id,recipient_id,message_id FROM mailbox_deliveries WHERE mission_id=$1
), source_records AS (
  SELECT i.*,
    CASE WHEN o.outbox_id IS NOT NULL THEN to_jsonb(o) END AS outbox,
    CASE WHEN m.message_id IS NOT NULL THEN to_jsonb(m) END AS ingress,
    CASE WHEN d.delivery_id IS NOT NULL THEN to_jsonb(d) END AS delivery,
    COALESCE(m.task_id,d.task_id,NULLIF(o.result->>'id',''),requested_task.task_id) AS task_id,
    COALESCE(m.message,d.message,o.request->'message') AS message,
    COALESCE(m.kind,d.kind,o.request->'message'->'metadata'->'mesh'->>'kind','question') AS kind,
    LEAST(o.created_at,m.created_at,d.created_at)::text AS created_at,
    array_remove(ARRAY[o.trace_id,m.trace_id,d.trace_id],NULL) AS source_trace_ids
  FROM identities i
  LEFT JOIN a2a_outbox o USING(mission_id,sender_id,recipient_id,message_id)
  LEFT JOIN a2a_messages m USING(mission_id,sender_id,recipient_id,message_id)
  LEFT JOIN mailbox_deliveries d USING(mission_id,sender_id,recipient_id,message_id)
  LEFT JOIN a2a_tasks requested_task ON requested_task.mission_id=i.mission_id
    AND requested_task.task_id=o.request->'message'->>'taskId'
    AND requested_task.recipient_id=i.recipient_id
    AND (requested_task.sender_id=i.sender_id OR requested_task.recipient_id=i.sender_id)
), indexed AS (
  SELECT s.*,
    CASE WHEN t.task_id IS NOT NULL THEN to_jsonb(t) END AS task,
    COALESCE(t.context_id,NULLIF(s.message->>'contextId','')) AS context_id,
    s.source_trace_ids || CASE WHEN t.trace_id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[t.trace_id] END AS trace_ids,
    COALESCE(first_event.seq,0)::text AS first_seq,
    exposure.count::text AS exposure_count,exposure.first_at::text AS first_exposure_at,
    acknowledgement.count::text AS acknowledgement_count,acknowledgement.first_at::text AS first_acknowledgement_at,
    replies.count::text AS reply_count,replies.first_at::text AS first_reply_at,
    CASE
      WHEN s.delivery->>'handled_at' IS NOT NULL THEN s.delivery->>'disposition'
      WHEN s.delivery->>'disposition'='deferred' THEN 'deferred'
      WHEN s.delivery IS NOT NULL AND exposure.count>0 THEN 'offered'
      WHEN s.delivery IS NOT NULL THEN 'received'
      WHEN s.ingress IS NOT NULL OR s.outbox->>'state'='delivered' THEN 'accepted'
      WHEN s.outbox->>'state'='failed' THEN 'delivery-rejected'
      WHEN s.outbox->>'state'='sending' THEN 'sending'
      WHEN (s.outbox->>'attempts')::integer>0 THEN 'retrying'
      ELSE 'queued'
    END AS state
  FROM source_records s
  LEFT JOIN a2a_tasks t ON t.mission_id=s.mission_id AND t.task_id=s.task_id
  LEFT JOIN LATERAL (
    SELECT min(e.seq) AS seq FROM trace_events e
    WHERE e.mission_id=s.mission_id AND e.message_id=s.message_id AND e.agent_id=s.sender_id
      AND e.data->>'recipientId'=s.recipient_id
      AND e.kind IN ('message.send.accepted','message.mailbox.persisted','message.ingress.accepted','message.reply.accepted','task.canceled')
  ) first_event ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS count,min(offered_at) AS first_at FROM mailbox_offers
    WHERE delivery_id=s.delivery->>'delivery_id'
  ) exposure ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS count,min(at) AS first_at FROM trace_events e
    WHERE e.mission_id=s.mission_id AND e.task_id=s.task_id AND e.kind='message.acknowledged'
      AND e.data->>'deliveryId'=s.delivery->>'delivery_id'
  ) acknowledgement ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS count,min(m.created_at) AS first_at FROM a2a_messages m
    WHERE m.mission_id=s.mission_id AND m.task_id=s.task_id AND m.kind='answer'
      AND m.sender_id=s.recipient_id AND m.recipient_id=s.sender_id
      AND s.sender_id=t.sender_id AND s.recipient_id=t.recipient_id
      AND m.created_at>=s.created_at::timestamptz
  ) replies ON true
)
`;

/**
 * Read-only logical-message diagnostics, including intents without a delivery.
 * Enumeration is fenced at snapshotSeq. Lifecycle snapshots remain current on
 * later pages; this is not an historical MVCC snapshot across HTTP requests.
 */
export async function listConversationMessages(
  db: Sql,
  missionId: string,
  filter: ConversationFilter = {},
): Promise<ConversationMessagePage> {
  const limit = pageLimit(filter.limit, 50, 200);
  const boundary = await pagination(db, missionId, filter, 'messages');
  const args: unknown[] = [missionId, boundary.snapshotSeq, boundary.snapshotAt];
  const where = selectors(filter, args);
  where.push('first_seq::bigint<=$2::bigint', 'created_at::timestamptz<=$3::timestamptz');
  if (boundary.cursor) {
    const last = boundary.cursor.last;
    args.push(last.seq, last.sender, last.recipient, last.message);
    const p = args.length - 3;
    where.push(
      `(first_seq::bigint,sender_id COLLATE "C",recipient_id COLLATE "C",message_id COLLATE "C")<($${p}::bigint,$${p + 1}::text COLLATE "C",$${p + 2}::text COLLATE "C",$${p + 3}::text COLLATE "C")`,
    );
  }
  args.push(limit + 1);
  const rows = (
    await db.query<MessageRow>(
      `${SOURCES}
    SELECT * FROM indexed WHERE ${where.join(' AND ')}
    ORDER BY first_seq::bigint DESC,sender_id COLLATE "C" DESC,recipient_id COLLATE "C" DESC,message_id COLLATE "C" DESC
    LIMIT $${args.length}`,
      args,
    )
  ).rows;
  const selected = rows.slice(0, limit);
  const histories = await messageHistories(db, missionId, selected);
  const messages = selected.map((row) => messageView(row, histories, boundary.observedAt));
  const last = selected.at(-1);
  return redact({
    messages,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({
            ...boundary.base,
            last: {
              seq: last.first_seq,
              sender: last.sender_id,
              recipient: last.recipient_id,
              message: last.message_id,
            },
          })
        : null,
    snapshotSeq: boundary.snapshotSeq,
    observedAt: boundary.observedAt,
  }) as ConversationMessagePage;
}

/**
 * Event-sequence pagination for the selected conversations. A message selector
 * expands to its task/trace, including replies, but never to the whole run.
 * Native Codex item IDs are scoped by run and trace; a run ID is not a
 * conversation trace even when native capture uses it as trace_id.
 */
export async function conversationTimeline(
  db: Sql,
  missionId: string,
  filter: ConversationFilter = {},
): Promise<ConversationTimelinePage> {
  const limit = pageLimit(filter.limit, 100, 1000);
  const boundary = await pagination(db, missionId, filter, 'events');
  const args: unknown[] = [missionId, boundary.snapshotSeq, boundary.snapshotAt];
  const where = selectors(filter, args);
  where.push('first_seq::bigint<=$2::bigint', 'created_at::timestamptz<=$3::timestamptz');
  args.push(boundary.cursor?.last.seq ?? '0');
  const afterParameter = args.length;
  args.push(limit + 1);
  const rows = (
    await db.query<JsonObject>(
      `${SOURCES}, selected AS (
    SELECT * FROM indexed WHERE ${where.join(' AND ')}
  ), related AS (
    SELECT e.id,e.trace_id,e.span_id,e.run_id FROM trace_events e
    WHERE e.mission_id=$1 AND e.seq<=$2::bigint AND EXISTS (
      SELECT 1 FROM selected s WHERE
        (e.task_id IS NOT NULL AND e.task_id=s.task_id)
        OR (e.trace_id IS NOT NULL AND e.trace_id=ANY(s.trace_ids))
        OR (COALESCE(e.data->>'deliveryId',e.data->'arguments'->>'deliveryId',e.data->'result'->>'deliveryId')=s.delivery->>'delivery_id')
        OR (COALESCE(e.data->>'outboxId',e.data->'result'->>'outboxId')=s.outbox->>'outbox_id')
        OR (e.message_id=s.message_id AND e.agent_id=s.sender_id
          AND COALESCE(e.data->>'recipientId',e.data->'arguments'->>'recipientId',
            e.data->'result'->>'recipientId',e.data->'event'->'item'->'arguments'->>'recipientId')=s.recipient_id)
        OR (e.message_id=s.message_id AND e.agent_id=s.recipient_id AND e.data->>'senderId'=s.sender_id)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(COALESCE(e.data->'messages',e.data->'result'->'messages'))='array'
            THEN COALESCE(e.data->'messages',e.data->'result'->'messages') ELSE '[]'::jsonb END
        ) item WHERE item->>'deliveryId'=s.delivery->>'delivery_id')
    )
  )
  SELECT e.* FROM trace_events e WHERE e.mission_id=$1 AND e.seq>$${afterParameter}::bigint AND e.seq<=$2::bigint
    AND (EXISTS(SELECT 1 FROM related r WHERE r.id=e.id)
      OR (e.trace_id IS NOT NULL AND e.trace_id IS DISTINCT FROM e.run_id
        AND EXISTS(SELECT 1 FROM related r WHERE r.trace_id=e.trace_id AND r.trace_id IS DISTINCT FROM r.run_id))
      OR (e.span_id IS NOT NULL AND EXISTS(SELECT 1 FROM related r WHERE r.span_id=e.span_id
        AND r.trace_id IS NOT DISTINCT FROM e.trace_id AND r.run_id IS NOT DISTINCT FROM e.run_id)))
  ORDER BY e.seq LIMIT $${args.length}`,
      args,
    )
  ).rows;
  const events = rows.slice(0, limit).map(eventView);
  const last = events.at(-1);
  return redact({
    events,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ ...boundary.base, last: { seq: last.seq } })
        : null,
    snapshotSeq: boundary.snapshotSeq,
    observedAt: boundary.observedAt,
  }) as ConversationTimelinePage;
}

interface Histories {
  attempts: Map<string, JsonObject[]>;
  exposures: Map<string, JsonObject[]>;
  acknowledgements: Map<string, JsonObject[]>;
  uptakes: Map<string, JsonObject[]>;
  uptakesAvailable: boolean;
}

async function messageHistories(
  db: Sql,
  missionId: string,
  rows: MessageRow[],
): Promise<Histories> {
  const outboxes = rows.flatMap((r) =>
    typeof r.outbox?.outbox_id === 'string' ? [r.outbox.outbox_id] : [],
  );
  const deliveries = rows.flatMap((r) =>
    typeof r.delivery?.delivery_id === 'string' ? [r.delivery.delivery_id] : [],
  );
  const uptakesAvailable = await uptakeLedgerAvailable(db);
  const [attempts, exposures, acknowledgements, uptakes] = await Promise.all([
    db.query<JsonObject>(
      `SELECT * FROM (
      SELECT a.*,count(*) OVER(PARTITION BY a.outbox_id)::text AS total,
        row_number() OVER(PARTITION BY a.outbox_id ORDER BY a.started_at DESC,a.attempt_id DESC) AS position
      FROM a2a_outbox_attempts a JOIN a2a_outbox o USING(outbox_id)
      WHERE o.mission_id=$1 AND a.outbox_id=ANY($2::text[])
    ) history WHERE position<=$3 ORDER BY started_at,attempt_id`,
      [missionId, outboxes, HISTORY_LIMIT],
    ),
    db.query<JsonObject>(
      `SELECT * FROM (
      SELECT o.*,count(*) OVER(PARTITION BY o.delivery_id)::text AS total,
        row_number() OVER(PARTITION BY o.delivery_id ORDER BY o.offered_at DESC,o.run_id DESC) AS position
      FROM mailbox_offers o JOIN mailbox_deliveries d USING(delivery_id)
      WHERE d.mission_id=$1 AND o.delivery_id=ANY($2::text[])
    ) history WHERE position<=$3 ORDER BY offered_at,run_id`,
      [missionId, deliveries, HISTORY_LIMIT],
    ),
    db.query<JsonObject>(
      `SELECT * FROM (
      SELECT e.*,e.data->>'deliveryId' AS delivery_id,count(*) OVER(PARTITION BY e.data->>'deliveryId')::text AS total,
        row_number() OVER(PARTITION BY e.data->>'deliveryId' ORDER BY e.seq DESC) AS position
      FROM trace_events e WHERE e.mission_id=$1 AND e.kind='message.acknowledged'
        AND e.data->>'deliveryId'=ANY($2::text[])
    ) history WHERE position<=$3 ORDER BY seq`,
      [missionId, deliveries, HISTORY_LIMIT],
    ),
    uptakesAvailable
      ? db.query<JsonObject>(
          `SELECT * FROM (
      SELECT u.*,count(*) OVER(PARTITION BY u.delivery_id)::text AS total,
        row_number() OVER(PARTITION BY u.delivery_id ORDER BY u.created_at DESC,u.revision DESC,u.uptake_id DESC) AS position
      FROM message_uptakes u WHERE u.mission_id=$1 AND u.delivery_id=ANY($2::text[])
    ) history WHERE position<=$3 ORDER BY created_at,revision,uptake_id`,
          [missionId, deliveries, HISTORY_LIMIT],
        )
      : Promise.resolve({ rows: [], rowCount: 0 }),
  ]);
  return {
    attempts: group(attempts.rows, 'outbox_id'),
    exposures: group(exposures.rows, 'delivery_id'),
    acknowledgements: group(acknowledgements.rows, 'delivery_id'),
    uptakes: group(uptakes.rows, 'delivery_id'),
    uptakesAvailable,
  };
}

function messageView(
  row: MessageRow,
  histories: Histories,
  observedAt: string,
): ConversationMessage {
  const outbox = row.outbox;
  const ingress = row.ingress;
  const delivery = row.delivery;
  const attempts = histories.attempts.get(String(outbox?.outbox_id)) ?? [];
  const exposures = histories.exposures.get(String(delivery?.delivery_id)) ?? [];
  const acknowledgements = histories.acknowledgements.get(String(delivery?.delivery_id)) ?? [];
  const uptakes = histories.uptakes.get(String(delivery?.delivery_id)) ?? [];
  const state = number(row.task?.state);
  const sourcePrincipal = object(outbox?.principal);
  const transport = !outbox
    ? 'none'
    : outbox.state === 'delivered'
      ? 'delivered'
      : outbox.state === 'failed'
        ? 'rejected'
        : outbox.state === 'sending'
          ? 'sending'
          : number(outbox.attempts) > 0
            ? 'retrying'
            : 'queued';
  const mailbox = !delivery
    ? 'absent'
    : delivery.handled_at
      ? (string(delivery.disposition) ?? 'handled')
      : delivery.disposition === 'deferred'
        ? 'deferred'
        : Number(row.exposure_count) > 0
          ? 'offered'
          : 'pending';
  const persistedAt = timestamp(delivery?.created_at ?? ingress?.created_at);
  const timings = {
    transportReceiptMs: difference(outbox?.delivered_at, outbox?.created_at),
    recipientPersistenceMs: difference(persistedAt, row.created_at),
    firstExposureMs: difference(row.first_exposure_at, persistedAt),
    firstAcknowledgementMs: difference(row.first_acknowledgement_at, persistedAt),
    finalAcknowledgementMs: difference(delivery?.handled_at, persistedAt),
    // This is task-level association, not an assertion that one answer resolves every earlier message.
    firstTaskReplyMs: difference(row.first_reply_at, row.created_at),
    pendingAgeMs:
      !delivery?.handled_at && (delivery !== null || transport !== 'rejected')
        ? difference(observedAt, row.created_at)
        : null,
  };
  const warnings: string[] = [];
  if (!histories.uptakesAvailable)
    warnings.push(
      'Uptake history is unavailable in this database schema; no uptake records were read.',
    );
  if (row.first_seq === '0')
    warnings.push(
      'No accepted-message trace event was found; ordering uses the stable identity fallback.',
    );
  if (ingress && !delivery) warnings.push('Accepted message has no mailbox delivery record.');
  if (outbox && number(outbox.attempts) !== number(attempts[0]?.total))
    warnings.push('Outbox attempt counter and retained attempt history differ.');
  if (attempts.some((a) => !a.ended_at))
    warnings.push('At least one retained delivery attempt has no recorded end.');
  return {
    missionId: row.mission_id,
    messageId: row.message_id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    senderRunId: string(ingress?.run_id ?? sourcePrincipal.runId),
    senderGeneration:
      ingress?.generation !== undefined
        ? number(ingress.generation)
        : sourcePrincipal.generation !== undefined
          ? number(sourcePrincipal.generation)
          : null,
    kind: row.kind,
    createdAt: timestamp(row.created_at)!,
    firstSeq: row.first_seq === '0' ? null : row.first_seq,
    traceIds: [...new Set(row.trace_ids)],
    taskId: row.task_id,
    contextId: row.context_id,
    message: row.message,
    lifecycle: {
      state: row.state,
      transport,
      mailbox: mailbox as ConversationMessage['lifecycle']['mailbox'],
      task: state ? (taskStates[state] ?? 'unknown') : null,
      taskTerminal: [3, 4, 5, 7].includes(state),
      taskReplyCount: Number(row.reply_count),
    },
    outbox: outbox
      ? {
          outboxId: String(outbox.outbox_id),
          state: String(outbox.state),
          attempts: number(outbox.attempts),
          acceptedAt: timestamp(outbox.created_at)!,
          nextAttemptAt: timestamp(outbox.next_attempt_at)!,
          deliveredAt: timestamp(outbox.delivered_at),
          originalPrincipal: outbox.principal,
          request: outbox.request,
          result: outbox.result,
          lastError: outbox.last_error,
          history: window(attempts, (a) => ({
            attemptId: String(a.attempt_id),
            startedAt: timestamp(a.started_at)!,
            endedAt: timestamp(a.ended_at),
            durationMs: difference(a.ended_at, a.started_at),
            result: a.result,
            error: a.error,
          })),
        }
      : null,
    ingress: ingress
      ? {
          acceptedAt: timestamp(ingress.created_at)!,
          runId: String(ingress.run_id),
          generation: number(ingress.generation),
          message: ingress.message,
          acceptedResult: ingress.accepted_result,
        }
      : null,
    delivery: delivery
      ? {
          deliveryId: String(delivery.delivery_id),
          persistedAt: timestamp(delivery.created_at)!,
          disposition: string(delivery.disposition),
          reason: string(delivery.disposition_reason),
          handledAt: timestamp(delivery.handled_at),
          handledByRunId: string(delivery.handled_run_id),
          exposures: window(exposures, (e) => ({
            runId: String(e.run_id),
            offeredAt: timestamp(e.offered_at)!,
          })),
          acknowledgements: window(acknowledgements, (a) => ({
            eventId: String(a.id),
            seq: String(a.seq),
            at: timestamp(a.at)!,
            runId: string(a.run_id),
            disposition: string(object(a.data).disposition),
            reason: object(a.data).reason,
          })),
          uptakes: {
            ...window(uptakes, (u) => uptakeView(u as unknown as UptakeRow)),
            available: histories.uptakesAvailable,
          },
        }
      : null,
    timings: {
      unit: 'milliseconds',
      basis: 'recorded-wall-clock',
      ...timings,
      negativeIntervals: Object.entries(timings)
        .filter(([, value]) => value !== null && value < 0)
        .map(([key]) => key),
    },
    warnings,
  };
}

function selectors(filter: ConversationFilter, args: unknown[]): string[] {
  const where = ['true'];
  for (const [key, sql] of [
    ['agent', '(sender_id=$N OR recipient_id=$N)'],
    ['task', 'task_id=$N'],
    ['message', 'message_id=$N'],
    ['outbox', "outbox->>'outbox_id'=$N"],
    ['state', 'state=$N'],
  ] as const) {
    if (filter[key] !== undefined) {
      args.push(filter[key]);
      where.push(sql.replaceAll('$N', `$${args.length}`));
    }
  }
  return where;
}

async function pagination(
  db: Sql,
  missionId: string,
  filter: ConversationFilter,
  kind: Cursor['kind'],
) {
  validateId(missionId, 'missionId');
  for (const key of ['agent', 'task', 'message', 'outbox'] as const)
    if (filter[key] !== undefined) validateId(filter[key], key);
  if (filter.state !== undefined && !CONVERSATION_STATES.some((state) => state === filter.state))
    throw new MeshError('INVALID_FILTER', 'Unknown conversation state.');
  const scope = createHash('sha256')
    .update(
      JSON.stringify([
        missionId,
        kind,
        filter.agent ?? null,
        filter.task ?? null,
        filter.message ?? null,
        filter.outbox ?? null,
        filter.state ?? null,
      ]),
    )
    .digest('hex');
  const cursor = filter.cursor ? decodeCursor(filter.cursor, kind, scope) : undefined;
  const row = (
    await db.query<{ seq: string; at: string }>(
      'SELECT next_event_seq::text AS seq,clock_timestamp()::text AS at FROM missions WHERE id=$1',
      [missionId],
    )
  ).rows[0];
  if (!row) throw new MeshError('NOT_FOUND', 'Mission does not exist.');
  const snapshotSeq = cursor?.snapshotSeq ?? row.seq;
  const snapshotAt = cursor?.snapshotAt ?? row.at;
  if (BigInt(snapshotSeq) > BigInt(row.seq))
    throw new MeshError('INVALID_CURSOR', 'Cursor refers to unavailable event history.');
  return {
    snapshotSeq,
    snapshotAt,
    observedAt: timestamp(row.at)!,
    cursor,
    base: { v: 1 as const, kind, scope, snapshotSeq, snapshotAt },
  };
}

function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function decodeCursor(raw: string, kind: Cursor['kind'], scope: string): Cursor {
  try {
    if (typeof raw !== 'string' || raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw))
      throw new Error();
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (
      value.v !== 1 ||
      value.kind !== kind ||
      value.scope !== scope ||
      !validSequence(value.snapshotSeq) ||
      !validSequence(value.last?.seq) ||
      !timestamp(value.snapshotAt) ||
      BigInt(value.last.seq) > BigInt(value.snapshotSeq)
    )
      throw new Error();
    if (kind === 'messages')
      for (const key of ['sender', 'recipient', 'message'] as const)
        validateId(value.last[key], `cursor ${key}`);
    return value;
  } catch {
    throw new MeshError('INVALID_CURSOR', 'Invalid conversation cursor or changed query scope.');
  }
}
function validSequence(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= MAX_SEQUENCE
  );
}
function validateId(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new MeshError('INVALID_FILTER', `Invalid ${name}.`);
  }
}
function pageLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new MeshError('INVALID_LIMIT', `Limit must be an integer from 1 to ${max}.`);
  return value;
}
function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function number(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}
function timestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function difference(end: unknown, start: unknown): number | null {
  const e = timestamp(end);
  const s = timestamp(start);
  return e && s ? Date.parse(e) - Date.parse(s) : null;
}
function group(rows: JsonObject[], key: string): Map<string, JsonObject[]> {
  const groups = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const id = String(row[key]);
    const items = groups.get(id) ?? [];
    items.push(row);
    groups.set(id, items);
  }
  return groups;
}
function window<T>(rows: JsonObject[], view: (row: JsonObject) => T): HistoryWindow<T> {
  const total = number(rows[0]?.total);
  return { total, items: rows.map(view), truncated: total > rows.length };
}
function eventView(row: JsonObject): TraceEvent {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    seq: String(row.seq),
    at: timestamp(row.at)!,
    kind: String(row.kind),
    agentId: string(row.agent_id) ?? undefined,
    runId: string(row.run_id) ?? undefined,
    traceId: string(row.trace_id) ?? undefined,
    spanId: string(row.span_id) ?? undefined,
    parentSpanId: string(row.parent_span_id) ?? undefined,
    correlationId: string(row.correlation_id) ?? undefined,
    causationId: string(row.causation_id) ?? undefined,
    messageId: string(row.message_id) ?? undefined,
    taskId: string(row.task_id) ?? undefined,
    operationId: string(row.operation_id) ?? undefined,
    data: row.data,
  };
}
