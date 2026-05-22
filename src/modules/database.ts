import { HttpTransport } from '../transport/http';

export interface DbQueryItem {
  normalizedQuery: string;
  queryHash: string;
  queryType: string; // SELECT, INSERT, UPDATE, DELETE, FIND, OTHER
  durationMs: number;
  timestampMillis: number;
  status: string; // success, error
  errorMessage?: string;
  databaseName?: string;
  databaseType?: string; // postgresql, mysql, sqlite, mongodb, mssql
  service?: string;
  environment?: string;
  traceId?: string;
  spanId?: string;
  rowsAffected?: number;
}

interface DbQueryIngestPayload {
  queries: DbQueryItem[];
}

const INGEST_PATH = '/ingest/v1/db';
const FLUSH_INTERVAL_MS = 5_000;
const BATCH_SIZE_THRESHOLD = 20;

/**
 * Transport / queue for DB query telemetry. Actual driver-specific
 * instrumentation lives in `src/integrations/db/*.ts`.
 */
export class DatabaseModule {
  private queue: DbQueryItem[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private transport: HttpTransport,
    private moduleConfig: { service?: string; environment?: string },
  ) {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    if (typeof this.flushTimer === 'object' && typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  /**
   * Record a database query. Batches internally and flushes every 5s or
   * when 20 items accumulate.
   */
  capture(item: DbQueryItem): void {
    this.queue.push({
      ...item,
      service: item.service ?? this.moduleConfig.service,
      environment: item.environment ?? this.moduleConfig.environment,
    });

    if (this.queue.length >= BATCH_SIZE_THRESHOLD) {
      this.flush();
    }
  }

  flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const payload: DbQueryIngestPayload = { queries: batch };
    this.transport.send(INGEST_PATH, payload);
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}

// ---------------------------------------------------------------------------
// Legacy re-exports
//
// The original single-file database module exported helpers like
// `normalizeQuery`, `hashQuery`, `detectQueryType`, and `enableDbAutoInstrumentation`.
// Consumers and unit tests import these names. Re-export them from the new
// integration files so behaviour is unchanged.
// ---------------------------------------------------------------------------

export { normalizeQuery, hashQuery, detectQueryType } from '../integrations/db/shared';
export { instrumentPg } from '../integrations/db/pg';
export { instrumentMysql2 } from '../integrations/db/mysql2';
export { instrumentSqlite } from '../integrations/db/sqlite';

import { instrumentPg } from '../integrations/db/pg';
import { instrumentMysql2 } from '../integrations/db/mysql2';
import { instrumentSqlite } from '../integrations/db/sqlite';

/**
 * Enable all driver-level auto-instrumentation (pg, mysql2, sqlite).
 * ORM-level integrations (Prisma, Sequelize, Mongoose) are explicit opt-in
 * via `allstak-js/db` because they require a live client instance.
 */
export function enableDbAutoInstrumentation(
  dbModule: DatabaseModule,
  config: { service?: string; environment?: string },
): void {
  instrumentPg(dbModule, config);
  instrumentMysql2(dbModule, config);
  instrumentSqlite(dbModule, config);
}
