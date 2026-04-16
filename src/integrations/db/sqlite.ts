/**
 * SQLite auto-instrumentation.
 *
 * Supports three widely-used SQLite drivers:
 *   1. `better-sqlite3` — synchronous, fastest, most popular.
 *      Patches Statement.prototype.{run,get,all,iterate} and
 *      Database.prototype.{exec,prepare,pragma}.
 *   2. `sqlite3`        — async callback-based classic driver.
 *      Patches Database.prototype.{run,get,all,each,exec}.
 *   3. `node:sqlite`    — Node 22+ built-in. Sync.
 *      Patches DatabaseSync.prototype.exec and StatementSync.prototype.*.
 *
 * Fail-open everywhere. SQLite drivers don't expose a database name in the
 * same way — we send the filename when available.
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

let patched = false;

function record(
  dbModule: DatabaseModule,
  config: DbIntegrationConfig,
  startTime: number,
  sql: string,
  databaseName: string,
  status: 'success' | 'error',
  err?: Error,
  rowsAffected = -1,
): void {
  const normalized = normalizeQuery(sql);
  safeCapture(dbModule, config, {
    normalizedQuery: normalized,
    queryHash: hashQuery(normalized),
    queryType: detectQueryType(sql),
    durationMs: Date.now() - startTime,
    timestampMillis: startTime,
    status,
    errorMessage: err?.message?.slice(0, 500),
    databaseName,
    databaseType: 'sqlite',
    rowsAffected,
  });
}

function patchBetterSqlite3(dbModule: DatabaseModule, config: DbIntegrationConfig): boolean {
  type BetterSqlite3 = {
    prototype: {
      prepare?: (sql: string) => { source?: string };
      exec?: (sql: string) => unknown;
      pragma?: (sql: string, opts?: unknown) => unknown;
    };
  };
  const mod = tryRequire<BetterSqlite3>('better-sqlite3');
  if (!mod || !mod.prototype) return false;

  const origPrepare = mod.prototype.prepare;
  const origExec = mod.prototype.exec;

  if (typeof origPrepare === 'function') {
    mod.prototype.prepare = function (this: { name?: string }, sql: string) {
      if (isOwnedByOrm(this)) {
        return origPrepare.call(this, sql);
      }
      const databaseName = (this as { name?: string }).name ?? '';

      // Capture SQL-compile errors (invalid SQL → throws here, before any
      // stmt.run/get/all can be called). Without this, failing queries at
      // prepare-time are invisible in the dashboard.
      let stmt: Record<string, unknown> & { source?: string };
      try {
        stmt = origPrepare.call(this, sql) as Record<string, unknown> & { source?: string };
      } catch (err) {
        record(dbModule, config, Date.now(), sql, databaseName, 'error', err as Error);
        throw err;
      }

      for (const method of ['run', 'get', 'all', 'iterate'] as const) {
        const original = stmt[method];
        if (typeof original === 'function') {
          stmt[method] = function (this: unknown, ...args: unknown[]) {
            const startTime = Date.now();
            try {
              const result = (original as Function).apply(this, args);
              const rows =
                (result as { changes?: number })?.changes ??
                (Array.isArray(result) ? result.length : -1);
              record(dbModule, config, startTime, sql, databaseName, 'success', undefined, rows);
              return result;
            } catch (err) {
              record(dbModule, config, startTime, sql, databaseName, 'error', err as Error);
              throw err;
            }
          };
        }
      }
      return stmt;
    };
  }

  if (typeof origExec === 'function') {
    mod.prototype.exec = function (this: { name?: string }, sql: string) {
      if (isOwnedByOrm(this)) return origExec.call(this, sql);
      const startTime = Date.now();
      const databaseName = this.name ?? '';
      try {
        const result = origExec.call(this, sql);
        record(dbModule, config, startTime, sql, databaseName, 'success');
        return result;
      } catch (err) {
        record(dbModule, config, startTime, sql, databaseName, 'error', err as Error);
        throw err;
      }
    };
  }

  return true;
}

function patchSqlite3(dbModule: DatabaseModule, config: DbIntegrationConfig): boolean {
  type Sqlite3 = {
    Database?: { prototype: Record<string, unknown> };
  };
  const mod = tryRequire<Sqlite3>('sqlite3');
  if (!mod?.Database?.prototype) return false;

  const proto = mod.Database.prototype;
  for (const method of ['run', 'get', 'all', 'each', 'exec']) {
    const original = proto[method];
    if (typeof original !== 'function') continue;

    proto[method] = function (this: { filename?: string }, ...args: unknown[]) {
      if (isOwnedByOrm(this)) {
        return (original as Function).apply(this, args);
      }
      const startTime = Date.now();
      const sql = typeof args[0] === 'string' ? (args[0] as string) : '';
      const databaseName = this.filename ?? '';

      const cbIndex = args.findIndex((a) => typeof a === 'function');
      if (cbIndex >= 0) {
        const cb = args[cbIndex] as Function;
        args[cbIndex] = function (this: unknown, err: Error | null, ...rest: unknown[]) {
          const rows = (this as { changes?: number })?.changes ?? -1;
          record(
            dbModule,
            config,
            startTime,
            sql,
            databaseName,
            err ? 'error' : 'success',
            err ?? undefined,
            rows,
          );
          return cb.apply(this, [err, ...rest]);
        };
      } else {
        // no cb — capture immediately (sqlite3 fires cb on next tick so we
        // approximate duration as ~0)
        record(dbModule, config, startTime, sql, databaseName, 'success');
      }
      try {
        return (original as Function).apply(this, args);
      } catch (err) {
        record(dbModule, config, startTime, sql, databaseName, 'error', err as Error);
        throw err;
      }
    };
  }
  return true;
}

function patchNodeSqlite(dbModule: DatabaseModule, config: DbIntegrationConfig): boolean {
  // node:sqlite is a built-in (Node 22+). tryRequire will pick it up.
  type NodeSqlite = {
    DatabaseSync?: { prototype: Record<string, unknown> };
    StatementSync?: { prototype: Record<string, unknown> };
  };
  const mod = tryRequire<NodeSqlite>('node:sqlite');
  if (!mod?.DatabaseSync?.prototype) return false;

  const dbProto = mod.DatabaseSync.prototype;

  const origPrepare = dbProto.prepare;
  if (typeof origPrepare === 'function') {
    dbProto.prepare = function (this: { location?: string }, sql: string) {
      const stmt = (origPrepare as Function).call(this, sql) as Record<string, unknown>;
      const databaseName =
        (this as { location?: string }).location ?? '';

      for (const method of ['run', 'get', 'all'] as const) {
        const original = stmt[method];
        if (typeof original === 'function') {
          stmt[method] = function (this: unknown, ...args: unknown[]) {
            const startTime = Date.now();
            try {
              const result = (original as Function).apply(this, args);
              const rows =
                (result as { changes?: number })?.changes ??
                (Array.isArray(result) ? result.length : -1);
              record(dbModule, config, startTime, sql, databaseName, 'success', undefined, rows);
              return result;
            } catch (err) {
              record(dbModule, config, startTime, sql, databaseName, 'error', err as Error);
              throw err;
            }
          };
        }
      }
      return stmt;
    };
  }

  const origExec = dbProto.exec;
  if (typeof origExec === 'function') {
    dbProto.exec = function (this: { location?: string }, sql: string) {
      const startTime = Date.now();
      const databaseName = this.location ?? '';
      try {
        const result = (origExec as Function).call(this, sql);
        record(dbModule, config, startTime, sql, databaseName, 'success');
        return result;
      } catch (err) {
        record(dbModule, config, startTime, sql, databaseName, 'error', err as Error);
        throw err;
      }
    };
  }

  return true;
}

export function instrumentSqlite(
  dbModule: DatabaseModule,
  config: DbIntegrationConfig = {},
): boolean {
  if (patched) return true;

  let any = false;
  any = patchBetterSqlite3(dbModule, config) || any;
  any = patchSqlite3(dbModule, config) || any;
  any = patchNodeSqlite(dbModule, config) || any;

  if (any) patched = true;
  return any;
}
