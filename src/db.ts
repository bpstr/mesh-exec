import pg from 'pg';
import type { Database, Sql, SqlResult } from './types.js';

/** A transaction always owns one connection. Never run BEGIN through Pool.query. */
export class PgDatabase implements Database {
  private pool: pg.Pool;
  lastConnectionError?: Error;
  constructor(connectionString: string, max = 16) {
    this.pool = new pg.Pool({
      connectionString,
      max,
      application_name: 'mesh-exec',
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      query_timeout: 20_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 20_000,
    });
    this.pool.on('error', (error) => {
      this.lastConnectionError = error;
    });
  }
  async query<T = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<SqlResult<T>> {
    const result = await this.pool.query(text, values);
    const last = Array.isArray(result) ? result.at(-1) : result;
    return { rows: (last?.rows ?? []) as T[], rowCount: last?.rowCount ?? 0 };
  }
  async transaction<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body({
        query: async <R>(text: string, values: unknown[] = []) => {
          const r = await client.query(text, values);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
