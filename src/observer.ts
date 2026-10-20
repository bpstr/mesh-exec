import { createReadStream, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { readEvents, redact, type TraceFilter } from './trace.js';
import {
  ArtifactWriter,
  copyArtifact,
  type ExportArtifact,
  type FileIntegrity,
} from './artifacts.js';
import type { Database, Sql } from './types.js';
import { invariant } from './types.js';
import { workState } from './planning.js';

/** Counts and artifact references only; event bodies and handoffs stay on disk. */
export async function digest(db: Sql, missionId: string, after?: string) {
  invariant(
    after === undefined || (after.length <= 20 && /^\d+$/u.test(after)),
    'INVALID_CURSOR',
    'after must be an event sequence',
  );
  const mission = (
    await db.query<{ id: string; state: string; revision: string; next_event_seq: string }>(
      'SELECT id,state,revision,next_event_seq FROM missions WHERE id=$1',
      [missionId],
    )
  ).rows[0];
  invariant(mission, 'NOT_FOUND', 'Mission does not exist');
  invariant(
    after === undefined || BigInt(after) <= BigInt(mission.next_event_seq),
    'INVALID_CURSOR',
    'Cursor is ahead of this mission',
  );
  const changes = await db.query<{ kind: string; count: number }>(
    `SELECT kind,count(*)::integer AS count FROM trace_events WHERE mission_id=$1 AND seq>$2 AND seq<=$3
     AND (kind LIKE 'mission.%' OR kind LIKE 'run.%' OR kind LIKE 'claim.%' OR kind LIKE 'work.%'
       OR kind LIKE 'requirement.%' OR kind LIKE 'checkpoint.%' OR kind LIKE 'review.%'
       OR kind LIKE 'knowledge.%' OR kind LIKE 'workspace.operation.%'
       OR kind IN ('message.ingress.accepted','message.reply.accepted','message.acknowledged','message.delivery.rejected'))
     GROUP BY kind ORDER BY kind`,
    [missionId, after ?? '0', mission.next_event_seq],
  );
  const cursor = String(mission.next_event_seq);
  const state = { id: mission.id, state: mission.state, workRevision: String(mission.revision) };
  if (after !== undefined && !changes.rows.length)
    return { mission: state, cursor, unchanged: true };
  const [runs, requirements, commands, mail, artifacts, operationArtifacts, tokens, work] =
    await Promise.all([
      db.query(
        'SELECT state,count(*)::integer AS count FROM runs WHERE mission_id=$1 GROUP BY state ORDER BY state',
        [missionId],
      ),
      db.query(
        'SELECT state,count(*)::integer AS count FROM requirements WHERE mission_id=$1 GROUP BY state ORDER BY state',
        [missionId],
      ),
      db.query(
        'SELECT kind,state,count(*)::integer AS count FROM workspace_operations WHERE mission_id=$1 GROUP BY kind,state ORDER BY kind,state',
        [missionId],
      ),
      db.query(
        'SELECT count(*)::integer AS total,count(*) FILTER(WHERE handled_at IS NULL)::integer AS pending FROM mailbox_deliveries WHERE mission_id=$1',
        [missionId],
      ),
      db.query(
        'SELECT id,log_dir AS directory FROM runs WHERE mission_id=$1 AND log_dir IS NOT NULL ORDER BY started_at DESC,id LIMIT 10',
        [missionId],
      ),
      db.query(
        `SELECT operation_id AS id,result->'stdout'->>'path' AS stdout,result->'stderr'->>'path' AS stderr
      FROM workspace_operations WHERE mission_id=$1 AND result IS NOT NULL AND kind='command' ORDER BY updated_at DESC,operation_id LIMIT 10`,
        [missionId],
      ),
      usage(db, missionId),
      workState(db, missionId),
    ]);
  return {
    mission: state,
    cursor,
    unchanged: false,
    changes: changes.rows,
    counts: {
      runs: runs.rows,
      requirements: requirements.rows,
      operations: commands.rows,
      messages: mail.rows[0],
      work: Object.fromEntries(
        ['ready', 'blocked', 'claimed', 'implemented'].map((state) => [
          state,
          work.items.filter((i) => i.state === state).length,
        ]),
      ),
    },
    admissionLimit: work.admissionLimit,
    usage: tokens,
    artifacts: {
      runs: artifacts.rows,
      commands: operationArtifacts.rows,
      limits: { runs: 10, commands: 10 },
    },
  };
}

/** CLI receipts only: missing/interrupted usage is unknown, never estimated as zero. */
export async function usage(db: Sql, missionId: string) {
  const result = await db.query<{ id: string; receipts: unknown[] }>(
    `SELECT r.id, COALESCE(jsonb_agg(t.data->'event'->'usage')
       FILTER (WHERE t.seq IS NOT NULL), '[]'::jsonb) AS receipts
     FROM runs r LEFT JOIN trace_events t ON t.mission_id=r.mission_id
       AND t.run_id=r.id AND t.kind='codex.turn.completed'
     WHERE r.mission_id=$1 GROUP BY r.id ORDER BY r.id`,
    [missionId],
  );
  let validReceipts = 0;
  let invalidReceipts = 0;
  let runsWithUsage = 0;
  const reportedTokens = { input: 0, cachedInput: 0, output: 0, total: 0 };
  for (const run of result.rows) {
    let reported = false;
    for (const receipt of run.receipts) {
      const r = receipt as Record<string, unknown> | null;
      const values = [r?.input_tokens, r?.cached_input_tokens, r?.output_tokens];
      if (
        !values.every((v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) ||
        (r!.cached_input_tokens as number) > (r!.input_tokens as number)
      ) {
        invalidReceipts++;
        continue;
      }
      const [input, cached, output] = values as number[];
      reportedTokens.input += input;
      reportedTokens.cachedInput += cached;
      reportedTokens.output += output;
      reportedTokens.total += input + output; // Cached input is already part of input.
      validReceipts++;
      reported = true;
    }
    if (reported) runsWithUsage++;
  }
  return {
    source: 'codex.turn.completed',
    runs: result.rows.length,
    runsWithUsage,
    runsWithoutUsage: result.rows.length - runsWithUsage,
    validReceipts,
    invalidReceipts,
    reportedTokens,
    note: 'Reported receipts only; unreported usage and monetary cost are unknown.',
  };
}

export async function status(db: Sql, missionId: string): Promise<Record<string, unknown>> {
  const [mission, runs, slots, requirements, messages, outbox, operations, tokenUsage] =
    await Promise.all([
      db.query(
        'SELECT id,repo,roadmap_path,roadmap_hash,state,revision,config,created_at,updated_at,acceptance FROM missions WHERE id=$1',
        [missionId],
      ),
      db.query(
        'SELECT state,count(*)::integer AS count FROM runs WHERE mission_id=$1 GROUP BY state',
        [missionId],
      ),
      db.query(
        'SELECT id,generation,state,active_run_id,handoff FROM slots WHERE mission_id=$1 ORDER BY id',
        [missionId],
      ),
      db.query(
        'SELECT state,count(*)::integer AS count FROM requirements WHERE mission_id=$1 GROUP BY state',
        [missionId],
      ),
      db.query(
        `SELECT count(*)::integer AS total,count(*) FILTER(WHERE handled_at IS NULL)::integer AS pending,
      EXTRACT(EPOCH FROM now()-min(created_at) FILTER(WHERE handled_at IS NULL)) AS oldest_pending_seconds FROM mailbox_deliveries WHERE mission_id=$1`,
        [missionId],
      ),
      db.query(
        'SELECT state,count(*)::integer AS count,sum(attempts)::integer AS attempts FROM a2a_outbox WHERE mission_id=$1 GROUP BY state',
        [missionId],
      ),
      db.query(
        'SELECT kind,state,count(*)::integer AS count FROM workspace_operations WHERE mission_id=$1 GROUP BY kind,state',
        [missionId],
      ),
      usage(db, missionId),
    ]);
  invariant(mission.rows[0], 'NOT_FOUND', 'Mission does not exist');
  return {
    mission: mission.rows[0],
    runs: runs.rows,
    slots: slots.rows,
    requirements: requirements.rows,
    messages: messages.rows[0],
    outbox: outbox.rows,
    operations: operations.rows,
    usage: tokenUsage,
  };
}

export async function messages(
  db: Sql,
  missionId: string,
  filter: {
    agent?: string;
    task?: string;
    message?: string;
    pending?: boolean;
    limit?: number;
    before?: string;
  } = {},
): Promise<unknown[]> {
  invariant(
    filter.limit === undefined || (Number.isSafeInteger(filter.limit) && filter.limit > 0),
    'INVALID_LIMIT',
    'Message limit must be a positive integer',
  );
  const conditions = ['d.mission_id=$1'];
  const args: unknown[] = [missionId];
  if (filter.agent) {
    args.push(filter.agent);
    conditions.push(`(d.sender_id=$${args.length} OR d.recipient_id=$${args.length})`);
  }
  if (filter.task) {
    args.push(filter.task);
    conditions.push(`d.task_id=$${args.length}`);
  }
  if (filter.message) {
    args.push(filter.message);
    conditions.push(`d.message_id=$${args.length}`);
  }
  if (filter.pending) conditions.push('d.handled_at IS NULL');
  if (filter.before) {
    args.push(filter.before);
    conditions.push(`d.created_at<$${args.length}::timestamptz`);
  }
  args.push(Math.min(filter.limit ?? 100, 2000));
  const r = await db.query(
    `SELECT d.*, COALESCE((SELECT jsonb_agg(jsonb_build_object('runId',o.run_id,'offeredAt',o.offered_at) ORDER BY o.offered_at) FROM mailbox_offers o WHERE o.delivery_id=d.delivery_id),'[]'::jsonb) AS exposures
    FROM mailbox_deliveries d WHERE ${conditions.join(' AND ')} ORDER BY d.created_at DESC,d.delivery_id DESC LIMIT $${args.length}`,
    args,
  );
  return redact(r.rows) as unknown[];
}

/** OpenMetrics text, no tokens or message bodies in metric labels. */
export async function metrics(db: Sql, missionId: string): Promise<string> {
  const s = await status(db, missionId);
  const lines: string[] = [];
  const label = (v: unknown) =>
    String(v).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
  const emit = (
    name: string,
    help: string,
    type: 'gauge' | 'counter',
    entries: { labels: Record<string, unknown>; value: unknown }[],
  ) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const e of entries)
      lines.push(
        `${name}{mission="${label(missionId)}"${Object.entries(e.labels)
          .map(([k, v]) => `,${k}="${label(v)}"`)
          .join('')}} ${Number(e.value) || 0}`,
      );
  };
  emit(
    'mesh_runs',
    'Run lifecycle counts',
    'gauge',
    (s.runs as any[]).map((r) => ({ labels: { state: r.state }, value: r.count })),
  );
  emit(
    'mesh_requirements',
    'Roadmap requirements by state',
    'gauge',
    (s.requirements as any[]).map((r) => ({ labels: { state: r.state }, value: r.count })),
  );
  emit(
    'mesh_outbox',
    'Outgoing interactions by delivery state',
    'gauge',
    (s.outbox as any[]).map((r) => ({ labels: { state: r.state }, value: r.count })),
  );
  emit('mesh_messages_pending', 'Unacknowledged mailbox deliveries', 'gauge', [
    { labels: {}, value: (s.messages as any).pending },
  ]);
  emit('mesh_message_oldest_pending_seconds', 'Age of oldest unacknowledged delivery', 'gauge', [
    { labels: {}, value: (s.messages as any).oldest_pending_seconds },
  ]);
  emit(
    'mesh_operations',
    'Workspace operations by state',
    'gauge',
    (s.operations as any[]).map((r) => ({
      labels: { kind: r.kind, state: r.state },
      value: r.count,
    })),
  );
  const tokenUsage = s.usage as Awaited<ReturnType<typeof usage>>;
  emit('mesh_usage_runs', 'Runs with or without valid CLI usage receipts', 'gauge', [
    { labels: { reporting: 'present' }, value: tokenUsage.runsWithUsage },
    { labels: { reporting: 'missing' }, value: tokenUsage.runsWithoutUsage },
  ]);
  emit('mesh_usage_receipts', 'Valid and malformed CLI usage receipts', 'gauge', [
    { labels: { validity: 'valid' }, value: tokenUsage.validReceipts },
    { labels: { validity: 'invalid' }, value: tokenUsage.invalidReceipts },
  ]);
  emit(
    'mesh_reported_tokens',
    'Tokens in valid CLI receipts only; unreported usage is unknown; cached input is included in input',
    'gauge',
    Object.entries(tokenUsage.reportedTokens).map(([kind, value]) => ({
      labels: { kind },
      value,
    })),
  );
  const counters = await db.query<{ kind: string; count: number }>(
    "SELECT kind,count(*)::integer AS count FROM trace_events WHERE mission_id=$1 AND kind IN ('claim.conflict','knowledge.invalidated','message.ingress.accepted','message.reply.accepted','message.acknowledged','message.delivery.retry_scheduled','message.delivery.rejected') GROUP BY kind",
    [missionId],
  );
  emit(
    'mesh_events_total',
    'Selected durable event counts',
    'counter',
    counters.rows.map((r) => ({ labels: { kind: r.kind }, value: r.count })),
  );
  return lines.join('\n') + '\n';
}

export async function logPath(
  db: Sql,
  missionId: string,
  input: { run?: string; operation?: string; stream?: 'stdout' | 'stderr' },
): Promise<string> {
  const stream = input.stream ?? 'stdout';
  if (input.run) {
    const r = await db.query<{ log_dir: string | null }>(
      'SELECT log_dir FROM runs WHERE mission_id=$1 AND id=$2',
      [missionId, input.run],
    );
    invariant(r.rows[0]?.log_dir, 'NOT_FOUND', 'Run log directory is unavailable');
    return join(r.rows[0].log_dir!, stream === 'stdout' ? 'stdout.jsonl' : 'stderr.log');
  }
  invariant(input.operation, 'INVALID_QUERY', 'Specify a run or operation');
  const r = await db.query<{
    result: Record<string, unknown> | null;
    journal: Record<string, unknown> | null;
  }>(
    "SELECT result,journal FROM workspace_operations WHERE mission_id=$1 AND operation_id=$2 AND kind='command'",
    [missionId, input.operation],
  );
  const result = r.rows[0]?.result;
  const value =
    (result?.[stream] as Record<string, unknown> | undefined)?.path ??
    result?.[stream + 'Path'] ??
    (result?.logs as Record<string, unknown> | undefined)?.[stream] ??
    (typeof r.rows[0]?.journal?.outputDirectory === 'string'
      ? join(dirname(r.rows[0].journal.outputDirectory), stream + '.log')
      : undefined);
  invariant(typeof value === 'string', 'NOT_FOUND', 'Command log is unavailable');
  return value;
}

/** Export a fixed committed prefix; ongoing writers cannot extend the export. */
export async function exportEvents(
  db: Sql,
  missionId: string,
  path: string,
  filter: TraceFilter = {},
): Promise<{
  events: number;
  path: string;
  upperEventSeq: string;
  lastEventSeq: string;
  bytes: number;
  sha256: string;
}> {
  const upper = await db.query<{ upper_event_seq: string }>(
    'SELECT next_event_seq::text AS upper_event_seq FROM missions WHERE id=$1',
    [missionId],
  );
  invariant(upper.rows[0], 'NOT_FOUND', 'Mission does not exist');
  const committed = String(upper.rows[0].upper_event_seq);
  invariant(
    filter.until === undefined || /^\d+$/u.test(filter.until),
    'INVALID_CURSOR',
    'The upper event cursor must be a nonnegative integer',
  );
  const upperEventSeq =
    filter.until !== undefined && BigInt(filter.until) < BigInt(committed)
      ? filter.until
      : committed;
  const stream = await ArtifactWriter.open(path);
  let count = 0;
  let after = filter.after ?? '0';
  try {
    while (true) {
      const batch = await readEvents(db, missionId, {
        ...filter,
        after,
        until: upperEventSeq,
        limit: EXPORT_PAGE_SIZE,
      });
      if (!batch.length) break;
      for (const event of batch) {
        await stream.write(JSON.stringify(redact(event)) + '\n');
        count++;
        after = event.seq;
      }
    }
    return {
      events: count,
      path: resolve(path),
      upperEventSeq,
      lastEventSeq: after,
      ...(await stream.finish()),
    };
  } catch (error) {
    await stream.abort();
    throw error;
  }
}

// A page is deliberately small: individual tool/message records can be large.
// Resident export memory is bounded by this page and the artifact inventory,
// rather than by the total trace or the byte size of any log file.
const EXPORT_PAGE_SIZE = 16;

interface MissingArtifact {
  path?: string;
  sourcePath?: string;
  reason: string;
  runId?: string;
  operationId?: string;
}

type ArtifactSource =
  | { kind: 'run'; id: string; state: string; directory: string | null }
  | {
      kind: 'command';
      id: string;
      state: string;
      streams: Array<{
        kind: 'stdout' | 'stderr';
        source?: string;
        expected?: Partial<FileIntegrity>;
      }>;
    };

interface TableExport {
  name: string;
  from: string;
  select: string;
  scope: string;
  keys: string[];
  fields: string[];
}

// Identifiers and joins are fixed application code, never interpolated input.
const TABLE_EXPORTS: readonly TableExport[] = [
  {
    name: 'runs',
    from: 'runs r',
    select:
      'r.id,r.agent_id,r.generation,r.state,r.started_at,r.ended_at,r.reason,r.handoff,r.result,r.log_dir',
    scope: 'r.mission_id=$1',
    keys: ['r.id'],
    fields: ['id'],
  },
  {
    name: 'operations',
    from: 'workspace_operations o',
    select:
      "o.operation_id,o.agent_id,o.run_id,o.kind,o.state,o.request,o.result,o.error,o.started_at,o.updated_at,CASE WHEN o.kind='command' THEN o.journal->>'outputDirectory' END AS command_output_directory",
    scope: 'o.mission_id=$1',
    keys: ['o.operation_id'],
    fields: ['operation_id'],
  },
  {
    name: 'tasks',
    from: 'a2a_tasks t',
    select: 't.*',
    scope: 't.mission_id=$1',
    keys: ['t.task_id'],
    fields: ['task_id'],
  },
  {
    name: 'messages',
    from: 'mailbox_deliveries d',
    select: 'd.*',
    scope: 'd.mission_id=$1',
    keys: ['d.delivery_id'],
    fields: ['delivery_id'],
  },
  {
    name: 'a2a-messages',
    from: 'a2a_messages m',
    select: 'm.*',
    scope: 'm.mission_id=$1',
    keys: ['m.sender_id', 'm.recipient_id', 'm.message_id'],
    fields: ['sender_id', 'recipient_id', 'message_id'],
  },
  {
    name: 'outbox',
    from: 'a2a_outbox o',
    select: 'o.*',
    scope: 'o.mission_id=$1',
    keys: ['o.outbox_id'],
    fields: ['outbox_id'],
  },
  {
    name: 'attempts',
    from: 'a2a_outbox_attempts a JOIN a2a_outbox o ON o.outbox_id=a.outbox_id',
    select: 'a.*',
    scope: 'o.mission_id=$1',
    keys: ['a.attempt_id'],
    fields: ['attempt_id'],
  },
  {
    name: 'exposures',
    from: 'mailbox_offers e JOIN mailbox_deliveries d ON d.delivery_id=e.delivery_id',
    select: 'e.*',
    scope: 'd.mission_id=$1',
    keys: ['e.delivery_id', 'e.run_id'],
    fields: ['delivery_id', 'run_id'],
  },
];

function artifactSegment(value: string): string {
  // User-supplied operation identifiers may contain path syntax or credentials.
  // Opaque archive directories keep both out of names and remain stable.
  return createHash('sha256').update(value).digest('hex');
}

async function jsonArtifact(path: string, value: unknown, filter = true): Promise<FileIntegrity> {
  const writer = await ArtifactWriter.open(path);
  try {
    await writer.write(JSON.stringify(filter ? redact(value) : value, null, 2) + '\n');
    return await writer.finish();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

async function tableArtifact(
  db: Sql,
  missionId: string,
  spec: TableExport,
  path: string,
  row: (value: Record<string, unknown>) => Promise<void>,
): Promise<FileIntegrity & { rows: number }> {
  const writer = await ArtifactWriter.open(path);
  let cursor: unknown[] | undefined;
  let rows = 0;
  try {
    await writer.write('[\n');
    for (;;) {
      const values: unknown[] = [missionId, ...(cursor ?? [])];
      const continuation = cursor
        ? ` AND (${spec.keys.join(',')}) > (${cursor.map((_, i) => `$${i + 2}`).join(',')})`
        : '';
      const batch = await db.query<Record<string, unknown>>(
        `SELECT ${spec.select} FROM ${spec.from} WHERE ${spec.scope}${continuation} ORDER BY ${spec.keys.join(',')} LIMIT ${EXPORT_PAGE_SIZE}`,
        values,
      );
      if (!batch.rows.length) break;
      for (const item of batch.rows) {
        await writer.write((rows ? ',\n' : '') + JSON.stringify(redact(item)));
        await row(item);
        rows++;
      }
      cursor = spec.fields.map((field) => batch.rows.at(-1)![field]);
    }
    await writer.write('\n]\n');
    return { rows, ...(await writer.finish()) };
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

async function smallJson(path: string): Promise<Record<string, any>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const information = await file.stat();
    invariant(
      information.isFile() && information.size <= 1024 * 1024,
      'INVALID_CAPTURE_MANIFEST',
      'Capture metadata must be a regular file of at most 1 MiB',
    );
    const bytes = Buffer.alloc(information.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await file.stat();
    invariant(
      offset === information.size &&
        after.size === information.size &&
        after.mtimeMs === information.mtimeMs,
      'INVALID_CAPTURE_MANIFEST',
      'Capture metadata changed while being read',
    );
    return JSON.parse(bytes.toString('utf8')) as Record<string, any>;
  } finally {
    await file.close();
  }
}

export async function exportMission(
  db: Database,
  missionId: string,
  directory: string,
): Promise<unknown> {
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const artifacts: ExportArtifact[] = [];
  const missing: MissingArtifact[] = [];
  const counts: Record<string, number> = {};
  const sourceList = join(directory, '.artifact-sources.jsonl');
  const sources = await ArtifactWriter.open(sourceList);
  let trace!: Awaited<ReturnType<typeof exportEvents>>;
  let snapshotAt = '';
  const remember = (path: string, information: FileIntegrity) =>
    artifacts.push({
      path,
      bytes: information.bytes,
      sha256: information.sha256,
      integrity: 'verified',
    });
  try {
    // The snapshot contains only database reads and paged local metadata writes.
    // Potentially enormous log copies happen after this transaction is released.
    await db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      snapshotAt = new Date().toISOString();
      remember(
        'mission.json',
        await jsonArtifact(join(directory, 'mission.json'), await status(tx, missionId)),
      );
      const work = await workState(tx, missionId);
      remember('work.json', await jsonArtifact(join(directory, 'work.json'), work));
      counts.work = work.items.length;
      trace = await exportEvents(tx, missionId, join(directory, 'events.jsonl'));
      remember('events.jsonl', trace);
      for (const spec of TABLE_EXPORTS) {
        const output = await tableArtifact(
          tx,
          missionId,
          spec,
          join(directory, spec.name + '.json'),
          async (row) => {
            if (spec.name === 'runs') {
              await sources.write(
                JSON.stringify({
                  kind: 'run',
                  id: String(row.id),
                  state: String(row.state),
                  directory: typeof row.log_dir === 'string' ? row.log_dir : null,
                } satisfies ArtifactSource) + '\n',
              );
            } else if (spec.name === 'operations' && row.kind === 'command') {
              const result = row.result as Record<string, any> | null;
              const streams = (['stdout', 'stderr'] as const).map((kind) => {
                const source =
                  result?.[kind]?.path ??
                  result?.[kind + 'Path'] ??
                  result?.logs?.[kind] ??
                  (typeof row.command_output_directory === 'string'
                    ? join(dirname(row.command_output_directory), kind + '.log')
                    : undefined);
                const expected =
                  result?.[kind] && typeof result[kind].bytes === 'number'
                    ? {
                        bytes: result[kind].bytes,
                        ...(typeof result[kind].sha256 === 'string'
                          ? { sha256: result[kind].sha256 }
                          : {}),
                      }
                    : undefined;
                return { kind, source, expected };
              });
              await sources.write(
                JSON.stringify({
                  kind: 'command',
                  id: row.operation_id,
                  state: row.state,
                  streams,
                }) + '\n',
              );
            }
          },
        );
        counts[spec.name] = output.rows;
        remember(spec.name + '.json', output);
      }
    });
    await sources.finish();
  } catch (error) {
    await sources.abort();
    throw error;
  }

  const copy = async (
    source: string,
    path: string,
    identity: { runId?: string; operationId?: string },
    expected?: Partial<FileIntegrity>,
    complete?: boolean,
    optional = false,
  ): Promise<ExportArtifact | undefined> => {
    const safeIdentity = redact(identity) as typeof identity;
    try {
      const item: ExportArtifact = {
        path,
        ...(await copyArtifact({ source, target: join(directory, path) })),
        sourcePath: String(redact(resolve(source))),
        ...safeIdentity,
        integrity: 'unverified',
      };
      if (expected && (expected.bytes !== undefined || expected.sha256 !== undefined)) {
        item.expected = expected;
        item.integrity =
          (expected.bytes === undefined || expected.bytes === item.sourceBytes) &&
          (expected.sha256 === undefined || expected.sha256 === item.sourceSha256)
            ? 'verified'
            : 'mismatch';
        if (item.integrity === 'mismatch') {
          item.partial = true;
          item.reasons!.push('Source bytes disagree with finalized capture metadata');
        }
      }
      if (complete === false) {
        item.partial = true;
        item.reasons!.push('Capture is unfinalized, incomplete, or predates capture metadata');
      }
      artifacts.push(item);
      return item;
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      missing.push({
        path,
        sourcePath: String(redact(source)),
        ...safeIdentity,
        reason: String(redact(error instanceof Error ? error.message : String(error))),
      });
      return undefined;
    }
  };

  const sourceStream = createReadStream(sourceList);
  const sourceLines = createInterface({ input: sourceStream, crlfDelay: Infinity });
  try {
    for await (const line of sourceLines) {
      const entry = JSON.parse(line) as ArtifactSource;
      if (entry.kind === 'run') {
        if (!entry.directory) {
          missing.push({
            runId: String(redact(entry.id)),
            reason: 'No run log directory was recorded',
          });
          continue;
        }
        const destination = `runs/${artifactSegment(entry.id)}`;
        const capture = await copy(
          join(entry.directory, 'capture.json'),
          `${destination}/capture.json`,
          { runId: entry.id },
        );
        let metadata: Record<string, any> | undefined;
        if (capture) {
          try {
            metadata = await smallJson(join(directory, capture.path));
          } catch (error) {
            capture.partial = true;
            capture.reasons!.push(String(redact((error as Error).message)));
          }
        }
        for (const name of [
          'stdout.jsonl',
          'stderr.log',
          'events.jsonl',
          'result.json',
          'prompt.txt',
          'result.schema.json',
        ]) {
          const channel =
            name === 'stdout.jsonl' ? 'stdout' : name === 'stderr.log' ? 'stderr' : undefined;
          const observed = channel
            ? metadata?.[channel]
            : name === 'prompt.txt'
              ? metadata?.prompt
              : name === 'result.schema.json'
                ? metadata?.schema
                : name === 'result.json'
                  ? metadata?.result
                  : undefined;
          const expected =
            observed && typeof observed.bytes === 'number' && typeof observed.sha256 === 'string'
              ? { bytes: observed.bytes, sha256: observed.sha256 }
              : undefined;
          const complete = channel
            ? metadata?.schemaVersion === 1 &&
              metadata?.status === 'complete' &&
              !!observed &&
              observed.eof === true &&
              observed.synced === true &&
              observed.indexComplete === true
            : name === 'result.json'
              ? metadata?.result?.status === 'valid'
              : undefined;
          await copy(
            join(entry.directory, name),
            `${destination}/${name}`,
            { runId: entry.id },
            expected,
            complete,
            name === 'events.jsonl',
          );
        }
      } else {
        for (const stream of entry.streams) {
          const path = `operations/${artifactSegment(entry.id)}/${stream.kind}.log`;
          if (!stream.source) {
            missing.push({
              path,
              operationId: String(redact(entry.id)),
              reason: 'No command log path was recorded',
            });
            continue;
          }
          const complete =
            ['succeeded', 'failed', 'cancelled'].includes(entry.state) &&
            stream.expected?.bytes !== undefined;
          await copy(stream.source, path, { operationId: entry.id }, stream.expected, complete);
        }
      }
    }
  } finally {
    sourceLines.close();
    sourceStream.destroy();
    await unlink(sourceList);
  }

  const partial = missing.length > 0 || artifacts.some((artifact) => artifact.partial);
  const integrity = {
    mismatched: artifacts
      .filter((artifact) => artifact.integrity === 'mismatch')
      .map((artifact) => artifact.path),
    unverified: artifacts
      .filter((artifact) => artifact.integrity === 'unverified')
      .map((artifact) => artifact.path),
  };
  const manifest = {
    formatVersion: 1,
    missionId: String(redact(missionId)),
    startedAt,
    snapshotAt,
    exportedAt: new Date().toISOString(),
    upperEventSeq: trace.upperEventSeq,
    lastEventSeq: trace.lastEventSeq,
    events: trace.events,
    tables: counts,
    consistency:
      'Database rows share one read-only repeatable-read snapshot. Each later file copy stops at its initial size; capture metadata reports whether the source is finalized. This is not an atomic database/filesystem snapshot.',
    byteOffsets:
      'Trace offsets address sourcePath bytes. They address exported bytes only when offsetsPreserved is true.',
    redaction:
      'Known credentials, bearer tokens, API-key patterns, and PostgreSQL URI passwords are filtered across chunk boundaries. Structured credential fields are filtered in database records. Oversized unresolved credential-shaped URI passwords are conservatively suppressed.',
    partial,
    integrity,
    artifacts,
    missing,
  };
  // User-controlled provenance is filtered above. Do not rewrite generated
  // checksums/opaque archive paths: filtering those would corrupt the inventory.
  await jsonArtifact(join(directory, 'export.json'), manifest, false);
  return {
    directory: resolve(directory),
    formatVersion: 1,
    missionId,
    upperEventSeq: trace.upperEventSeq,
    events: trace.events,
    artifacts: artifacts.length,
    missing: missing.length,
    partial,
    integrity,
  };
}
