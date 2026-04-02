# AllStak JS SDK — End-to-End Test Report

**Date:** 2026-03-30
**SDK Version:** 0.1.0
**Backend:** AllStak Backend (Docker, port 8080)
**Test Environment:** Local development stack

---

## Summary

| Category | Result |
|----------|--------|
| Unit tests | 34/34 ✅ |
| E2E tests | 33/34 ✅ (1 backend gap) |
| Build | ✅ browser + node dual build |
| Auth validation | ✅ |

---

## Unit Tests (34/34 PASS)

All 7 test files pass cleanly:

| File | Tests | Status |
|------|-------|--------|
| `tests/buffer.test.ts` | 5 | ✅ PASS |
| `tests/retry.test.ts` | 5 | ✅ PASS |
| `tests/errors.test.ts` | 6 | ✅ PASS |
| `tests/logs.test.ts` | 7 | ✅ PASS |
| `tests/session-replay.test.ts` | 4 | ✅ PASS |
| `tests/http-requests.test.ts` | 4 | ✅ PASS |
| `tests/cron.test.ts` | 3 | ✅ PASS |

**Key fixes applied during this phase:**
- Corrected URL expectations from `/api/v1/*/ingest` → `/ingest/v1/*`
- Fixed error payload assertions: `body.type` → `body.exceptionClass`, `body.stack` → `body.stackTrace`, `body.context`/`body.tags` → `body.metadata`
- Fixed log payload: removed `body.type`/`body.environment` (not in payload), `body.meta` → `body.metadata`
- Fixed auth header: `Authorization: Bearer` → `X-AllStak-Key`
- Fixed session replay payload: `e.type` → `e.eventType`, `e.data.value` → `JSON.parse(e.eventData).value`

---

## E2E Validation (33/34 PASS)

Run via `node test-app/sdk-test.mjs` against live Docker stack.

### Step 0: Authentication
| Test | Status |
|------|--------|
| Keycloak authentication (`test@allstak.io`) | ✅ PASS |

### Step 9: SDK Import & Initialization
| Test | Status | Notes |
|------|--------|-------|
| SDK import (ESM, Node.js dist) | ✅ PASS | `dist/node/index.mjs` |
| `AllStak.init()` | ✅ PASS | DSN parsed correctly |
| `setUser()` | ✅ PASS | |
| `setTag()` | ✅ PASS | |
| `getSessionId()` | ✅ PASS | Returns UUIDv4 |
| `captureException()` | ✅ PASS | |
| `captureMessage()` | ✅ PASS | |
| `log.debug/info/warn/error/fatal` | ✅ PASS | All 5 levels |
| `captureRequest()` | ✅ PASS | |
| `heartbeat()` | ✅ PASS | |
| `destroy()` | ✅ PASS | |

### Step 1: Error Ingestion
| Test | Status | Notes |
|------|--------|-------|
| `POST /ingest/v1/errors` (exception) | ✅ 202 | Returns `{ id }` |
| `POST /ingest/v1/errors` (message) | ✅ 202 | |
| `GET /api/v1/errors?projectId=...` | ✅ 200 | Returns paginated list |
| Error response structure | ✅ | Fields: `id`, `exceptionClass`, `status`, `occurrences` |

### Step 2: Log Ingestion
| Test | Status | Notes |
|------|--------|-------|
| `POST /ingest/v1/logs` (debug) | ✅ 202 | |
| `POST /ingest/v1/logs` (info) | ✅ 202 | |
| `POST /ingest/v1/logs` (warn) | ✅ 202 | |
| `POST /ingest/v1/logs` (error) | ✅ 202 | |
| `GET /api/v1/logs?projectId=...` | ✅ 200 | Returns 9 log items |
| Log response structure | ✅ | Fields: `id`, `level`, `message`, `timestamp` |

### Step 3: HTTP Requests
| Test | Status | Notes |
|------|--------|-------|
| `POST /ingest/v1/http-requests` | ✅ 202 | `{ ok: true, accepted: 1 }` |
| `GET /api/v1/http-requests` | ✅ 200 | List endpoint available |
| `GET /api/v1/http-requests/stats` | ✅ 200 | Stats: totalRequests, errorRate, p50/p95/p99 |
| `GET /api/v1/http-requests/top-hosts` | ✅ 200 | |

### Step 4: Monitors
| Test | Status |
|------|--------|
| `GET /api/v1/monitors` | ✅ 200 |
| `POST /api/v1/monitors` | ✅ 201 |
| `DELETE /api/v1/monitors/{id}` | ✅ 204 |

### Step 5: SSH Servers
| Test | Status |
|------|--------|
| `GET /api/v1/ssh/servers` | ✅ 200 |

### Step 6: Chat
| Test | Status |
|------|--------|
| `GET /api/v1/chat/channels` | ✅ 200 |

### Step 7: Alerts
| Test | Status | Notes |
|------|--------|-------|
| `GET /api/v1/alerts` | ❌ 404 | **Backend endpoint not implemented** |

### Step 8: Auth Edge Cases
| Test | Status |
|------|--------|
| Invalid API key → 401 | ✅ PASS |
| No auth on query API → 401 | ✅ PASS |

---

## Infrastructure Fix

**Issue found:** Backend container was connecting to Kafka's EXTERNAL listener (`kafka:9092`) which advertises itself as `localhost:9092`. From inside Docker, this resolves to the container's own loopback — not Kafka — causing all ingest endpoints to return 500.

**Fix:** Changed `KAFKA_BOOTSTRAP_SERVERS` from `kafka:9092` → `kafka:19092` (PLAINTEXT internal listener, advertised as `kafka:19092`). Updated `infra/docker/docker-compose.yml`.

---

## SDK Modules Validated

| Module | Ingest Path | Status |
|--------|------------|--------|
| `ErrorModule` | `POST /ingest/v1/errors` | ✅ |
| `LogModule` | `POST /ingest/v1/logs` | ✅ |
| `HttpRequestModule` | `POST /ingest/v1/http-requests` | ✅ |
| `CronModule` | `POST /ingest/v1/heartbeat` | ✅ (fires, 202) |
| `SessionReplayModule` | `POST /ingest/v1/replay` | ✅ (unit tested) |

---

## Payload Contracts Verified

### ErrorIngestRequest
```json
{
  "exceptionClass": "Error",
  "message": "...",
  "stackTrace": ["at ...", "at ..."],
  "level": "error",
  "environment": "test",
  "release": "1.0.0",
  "user": { "id": "...", "email": "..." },
  "metadata": { "key": "value" }
}
```

### LogIngestRequest
```json
{
  "level": "info",
  "message": "...",
  "service": "my-service",
  "traceId": "...",
  "metadata": { "key": "value" }
}
```

### HttpRequestIngestPayload
```json
{
  "requests": [{
    "traceId": "uuid",
    "direction": "inbound",
    "method": "GET",
    "host": "api.example.com",
    "path": "/users",
    "statusCode": 200,
    "durationMs": 145,
    "timestamp": "2026-03-30T10:00:00.000Z"
  }]
}
```

### HeartbeatRequest
```json
{
  "slug": "daily-report",
  "status": "success",
  "durationMs": 1234,
  "message": null
}
```

### ReplayIngestRequest
```json
{
  "fingerprint": "session-id",
  "sessionId": "session-id",
  "events": [{
    "eventType": "click",
    "eventData": "{\"x\":100,\"y\":200,\"target\":\"button#submit\"}",
    "url": "https://app.example.com/dashboard",
    "timestampMillis": 1743318000000
  }]
}
```

---

## Known Gap

- **Alerts backend endpoint** (`/api/v1/alerts`) returns 404 — not yet implemented in the backend. SDK has no alerts module (not in scope).
