import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from './trace.js';
import { invariant, type Sql } from './types.js';

export interface RunFilter {
  agent?: string;
  run?: string;
  state?: string;
  cursor?: string;
  limit?: number;
}

async function captureRecord(directory: string | null, state: string): Promise<unknown> {
  if (!directory)
    return { status: 'unavailable', reason: 'No run artifact directory was recorded' };
  const path = join(directory, 'capture.json');
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await file.stat();
      invariant(
        metadata.isFile() && metadata.size <= 1024 * 1024,
        'INVALID_CAPTURE',
        'Capture manifest must be a regular file of at most 1 MiB',
      );
      // A fixed bound also covers a file that grows after stat().
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
      }
      invariant(bytes <= 1024 * 1024, 'INVALID_CAPTURE', 'Capture manifest exceeds 1 MiB');
      return { path, manifest: redact(JSON.parse(buffer.subarray(0, bytes).toString('utf8'))) };
    } finally {
      await file.close();
    }
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      path,
      status: missing && ['starting', 'running'].includes(state) ? 'in-progress' : 'unavailable',
      reason: missing ? 'No capture manifest is present' : String(redact((error as Error).message)),
    };
  }
}

/** Run history uses PostgreSQL's full timestamp precision, not JS millisecond cursors. */
export async function listRuns(db: Sql, missionId: string, filter: RunFilter = {}) {
  const limit = filter.limit ?? 128;
  invariant(
    Number.isSafeInteger(limit) && limit > 0 && limit <= 1024,
    'INVALID_LIMIT',
    'Run limit must be between 1 and 1024',
  );
  const scope = createHash('sha256')
    .update(
      JSON.stringify([missionId, filter.agent ?? null, filter.run ?? null, filter.state ?? null]),
    )
    .digest('hex');
  const conditions = ['mission_id=$1'];
  const values: unknown[] = [missionId];
  for (const [key, column] of [
    ['agent', 'agent_id'],
    ['run', 'id'],
    ['state', 'state'],
  ] as const) {
    if (filter[key] !== undefined) {
      invariant(
        typeof filter[key] === 'string' && filter[key]!.length > 0,
        'INVALID_FILTER',
        `${key} must be a nonempty string`,
      );
      values.push(filter[key]);
      conditions.push(`${column}=$${values.length}`);
    }
  }
  if (filter.cursor !== undefined) {
    let cursor: { scope?: string; at?: string; id?: string } = {};
    try {
      invariant(filter.cursor.length <= 4096, 'INVALID_CURSOR', 'Run cursor is too long');
      cursor = JSON.parse(Buffer.from(filter.cursor, 'base64url').toString('utf8'));
    } catch {
      /* Validated below without echoing untrusted cursor text. */
    }
    invariant(
      cursor?.scope === scope &&
        typeof cursor.at === 'string' &&
        Number.isFinite(Date.parse(cursor.at)) &&
        typeof cursor.id === 'string',
      'INVALID_CURSOR',
      'Run cursor is invalid or belongs to another query',
    );
    values.push(cursor.at, cursor.id);
    conditions.push(`(started_at,id)<($${values.length - 1}::timestamptz,$${values.length})`);
  }
  values.push(limit + 1);
  const result = await db.query<Record<string, unknown>>(
    `SELECT id,agent_id,generation,state,pid,started_at,started_at::text AS cursor_at,
      ended_at,heartbeat_at,last_activity_at,lease_expires,reason,handoff,result,log_dir,
      (SELECT count(*)::integer FROM trace_events e WHERE e.mission_id=runs.mission_id
        AND e.run_id=runs.id) AS event_count
     FROM runs WHERE ${conditions.join(' AND ')}
     ORDER BY started_at DESC,id DESC LIMIT $${values.length}`,
    values,
  );
  const hasMore = result.rows.length > limit;
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? Buffer.from(JSON.stringify({ scope, at: last.cursor_at, id: last.id })).toString(
          'base64url',
        )
      : null;
  const runs = await Promise.all(
    page.map(async ({ cursor_at: _cursor, ...row }) => ({
      ...row,
      ...(filter.run
        ? { capture: await captureRecord(row.log_dir as string | null, String(row.state)) }
        : {}),
    })),
  );
  return { runs: redact(runs), nextCursor, observedAt: new Date().toISOString() };
}
