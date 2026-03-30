/**
 * AllStak SDK End-to-End Test Suite
 *
 * Tests ALL SDK features against a real running backend.
 * API Key: sk_4f53a969-4f5e-4403-a0df-ea54596661f0
 * Base URL: http://localhost:8080
 */

const BASE_URL = 'http://localhost:8080';
const API_KEY = 'ask_9c3775eab9264e9aa4048b7bafc1c512';
const PROJECT_ID = 'c1a88f24-29df-4066-b607-a32e43bfa775';

// Get JWT token for query APIs (they use Bearer auth, not API key)
const KEYCLOAK_URL = 'http://localhost:8180';

let JWT_TOKEN = '';
const results = [];

function log(msg) { console.log(`  ${msg}`); }
function pass(test) { results.push({ test, status: 'PASS' }); console.log(`  ✅ ${test}`); }
function fail(test, err) { results.push({ test, status: 'FAIL', error: String(err) }); console.log(`  ❌ ${test}: ${err}`); }

// ─────────────────────────────────────────────────
// Helper: Make API request with API key (ingest)
// ─────────────────────────────────────────────────
async function ingestPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AllStak-Key': API_KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, ok: res.ok };
}

// ─────────────────────────────────────────────────
// Helper: Make API request with JWT (query)
// ─────────────────────────────────────────────────
async function apiGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${JWT_TOKEN}`,
      'Accept': 'application/json',
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, ok: res.ok };
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${JWT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, ok: res.ok };
}

async function apiDelete(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${JWT_TOKEN}`,
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, ok: res.ok };
}

// ─────────────────────────────────────────────────
// Step 0: Authenticate
// ─────────────────────────────────────────────────
async function authenticate() {
  console.log('\n═══ STEP 0: Authentication ═══');
  try {
    const res = await fetch(`${KEYCLOAK_URL}/realms/allstak/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'allstak-web',
        username: 'test@allstak.io',
        password: 'Test1234!',
      }),
    });
    const data = await res.json();
    if (!data.access_token) throw new Error('No access_token in response');
    JWT_TOKEN = data.access_token;
    pass('Keycloak authentication');
    return true;
  } catch (err) {
    fail('Keycloak authentication', err);
    return false;
  }
}

// ─────────────────────────────────────────────────
// Step 1: Test Error Ingestion (SDK path)
// ─────────────────────────────────────────────────
async function testErrorIngestion() {
  console.log('\n═══ STEP 1: Error Ingestion ═══');

  // Test 1a: Send an error
  const errorPayload = {
    exceptionClass: 'SDKTestError',
    message: 'SDK test: null pointer in user service',
    stackTrace: [
      'at UserService.getProfile (UserService.js:42)',
      'at Router.handle (router.js:88)',
    ],
    level: 'error',
    environment: 'test',
    metadata: { sdk: 'allstak-js', version: '0.1.0' },
  };

  const res = await ingestPost('/ingest/v1/errors', errorPayload);
  if (res.ok) {
    pass(`Error ingestion (status: ${res.status})`);
    log(`Response: ${JSON.stringify(res.data)}`);
  } else {
    fail(`Error ingestion`, `status=${res.status} body=${JSON.stringify(res.data)}`);
  }

  // Test 1b: Send a message-level event
  const msgPayload = {
    exceptionClass: 'Message',
    message: 'SDK test: deployment completed',
    level: 'info',
    environment: 'test',
  };

  const res2 = await ingestPost('/ingest/v1/errors', msgPayload);
  if (res2.ok) {
    pass(`Message ingestion (status: ${res2.status})`);
  } else {
    fail(`Message ingestion`, `status=${res2.status}`);
  }

  // Test 1c: Verify errors appear in query API
  await new Promise(r => setTimeout(r, 1000)); // wait for processing
  const queryRes = await apiGet('/api/v1/errors', { projectId: PROJECT_ID, page: 1, perPage: 50 });
  if (queryRes.ok) {
    const items = queryRes.data?.data?.items ?? queryRes.data?.items ?? [];
    pass(`Query errors API (status: ${queryRes.status}, count: ${items.length})`);
    if (items.length > 0) {
      const first = items[0];
      log(`First error: ${first.exceptionClass} — ${first.title || first.message}`);
      // Validate structure
      const requiredFields = ['id', 'exceptionClass', 'status', 'occurrences'];
      const missing = requiredFields.filter(f => !(f in first));
      if (missing.length > 0) {
        fail('Error response structure', `Missing fields: ${missing.join(', ')}`);
      } else {
        pass('Error response structure validated');
      }
    }
  } else {
    fail(`Query errors API`, `status=${queryRes.status}`);
  }
}

// ─────────────────────────────────────────────────
// Step 2: Test Log Ingestion
// ─────────────────────────────────────────────────
async function testLogIngestion() {
  console.log('\n═══ STEP 2: Log Ingestion ═══');

  const levels = ['debug', 'info', 'warn', 'error'];
  for (const level of levels) {
    const payload = {
      level,
      message: `SDK test log [${level}]: system check at ${new Date().toISOString()}`,
      service: 'sdk-test',
      metadata: { test: true, level },
    };
    const res = await ingestPost('/ingest/v1/logs', payload);
    if (res.ok) {
      pass(`Log ingestion [${level}] (status: ${res.status})`);
    } else {
      fail(`Log ingestion [${level}]`, `status=${res.status} body=${JSON.stringify(res.data)}`);
    }
  }

  // Query logs
  await new Promise(r => setTimeout(r, 1000));
  const queryRes = await apiGet('/api/v1/logs', { projectId: PROJECT_ID, page: 1, perPage: 50, timeRange: '1h' });
  if (queryRes.ok) {
    const items = queryRes.data?.data?.items ?? queryRes.data?.items ?? [];
    pass(`Query logs API (status: ${queryRes.status}, count: ${items.length})`);
    if (items.length > 0) {
      const first = items[0];
      const requiredFields = ['id', 'level', 'message', 'timestamp'];
      const missing = requiredFields.filter(f => !(f in first));
      if (missing.length > 0) {
        fail('Log response structure', `Missing fields: ${missing.join(', ')}`);
      } else {
        pass('Log response structure validated');
      }
    }
  } else {
    fail(`Query logs API`, `status=${queryRes.status}`);
  }
}

// ─────────────────────────────────────────────────
// Step 3: Test HTTP Requests
// ─────────────────────────────────────────────────
async function testHttpRequests() {
  console.log('\n═══ STEP 3: HTTP Requests ═══');

  // Test 3a: Ingest an HTTP request trace
  const reqPayload = {
    projectId: PROJECT_ID,
    requests: [{
      traceId: 'trace-sdk-test-001',
      direction: 'inbound',
      method: 'GET',
      host: 'api.example.com',
      path: '/api/users/123',
      statusCode: 200,
      durationMs: 145,
      requestSize: 0,
      responseSize: 512,
      userId: 'user-42',
      timestamp: new Date().toISOString(),
    }],
  };

  const ingestRes = await ingestPost('/ingest/v1/http-requests', reqPayload);
  log(`Ingest HTTP request: status=${ingestRes.status} body=${JSON.stringify(ingestRes.data)}`);
  if (ingestRes.ok) {
    pass(`HTTP request ingestion (status: ${ingestRes.status})`);
  } else {
    fail(`HTTP request ingestion`, `status=${ingestRes.status}`);
  }

  // Test 3b: Query HTTP requests list
  const listRes = await apiGet('/api/v1/http-requests', { projectId: PROJECT_ID });
  log(`Query HTTP requests: status=${listRes.status}`);
  if (listRes.ok) {
    const items = listRes.data?.data?.items ?? listRes.data?.items ?? [];
    pass(`Query HTTP requests API (status: ${listRes.status}, count: ${items.length})`);
  } else if (listRes.status === 404) {
    fail('Query HTTP requests API', 'ENDPOINT NOT FOUND (404) — backend module not registered');
  } else {
    fail(`Query HTTP requests API`, `status=${listRes.status}`);
  }

  // Test 3c: Query HTTP request stats
  const statsRes = await apiGet('/api/v1/http-requests/stats', { projectId: PROJECT_ID });
  log(`HTTP request stats: status=${statsRes.status}`);
  if (statsRes.ok) {
    pass(`HTTP request stats API (status: ${statsRes.status})`);
    log(`Stats: ${JSON.stringify(statsRes.data)}`);
  } else if (statsRes.status === 404) {
    fail('HTTP request stats API', 'ENDPOINT NOT FOUND (404)');
  } else {
    fail(`HTTP request stats API`, `status=${statsRes.status}`);
  }

  // Test 3d: Query top hosts
  const hostsRes = await apiGet('/api/v1/http-requests/top-hosts', { projectId: PROJECT_ID });
  log(`Top hosts: status=${hostsRes.status}`);
  if (hostsRes.ok) {
    pass(`Top hosts API (status: ${hostsRes.status})`);
  } else if (hostsRes.status === 404) {
    fail('Top hosts API', 'ENDPOINT NOT FOUND (404)');
  } else {
    fail(`Top hosts API`, `status=${hostsRes.status}`);
  }
}

// ─────────────────────────────────────────────────
// Step 4: Test Monitors
// ─────────────────────────────────────────────────
async function testMonitors() {
  console.log('\n═══ STEP 4: Monitors ═══');

  // List monitors
  const listRes = await apiGet('/api/v1/monitors', { projectId: PROJECT_ID });
  if (listRes.ok) {
    const items = listRes.data?.data?.items ?? listRes.data?.items ?? listRes.data?.data ?? [];
    pass(`List monitors (status: ${listRes.status}, count: ${Array.isArray(items) ? items.length : '?'})`);
  } else {
    fail(`List monitors`, `status=${listRes.status}`);
  }

  // Create a monitor
  const createRes = await apiPost('/api/v1/monitors', {
    projectId: PROJECT_ID,
    name: 'SDK Test Monitor',
    url: 'https://httpstat.us/200',
    intervalMinutes: 5,
  });
  let monitorId = null;
  if (createRes.ok || createRes.status === 201) {
    monitorId = createRes.data?.data?.id ?? createRes.data?.id;
    pass(`Create monitor (status: ${createRes.status}, id: ${monitorId})`);
  } else {
    fail(`Create monitor`, `status=${createRes.status} body=${JSON.stringify(createRes.data)}`);
  }

  // Delete the test monitor (cleanup)
  if (monitorId) {
    const delRes = await apiDelete(`/api/v1/monitors/${monitorId}`, { projectId: PROJECT_ID });
    if (delRes.ok || delRes.status === 204) {
      pass(`Delete monitor (status: ${delRes.status})`);
    } else {
      fail(`Delete monitor`, `status=${delRes.status}`);
    }
  }
}

// ─────────────────────────────────────────────────
// Step 5: Test SSH Servers
// ─────────────────────────────────────────────────
async function testSSH() {
  console.log('\n═══ STEP 5: SSH Servers ═══');

  const listRes = await apiGet('/api/v1/ssh/servers', { projectId: PROJECT_ID });
  if (listRes.ok) {
    const items = listRes.data?.data ?? listRes.data ?? [];
    pass(`List SSH servers (status: ${listRes.status}, count: ${Array.isArray(items) ? items.length : '?'})`);
  } else {
    fail(`List SSH servers`, `status=${listRes.status}`);
  }
}

// ─────────────────────────────────────────────────
// Step 6: Test Chat
// ─────────────────────────────────────────────────
async function testChat() {
  console.log('\n═══ STEP 6: Chat ═══');

  // List channels
  const orgRes = await apiGet('/api/v1/organizations');
  // Raw response: {success, data: {items: [...], pagination: {...}}}
  const orgs = orgRes.data?.data?.items ?? orgRes.data?.items ?? orgRes.data?.data ?? [];
  const orgId = Array.isArray(orgs) ? orgs[0]?.id : null;
  if (!orgId) {
    fail('Get org for chat', 'No org found');
    return;
  }

  const channelsRes = await apiGet('/api/v1/chat/channels', { orgId });
  if (channelsRes.ok) {
    const channels = channelsRes.data?.data ?? channelsRes.data ?? [];
    pass(`List chat channels (status: ${channelsRes.status}, count: ${Array.isArray(channels) ? channels.length : '?'})`);

    if (Array.isArray(channels) && channels.length > 0) {
      const channelId = channels[0].id;

      // Fetch messages
      const msgsRes = await apiGet(`/api/v1/chat/channels/${channelId}/messages`);
      if (msgsRes.ok) {
        const msgs = msgsRes.data?.data ?? msgsRes.data ?? [];
        pass(`Fetch channel messages (status: ${msgsRes.status}, count: ${Array.isArray(msgs) ? msgs.length : '?'})`);
      } else {
        fail(`Fetch channel messages`, `status=${msgsRes.status}`);
      }

      // Send a message
      const sendRes = await apiPost(`/api/v1/chat/channels/${channelId}/messages`, {
        content: 'SDK test message from allstak-js test suite',
      });
      if (sendRes.ok || sendRes.status === 201) {
        pass(`Send chat message (status: ${sendRes.status})`);
      } else {
        fail(`Send chat message`, `status=${sendRes.status} body=${JSON.stringify(sendRes.data)}`);
      }
    }
  } else {
    fail(`List chat channels`, `status=${channelsRes.status}`);
  }
}

// ─────────────────────────────────────────────────
// Step 7: Test Alerts
// ─────────────────────────────────────────────────
async function testAlerts() {
  console.log('\n═══ STEP 7: Alerts ═══');

  const listRes = await apiGet('/api/v1/alerts', { projectId: PROJECT_ID });
  log(`Alerts endpoint: status=${listRes.status}`);
  if (listRes.ok) {
    pass(`List alerts (status: ${listRes.status})`);
  } else if (listRes.status === 404) {
    fail('List alerts', 'ENDPOINT NOT FOUND (404) — backend not implemented');
  } else {
    fail(`List alerts`, `status=${listRes.status}`);
  }
}

// ─────────────────────────────────────────────────
// Step 8: Test Auth Edge Cases
// ─────────────────────────────────────────────────
async function testAuth() {
  console.log('\n═══ STEP 8: Auth Edge Cases ═══');

  // Test with invalid API key
  const badRes = await fetch(`${BASE_URL}/ingest/v1/errors`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AllStak-Key': 'invalid-key-12345',
    },
    body: JSON.stringify({ exceptionClass: 'Test', message: 'test', level: 'error' }),
  });
  if (badRes.status === 401 || badRes.status === 403) {
    pass(`Invalid API key rejected (status: ${badRes.status})`);
  } else {
    fail(`Invalid API key handling`, `Expected 401/403, got ${badRes.status}`);
  }

  // Test with no auth
  const noAuthRes = await fetch(`${BASE_URL}/api/v1/errors?projectId=${PROJECT_ID}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (noAuthRes.status === 401) {
    pass(`No auth rejected (status: ${noAuthRes.status})`);
  } else {
    fail(`No auth handling`, `Expected 401, got ${noAuthRes.status}`);
  }
}

// ─────────────────────────────────────────────────
// Step 9: Test SDK import and initialization
// ─────────────────────────────────────────────────
async function testSDKInit() {
  console.log('\n═══ STEP 9: SDK Import & Init ═══');

  try {
    const sdk = await import('../dist/node/index.mjs');
    const AllStak = sdk.AllStak;

    if (!AllStak) {
      fail('SDK import', 'AllStak not found in exports');
      return;
    }
    pass('SDK import successful');

    // Init
    const client = AllStak.init({
      dsn: `http://ask_9c3775eab9264e9aa4048b7bafc1c512@localhost:8080`,
      environment: 'sdk-test',
      release: '0.1.0-test',
    });
    pass('SDK init successful');

    // Set user
    AllStak.setUser({ id: 'sdk-user-1', email: 'sdk@test.com' });
    pass('setUser works');

    // Set tag
    AllStak.setTag('test', 'true');
    pass('setTag works');

    // Get session ID
    const sessionId = AllStak.getSessionId();
    if (sessionId && sessionId.length > 0) {
      pass(`getSessionId works (${sessionId})`);
    } else {
      fail('getSessionId', 'Empty session ID');
    }

    // Capture exception
    try {
      AllStak.captureException(new Error('SDK init test error'));
      pass('captureException works');
    } catch (err) {
      fail('captureException', err);
    }

    // Capture message
    try {
      AllStak.captureMessage('SDK init test message', 'info');
      pass('captureMessage works');
    } catch (err) {
      fail('captureMessage', err);
    }

    // Log methods
    try {
      AllStak.log.info('SDK test log info', { test: true });
      AllStak.log.warn('SDK test log warn');
      AllStak.log.error('SDK test log error');
      AllStak.log.debug('SDK test log debug');
      AllStak.log.fatal('SDK test log fatal');
      pass('All log methods work (debug/info/warn/error/fatal)');
    } catch (err) {
      fail('Log methods', err);
    }

    // captureRequest
    try {
      AllStak.captureRequest({
        direction: 'inbound',
        method: 'GET',
        host: 'localhost',
        path: '/health',
        statusCode: 200,
        durationMs: 12,
      });
      pass('captureRequest works');
    } catch (err) {
      fail('captureRequest', err);
    }

    // heartbeat
    try {
      AllStak.heartbeat({ slug: 'sdk-test-job', status: 'success', durationMs: 100 });
      pass('heartbeat works');
    } catch (err) {
      fail('heartbeat', err);
    }

    // Wait for sends to complete
    await new Promise(r => setTimeout(r, 3000));

    // Destroy
    AllStak.destroy();
    pass('SDK destroy works');

  } catch (err) {
    fail('SDK import/init', err);
  }
}

// ─────────────────────────────────────────────────
// Main runner
// ─────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  AllStak SDK End-to-End Validation Suite     ║');
  console.log('╚══════════════════════════════════════════════╝');

  const authed = await authenticate();
  if (!authed) {
    console.log('\n⛔ Cannot proceed without authentication');
    process.exit(1);
  }

  await testSDKInit();
  await testErrorIngestion();
  await testLogIngestion();
  await testHttpRequests();
  await testMonitors();
  await testSSH();
  await testChat();
  await testAlerts();
  await testAuth();

  // ─── Final Report ───
  console.log('\n\n╔══════════════════════════════════════════════╗');
  console.log('║  FINAL REPORT                                ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : '❌';
    console.log(`${icon} ${r.test}${r.error ? ` — ${r.error}` : ''}`);
  }

  console.log(`\n─── ${passed} PASSED, ${failed} FAILED out of ${results.length} tests ───`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ❌ ${r.test}: ${r.error}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
