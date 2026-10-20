import { createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { once } from 'node:events';
import { readEvents, redact, type TraceFilter } from './trace.js';
import type { Database, Sql } from './types.js';
import { invariant } from './types.js';

export async function status(db: Sql, missionId: string): Promise<Record<string, unknown>> {
  const [mission, runs, slots, requirements, messages, outbox, operations] = await Promise.all([
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
  const r = await db.query<{ result: Record<string, unknown> }>(
    'SELECT result FROM workspace_operations WHERE mission_id=$1 AND operation_id=$2',
    [missionId, input.operation],
  );
  const result = r.rows[0]?.result;
  const value =
    (result?.[stream] as Record<string, unknown> | undefined)?.path ??
    result?.[stream + 'Path'] ??
    (result?.logs as Record<string, unknown> | undefined)?.[stream];
  invariant(typeof value === 'string', 'NOT_FOUND', 'Command log is unavailable');
  return value;
}

/** Exports the complete durable trace; pagination does not truncate large missions. */
export async function exportEvents(
  db: Database,
  missionId: string,
  path: string,
  filter: TraceFilter = {},
): Promise<{ events: number; path: string }> {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const stream = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  await once(stream, 'open');
  let count = 0;
  let after = filter.after ?? '0';
  try {
    while (true) {
      const batch = await readEvents(db, missionId, { ...filter, after, limit: 2000 });
      if (!batch.length) break;
      for (const event of batch) {
        if (!stream.write(JSON.stringify(event) + '\n')) await once(stream, 'drain');
        count++;
        after = event.seq;
      }
    }
    stream.end();
    await once(stream, 'finish');
    return { events: count, path: resolve(path) };
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

export async function exportMission(
  db: Database,
  missionId: string,
  directory: string,
): Promise<unknown> {
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const snapshot = await status(db, missionId);
  await writeFile(
    join(directory, 'mission.json'),
    JSON.stringify(redact(snapshot), null, 2) + '\n',
    { mode: 0o600 },
  );
  const trace = await exportEvents(db, missionId, join(directory, 'events.jsonl'));
  const [runs, ops, tasks] = await Promise.all([
    db.query(
      'SELECT id,agent_id,generation,state,started_at,ended_at,reason,handoff,result,log_dir FROM runs WHERE mission_id=$1 ORDER BY started_at',
      [missionId],
    ),
    db.query(
      'SELECT operation_id,agent_id,run_id,kind,state,request,result,error,started_at,updated_at FROM workspace_operations WHERE mission_id=$1 ORDER BY started_at',
      [missionId],
    ),
    db.query('SELECT * FROM a2a_tasks WHERE mission_id=$1 ORDER BY created_at', [missionId]),
  ]);
  for (const [name, data] of [
    ['runs', runs.rows],
    ['operations', ops.rows],
    ['tasks', tasks.rows],
  ] as const)
    await writeFile(join(directory, name + '.json'), JSON.stringify(redact(data), null, 2) + '\n', {
      mode: 0o600,
    });
  const allMessages = await db.query(
    'SELECT * FROM mailbox_deliveries WHERE mission_id=$1 ORDER BY created_at,delivery_id',
    [missionId],
  );
  await writeFile(
    join(directory, 'messages.json'),
    JSON.stringify(redact(allMessages.rows), null, 2) + '\n',
    { mode: 0o600 },
  );
  const artifacts: string[] = [];
  const missing: { source: string; reason: string }[] = [];
  for (const row of runs.rows as { id: string; log_dir: string | null }[])
    if (row.log_dir) {
      for (const name of [
        'stdout.jsonl',
        'stderr.log',
        'events.jsonl',
        'result.json',
        'prompt.txt',
        'result.schema.json',
      ]) {
        const source = join(row.log_dir, name);
        try {
          const content = await readFile(source, 'utf8');
          const target = join(directory, 'runs', row.id, name);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, String(redact(content)), { mode: 0o600 });
          artifacts.push(relative(directory, target));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          missing.push({ source, reason: 'not present' });
        }
      }
    }
  for (const row of ops.rows as { operation_id: string; result: any }[]) {
    for (const kind of ['stdout', 'stderr'] as const) {
      const source =
        row.result?.[kind]?.path ?? row.result?.[kind + 'Path'] ?? row.result?.logs?.[kind];
      if (typeof source !== 'string') continue;
      try {
        const content = await readFile(source, 'utf8');
        const target = join(
          directory,
          'operations',
          encodeURIComponent(row.operation_id),
          kind + '.log',
        );
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, String(redact(content)), { mode: 0o600 });
        artifacts.push(relative(directory, target));
      } catch (error) {
        missing.push({ source, reason: (error as Error).message });
      }
    }
  }
  const manifest = {
    missionId,
    exportedAt: new Date().toISOString(),
    events: trace.events,
    artifacts,
    missing,
    redaction:
      'Bearer tokens, known run credentials, API-key patterns, and credential fields redacted; application text is retained.',
  };
  await writeFile(join(directory, 'export.json'), JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o600,
  });
  return { directory: resolve(directory), ...manifest };
}
