# @allstak/js

Official AllStak JavaScript SDK for Node.js, Express, browser apps, React, Vite, and Next.js.

It captures errors, structured logs, inbound and outbound HTTP requests, request and response metadata, distributed traces, spans, database queries, source maps, and cron heartbeats.

## Install

```bash
npm install @allstak/js
```

Production ingest is used by default:

```text
https://api.allstak.sa
```

Create a project in [app.allstak.sa](https://app.allstak.sa), copy the project API key, and expose it as an environment variable:

```bash
export ALLSTAK_API_KEY=ask_live_xxx
```

## Node.js

Use this for scripts, workers, queues, CLIs, and any plain Node.js service.

```ts
import { AllStak } from '@allstak/js';

AllStak.init({
  apiKey: process.env.ALLSTAK_API_KEY!,
  environment: 'production',
  release: 'my-service@1.0.0',
  tags: {
    service: 'my-service',
  },
});

AllStak.logger.info('worker started');

await AllStak.trace('jobs.send-email', async () => {
  // your work here
});

try {
  throw new Error('example failure');
} catch (error) {
  AllStak.captureException(error as Error);
}

await AllStak.flush();
```

## Express

Mount the request handler before routes and the error handler after routes.

```ts
import express from 'express';
import { AllStak } from '@allstak/js';
import { allstakExpress } from '@allstak/js/express';

AllStak.init({
  apiKey: process.env.ALLSTAK_API_KEY!,
  environment: 'production',
  release: 'api@1.0.0',
  tags: {
    service: 'api',
  },
  httpBodyCapture: {
    request: true,
    response: true,
  },
});

const app = express();

app.use(express.json());
app.use(allstakExpress.requestHandler());

app.get('/health', (_req, res) => {
  AllStak.logger.info('health checked');
  res.json({ ok: true });
});

app.post('/checkout', async (_req, res) => {
  await AllStak.trace('payments.authorize', async () => {
    AllStak.logger.info('authorizing payment');
  });

  res.status(201).json({ status: 'created' });
});

app.get('/boom', () => {
  throw new Error('checkout failed');
});

app.use(allstakExpress.errorHandler());

app.listen(3000);
```

This automatically links the request, root span, logs, and captured errors through the same trace and request IDs.

## Browser

Use this in a plain browser app.

```html
<script type="module">
  import { AllStak } from 'https://esm.sh/@allstak/js/browser';

  AllStak.init({
    apiKey: 'ask_live_xxx',
    environment: 'production',
    release: 'web@1.0.0',
    tracePropagationTargets: [/^https:\/\/api\.allstak\.sa/, /^https:\/\/api\.example\.com/],
  });

  AllStak.logger.info('browser app loaded');

  try {
    throw new Error('browser smoke error');
  } catch (error) {
    AllStak.captureException(error);
  }

  await AllStak.flush();
</script>
```

For production web apps, prefer loading the package through your bundler instead of a CDN URL.

## React

Wrap your app with `AllStakErrorBoundary` and initialize once at startup.

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { AllStak } from '@allstak/js/browser';
import { AllStakErrorBoundary } from '@allstak/js/react';
import App from './App';

AllStak.init({
  apiKey: import.meta.env.VITE_ALLSTAK_API_KEY,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_RELEASE,
  tracePropagationTargets: [/^https:\/\/api\.example\.com/],
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AllStakErrorBoundary fallback={<div>Something went wrong.</div>}>
    <App />
  </AllStakErrorBoundary>,
);
```

Optional render profiling:

```tsx
import { withAllStakProfiler } from '@allstak/js/react';

export default withAllStakProfiler(App, { name: 'App' });
```

## Vite

Use the browser SDK at runtime and the Vite plugin for source maps.

```bash
npm install @allstak/js
```

```ts
// src/allstak.ts
import { AllStak } from '@allstak/js/browser';

AllStak.init({
  apiKey: import.meta.env.VITE_ALLSTAK_API_KEY,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_RELEASE,
  tracePropagationTargets: [/^https:\/\/api\.example\.com/],
});

export { AllStak };
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { allstakVitePlugin } from '@allstak/js/vite';

export default defineConfig({
  plugins: [
    react(),
    allstakVitePlugin({
      release: process.env.VITE_RELEASE ?? process.env.RELEASE ?? 'web@1.0.0',
      token: process.env.ALLSTAK_UPLOAD_TOKEN,
      dist: 'web',
    }),
  ],
  build: {
    sourcemap: true,
  },
});
```

## Next.js

Use the browser SDK in client components and the Next helper for browser source maps.

```js
// next.config.js
const { withAllStak } = require('@allstak/js/next');

module.exports = withAllStak(
  {
    release: process.env.NEXT_PUBLIC_RELEASE ?? process.env.RELEASE ?? 'web@1.0.0',
    token: process.env.ALLSTAK_UPLOAD_TOKEN,
    dist: 'web',
  },
  {
    reactStrictMode: true,
  },
);
```

```tsx
// app/allstak-client.tsx
'use client';

import { useEffect } from 'react';
import { AllStak } from '@allstak/js/browser';

export function AllStakClient() {
  useEffect(() => {
    AllStak.init({
      apiKey: process.env.NEXT_PUBLIC_ALLSTAK_API_KEY!,
      environment: process.env.NODE_ENV,
      release: process.env.NEXT_PUBLIC_RELEASE,
      tracePropagationTargets: [/^https:\/\/api\.example\.com/],
    });
  }, []);

  return null;
}
```

Add `<AllStakClient />` once in your root layout.

## Logs

```ts
AllStak.logger.debug('debug detail');
AllStak.logger.info('order created', { orderId: 'ord_123' });
AllStak.logger.warn('payment retrying');
AllStak.logger.error('payment failed');
AllStak.logger.fatal('worker cannot continue');
```

Logs created inside an Express request or active trace are automatically linked to the current request and span.

## Traces And Spans

```ts
await AllStak.trace('checkout.submit', async () => {
  const span = AllStak.startSpan('payments.authorize', {
    op: 'payments.authorize',
    attributes: {
      provider: 'primary',
    },
  });

  try {
    // call provider
    span.finish('ok');
  } catch (error) {
    span.finish('error');
    throw error;
  }
});
```

## Cron Heartbeats

```ts
await AllStak.heartbeat({
  slug: 'nightly-billing-sync',
  status: 'ok',
  durationMs: 1234,
});
```

## Configuration

| Option | Type | Required | Default | Description |
|---|---:|:---:|---|---|
| `apiKey` | `string` | yes | - | Project API key. |
| `environment` | `string` | no | auto | Deployment environment. |
| `release` | `string` | no | auto | App version, build ID, or git SHA. |
| `host` | `string` | no | `https://api.allstak.sa` | Ingest host override for self-hosted deployments. |
| `user` | `{ id?, email? }` | no | - | Default user context. |
| `tags` | `Record<string,string>` | no | - | Default tags on every event. |
| `autoBreadcrumbs` | `boolean` | no | `true` | Capture console and fetch breadcrumbs. |
| `autoDbInstrumentation` | `boolean` | no | `true` | Auto-instrument supported DB clients. |
| `autoNodeErrorCapture` | `boolean` | no | `true` | Capture uncaught exceptions and unhandled rejections in Node.js. |
| `httpBodyCapture` | `object` | no | off | Capture request and response bodies where supported. |
| `tracePropagationTargets` | `(string \\| RegExp)[]` | no | `[]` | Targets that should receive trace headers from browser fetch calls. |
| `maxBreadcrumbs` | `number` | no | `50` | Breadcrumb ring buffer size. |

## Source Maps

The Vite, Webpack, and Next helpers inject a debug ID into each browser bundle and matching `.map` file, then upload the source map to AllStak.

Required environment variable:

```bash
export ALLSTAK_UPLOAD_TOKEN=ast_upload_xxx
```

Manual source-map processing is also available:

```ts
import { processBuildOutput } from '@allstak/js/sourcemaps';

await processBuildOutput({
  dir: 'dist',
  release: process.env.RELEASE!,
  token: process.env.ALLSTAK_UPLOAD_TOKEN!,
  dist: 'web',
});
```

## Verify Locally

```bash
node -e "import('@allstak/js').then(async ({ AllStak }) => { AllStak.init({ apiKey: process.env.ALLSTAK_API_KEY, release: 'readme-smoke' }); AllStak.logger.info('readme smoke'); AllStak.captureException(new Error('readme smoke error')); console.log(await AllStak.flush()); })"
```

The event should appear in the dashboard within seconds.

## Publish

Before publishing, make sure npm is logged in with permission to publish `@allstak/js`:

```bash
npm whoami
```

One-command patch release:

```bash
pnpm run release:patch
```

That command:

1. Bumps the patch version in `package.json`.
2. Cleans `dist`.
3. Runs TypeScript checks.
4. Runs tests.
5. Builds the package.
6. Runs `npm pack --dry-run`.
7. Publishes to npm with public access.

To publish the current version without bumping:

```bash
pnpm run release:publish
```

## Links

- Documentation: https://docs.allstak.sa
- Dashboard: https://app.allstak.sa
- Source: https://github.com/AllStak/allstak-js

## License

MIT (c) AllStak
