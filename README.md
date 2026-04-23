# @allstak/js

**Track errors, logs, HTTP calls, and cron jobs in your Node.js app in under 30 seconds.**

[![npm version](https://img.shields.io/npm/v/@allstak/js.svg)](https://www.npmjs.com/package/@allstak/js)
[![CI](https://github.com/allstak-io/allstak-js/actions/workflows/ci.yml/badge.svg)](https://github.com/allstak-io/allstak-js/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Official AllStak SDK for Node.js — captures errors, structured logs, inbound/outbound HTTP, database queries, distributed traces, and cron heartbeats.

## Dashboard

View captured events live at [app.allstak.sa](https://app.allstak.sa).

![AllStak dashboard](https://app.allstak.sa/images/dashboard-preview.png)

## Features

- Uncaught exception and unhandled-rejection capture
- Structured logs with levels (`debug`, `info`, `warning`, `error`, `fatal`)
- HTTP request telemetry (inbound + outbound) with auto `fetch` instrumentation
- Database query capture for `pg` and `mysql2` (auto-instrumented)
- Distributed tracing with spans and automatic parenting
- Cron heartbeat monitoring
- Breadcrumbs ring buffer with auto-capture from `console` and `fetch`
- Express middleware entry point at `@allstak/js/express`

## What You Get

Once integrated, every event flows to your AllStak dashboard:

- **Errors** — stack traces, breadcrumbs, release + environment tags
- **Logs** — structured logs with search and filters
- **HTTP** — inbound and outbound request timing, status codes, failed calls
- **Database** — query capture for `pg` and `mysql2` with statement normalization
- **Traces** — distributed spans across services
- **Cron monitors** — scheduled job success/failure tracking
- **Alerts** — email and webhook notifications on regressions

## Installation

```bash
npm install @allstak/js
```

## Quick Start

> Create a project at [app.allstak.sa](https://app.allstak.sa) to get your API key.

```ts
import { AllStak } from '@allstak/js';

AllStak.init({
  apiKey: process.env.ALLSTAK_API_KEY!,
  environment: 'production',
  release: 'myapp@1.0.0',
});

AllStak.captureException(new Error('test: hello from allstak-js'));
```

Run the file — the test error appears in your dashboard within seconds.

## Get Your API Key

1. Sign up at [app.allstak.sa](https://app.allstak.sa)
2. Create a project
3. Copy your API key from **Project Settings → API Keys**
4. Export it as `ALLSTAK_API_KEY` or pass it to `AllStak.init(...)`

## Configuration

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `apiKey` | `string` | yes | — | Project API key (`ask_live_…`) |
| `environment` | `string` | no | — | Deployment env (`production`, `staging`) |
| `release` | `string` | no | — | Version or git SHA |
| `host` | `string` | no | `https://api.allstak.sa` | Ingest host override (self-hosted only) |
| `user` | `{ id?, email? }` | no | — | Default user context |
| `tags` | `Record<string,string>` | no | — | Default tags attached to events |
| `autoBreadcrumbs` | `boolean` | no | `true` | Auto-capture fetch/console breadcrumbs |
| `autoDbInstrumentation` | `boolean` | no | `true` | Auto-wrap `pg` and `mysql2` |
| `autoNodeErrorCapture` | `boolean` | no | `true` | Hook `uncaughtException` / `unhandledRejection` |
| `maxBreadcrumbs` | `number` | no | `50` | Ring buffer size |

## Example Usage

Capture an exception with context:

```ts
AllStak.captureException(new Error('Payment failed'), { orderId: 'ORD-42' });
```

Send a structured log:

```ts
AllStak.captureMessage('User signed up', 'info');
```

Set user and tags:

```ts
AllStak.setUser({ id: 'u_123', email: 'alice@example.com' });
AllStak.setTag('region', 'eu-west-1');
```

Send a cron heartbeat:

```ts
AllStak.heartbeat({ slug: 'daily-report', status: 'ok', durationMs: 1234 });
```

## Production Endpoint

Production endpoint: `https://api.allstak.sa`. To point at a self-hosted deployment, pass `host`:

```ts
AllStak.init({ apiKey: '...', host: 'https://allstak.mycorp.com' });
```

## Links

- Documentation: https://docs.allstak.sa
- Dashboard: https://app.allstak.sa
- Source: https://github.com/allstak-io/allstak-js

## License

MIT © AllStak
