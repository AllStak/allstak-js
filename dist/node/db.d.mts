import { D as DatabaseModule } from './database-DMxZg38h.mjs';

/**
 * Shared helpers used by every DB integration under `src/integrations/db/`.
 *
 * Keep this file tiny and side-effect free so it can be imported from Node
 * and browser builds without pulling any native dependencies.
 */

interface DbIntegrationConfig {
    service?: string;
    environment?: string;
}
/**
 * Called by the client.ts bootstrap so DB integrations can ask the running
 * AllStak instance for the current trace id / span id. We keep this as a
 * simple function reference instead of importing the client to avoid a
 * circular dep between modules/database ↔ integrations/db ↔ client.
 */
type TraceResolver = () => {
    traceId?: string;
    spanId?: string;
};
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
declare function normalizeQuery(sql: string): string;
declare function hashQuery(normalized: string): string;
declare function detectQueryType(sql: string): string;

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

declare function instrumentPg(dbModule: DatabaseModule, config?: DbIntegrationConfig): boolean;

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

declare function instrumentMysql2(dbModule: DatabaseModule, config?: DbIntegrationConfig): boolean;

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

declare function instrumentSqlite(dbModule: DatabaseModule, config?: DbIntegrationConfig): boolean;

/**
 * Prisma integration.
 *
 * Opt-in API: the user must call `instrumentPrisma(prismaClient)` because
 * we don't auto-patch `@prisma/client` at import time (Prisma uses generated
 * code; there's no stable prototype to monkey-patch).
 *
 * Implementation: uses Prisma's built-in `$on('query', ...)` event, which
 * fires for every query with { query, params, duration, target }. This is
 * Prisma's supported observability hook and is stable across versions.
 *
 * Side effect: marks the underlying driver connection as ORM-owned so the
 * pg/mysql2 driver-level wrappers skip it (avoiding double-capture).
 */

interface PrismaClientLike {
    $on: (event: 'query', cb: (e: PrismaQueryEvent) => void) => void;
    $connect?: () => Promise<void>;
    _engine?: unknown;
    _engineConfig?: {
        datamodel?: string;
    };
}
interface PrismaQueryEvent {
    timestamp: Date;
    query: string;
    params?: string;
    duration: number;
    target?: string;
}
/**
 * Attach Prisma query instrumentation. Returns true if the hook was wired.
 *
 * IMPORTANT: the caller must have instantiated the client with
 *   `new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })`
 * — otherwise Prisma won't emit query events. We document this in the README.
 */
declare function instrumentPrisma(prisma: PrismaClientLike, dbModule: DatabaseModule, config?: DbIntegrationConfig & {
    databaseType?: 'postgresql' | 'mysql' | 'sqlite';
}): boolean;

/**
 * Sequelize integration.
 *
 * Opt-in API. Sequelize is a classic ORM that sits on top of pg/mysql2/sqlite.
 * We hook its `beforeQuery` / `afterQuery` lifecycle events via
 * `sequelize.addHook(...)`. These hooks give us:
 *   - The final SQL string that will be executed
 *   - The options object (bind / replacements / type)
 *   - The timing between before and after (we record start time in a
 *     per-invocation symbol on the options object)
 *
 * The SDK's Sequelize integration also marks the underlying pg/mysql2
 * connection manager as ORM-owned so the driver-level wrappers don't
 * double-capture.
 */

interface SequelizeLike {
    addHook: (event: string, cb: (...args: unknown[]) => void) => unknown;
    options?: {
        dialect?: string;
        database?: string;
    };
    connectionManager?: {
        pool?: unknown;
        getConnection?: (options?: unknown) => Promise<unknown>;
    };
    config?: {
        database?: string;
    };
}
declare function instrumentSequelize(sequelize: SequelizeLike, dbModule: DatabaseModule, config?: DbIntegrationConfig): boolean;

/**
 * MongoDB + Mongoose integration.
 *
 * Strategy: the official `mongodb` driver exposes APM (Application
 * Performance Monitoring) events on the MongoClient via the constructor
 * option `monitorCommands: true`. Events `commandStarted`,
 * `commandSucceeded`, `commandFailed` give us per-operation timing + the
 * command body (filter/doc/update spec) + the database and collection name.
 *
 * Because Mongoose is a layer on top of the `mongodb` driver, hooking the
 * underlying MongoClient transparently covers Mongoose too — we just need
 * the caller to pass the right client in (either `mongoose.connection.client`
 * or the MongoClient they created manually).
 *
 * Mapping to the SQL-shaped backend ingest contract:
 *   - normalizedQuery = "<commandName> <collection>"  e.g. "find tasks"
 *   - queryType       = uppercased commandName e.g. "FIND" / "INSERT" / "UPDATE" / "DELETE"
 *   - databaseType    = "mongodb"
 *   - databaseName    = the databaseName from the APM event
 *   - durationMs      = event.duration  (mongodb driver gives this in microseconds)
 *   - status          = success | error
 *   - errorMessage    = on failure
 *   - rowsAffected    = n / nModified / deletedCount when present
 *
 * We never ship document values or filter fields — only command shape. This
 * avoids leaking PII the way raw SQL normalization does.
 */

interface MongoClientLike {
    on?: (event: string, cb: (evt: MongoApmEvent) => void) => unknown;
    s?: unknown;
}
interface MongoApmEvent {
    requestId: number;
    commandName: string;
    databaseName?: string;
    command?: Record<string, unknown>;
    duration?: number;
    reply?: Record<string, unknown>;
    failure?: Error & {
        message?: string;
    };
}
declare function instrumentMongo(client: MongoClientLike, dbModule: DatabaseModule, config?: DbIntegrationConfig): boolean;
/**
 * Mongoose convenience wrapper. Given a mongoose instance (or connection),
 * locate the underlying MongoClient and hook it.
 *
 * IMPORTANT: the user must have connected with `monitorCommands: true`, e.g.:
 *   mongoose.connect(uri, { monitorCommands: true })
 */
declare function instrumentMongoose(mongoose: {
    connection?: {
        client?: MongoClientLike;
        db?: {
            serverConfig?: unknown;
        };
    };
    connections?: Array<{
        client?: MongoClientLike;
    }>;
}, dbModule: DatabaseModule, config?: DbIntegrationConfig): boolean;

export { type DbIntegrationConfig, type TraceResolver, detectQueryType, hashQuery, instrumentMongo, instrumentMongoose, instrumentMysql2, instrumentPg, instrumentPrisma, instrumentSequelize, instrumentSqlite, normalizeQuery };
