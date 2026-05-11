# Changelog

All notable changes to `@allstak/js` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-11

### Added

- Full-stack database instrumentation: PostgreSQL (pg), MySQL (mysql2),
  SQLite (better-sqlite3, sqlite3, node:sqlite), Prisma, Sequelize,
  MongoDB/Mongoose via `@allstak/js/db`.
- Trace propagation into captured database queries.
- ORM dedup machinery to prevent double-capture when ORM wraps a driver.
- ESM `createRequire` shim so driver auto-instrumentation works in ESM.

### Changed

- Database module refactored: `src/integrations/db/` tree replaces inline logic.
- `normalizeQuery()` no longer masks double-quoted SQL identifiers.

### Fixed

- mysql2 promise-pool error queries now correctly record as `status: 'error'`.
- SQLite `prepare()` compile errors are now captured.
- Sequelize + SQLite double-capture resolved via `connectionManager.getConnection` patching.

## [0.1.3] — 2026-04-10

### Changed

- Aligned repo state with `@allstak/*@0.1.3` on npm.
- Version constant `SDK_VERSION` synced to package.json.

## [0.1.2] — 2026-04-08

### Added

- v2 ingest contract: top-level `sdkName`, `sdkVersion`, `platform` fields.
- Structured `frames[]` alongside string `stackTrace[]`.
- `debugMeta.images[]` for source map debugId aggregation.

## [0.1.1] — 2026-03-28

### Added

- Drop-in Express integration via `@allstak/js/express`.
- Drop-in cron monitoring via `@allstak/js/cron`.
- Node `uncaughtException` and `unhandledRejection` auto-capture.
- Production ingest host `api.allstak.sa` baked in.
- Source map injection and upload pipeline (`@allstak/js/sourcemaps`).
- Vite and Webpack build plugins.

### Changed

- Config uses `apiKey` (required) + optional `host`, replacing old `dsn` field.

### Fixed

- Exports map corrected for react/react-native sub-exports.
