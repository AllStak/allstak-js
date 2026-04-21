# allstak-js

Official JavaScript/TypeScript SDK for [AllStak](https://allstak.io). Drop-in observability for Node.js, Express, and the browser. One install + one API key gives you error tracking, logs, HTTP requests, DB queries, traces, outbound HTTP capture, and cron monitoring.

## 1. What you get

**One package. One API key.** What you get *automatically* from `AllStak.init(apiKey)` alone:
- every uncaught exception and unhandled promise rejection (Node) / `window.onerror` + `unhandledrejection` (browser);
- every outbound HTTP call — `fetch`, `node:http`, `node:https`, and anything that goes through them (axios, got, node-fetch, etc.);
- `console.warn` / `console.error` as breadcrumbs;
- `environment` / `release` / `tags` stamped on every captured event.

What you have to wire *manually* (one line each — see the table in §6): inbound HTTP via `allstakExpress.requestHandler()`; thrown-route-errors via `allstakExpress.errorHandler()`; DB queries via `allstak-js/db`; cron heartbeats via `allstak-js/cron`. The dashboard reflects exactly what you wire — nothing is silently missing or partially captured.

## 2. Install

```bash
npm install allstak-js
# or: pnpm add allstak-js   /   yarn add allstak-js
```

Requires Node.js **18+** (uses native `fetch`). Modern browsers and React Native are also supported via the package's `exports` map.

## 3. 60-second setup (Express)

```ts
import express from 'express';
import { AllStak } from 'allstak-js';
import { allstakExpress } from 'allstak-js/express';

AllStak.init({
  apiKey: process.env.ALLSTAK_API_KEY!,
  environment: process.env.NODE_ENV ?? 'production',
  release: process.env.GIT_SHA ?? 'v1.0.0',
});

const app = express();

// Mount BEFORE your routes
app.use(allstakExpress.requestHandler());

app.get('/tasks', (req, res) => { /* … */ });

// Mount AFTER your routes
app.use(allstakExpress.errorHandler());

app.listen(3000);
```

That's it. The SDK auto-attaches `req.user` (if set), opens a per-request trace span, captures the inbound HTTP request, and reports any thrown error to AllStak. Get the API key from your AllStak dashboard → Project → Install SDK.

## 4. First error in under a minute

Boot your app and trigger any error route you have. For example, a route that throws:

```ts
app.get('/boom', () => { throw new Error('hello allstak'); });
```

`curl http://localhost:3000/boom` and open the AllStak dashboard → **Errors**. You'll see the exception with the full stack trace, request method/path/host, the per-request trace ID, the authenticated user, and breadcrumbs of recent log/HTTP entries.

To send a manual event from anywhere in your code:

```ts
import { AllStak } from 'allstak-js';
AllStak.captureMessage('hello from JS SDK', 'info');
AllStak.captureException(new Error('something went wrong'));
```

## 5. Plain Node (no Express)

```ts
import { AllStak } from 'allstak-js';

AllStak.init({
  apiKey: process.env.ALLSTAK_API_KEY!,
  environment: 'production',
  release: 'v1.0.0',
});

// Optional: tag every event with a global field
AllStak.setTag('service', 'worker');

try {
  await runJob();
} catch (err) {
  AllStak.captureException(err as Error);
} finally {
  AllStak.destroy(); // graceful flush before exit
}
```

The SDK installs Node `uncaughtException` and `unhandledRejection` listeners automatically. Disable with `autoNodeErrorCapture: false`.

## 6. What gets captured automatically

This table is the single source of truth — runtime-verified against the live AllStak backend. "Auto" means `AllStak.init(...)` alone is enough; "Manual" means you must call an SDK method or mount a helper.

| Feature | Auto vs Manual | Verified |
|---|---|---|
| `uncaughtException` (Node) | **Auto** via `process.on('uncaughtException')` | ✅ |
| `unhandledRejection` (Node) | **Auto** via `process.on('unhandledRejection')` | ✅ |
| `window.onerror` + `unhandledrejection` (Browser) | **Auto** via `window.addEventListener` | ✅ |
| Outbound `fetch()` → records to `/ingest/v1/http-requests` AND breadcrumb | **Auto** | ✅ |
| Outbound `node:http` / `node:https` (covers axios, got, node-fetch, native) | **Auto** | ✅ |
| `console.warn` / `console.error` → breadcrumbs | **Auto** | ✅ |
| Inbound HTTP (Express) | **Manual** — register `allstakExpress.requestHandler()` BEFORE your routes (Express middleware order matters) | ✅ when wired |
| Express thrown errors | **Manual** — register `allstakExpress.errorHandler()` AFTER your routes | ✅ |
| Per-request trace span | Manual — started inside `requestHandler` | ✅ |
| `pg` / `mysql2` / `sqlite` queries | **Manual** — opt-in via `allstak-js/db` helpers (`installPg(pool, ...)`, etc.). The earlier README claim of zero-config DB auto-instrumentation was wrong; tracked as a follow-up. | ✅ when wired |
| Prisma / Sequelize / Mongoose / MongoDB queries | Manual — `allstak-js/db` opt-in helpers | ✅ when wired |
| `captureMessage(...)` | Routes to **logs** by default (`info`/`warning`); to **logs + errors** for `error`/`fatal`. Override with `{ as: 'log' \| 'error' \| 'both' }`. | ✅ |
| Browser session replay | Opt-in via `sessionReplay.enabled: true` | source-only |
| Scheduled task heartbeats | Manual — `monitor()` from `allstak-js/cron` | ✅ when wired |
| `environment` / `release` / `tags` on every event | **Auto** from `init()` config (also stamped on http_requests as of v0.x — earlier versions lost these tags on http rows) | ✅ |

Each automatic feature can be turned off via the `AllStak.init()` config:

```ts
AllStak.init({
  apiKey: '…',
  autoBreadcrumbs: false,
  autoNodeErrorCapture: false,
  autoDbInstrumentation: false,
});
```

## 7. Manual capture

```ts
import { AllStak } from 'allstak-js';

// Errors with metadata
AllStak.captureException(new Error('payment failed'), {
  orderId: 'ORD-123',
  amount: 99.9,
});

// Messages
AllStak.captureMessage('Payment retried', 'warning');

// Logs (debug | info | warn | error | fatal)
AllStak.log.info('Order processed', { orderId: 'ORD-123' });
AllStak.log.warn('Retrying payment', { attempt: 2 });
AllStak.log.error('Payment failed', { gateway: 'stripe' });

// Per-process user context (Express middleware also auto-attaches req.user)
AllStak.setUser({ id: 'user-42', email: 'alice@example.com' });

// Global tags attached to every event
AllStak.setTag('service', 'checkout-api');
AllStak.setTag('region', 'eu-west-1');

// Breadcrumbs (attached to the next captured error)
AllStak.addBreadcrumb('ui',   'User clicked Pay');
AllStak.addBreadcrumb('http', 'POST /payments -> 502', 'error', { statusCode: 502 });

// Outbound HTTP requests (Express integration captures inbound automatically)
AllStak.captureRequest({
  direction: 'outbound',
  method: 'POST',
  host: 'api.stripe.com',
  path: '/v1/charges',
  statusCode: 200,
  durationMs: 187,
});

// Manual cron heartbeats (or use the wrapper helper from allstak-js/cron)
AllStak.heartbeat({ slug: 'daily-report', status: 'success', durationMs: 1240 });
```

## 7.5 Database instrumentation (`allstak-js/db`)

AllStak captures database queries for six of the most common Node data layers.
Three are auto-instrumented at `AllStak.init()` time (you don't have to write
any DB wiring code); the other three are ORMs and must be opted in explicitly
because they require a live client instance.

| Driver / ORM | Auto or manual | Notes |
|---|---|---|
| `pg` (PostgreSQL) | auto | Client + Pool, callback + promise + Submittable. Captures BEGIN / COMMIT / ROLLBACK transactions individually. |
| `mysql2` (incl. `mysql2/promise`) | auto | Classic Connection + Pool, promise pool, `pool.execute` prepared statements. |
| `better-sqlite3`, `sqlite3`, `node:sqlite` | auto | Prepare / run / get / all / iterate, plus compile-time errors on bad SQL. |
| Prisma (`@prisma/client`) | opt-in via `instrumentPrisma(...)` | Uses Prisma's `$on('query')` event — client must be constructed with `log: [{ emit: 'event', level: 'query' }]`. |
| Sequelize | opt-in via `instrumentSequelize(...)` | Hooks `beforeQuery`/`afterQuery` and patches `connectionManager.getConnection` to mark raw connections so the driver layer skips duplicates. |
| MongoDB + Mongoose | opt-in via `instrumentMongo` / `instrumentMongoose(...)` | Hooks the official `mongodb` driver APM events (`commandStarted`/`commandSucceeded`/`commandFailed`). The client must be constructed with `monitorCommands: true`. |

```ts
// Driver-level captures are automatic:
import { AllStak } from 'allstak-js';
import { Pool } from 'pg';
AllStak.init({ apiKey: process.env.ALLSTAK_API_KEY! });
const pool = new Pool({ /* ... */ });
await pool.query('SELECT 1');   // → captured automatically

// ORM captures are opt-in:
import { instrumentPrisma, instrumentSequelize, instrumentMongoose } from 'allstak-js/db';
import { PrismaClient } from '@prisma/client';
import { Sequelize } from 'sequelize';
import mongoose from 'mongoose';

const prisma = new PrismaClient({
  log: [{ emit: 'event', level: 'query' }],
});
instrumentPrisma(prisma, AllStak.database, { databaseType: 'postgresql' });

const sequelize = new Sequelize({ dialect: 'postgres', /* ... */ });
instrumentSequelize(sequelize, AllStak.database);

await mongoose.connect(process.env.MONGO_URL!, { monitorCommands: true });
instrumentMongoose(mongoose, AllStak.database);
```

**Safe by default.** SQL queries are normalized before they leave your
process — single-quoted string literals, numeric literals, dollar-quoted
blocks, and block/line comments are all replaced with `?` placeholders.
Double-quoted identifiers (`"public"."Task"`) are preserved so ORM-generated
queries remain readable. No parameter values are ever captured.

**What we capture per query:** `normalizedQuery`, `queryHash`, `queryType`
(SELECT/INSERT/UPDATE/DELETE/BEGIN/COMMIT/ROLLBACK/OTHER for SQL,
FIND/INSERT/UPDATE/DELETE for Mongo), `durationMs`, `status` (success/error),
`errorMessage` (first 500 chars on failure), `databaseName`, `databaseType`,
`rowsAffected`, `traceId` + `spanId` (auto-populated from the active span),
`service`, and `environment`.

**ORM double-capture prevention.** When you call `instrumentSequelize(...)`
the integration marks Sequelize's raw connection objects as ORM-owned and
the driver-level wrappers skip them — so queries are recorded once by the
ORM hook, not twice.

## 8. Cron monitoring (`allstak-js/cron`)

```ts
import cron from 'node-cron';
import { AllStak } from 'allstak-js';
import { monitor } from 'allstak-js/cron';

AllStak.init({ apiKey: process.env.ALLSTAK_API_KEY! });

// Wrap any function so every call ships a heartbeat with success/failure
// + real durationMs. Slug is auto-normalised to ^[a-z0-9-]+$.
cron.schedule('*/5 * * * *', monitor('daily-report', async () => {
  await runDailyReport();
}));

// Works with any scheduler — node-cron, node-schedule, BullMQ, Agenda,
// plain setInterval. The wrapper preserves the original return value
// and re-throws on error so the host scheduler still sees failures.
```

## 9. Where to find your data in the dashboard

| What you sent | Dashboard page |
|---|---|
| Exceptions (auto + `captureException`) | **Errors** |
| Log lines (`AllStak.log.*`) | **Logs** |
| Inbound + outbound HTTP requests | **Requests** |
| `pg` / `mysql2` / `sqlite` / Prisma / Sequelize / MongoDB / Mongoose queries | **Database** |
| Per-request trace spans | **Traces** |
| Cron heartbeats (`monitor()` / `heartbeat()`) | **Cron Jobs** |
| Browser session replays | **Session Replay** |

Click any error to see the full stack trace, breadcrumbs, request context (method/path/host/trace ID), the user, custom metadata as tags, occurrence count, fingerprint, release, environment, and the linked trace.

## 10. Production notes

- **Buffering**: HTTP requests, DB queries, and spans are batched in per-channel queues (default ~20 items / 5 s flush interval). Errors and cron heartbeats are sent immediately.
- **Retries**: built-in exponential-backoff retry on transport failures. The transport buffers payloads on failure and replays them on the next successful send.
- **Timeouts**: 3 s per request. Never blocks your hot path.
- **Static ingest host**: the SDK ships with the production ingest URL baked in (`INGEST_HOST`). There is no DSN, no host config to manage. Self-hosted? Pass `host: 'https://your-allstak.example.com'` to `AllStak.init()`.
- **No-op safe**: if `apiKey` is missing, `AllStak.init()` will throw. Wrap the call in a feature flag for staging if needed.
- **Graceful shutdown**: call `AllStak.destroy()` before your process exits to flush buffers.
- **Trace propagation**: the Express middleware honors an upstream `x-trace-id` or `traceparent` header, so distributed traces stitch end-to-end across services.
- **Sensitive headers**: not captured by default — only method, path, host, status code, duration. Add custom redaction in your own middleware if needed.

## 11. Troubleshooting

**Events aren't appearing in the dashboard.**
1. Confirm the SDK was initialised exactly once. Check that `AllStak.init({ apiKey: '…' })` runs before any other SDK call.
2. Confirm the API key is correct. The dashboard shows the key once at project creation; if you lost it, regenerate one in **Settings → API Keys**.
3. Confirm you're looking at the correct project in the dashboard's project picker. API keys are project-scoped.
4. Open the dashboard's environment filter (top right) and switch to "All Envs" — events show up under whatever `environment` field you sent.
5. Buffered events flush every 5 s. Wait at least that long before refreshing the dashboard.

**Express integration isn't capturing requests.** Make sure `app.use(allstakExpress.requestHandler())` is mounted **before** your routes, and `allstakExpress.errorHandler()` is mounted **after** them. Order matters in Express.

**Outbound HTTP isn't captured.** The Express request handler captures *inbound* requests. For *outbound* calls (`fetch`/`axios`/etc.), call `AllStak.captureRequest({ direction: 'outbound', … })` from your service layer, or use the `pg`/`mysql2` auto-instrumentation for DB queries.

**`AllStak.init() must be called before using the SDK`.** You called a capture method before init. Make sure your bootstrap file runs `AllStak.init(...)` before importing modules that use the SDK.

**TypeScript types not resolving.** Make sure `moduleResolution` is set to `Bundler`, `NodeNext`, or `Node16` in your `tsconfig.json` so TypeScript honours the package's `exports` map.

**Where's the host config?** There isn't one for normal customers. The ingest URL is the production AllStak endpoint (`INGEST_HOST`). For self-hosted AllStak deployments or integration tests, pass `host: 'https://your-allstak.example.com'` to `AllStak.init()`.

## 12. Real Express example

```ts
// server.ts
import express from 'express';
import session from 'express-session';
import { AllStak } from 'allstak-js';
import { allstakExpress } from 'allstak-js/express';

AllStak.init({
  apiKey: process.env.ALLSTAK_API_KEY!,
  environment: process.env.NODE_ENV ?? 'production',
  release: process.env.GIT_SHA ?? 'v1.0.0',
  tags: { service: 'checkout-api' },
});

const app = express();
app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET!, resave: false, saveUninitialized: false }));
app.use(allstakExpress.requestHandler());

// Tiny user resolver — anything you put on req.user gets attached automatically.
app.use(async (req, _res, next) => {
  if (req.session?.userId) {
    req.user = await db.user.findUnique({ where: { id: req.session.userId } });
  }
  next();
});

app.post('/checkout/:orderId', async (req, res, next) => {
  try {
    AllStak.addBreadcrumb('ui', `Customer clicked checkout for ${req.params.orderId}`);
    const receipt = await orderService.process(req.params.orderId);

    // Outbound HTTP — capture it for the Requests page
    const start = Date.now();
    const stripeRes = await fetch('https://api.stripe.com/v1/charges', { method: 'POST', /* … */ });
    AllStak.captureRequest({
      direction: 'outbound',
      method: 'POST',
      host: 'api.stripe.com',
      path: '/v1/charges',
      statusCode: stripeRes.status,
      durationMs: Date.now() - start,
    });

    res.json({ ok: true, receipt });
  } catch (err) {
    // Optional — already captured automatically by the error handler.
    AllStak.captureException(err as Error, { orderId: req.params.orderId });
    next(err);
  }
});

app.use(allstakExpress.errorHandler());
app.listen(3000);
```

That's the entire integration. The SDK handles the rest.

## License

MIT
