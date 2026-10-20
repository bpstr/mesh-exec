import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { PgDatabase } from '../src/db.js';
import type { Database, Sql, SqlResult } from '../src/types.js';

/** Real PostgreSQL parser/transactions in WASM; production uses a pg Pool. */
export class TestDatabase implements Database {
  private pg?: PGlite;
  private remote?: PgDatabase;
  private schema?: string;
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor() {
    const connection = process.env.TEST_DATABASE_URL;
    if (connection) {
      this.schema = 'mesh_test_' + randomBytes(8).toString('hex');
      const admin = new PgDatabase(connection);
      const scoped = new URL(connection);
      scoped.searchParams.set('options', `-c search_path=${this.schema},public`);
      this.remote = new PgDatabase(scoped.toString());
      this.ready = admin
        .query(`CREATE SCHEMA ${this.schema}`)
        .then(() => undefined)
        .finally(() => admin.close());
    } else {
      this.pg = new PGlite();
      this.ready = Promise.resolve();
    }
  }
  async query<T = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<SqlResult<T>> {
    await this.ready;
    if (this.remote) return this.remote.query<T>(sql, values);
    if (!values.length && sql.includes(';')) {
      await this.pg!.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    const r = await this.pg!.query<T>(sql, values);
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
  }
  async transaction<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
    await this.ready;
    if (this.remote) return this.remote.transaction(body);
    const next = this.queue.then(() =>
      this.pg!.transaction(async (tx) =>
        body({
          query: async <R>(sql: string, values: unknown[] = []) => {
            const r = await tx.query<R>(sql, values);
            return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
          },
        }),
      ),
    );
    this.queue = next.catch(() => {});
    return next;
  }
  async close(): Promise<void> {
    await this.ready;
    if (this.remote) {
      await this.remote.close();
      const admin = new PgDatabase(process.env.TEST_DATABASE_URL!);
      try {
        await admin.query(`DROP SCHEMA ${this.schema} CASCADE`);
      } finally {
        await admin.close();
      }
    } else await this.pg!.close();
  }
}
