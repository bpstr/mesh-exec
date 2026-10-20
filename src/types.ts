export interface SqlResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}
export interface Sql {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<SqlResult<T>>;
}
export interface Database extends Sql {
  transaction<T>(body: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface Principal {
  missionId: string;
  agentId: string;
  runId: string;
  generation: number;
}
export interface TraceInput {
  missionId: string;
  kind: string;
  agentId?: string;
  runId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  correlationId?: string;
  causationId?: string;
  messageId?: string;
  taskId?: string;
  operationId?: string;
  data?: unknown;
}
export interface TraceEvent extends TraceInput {
  id: string;
  seq: string;
  at: string;
}
export type EventSink = (event: TraceInput, tx?: Sql) => Promise<TraceEvent>;
export type MissionState =
  'active' | 'closing' | 'completed' | 'blocked' | 'stalled' | 'stopped' | 'resource-limit';
export class MeshError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'MeshError';
  }
}
export function invariant(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new MeshError(code, message);
}
