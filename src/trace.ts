import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Database, EventSink, Principal, Sql, TraceEvent, TraceInput } from './types.js';

const SECRET_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|access_token|refresh_token|api_key|apikey|run_token|bearer|token|token_hash)$/i;
const secrets = new Set<string>();
export function registerSecret(secret: string): void {
  if (secret.length >= 8) secrets.add(secret);
}
export function redact(value: unknown, extraSecrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of [...secrets, ...extraSecrets])
      if (secret.length >= 8) text = text.split(secret).join('[REDACTED]');
    return text
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
      .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@');
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, extraSecrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, extraSecrets),
      ]),
    );
  return value;
}

type SpanContext = Partial<TraceInput>;
const context = new AsyncLocalStorage<SpanContext>();
export function traceId(): string {
  return randomBytes(16).toString('hex');
}
export function spanId(): string {
  return randomBytes(8).toString('hex');
}

export class Tracer {
  constructor(private db: Database) {}
  /** Sequence is allocated under the mission row lock and committed with its event.
   * A reader cannot miss a late-committing lower sequence, unlike BIGSERIAL cursors. */
  emit: EventSink = async (input, tx) => {
    const write = async (sql: Sql): Promise<TraceEvent> => {
      const e = { ...context.getStore(), ...input };
      const allocated = await sql.query<{ next_event_seq: string }>(
        'UPDATE missions SET next_event_seq=next_event_seq+1 WHERE id=$1 RETURNING next_event_seq',
        [e.missionId],
      );
      if (!allocated.rows[0]) throw new Error(`Trace mission ${e.missionId} does not exist`);
      const id = randomUUID();
      const at = new Date().toISOString();
      const seq = String(allocated.rows[0].next_event_seq);
      const data = redact(e.data ?? {});
      await sql.query(
        `INSERT INTO trace_events(id,mission_id,seq,at,kind,agent_id,run_id,trace_id,span_id,parent_span_id,correlation_id,causation_id,message_id,task_id,operation_id,data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
        [
          id,
          e.missionId,
          seq,
          at,
          e.kind,
          e.agentId ?? null,
          e.runId ?? null,
          e.traceId ?? null,
          e.spanId ?? null,
          e.parentSpanId ?? null,
          e.correlationId ?? null,
          e.causationId ?? null,
          e.messageId ?? null,
          e.taskId ?? null,
          e.operationId ?? null,
          JSON.stringify(data),
        ],
      );
      return { ...e, id, at, seq, data } as TraceEvent;
    };
    return tx ? write(tx) : this.db.transaction(write);
  };
  async span<T>(
    principal: Principal,
    kind: string,
    data: unknown,
    body: () => Promise<T>,
  ): Promise<T> {
    const parent = context.getStore();
    const started = performance.now();
    const args = (data as { arguments?: Record<string, unknown> })?.arguments;
    const handles = (object: Record<string, unknown> | undefined) =>
      Object.fromEntries(
        ['messageId', 'taskId', 'operationId']
          .filter((key) => typeof object?.[key] === 'string')
          .map((key) => [key, object![key]]),
      );
    const current = {
      ...principal,
      ...handles(args),
      traceId: parent?.traceId ?? traceId(),
      spanId: spanId(),
      parentSpanId: parent?.spanId,
      correlationId: parent?.correlationId ?? principal.runId,
    };
    return context.run(current, async () => {
      const start = await this.emit({ ...principal, kind: `${kind}.started`, data });
      try {
        const result = await body();
        await this.emit({
          ...principal,
          ...handles(
            result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined,
          ),
          kind: `${kind}.completed`,
          causationId: start.id,
          data: { durationMs: performance.now() - started, result },
        });
        return result;
      } catch (error) {
        await this.emit({
          ...principal,
          kind: `${kind}.failed`,
          causationId: start.id,
          data: {
            durationMs: performance.now() - started,
            error:
              error instanceof Error
                ? { ...error, name: error.name, message: error.message }
                : String(error),
          },
        });
        throw error;
      }
    });
  }
}

export interface TraceFilter {
  after?: string;
  limit?: number;
  agent?: string;
  run?: string;
  task?: string;
  message?: string;
  operation?: string;
  correlation?: string;
  kind?: string;
}
export async function readEvents(
  db: Sql,
  missionId: string,
  filter: TraceFilter = {},
): Promise<TraceEvent[]> {
  const conditions = ['mission_id=$1', 'seq>$2'];
  const args: unknown[] = [missionId, filter.after ?? '0'];
  for (const [key, column] of Object.entries({
    agent: 'agent_id',
    run: 'run_id',
    task: 'task_id',
    message: 'message_id',
    operation: 'operation_id',
    correlation: 'correlation_id',
    kind: 'kind',
  })) {
    const value = filter[key as keyof TraceFilter];
    if (value !== undefined) {
      args.push(value);
      conditions.push(`${column}=$${args.length}`);
    }
  }
  args.push(Math.min(Math.max(filter.limit ?? 200, 1), 2000));
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM trace_events WHERE ${conditions.join(' AND ')} ORDER BY seq LIMIT $${args.length}`,
    args,
  );
  return result.rows.map(
    (r) =>
      ({
        id: r.id,
        missionId: r.mission_id,
        seq: String(r.seq),
        at: new Date(r.at as string).toISOString(),
        kind: r.kind,
        agentId: r.agent_id,
        runId: r.run_id,
        traceId: r.trace_id,
        spanId: r.span_id,
        parentSpanId: r.parent_span_id,
        correlationId: r.correlation_id,
        causationId: r.causation_id,
        messageId: r.message_id,
        taskId: r.task_id,
        operationId: r.operation_id,
        data: r.data,
      }) as TraceEvent,
  );
}
