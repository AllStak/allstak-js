# allstak-js

Official JavaScript/TypeScript SDK for the [AllStak](https://allstak.com) monitoring platform.

Covers: **Error Monitoring**, **Logs**, **HTTP Request Tracing**, **Cron Heartbeats**, and **Session Replay**.

## Installation

```bash
npm install allstak-js
# or
pnpm add allstak-js
```

## Quick Start

```typescript
import { AllStak } from 'allstak-js';

AllStak.init({
  dsn: 'https://YOUR_API_KEY@your-allstak-instance.com',
  environment: 'production',
  release: '1.0.0',
  sessionReplay: {
    enabled: true,
    maskAllInputs: true,
    sampleRate: 1.0,
  },
});
```

## API Reference

### Error Monitoring

```typescript
// Capture an exception
AllStak.captureException(new Error('Something broke'), {
  route: '/api/users',
});

// Capture a message
AllStak.captureMessage('Disk space low', 'warning');

// Auto-capture is enabled by default:
// - window.onerror
// - unhandledrejection
```

### Session Replay (Browser Only)

Session replay is automatically started when `sessionReplay.enabled` is `true` in the config. It records:

- DOM mutations
- Click events
- Scroll events
- Input events (masked when `maskAllInputs: true`)

Events are batched and uploaded every 10 seconds or when the buffer reaches 50 events.

### HTTP Request Tracing

```typescript
// Report an inbound or outbound HTTP request.
// Batches internally — flushes every 5s or when 20 items accumulate.
AllStak.captureRequest({
  direction: 'inbound',           // 'inbound' | 'outbound'
  method: 'GET',
  host: 'api.example.com',
  path: '/users/123',
  statusCode: 200,
  durationMs: 145,
  userId: 'user-42',              // optional
  traceId: 'my-trace-id',         // optional, auto-generated if omitted
});
```

### Cron Heartbeats

```typescript
// Report a cron job execution. The slug must match a monitor configured
// in the AllStak dashboard under Cron Monitors.
const start = Date.now();
try {
  await runDailyReport();
  AllStak.heartbeat({
    slug: 'daily-report',
    status: 'success',
    durationMs: Date.now() - start,
  });
} catch (err) {
  AllStak.heartbeat({
    slug: 'daily-report',
    status: 'failed',
    durationMs: Date.now() - start,
    message: err.message,
  });
}
```

### Logs

```typescript
AllStak.log.debug('Verbose debug info');
AllStak.log.info('User signed in', { userId: '42' });
AllStak.log.warn('Slow query detected', { duration: 3200 });
AllStak.log.error('Payment failed', { orderId: 'abc-123' });
AllStak.log.fatal('Database unreachable');
```

### User Context

```typescript
AllStak.setUser({ id: '123', email: 'user@example.com' });
AllStak.setTag('component', 'checkout');
```

### Cleanup

```typescript
AllStak.destroy();
```

## SDK Behavior

| Behavior | Value |
|----------|-------|
| Request timeout | 3000ms |
| Local buffer | Yes — queues events when offline |
| Retry strategy | Exponential backoff |
| Max retries | 3 |
| Backoff formula | `delay = 500ms * 2^attempt` |
| Buffer max size | 100 events (drops oldest) |

## Framework Usage

### React (Vite / CRA)

Create a singleton init file and import it once at the app entry point:

```typescript
// src/allstak.ts
import { AllStak } from 'allstak-js';

AllStak.init({
  dsn: 'https://YOUR_API_KEY@your-allstak-instance.com',
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_APP_VERSION,
  service: 'my-react-app',
  sessionReplay: { enabled: true, maskAllInputs: true, sampleRate: 1.0 },
});

export default AllStak;
```

```typescript
// src/main.tsx
import './allstak';   // initialise before rendering
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
```

Unhandled errors and promise rejections are captured automatically. Use the SDK anywhere in the app:

```typescript
import AllStak from './allstak';

// In an error boundary:
AllStak.captureException(error, { component: 'CheckoutForm' });

// In an API utility:
AllStak.captureRequest({ direction: 'outbound', method: 'POST',
  host: 'api.stripe.com', path: '/v1/charges', statusCode: 200, durationMs: 312 });
```

### Vanilla JS (ES Module)

```html
<script type="module">
  import { AllStak } from '/dist/browser/index.mjs';

  AllStak.init({
    dsn: 'https://YOUR_API_KEY@your-allstak-instance.com',
    environment: 'production',
    service: 'my-vanilla-app',
    sessionReplay: { enabled: true, maskAllInputs: true },
  });

  document.getElementById('pay-btn').addEventListener('click', async () => {
    const t0 = Date.now();
    try {
      const res = await fetch('/api/payment', { method: 'POST', body: JSON.stringify(cart) });
      AllStak.captureRequest({
        direction: 'inbound', method: 'POST', host: location.hostname,
        path: '/api/payment', statusCode: res.status, durationMs: Date.now() - t0,
      });
    } catch (err) {
      AllStak.captureException(err);
    }
  });
</script>
```

When using a local dev server, ensure the server root is the project root so that the SDK `dist/` path is accessible. See `examples/serve.mjs` for a minimal static server that handles this.

### Node.js (ESM)

```javascript
// server.mjs
import { AllStak } from 'allstak-js';

AllStak.init({
  dsn: 'https://YOUR_API_KEY@your-allstak-instance.com',
  environment: process.env.NODE_ENV ?? 'production',
  service: 'my-api-server',
});

// Express middleware — capture every inbound request
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    AllStak.captureRequest({
      direction: 'inbound',
      method: req.method,
      host: req.hostname,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - t0,
      userId: req.user?.id,
    });
  });
  next();
});

// Cron job wrapper
async function runWithHeartbeat(slug, fn) {
  const t0 = Date.now();
  try {
    await fn();
    AllStak.heartbeat({ slug, status: 'success', durationMs: Date.now() - t0 });
  } catch (err) {
    AllStak.heartbeat({ slug, status: 'failed', durationMs: Date.now() - t0, message: err.message });
    throw err;
  }
}
```

Session replay is not included in the Node.js build (`dist/node/`).

## Development

```bash
pnpm install
pnpm build       # Produces dist/browser/ and dist/node/
pnpm test        # Runs all tests via Vitest
pnpm lint        # ESLint
pnpm format      # Prettier
```

## Build Outputs

- `dist/browser/` — Browser build (includes session replay)
- `dist/node/` — Node.js build (excludes session replay)

Both outputs include CJS, ESM, type declarations, and source maps.

## License

MIT
