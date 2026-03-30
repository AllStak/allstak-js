/**
 * AllStak JS SDK — Node.js Real Integration Example
 *
 * Demonstrates real SDK usage in a backend/service context:
 * - Error capture + auto-capture
 * - All log levels
 * - HTTP request tracing
 * - Cron heartbeat (success + failure)
 * - User context, tags, environment
 *
 * Run: node examples/node-app/index.mjs
 */

import { AllStak } from '../../dist/node/index.mjs';

const DSN = 'http://ask_9c3775eab9264e9aa4048b7bafc1c512@localhost:8080';
const PROJECT_ENV = 'node-example';

// ── Init ──────────────────────────────────────────────────────────────────
AllStak.init({
  dsn: DSN,
  environment: PROJECT_ENV,
  release: '1.0.0',
  tags: {
    service: 'allstak-node-example',
    framework: 'node',
  },
});

AllStak.setUser({ id: 'node-user-1', email: 'backend@allstak.io' });
AllStak.setTag('region', 'us-east-1');

const sessionId = AllStak.getSessionId();
console.log(`[AllStak] Session: ${sessionId}`);
console.log(`[AllStak] Environment: ${PROJECT_ENV}\n`);

// ── Helper ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function printSection(title) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(50));
}

// ── 1. Logs ───────────────────────────────────────────────────────────────
printSection('1. LOG LEVELS');

AllStak.log.debug('App starting up', { pid: process.pid, nodeVersion: process.version });
console.log('  ✓ log.debug sent');

AllStak.log.info('Server listening on port 4000', { port: 4000, host: '0.0.0.0' });
console.log('  ✓ log.info sent');

AllStak.log.warn('Memory usage high', { heapUsed: 450, heapTotal: 512, unit: 'MB' });
console.log('  ✓ log.warn sent');

AllStak.log.error('Database connection refused', {
  host: 'db.internal',
  port: 5432,
  retryCount: 3,
  error: 'ECONNREFUSED',
});
console.log('  ✓ log.error sent');

AllStak.log.fatal('Out of disk space — halting writes', {
  diskPath: '/var/data',
  freeBytes: 0,
  totalBytes: 107374182400,
});
console.log('  ✓ log.fatal sent');

// ── 2. Error Capture ──────────────────────────────────────────────────────
printSection('2. ERROR CAPTURE');

// Explicit exception
try {
  const data = null;
  console.log(data.nonExistent); // throws
} catch (err) {
  AllStak.captureException(err, {
    route: '/api/users',
    userId: 'node-user-1',
    action: 'read_profile',
  });
  console.log('  ✓ captureException sent (TypeError)');
}

// Custom error
class DatabaseError extends Error {
  constructor(message, query) {
    super(message);
    this.name = 'DatabaseError';
    this.query = query;
  }
}
try {
  throw new DatabaseError('Query timeout after 30s', 'SELECT * FROM events WHERE ...');
} catch (err) {
  AllStak.captureException(err, { query: err.query, timeout: 30000, db: 'postgres' });
  console.log('  ✓ captureException sent (DatabaseError)');
}

// Message-level events
AllStak.captureMessage('Scheduled maintenance starting in 5 minutes', 'warning');
console.log('  ✓ captureMessage (warning)');

AllStak.captureMessage('Deploy completed: v1.0.0 → v1.1.0', 'info');
console.log('  ✓ captureMessage (info)');

// ── 3. HTTP Request Tracing ───────────────────────────────────────────────
printSection('3. HTTP REQUEST TRACING');

// Simulate several inbound requests
const requests = [
  { method: 'GET', path: '/api/users', statusCode: 200, durationMs: 45, direction: 'inbound' },
  { method: 'POST', path: '/api/orders', statusCode: 201, durationMs: 312, direction: 'inbound' },
  { method: 'DELETE', path: '/api/sessions/abc123', statusCode: 204, durationMs: 12, direction: 'inbound' },
  { method: 'GET', path: '/api/products/999', statusCode: 404, durationMs: 8, direction: 'inbound' },
  { method: 'POST', path: '/api/checkout', statusCode: 500, durationMs: 2100, direction: 'inbound' },
];

for (const req of requests) {
  AllStak.captureRequest({
    direction: req.direction,
    method: req.method,
    host: 'api.allstak-node-example.com',
    path: req.path,
    statusCode: req.statusCode,
    durationMs: req.durationMs,
    userId: 'node-user-1',
  });
}
console.log(`  ✓ ${requests.length} inbound requests captured`);

// Simulate outbound requests (downstream API calls)
const outbound = [
  { method: 'POST', path: '/v1/send', host: 'email.sendgrid.com', statusCode: 202, durationMs: 180 },
  { method: 'GET', path: '/v3/charges/ch_123', host: 'api.stripe.com', statusCode: 200, durationMs: 220 },
  { method: 'POST', path: '/sms', host: 'api.twilio.com', statusCode: 201, durationMs: 440 },
];

for (const req of outbound) {
  AllStak.captureRequest({
    direction: 'outbound',
    method: req.method,
    host: req.host,
    path: req.path,
    statusCode: req.statusCode,
    durationMs: req.durationMs,
    traceId: `trace-node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
}
console.log(`  ✓ ${outbound.length} outbound requests captured`);

// ── 4. Cron Heartbeats ────────────────────────────────────────────────────
printSection('4. CRON HEARTBEATS');

// Simulate a successful cron job
async function runSuccessfulJob() {
  console.log('  Running daily-report job...');
  const start = Date.now();
  await sleep(200); // simulate work
  AllStak.heartbeat({
    slug: 'daily-report',
    status: 'success',
    durationMs: Date.now() - start,
    message: 'Generated 142 rows, exported to S3',
  });
  console.log('  ✓ heartbeat sent: daily-report (success)');
}

// Simulate a failed cron job
async function runFailedJob() {
  console.log('  Running db-backup job...');
  const start = Date.now();
  await sleep(100); // simulate partial work
  AllStak.heartbeat({
    slug: 'db-backup',
    status: 'failed',
    durationMs: Date.now() - start,
    message: 'S3 upload failed: AccessDenied on bucket allstak-backups',
  });
  console.log('  ✓ heartbeat sent: db-backup (failed)');
}

// Simulate more jobs
async function runCleanupJob() {
  const start = Date.now();
  await sleep(50);
  AllStak.heartbeat({
    slug: 'cleanup-old-sessions',
    status: 'success',
    durationMs: Date.now() - start,
    message: 'Deleted 2,841 expired sessions',
  });
  console.log('  ✓ heartbeat sent: cleanup-old-sessions (success)');
}

async function runSyncJob() {
  const start = Date.now();
  await sleep(75);
  AllStak.heartbeat({
    slug: 'sync-analytics',
    status: 'success',
    durationMs: Date.now() - start,
    message: 'Synced 15,432 events to ClickHouse',
  });
  console.log('  ✓ heartbeat sent: sync-analytics (success)');
}

await runSuccessfulJob();
await runFailedJob();
await runCleanupJob();
await runSyncJob();

// ── 5. Context Updates ────────────────────────────────────────────────────
printSection('5. CONTEXT UPDATES');

// Update user context mid-session
AllStak.setUser({ id: 'node-user-2', email: 'admin@allstak.io' });
AllStak.setTag('role', 'admin');
AllStak.log.info('Admin action performed', { action: 'flush_cache', target: 'redis' });
console.log('  ✓ context updated + info log sent');

// ── 6. Batch flush — wait for HTTP flush interval ─────────────────────────
printSection('6. FLUSHING HTTP REQUEST BATCH');
console.log('  Waiting 6s for HTTP request batch to flush...');
await sleep(6000);
console.log('  ✓ HTTP request batch flushed');

// ── Cleanup ───────────────────────────────────────────────────────────────
AllStak.destroy();
console.log('\n[AllStak] SDK destroyed, all remaining events flushed.');
console.log('\n✅ Node.js example complete. Check the AllStak dashboard.');
