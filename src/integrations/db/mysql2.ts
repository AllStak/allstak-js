/**
 * MySQL (`mysql2`) auto-instrumentation.
 *
 * Strategy: patch ONLY the classic callback-based `Connection.prototype.query`
 * and `.execute`. The `mysql2/promise` wrapper internally calls the classic
 * API with a done-callback, so by wrapping the underlying callback path we
 * transparently capture:
 *   - conn.query(sql, cb)
 *   - conn.execute(sql, params, cb)
 *   - pool.query(sql) / pool.execute(sql, params)
 *   - conn.promise().query(...) / pool.promise().query(...)
 *   - import('mysql2/promise'); pool.query(...)   ← the common modern form
 *   - Transactions via conn.beginTransaction / commit / rollback
 *
 * We intentionally do NOT patch the promise wrapper classes directly, as
 * doing so creates a double-wrap that confuses mysql2's internal
 * `make_done_cb` machinery and breaks the promise chain.
 *
 * Fail-open: any exception inside capture is swallowed.
 */

import type { DatabaseModule } from '../../modules/database';
import {
  DbIntegrationConfig,
  detectQueryType,
  hashQuery,
  isOwnedByOrm,
  normalizeQuery,
  safeCapture,
  tryRequire,
} from './shared';

type Mysql2Module = {
  Connection?: { prototype: Record<string, unknown> };
};

let patched = false;

export function instrumentMysql2(
  dbModule: DatabaseModule,
  config: DbIntegrationConfig = {},
): boolean {
  if (patched) return true;

  const mysql2 = tryRequire<Mysql2Module>('mysql2');
  if (!mysql2?.Connection?.prototype) return false;

  const proto = mysql2.Connection.prototype as Record<string, unknown>;

  const getSql = (args: unknown[]): string => {
    const first = args[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') {
      const o = first as { sql?: string };
      if (typeof o.sql === 'string') return o.sql;
    }
    return '';
  };

  const wrapProtoMethod = (methodName: string): void => {
    const original = proto[methodName];
    if (typeof original !== 'function') return;

    proto[methodName] = function wrapped(this: unknown, ...args: unknown[]): unknown {
      if (isOwnedByOrm(this)) {
        return (original as Function).apply(this, args);
      }

      const startTime = Date.now();
      const sql = getSql(args);
      const normalized = normalizeQuery(sql);
      const databaseName =
        (this as { config?: { database?: string } }).config?.database ?? '';

      const record = (
        status: 'success' | 'error',
        err?: Error,
        rowsAffected = -1,
      ): void => {
        safeCapture(dbModule, config, {
          normalizedQuery: normalized,
          queryHash: hashQuery(normalized),
          queryType: detectQueryType(sql),
          durationMs: Date.now() - startTime,
          timestampMillis: startTime,
          status,
          errorMessage: err?.message?.slice(0, 500),
          databaseName,
          databaseType: 'mysql',
          rowsAffected,
        });
      };

      // Locate the callback. mysql2 has 3 shapes:
      //   1. query(sql, cb) | query(sql, values, cb)           — cb is a fn arg
      //   2. query({sql, values}, cb)                          — cb is a fn arg
      //   3. query(cmdQuery)  — cmdQuery is a Query object whose .onResult is
      //      the callback. This shape is used internally by Pool.query: the
      //      pool builds a cmdQuery with `onResult` set, then calls
      //      `conn.query(cmdQuery)` with NO callback argument. The legacy
      //      wrapper missed this path entirely and silently recorded every
      //      pooled error as success.
      let cbIndex = -1;
      for (let i = args.length - 1; i >= 0; i--) {
        if (typeof args[i] === 'function') {
          cbIndex = i;
          break;
        }
      }

      const wrapOriginalCb = (
        original: (err: Error | null, results?: unknown, fields?: unknown) => void,
      ) => {
        return function wrappedCb(
          this: unknown,
          err: Error | null,
          results?: unknown,
          fields?: unknown,
        ) {
          const rows =
            (results as { affectedRows?: number; length?: number })?.affectedRows ??
            (results as { length?: number })?.length ??
            -1;
          record(err ? 'error' : 'success', err ?? undefined, rows);
          return original.call(this, err, results, fields);
        };
      };

      if (cbIndex >= 0) {
        const originalCb = args[cbIndex] as (
          err: Error | null,
          results?: unknown,
          fields?: unknown,
        ) => void;
        args[cbIndex] = wrapOriginalCb(originalCb);
        try {
          return (original as Function).apply(this, args);
        } catch (err) {
          record('error', err as Error);
          throw err;
        }
      }

      // Shape 3: first arg is a Query object with .onResult. Wrap onResult
      // before delegating so the pool-dispatched callback is intercepted.
      const first = args[0] as { onResult?: (err: Error | null, rows?: unknown, fields?: unknown) => void } | undefined;
      if (first && typeof first.onResult === 'function') {
        const origOnResult = first.onResult;
        first.onResult = wrapOriginalCb(origOnResult);
        try {
          return (original as Function).apply(this, args);
        } catch (err) {
          record('error', err as Error);
          throw err;
        }
      }

      // No callback at all — very unusual. Best-effort: record success
      // and return the raw result.
      try {
        const result = (original as Function).apply(this, args);
        record('success');
        return result;
      } catch (err) {
        record('error', err as Error);
        throw err;
      }
    };
  };

  wrapProtoMethod('query');
  wrapProtoMethod('execute');

  patched = true;
  return true;
}
