/**
 * PostgreSQL (`pg`) auto-instrumentation.
 *
 * Monkey-patches `pg.Client.prototype.query` at require time. Because
 * `pg.Pool.query` internally checks out a `Client` and delegates to
 * `Client.prototype.query`, patching the client prototype transparently
 * covers:
 *   - new Client().query(...)         — promise-returning, await-able
 *   - pool.query(...)                 — passes a cb to client.query, undefined return
 *   - pool.connect() → client.query() — explicit checkout
 *   - prepared/named queries          — client.query({ name, text, values })
 *   - transactions                    — BEGIN/COMMIT/ROLLBACK all captured
 *
 * Supports all three call signatures:
 *   1. client.query('SELECT 1')              → returns Promise
 *   2. client.query('SELECT $1', [1])        → returns Promise
 *   3. client.query('SELECT $1', [1], cb)    → returns undefined, fires cb
 *   4. client.query({ text, values }, cb)    → ditto
 *   5. client.query(submittable)             → Submittable with onend()
 *
 * Fail-open: any exception inside capture is swallowed so the host query
 * chain is never broken.
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

type PgModule = {
  Client: { prototype: { query: (...args: unknown[]) => unknown } };
};

let patched = false;

export function instrumentPg(
  dbModule: DatabaseModule,
  config: DbIntegrationConfig = {},
): boolean {
  if (patched) return true;

  const pg = tryRequire<PgModule>('pg');
  if (!pg || !pg.Client || !pg.Client.prototype || !pg.Client.prototype.query) {
    return false;
  }

  const originalQuery = pg.Client.prototype.query;

  pg.Client.prototype.query = function patchedPgQuery(this: unknown, ...args: unknown[]): unknown {
    if (isOwnedByOrm(this)) {
      return originalQuery.apply(this, args);
    }

    const startTime = Date.now();
    const firstArg = args[0];
    const queryText =
      typeof firstArg === 'string'
        ? firstArg
        : (firstArg as { text?: string })?.text ?? '';
    const normalized = normalizeQuery(queryText);
    const databaseName = (this as { database?: string }).database ?? '';

    const record = (
      status: 'success' | 'error',
      err?: Error & { message?: string },
      rowsAffected = -1,
    ): void => {
      safeCapture(dbModule, config, {
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: detectQueryType(queryText),
        durationMs: Date.now() - startTime,
        timestampMillis: startTime,
        status,
        errorMessage: err?.message?.slice(0, 500),
        databaseName,
        databaseType: 'postgresql',
        rowsAffected,
      });
    };

    // ── Callback signature: (config, values?, cb) or (config, cb) ──────
    // pg's Client.query returns `undefined` in this case, so we must
    // intercept the callback to capture success/error.
    let cbIndex = -1;
    for (let i = args.length - 1; i >= 0; i--) {
      if (typeof args[i] === 'function') {
        cbIndex = i;
        break;
      }
    }
    // Submittable objects may have a `.callback` property pg uses internally.
    // When config.callback is set we also intercept it.
    const submittable =
      firstArg && typeof firstArg === 'object'
        ? (firstArg as { callback?: (err: Error | null, res?: { rowCount?: number }) => void })
        : null;

    if (cbIndex >= 0) {
      const originalCb = args[cbIndex] as (err: Error | null, res?: { rowCount?: number }) => void;
      args[cbIndex] = function wrappedCb(err: Error | null, res?: { rowCount?: number }) {
        record(err ? 'error' : 'success', err ?? undefined, res?.rowCount ?? -1);
        return originalCb.call(this, err, res as never);
      };
      try {
        return originalQuery.apply(this, args);
      } catch (err) {
        record('error', err as Error);
        throw err;
      }
    } else if (submittable?.callback && typeof submittable.callback === 'function') {
      const originalCb = submittable.callback;
      submittable.callback = function wrappedCb(err: Error | null, res?: { rowCount?: number }) {
        record(err ? 'error' : 'success', err ?? undefined, res?.rowCount ?? -1);
        return originalCb.call(this, err, res as never);
      };
      try {
        return originalQuery.apply(this, args);
      } catch (err) {
        record('error', err as Error);
        throw err;
      }
    }

    // ── Promise signature: no callback, returns a Promise ──────────────
    try {
      const result = originalQuery.apply(this, args);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<{ rowCount?: number }>).then(
          (res) => {
            record('success', undefined, res?.rowCount ?? -1);
            return res;
          },
          (err: Error) => {
            record('error', err);
            throw err;
          },
        );
      }
      // Submittable return path — best-effort event listener.
      const maybeEmitter = result as { on?: (ev: string, cb: unknown) => unknown };
      if (maybeEmitter && typeof maybeEmitter.on === 'function') {
        maybeEmitter.on('end', () => record('success'));
        maybeEmitter.on('error', (err: Error) => record('error', err));
      }
      return result;
    } catch (err) {
      record('error', err as Error);
      throw err;
    }
  };

  patched = true;
  return true;
}
