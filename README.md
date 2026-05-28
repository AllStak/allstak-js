# @allstak/js

AllStak JavaScript SDK for Node.js, Express, browser apps, React helpers, Vite, Webpack, Next.js, logs, request telemetry, spans, and source maps.

## Install

```bash
npm install @allstak/js
```

Create a project in [app.allstak.sa](https://app.allstak.sa), copy the project API key, and expose it to your app:

```bash
export ALLSTAK_API_KEY=ask_live_xxx
export ALLSTAK_RELEASE=my-service@1.0.0
```

## Node.js

```ts
import { AllStak } from '@allstak/js';

AllStak.init({
  apiKey: process.env.ALLSTAK_API_KEY!,
  environment: process.env.NODE_ENV ?? 'production',
  release: process.env.ALLSTAK_RELEASE,
  tags: { service: 'worker' },
});

AllStak.logger.info('worker started');

await AllStak.trace('jobs.send-email', async () => {
  // your work here
});

try {
  throw new Error('payment failed');
} catch (error) {
  AllStak.captureException(error as Error);
}

await AllStak.flush();
```

## Express

```ts
import express from 'express';
import { AllStak } from '@allstak/js';
import { allstakExpress } from '@allstak/js/express';

AllStak.init({
  apiKey: process.env.ALLSTAK_API_KEY!,
  environment: process.env.NODE_ENV ?? 'production',
  release: process.env.ALLSTAK_RELEASE,
  tags: { service: 'api' },
  httpBodyCapture: {
    request: true,
    response: true,
  },
});

const app = express();
app.use(express.json());
app.use(allstakExpress.requestHandler());

app.post('/checkout', async (_req, res) => {
  res.json({ ok: true });
});

app.use(allstakExpress.errorHandler());
app.listen(3000);
```

## Browser

```ts
import AllStak from '@allstak/js/browser';

AllStak.init({
  apiKey: import.meta.env.VITE_ALLSTAK_API_KEY,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_ALLSTAK_RELEASE,
  autoBreadcrumbs: true,
});
```

## React helpers

`@allstak/js/react` provides lightweight helpers when you want to keep the core JS package:

```tsx
import { AllStakErrorBoundary } from '@allstak/js/react';

export function App() {
  return (
    <AllStakErrorBoundary fallback={<p>Something went wrong.</p>}>
      <AppRoot />
    </AllStakErrorBoundary>
  );
}
```

For the full React provider API, install `@allstak/react`.

## Vite source maps

```ts
import { defineConfig } from 'vite';
import { allstakVitePlugin } from '@allstak/js/vite';

export default defineConfig({
  build: { sourcemap: true },
  plugins: [
    allstakVitePlugin({
      release: process.env.ALLSTAK_RELEASE,
      uploadToken: process.env.ALLSTAK_UPLOAD_TOKEN,
    }),
  ],
});
```

## Next.js source maps

```js
const { withAllStak } = require('@allstak/js/next');

module.exports = withAllStak({
  release: process.env.ALLSTAK_RELEASE,
  uploadToken: process.env.ALLSTAK_UPLOAD_TOKEN,
}, {
  reactStrictMode: true,
});
```

## Useful API

```ts
AllStak.captureException(error);
AllStak.captureMessage('deploy started', 'info');
AllStak.logger.warn('payment retry', { orderId: 'ord_123' });
AllStak.setUser({ id: 'user_123', email: 'user@example.com' });
AllStak.setTag('region', 'me-central-1');
AllStak.startSpan('checkout.authorize').finish('ok');
await AllStak.flush();
```

## Configuration

| Option | Description |
| --- | --- |
| `apiKey` | Project API key from AllStak. |
| `environment` | Deployment environment, for example `production` or `staging`. |
| `release` | App version, commit SHA, or build identifier. |
| `tags` | Tags added to every event. Use `tags.service` for service filtering. |
| `sampleRate` | Error sample rate from `0` to `1`. |
| `tracesSampleRate` | Span sample rate from `0` to `1`. |
| `httpBodyCapture` | Enables request and response body capture with redaction. |
| `beforeSend` | Optional hook to modify or drop error events before sending. |

## Privacy

The SDK redacts common sensitive fields such as authorization headers, cookies, passwords, tokens, secrets, and API keys. Keep secrets out of custom metadata and use `beforeSend` for app-specific redaction.

## Troubleshooting

- No events: confirm `ALLSTAK_API_KEY` is set and the project is active.
- Minified stack traces: set the same `release` in the SDK and source-map upload plugin.
- App shutdown: call `await AllStak.flush()` before a short-lived process exits.
- Browser requests blocked: allow `https://api.allstak.sa` in your content security policy.

## Contributing and Support

- Report bugs with the GitHub bug report template: https://github.com/AllStak/allstak-js/issues/new/choose
- Open pull requests using the checklist in [CONTRIBUTING.md](CONTRIBUTING.md).
- Report security vulnerabilities privately through [SECURITY.md](SECURITY.md).

## License

MIT
