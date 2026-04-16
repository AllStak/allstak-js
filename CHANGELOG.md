# Changelog

All notable changes to `allstak-js` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-04-11

Expanded database instrumentation: the SDK now covers the six most common
Node data layers with real-world validation against live databases.

### Highlights

- **Full-stack DB coverage.** PostgreSQL, MySQL, SQLite, Prisma, Sequelize,
  and MongoDB/Mongoose are all supported out of the box. Driver-level
  integrations (pg, mysql2, sqlite) are auto-wired at `AllStak.init()`;
  ORM-level integrations (Prisma, Sequelize, Mongoose) are opt-in via
  `allstak-js/db`.
- **Real-world validated.** Each integration was validated against a real
  running database with real CRUD (create / read / update / delete /
  transactions / failing queries) and verified on the AllStak dashboard.

### Added

- New `src/integrations/db/` tree with one file per data layer:
  `shared.ts`, `pg.ts`, `mysql2.ts`, `sqlite.ts`, `prisma.ts`,
  `sequelize.ts`, `mongoose.ts`.
- New `allstak-js/db` sub-module exporting `instrumentPg`,
  `instrumentMysql2`, `instrumentSqlite`, `instrumentPrisma`,
  `instrumentSequelize`, `instrumentMongo`, `instrumentMongoose`, plus the
  `normalizeQuery` / `hashQuery` / `detectQueryType` helpers.
- **pg**: full support for the callback, promise, and Submittable call
  signatures; transparent `Pool.query` coverage via `Client.prototype.query`
  patching; per-query `BEGIN` / `COMMIT` / `ROLLBACK` capture.
- **mysql2**: fixed the promise-path gap — `mysql2/promise`,
  `pool.promise().query()`, and `pool.query()` (which dispatches a Query
  object with `onResult`) are now all captured. Connection.prototype is
  patched exactly once at the classic layer; the promise wrapper and pool
  inherit the instrumentation with no double-capture.
- **SQLite**: support for `better-sqlite3`, `sqlite3`, and Node 22+
  `node:sqlite`. Compile-time errors at `prepare()` are captured.
- **Prisma**: `instrumentPrisma(prismaClient, AllStak.database, { databaseType })`
  hooks Prisma's `$on('query')` event. Client must be constructed with
  `log: [{ emit: 'event', level: 'query' }]`.
- **Sequelize**: `instrumentSequelize(sequelize, AllStak.database)` uses
  `beforeQuery`/`afterQuery` hooks plus patches
  `connectionManager.getConnection` so raw connections are marked
  ORM-owned — preventing double-capture when a dialect also has a
  driver-level wrapper (SQLite was the motivating case; the abstract
  `afterConnect` hook doesn't fire for the sqlite dialect).
- **MongoDB + Mongoose**: `instrumentMongo(client, …)` and
  `instrumentMongoose(mongoose, …)` hook the `commandStarted`,
  `commandSucceeded`, and `commandFailed` APM events. The driver/client
  must be constructed with `monitorCommands: true`. Operations are mapped
  to the SQL-shaped ingest contract via a command-name → queryType table
  (`find→SELECT`, `insert→INSERT`, …) with `databaseType: "mongodb"`.
- **Trace propagation into DB queries.** Every captured query is
  auto-stamped with the current `traceId` and `spanId` from the tracing
  module via a shared trace resolver.
- **ORM dedup machinery.** A shared symbol (`allstak.db.ownedByOrm`) is
  used to mark ORM-owned raw connections. Every driver wrapper checks
  `isOwnedByOrm(this)` and bypasses capture when set.
- Host-app module resolution for optional peer deps: `tryRequire()` now
  walks `process.cwd()` and `require.main.paths` so driver modules like
  `pg` and `mysql2` are resolved from the host project's `node_modules`,
  not the SDK's. Without this, ESM-built SDKs could not see the host's
  peer dependencies and all auto-instrumentation silently no-op'd.
- tsup `esbuildOptions` banner that injects
  `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`
  into every Node ESM chunk. Without this banner the tsup-generated
  `__require` polyfill resolves to the "Dynamic require of X is not
  supported" throwing Proxy in ESM mode, silently disabling all
  `tryRequire()` calls.
- New unit test file `tests/db-shared.test.ts` covering `normalizeQuery`,
  `hashQuery`, `detectQueryType`, and the ORM dedup markers (20 new tests).

### Changed

- `src/modules/database.ts` is now a pure queue/transport. All driver and
  ORM instrumentation logic moved to `src/integrations/db/`. The module
  re-exports `normalizeQuery`, `hashQuery`, `detectQueryType`,
  `instrumentPg`, `instrumentMysql2`, `instrumentSqlite`, and
  `enableDbAutoInstrumentation` for backwards compatibility.
- `normalizeQuery()` no longer masks double-quoted content. In ANSI SQL
  and PostgreSQL `"..."` is a quoted identifier (e.g.
  `"public"."Task"."id"`) — masking it turned every ORM-generated query
  into the useless shape `SELECT ?.?.? FROM ?.?`.
- `tsup.config.ts` adds a `db` entry point to both Node and browser
  builds, and uses `esbuildOptions` to inject a real `createRequire` shim
  into Node ESM chunks.
- `package.json` exports map grows a `./db` condition pointing at the new
  entry.
- Version bumped from `1.0.0` to `1.1.0`.

### Fixed

- `mysql2` failing queries dispatched through the promise pool path are
  now correctly recorded with `status: 'error'`. Previously they were
  silently recorded as `success` because the pool builds a Query object
  with `onResult` and calls `conn.query(cmdQuery)` — the legacy wrapper
  only looked for function-typed arguments and missed this shape
  entirely.
- `better-sqlite3` / `sqlite3` / `node:sqlite` `prepare()` calls that
  throw on invalid SQL are now captured as error queries. Previously the
  throw happened before any stmt method could be wrapped and the bad
  query was invisible on the dashboard.
- Sequelize + SQLite double-capture. Sequelize's sqlite dialect has its
  own `getConnection()` that bypasses the abstract pool's `afterConnect`
  hook, so the "mark raw connection as ORM-owned" path never ran. The
  Sequelize integration now also patches `connectionManager.getConnection`
  directly so every returned connection is marked.

## [1.0.0] — 2026-04-11

First public release of the AllStak JavaScript SDK on npm.

### Highlights

- **Static ingest host.** Customers no longer have to construct a DSN. Pass `apiKey` and you're done. The production AllStak ingest URL is baked into the SDK.
- **Drop-in Express integration** via `allstak-js/express` — request capture, error handler, user auto-attach, and per-request trace span in 2 lines.
- **Drop-in cron monitoring helper** via `allstak-js/cron` — wrap any scheduled task and ship a heartbeat with real `durationMs`.
- **Node uncaughtException + unhandledRejection auto-capture.** Previously browser-only.
- **Real-world validated.** End-to-end validated against a real Express + node:sqlite Tasks app with real session auth, real CRUD, real business logic exceptions, real outbound HTTP, and a real cron runner.

### Added

- `allstak-js/express` sub-module with `allstakExpress.requestHandler()` and `allstakExpress.errorHandler()`. Captures inbound HTTP, opens/closes a per-request trace span, honors upstream `x-trace-id` / `traceparent`, auto-attaches `req.user` onto subsequent captures, and forwards thrown errors through the Express error pipeline.
- `allstak-js/cron` sub-module with `monitor(slug, fn)`. Wraps any callable so every invocation emits an AllStak heartbeat with success/failure + real `durationMs`. Slug is auto-normalised to `^[a-z0-9-]+$`.
- Node `uncaughtException` and `unhandledRejection` listeners installed automatically when running in Node. Toggle via `autoNodeErrorCapture: false`.
- `INGEST_HOST` and `SDK_VERSION` exported constants from the main entry.
- Optional `host` config field for self-hosted AllStak deployments and integration tests.
- New tsup entries: `dist/node/express.{js,mjs,d.ts}` and `dist/node/cron.{js,mjs,d.ts}`, plus matching browser builds.
- `engines.node`: `>=18.0.0`.
- `prepublishOnly` script that runs `clean && build` before `npm publish`.
- `repository`, `homepage`, `bugs`, `author`, `publishConfig.access` package.json fields.

### Changed

- `AllStakConfig` now uses `apiKey` (required) + optional `host`, instead of the old `dsn` field. The legacy `dsn` field is still parsed for backwards-compatibility but is now deprecated.
- `keywords` extended with `tracing`, `apm`, `node`, `nodejs`, `express`, `browser`, `typescript`.
- `exports` map split into separate entries for the main SDK, `/express`, and `/cron`. Each entry has explicit `types`, `import`, `require`, and `default` keys for both Node and browser conditions.
- Version bumped from `0.1.0` (internal pre-release) to `1.0.0`.

### Fixed

- Stale unit tests that asserted the old metadata payload format (without auto-injected `traceId`/`spanId`) and the old replay masking string (`'***'` → `'[MASKED]'`). All 34 unit tests now pass.

### What's new for Node / JS users

If you're upgrading from a `0.x` version: change your `AllStak.init({ dsn: 'http://KEY@host' })` to `AllStak.init({ apiKey: 'ask_live_…' })`. The SDK will use the production ingest host automatically. Set `host: '…'` only if you self-host AllStak.

Then install the Express integration in 2 lines:

```ts
import { AllStak } from 'allstak-js';
import { allstakExpress } from 'allstak-js/express';

AllStak.init({ apiKey: process.env.ALLSTAK_API_KEY!, environment: 'production' });

const app = express();
app.use(allstakExpress.requestHandler());      // BEFORE routes
// … your routes …
app.use(allstakExpress.errorHandler());        // AFTER routes
```

And monitor any scheduled task with one wrap:

```ts
import cron from 'node-cron';
import { monitor } from 'allstak-js/cron';

cron.schedule('*/5 * * * *', monitor('housekeeping', async () => {
  await runHousekeeping();
}));
```

After upgrading you should immediately see, with no other code changes:
- Inbound HTTP requests on the **Requests** page (real round-trip timing)
- Per-request spans on the **Traces** page
- Authenticated user (`req.user`) on every error detail page
- Thrown errors from any Express route on the **Errors** page
- Cron heartbeats on the **Cron Jobs** page (success + failure)
- `console.warn` / `console.error` calls as breadcrumbs on the next captured error

### Breaking changes

- **`AllStakConfig.dsn` is deprecated**, replaced by `AllStakConfig.apiKey`. The old form still works (we parse it and extract the API key + host), so existing apps continue to compile and ship events. But the field will be removed in 2.0.

### Compatibility

- Node.js 18+ (uses `fetch`, `AbortController`, `crypto.randomUUID`)
- Browsers: modern (ESM)
- React Native via the `react-native` export condition
- TypeScript: full type definitions included for both browser and Node builds, with separate `.d.ts` and `.d.mts` files

### Pre-1.0 work

Internal pre-1.0 development happened across the `allstak-js` repository before this public release. The internal `0.1.0` version was never published to npm.
