# Changelog

All notable changes to `@allstak/js` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-05-29

### Added

- **Release-health session tracking.** A `Session` / `SessionTracker`
  (`src/session.ts`) opens one release-health session per process/app-launch
  and reports lifecycle to `/ingest/v1/sessions/start` and
  `/ingest/v1/sessions/end`. Status vocabulary matches the backend contract and
  the Java SDK (`ok` → `errored` → `crashed`/`abnormal`), enabling crash-free
  session/user rates. Sessions are best-effort live-only and are never
  persisted to the offline queue.
- **Offline / persistent transport queue** (`src/transport/offline-queue.ts`).
  Events that cannot be delivered (network error, retries exhausted, circuit
  open/offline, or shutdown with buffered events) are written to a persistent
  store instead of being dropped, then drained on the next init. Payloads are
  persisted post-redaction — only the exact PII-scrubbed bytes the transport
  would have sent are stored. Session start/end calls are excluded.
- **Value-pattern PII scrubbing + `sendDefaultPii`** (`src/utils/redact.ts`,
  `config.sendDefaultPii`). In addition to the existing key-based deny-list,
  values are now pattern-scrubbed: credit-card and SSN patterns are **always**
  scrubbed regardless of configuration; email addresses and IP addresses are
  scrubbed **unless** `sendDefaultPii: true` is set. Applied across logs,
  errors, and breadcrumbs.
- **Core Web Vitals collection (browser)** (`src/modules/web-vitals.ts`). LCP,
  CLS, INP, FCP, and TTFB are observed natively (no `web-vitals` dependency)
  and reported as a single `op: 'web.vital'` span to `/ingest/v1/spans`,
  surfacing in the dashboard's web-vitals view.
- **Outbound Node HTTP trace-context propagation** (`src/modules/auto-node-http.ts`).
  `http.request` / `https.request` calls are auto-instrumented to inject W3C
  trace context, continuing the distributed trace across outbound service calls.
- **Head-of-trace sampling: `tracesSampleRate` + `tracesSampler`**
  (`config.tracesSampleRate`, `config.tracesSampler`). The sampling decision is
  made once at the head of a trace (W3C sticky head-of-trace) and propagated, so
  a `tracesSampler` can honor `parentSampled`. Back-compat default: when neither
  is set, every trace is sampled (tracing stays fully on).
- **Runtime release auto-detection + auto-registration**
  (`src/release-detect.ts`, `src/release-registration.ts`). Node-only, guarded
  local-git probe at init resolves `release` (after `ALLSTAK_RELEASE` and other
  env vars) and can auto-register the detected runtime release, so a non-empty
  release is associated with events without a CI/CD step.

### Changed

- Transport now honors a real `Retry-After` header on `429`/`503` responses,
  overriding the computed exponential backoff for the circuit breaker
  (`src/transport/http.ts`).
- Removed hardcoded example API keys from the repo.

### Docs

- Quickstart no longer includes host setup; SDK contribution readiness docs
  improved.

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
