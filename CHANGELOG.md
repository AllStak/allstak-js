# Changelog

All notable changes to `@allstak/js` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] — 2026-05-18

### Security (CRITICAL)

- **`captureException(error, context)` no longer ships caller-supplied context
  to ingest verbatim.** Pre-fix versions transmitted any sensitive keys passed
  in the context object (e.g. `authorization`, `cookie`, `*token`, `*api_key`,
  `*password`, `*secret`, `*jwt`, `*csrf`, etc.) in plaintext. See
  `docs/reports/wizard-full-cycle-e2e-2026-05-18.md` Finding #1 for the full
  audit trail.
- New `src/utils/redact.ts` ports the redactor pattern already shipped in the
  PHP, Go, NestJS, Fastify, and OTel SDKs. Default deny-list matches
  `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`,
  `x-auth-token`, `x-access-token`, `x-allstak-key`, plus key-suffix patterns
  `*token`, `*api_key`, `*password`, `*passwd`, `*secret`, `*session_id`,
  `*csrf`, `*jwt`, `*bearer`. Case-insensitive; recursive over plain objects
  and arrays; cycle-safe via `WeakMap`; depth-capped at 12 levels; never
  mutates caller input.
- Applied to `captureException` per-call context, `captureMessage`
  options.metadata / options.data, `Logs.send` metadata, breadcrumb `data`
  (redacted at drain time), and `config.tags` / `config.extras`.
- Caller may extend the deny-list:
  `AllStak.init({ redactKeys: ['internal_id', /^x-tenant-/] })`.

### Fixed

- **`captureMessage(msg, level, { data: ... })` no longer silently drops the
  `data` field.** The public `.d.ts` advertised this option from the initial
  release but the implementation never serialised it. Both `data` and
  `metadata` are now accepted and forwarded (redacted) to log + error streams.

### Tests

- 16 new tests in `tests/redaction.test.ts` cover the deny-list, custom
  patterns, nested object/array walks, cycle handling, depth cap, end-to-end
  `captureException` redaction, breadcrumb data redaction, and the
  `captureMessage` options.data / metadata fix. Total suite: 118 → 134 tests,
  all green.

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
