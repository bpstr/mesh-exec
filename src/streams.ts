import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Writable } from 'node:stream';
import { readEvents, type TraceFilter } from './trace.js';
import { invariant, type Sql, type TraceEvent } from './types.js';

/** A slow observer must not cause an unbounded queue of output buffers. */
export async function writeOutput(
  destination: Writable,
  value: string | Buffer,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted || destination.destroyed || destination.writableEnded) return false;
  if (!destination.write(value)) {
    return new Promise<boolean>((resolve, reject) => {
      const finish = (ready: boolean, error?: Error) => {
        destination.off('drain', onDrain);
        destination.off('close', onClose);
        destination.off('finish', onClose);
        destination.off('error', onError);
        signal?.removeEventListener('abort', onClose);
        if (error) reject(error);
        else resolve(ready);
      };
      const onDrain = () => finish(!signal?.aborted);
      const onClose = () => finish(false);
      const onError = (error: Error) => finish(false, error);
      destination.once('drain', onDrain);
      destination.once('close', onClose);
      destination.once('finish', onClose);
      destination.once('error', onError);
      signal?.addEventListener('abort', onClose, { once: true });
      if (signal?.aborted || destination.destroyed || destination.writableFinished) onClose();
    });
  }
  return !signal?.aborted;
}

export async function* traceEvents(
  db: Sql,
  missionId: string,
  filter: TraceFilter = {},
  options: { follow?: boolean; signal?: AbortSignal; pollMs?: number } = {},
): AsyncGenerator<TraceEvent> {
  let after = filter.after ?? '0';
  const limit = Math.min(filter.limit ?? 200, 2000);
  do {
    const batch = await readEvents(db, missionId, { ...filter, after });
    for (const event of batch) {
      if (options.signal?.aborted) return;
      yield event;
      after = event.seq;
    }
    if (!options.follow || (filter.until !== undefined && batch.length < limit)) return;
    if (batch.length < limit) {
      try {
        await delay(options.pollMs ?? 500, undefined, { signal: options.signal });
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      }
    }
  } while (!options.signal?.aborted);
}

/** Retains raw UTF-8 bytes, including characters split across read boundaries. */
export async function streamLog(
  path: string,
  destination: Writable,
  options: { offset?: number; follow?: boolean; signal?: AbortSignal; pollMs?: number } = {},
): Promise<{ offset: number }> {
  let offset = options.offset ?? 0;
  invariant(
    Number.isSafeInteger(offset) && offset >= 0,
    'INVALID_OFFSET',
    'Log offset must be a nonnegative byte position',
  );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await file.stat();
    invariant(initial.isFile(), 'INVALID_LOG', 'Log must be a regular file');
    invariant(
      offset <= initial.size,
      'INVALID_OFFSET',
      'Log offset is beyond the current file size',
    );
    const buffer = Buffer.alloc(64 * 1024);
    do {
      const size = options.follow ? (await file.stat()).size : initial.size;
      invariant(size >= offset, 'LOG_TRUNCATED', 'Log was truncated while it was being followed');
      while (offset < size && !options.signal?.aborted) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, size - offset),
          offset,
        );
        invariant(bytesRead > 0, 'LOG_TRUNCATED', 'Log ended before the recorded file size');
        // Copy because Writable implementations may retain the buffer until drain.
        if (
          !(await writeOutput(
            destination,
            Buffer.from(buffer.subarray(0, bytesRead)),
            options.signal,
          ))
        )
          return { offset };
        offset += bytesRead;
      }
      if (!options.follow || options.signal?.aborted) return { offset };
      try {
        await delay(options.pollMs ?? 500, undefined, { signal: options.signal });
      } catch (error) {
        if (options.signal?.aborted) return { offset };
        throw error;
      }
    } while (!options.signal?.aborted);
    return { offset };
  } finally {
    await file.close();
  }
}
