/**
 * Shared helpers used by every DB integration under `src/integrations/db/`.
 *
 * Keep this file tiny and side-effect free so it can be imported from Node
 * and browser builds without pulling any native dependencies.
 */

import type { DatabaseModule, DbQueryItem } from '../../modules/database';

export interface DbIntegrationConfig {
  service?: string;
  environment?: string;
}

/**
 * Called by the client.ts bootstrap so DB integrations can ask the running
 * AllStak instance for the current trace id / span id. We keep this as a
 * simple function reference instead of importing the client to avoid a
 * circular dep between modules/database ↔ integrations/db ↔ client.
 */
export type TraceResolver = () => { traceId?: string; spanId?: string };

let traceResolver: TraceResolver | null = null;
export function setTraceResolver(resolver: TraceResolver | null): void {
  traceResolver = resolver;
}
export function getTraceContext(): { traceId?: string; spanId?: string } {
  if (!traceResolver) return {};
  try {
    return traceResolver() ?? {};
  } catch {
    return {};
  }
}

/**
 * Normalize a SQL statement for deduplication & safe storage:
 *   - strip single-quoted string literals (all dialects)
 *   - strip dollar-quoted string literals ($tag$...$tag$, Postgres)
 *   - strip `--` line comments and block comments
 *   - mask numeric literals
 *   - collapse whitespace
 *
 * We deliberately do NOT mask double-quoted content: in PostgreSQL and
 * ANSI-compliant MySQL it's a *quoted identifier*, not a string literal
 * (e.g. `"public"."Task"`). Masking it would turn every ORM-generated
 * query into a useless `SELECT ?.?.? FROM ?.?` shape. MySQL with
 * ANSI_QUOTES off uses "..." for strings, but that's the exceptional
 * case — most modern apps keep ANSI_QUOTES on via `sql_mode`.
 */
export function normalizeQuery(sql: string): string {
  if (!sql) return '';
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // /* block comments */
    .replace(/--[^\n]*/g, ' ')                  // -- line comments
    .replace(/'(?:''|[^'])*'/g, '?')            // single-quoted literals (incl. '' escape)
    .replace(/\$[a-zA-Z0-9_]*\$[\s\S]*?\$[a-zA-Z0-9_]*\$/g, '?') // dollar-quoted
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')         // numeric literals
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashQuery(normalized: string): string {
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + c;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function detectQueryType(sql: string): string {
  const first = sql.trim().split(/\s+/)[0]?.toUpperCase();
  if (!first) return 'OTHER';
  if (['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'BEGIN', 'COMMIT', 'ROLLBACK'].includes(first)) {
    return first;
  }
  return 'OTHER';
}

/**
 * Fail-open capture wrapper: catch any exception thrown inside the capture
 * path so we never break the host app's query chain.
 */
export function safeCapture(
  dbModule: DatabaseModule,
  config: DbIntegrationConfig,
  item: Omit<DbQueryItem, 'service' | 'environment' | 'traceId' | 'spanId'>,
): void {
  try {
    const ctx = getTraceContext();
    dbModule.capture({
      ...item,
      service: config.service,
      environment: config.environment,
      traceId: ctx.traceId,
      spanId: ctx.spanId,
    });
  } catch {
    /* never break the host process */
  }
}

/**
 * ORM dedup: when an ORM integration (Prisma, Sequelize, Mongoose) captures a
 * query, it also tags the underlying driver connection so the driver-level
 * wrapper knows to skip. We attach a symbol to the connection/client object.
 */
export const DEDUPE_SYMBOL = Symbol.for('allstak.db.ownedByOrm');

export function markOwnedByOrm(target: unknown): void {
  try {
    if (target && typeof target === 'object') {
      (target as Record<symbol, boolean>)[DEDUPE_SYMBOL] = true;
    }
  } catch {
    /* ignore */
  }
}

export function isOwnedByOrm(target: unknown): boolean {
  try {
    if (target && typeof target === 'object') {
      return (target as Record<symbol, boolean>)[DEDUPE_SYMBOL] === true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Require a Node module defensively. Returns null if the module isn't
 * installed in the host app (expected for optional peer deps).
 */
/**
 * Resolve a peer dependency from the HOST app's node_modules, not the SDK's.
 *
 * Why: the SDK is installed in `<host>/node_modules/allstak-js/dist/node/*.mjs`.
 * Plain `require('pg')` from inside the SDK resolves relative to the SDK's
 * own directory and will fail with ERR_MODULE_NOT_FOUND — because `pg` is a
 * peer dep of the host app, not an SDK dep. We deliberately try a list of
 * resolution bases so the lookup walks up through the host project:
 *
 *   1. `process.cwd()`     — most Node apps boot from their project root
 *   2. `require.main.paths`— the initial script's resolution chain
 *   3. `require.resolve.paths(name)` in the SDK — last-resort fallback
 *
 * Returns `null` if the peer dep is not installed — this is expected and
 * must not break anything: it just means that optional integration is off.
 */
export function tryRequire<T = unknown>(name: string): T | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req: any = typeof require !== 'undefined' ? require : null;
  if (!req) {
    if (process?.env?.ALLSTAK_DB_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.error(`[allstak-db] tryRequire('${name}') skipped: no require`);
    }
    return null;
  }

  const bases: string[] = [];
  try {
    bases.push(process.cwd());
  } catch {
    /* ignore */
  }
  try {
    // Node-only: walk the main module's resolution paths if present.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mainPaths = req.main?.paths as string[] | undefined;
    if (mainPaths) bases.push(...mainPaths);
  } catch {
    /* ignore */
  }

  // 1. Try resolving from the host app's paths.
  for (const base of bases) {
    try {
      const resolved = req.resolve(name, { paths: [base] });
      return req(resolved) as T;
    } catch {
      /* try next base */
    }
  }

  // 2. Last resort: plain require (may hit the SDK's own node_modules).
  try {
    return req(name) as T;
  } catch (e) {
    // Guarded access: `process` is undeclared in browsers and would throw
    // ReferenceError (optional chaining does not guard against this).
    if (typeof process !== 'undefined' && process?.env?.ALLSTAK_DB_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.error(`[allstak-db] tryRequire('${name}') failed:`, (e as Error).message);
    }
    return null;
  }
}
