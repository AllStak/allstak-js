import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AllStak } from '../src/index';

const TEST_DSN = 'https://test-key@localhost:3000';

/**
 * Helper: init the SDK with httpBodyCapture enabled and fake timers,
 * return a fetch spy so tests can inspect what was sent to ingest.
 */
function setup() {
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  vi.useFakeTimers();

  AllStak.init({
    dsn: TEST_DSN,
    environment: 'test',
    httpBodyCapture: {
      enabled: true,
      maxBodySize: 16_384,
      contentTypes: ['application/json', 'text/plain'],
    },
  });

  return fetchSpy;
}

/**
 * Trigger a fetch that the SDK instruments, then flush the HTTP request batch
 * and return the ingest payload that was sent to /ingest/v1/http-requests.
 */
async function captureOutboundFetch(
  fetchSpy: ReturnType<typeof vi.fn>,
  url: string,
  init?: RequestInit,
) {
  // The first fetch call is the "user" request, which the SDK intercepts
  // and records.  The SDK's *own* ingest POST uses the same fetch spy.
  await globalThis.fetch(url, init);

  // Flush the HTTP-request batch
  vi.advanceTimersByTime(5_000);

  // Wait for the ingest POST to be called
  await vi.waitFor(() => {
    const ingestCalls = fetchSpy.mock.calls.filter(
      ([u]: [string]) => typeof u === 'string' && u.includes('/ingest/v1/http-requests'),
    );
    expect(ingestCalls.length).toBeGreaterThanOrEqual(1);
  });

  // Find the ingest call and parse the payload
  const ingestCall = fetchSpy.mock.calls.find(
    ([u]: [string]) => typeof u === 'string' && u.includes('/ingest/v1/http-requests'),
  );
  const body = JSON.parse(ingestCall![1].body as string);
  return body.requests[0];
}

/**
 * Stringify the entire request payload to check nothing sensitive leaked.
 */
function payloadString(payload: unknown): string {
  return JSON.stringify(payload);
}

describe('Sensitive Data Masking', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = setup();
  });

  afterEach(() => {
    AllStak.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ─── Authorization Headers ──────────────────────────────────────────

  describe('Authorization headers', () => {
    it('redacts the Authorization request header', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/data', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123',
          'Content-Type': 'application/json',
        },
      });

      // The authorization header must be present but redacted
      expect(req.requestHeaders?.authorization).toBe('[REDACTED]');
      // Content-Type should pass through
      expect(req.requestHeaders?.['content-type']).toBe('application/json');
      // The raw token must not appear anywhere in the payload
      expect(payloadString(req)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('redacts Basic auth in the Authorization header', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/data', {
        method: 'GET',
        headers: {
          Authorization: 'Basic dXNlcjpwYXNzd29yZA==',
        },
      });

      expect(req.requestHeaders?.authorization).toBe('[REDACTED]');
      expect(payloadString(req)).not.toContain('dXNlcjpwYXNzd29yZA==');
    });
  });

  // ─── Cookie Headers ─────────────────────────────────────────────────

  describe('Cookie headers', () => {
    it('redacts Cookie request headers', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/data', {
        method: 'GET',
        headers: {
          Cookie: 'session=abc123; token=xyz789',
          Accept: 'application/json',
        },
      });

      expect(req.requestHeaders?.cookie).toBe('[REDACTED]');
      expect(payloadString(req)).not.toContain('abc123');
      expect(payloadString(req)).not.toContain('xyz789');
    });
  });

  // ─── Password Fields in Bodies ──────────────────────────────────────

  describe('Password fields in request/response bodies', () => {
    it('redacts password fields in JSON request bodies', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'alice',
          password: 'super-secret-pass-123',
          remember: true,
        }),
      });

      // The password value must be redacted
      expect(payloadString(req)).not.toContain('super-secret-pass-123');
      // But the username should pass through
      expect(req.requestBody).toContain('alice');
      // Confirm the field exists but is masked
      const parsed = JSON.parse(req.requestBody!);
      expect(parsed.password).toBe('[REDACTED]');
    });

    it('redacts passcode fields in JSON request bodies', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: '42',
          passcode: '991122',
        }),
      });

      const parsed = JSON.parse(req.requestBody!);
      expect(parsed.passcode).toBe('[REDACTED]');
      expect(payloadString(req)).not.toContain('991122');
    });

    it('redacts nested sensitive fields deep in JSON', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: {
            email: 'alice@example.com',
            credentials: {
              password: 'deep-nested-secret',
              refreshToken: 'rt_abc123',
            },
          },
        }),
      });

      expect(payloadString(req)).not.toContain('deep-nested-secret');
      expect(payloadString(req)).not.toContain('rt_abc123');
      const parsed = JSON.parse(req.requestBody!);
      expect(parsed.user.credentials.password).toBe('[REDACTED]');
      expect(parsed.user.credentials.refreshToken).toBe('[REDACTED]');
      // Non-sensitive data survives
      expect(parsed.user.email).toBe('alice@example.com');
    });
  });

  // ─── API Key Values ─────────────────────────────────────────────────

  describe('API key / token fields in bodies', () => {
    it('redacts token fields in JSON request bodies', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'user.created',
          token: 'tok_live_abc123def456',
        }),
      });

      const parsed = JSON.parse(req.requestBody!);
      expect(parsed.token).toBe('[REDACTED]');
      expect(payloadString(req)).not.toContain('tok_live_abc123def456');
    });

    it('redacts secret fields in JSON request bodies', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: 'my-app',
          secret: 'shh-do-not-leak',
        }),
      });

      const parsed = JSON.parse(req.requestBody!);
      expect(parsed.secret).toBe('[REDACTED]');
      expect(payloadString(req)).not.toContain('shh-do-not-leak');
    });

    it('redacts jwt fields in JSON request bodies', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'refresh',
          jwt: 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhbGxzdGFrIn0.sig',
        }),
      });

      const parsed = JSON.parse(req.requestBody!);
      expect(parsed.jwt).toBe('[REDACTED]');
    });
  });

  // ─── Token Values in URL Query Strings ──────────────────────────────

  describe('Token values in URL query strings', () => {
    it('strips query parameters from the captured path', async () => {
      const req = await captureOutboundFetch(
        fetchSpy,
        'https://api.example.com/resource?token=secret_tok_123&api_key=ak_live_xyz',
        { method: 'GET' },
      );

      // The path should not contain query parameters at all
      expect(req.path).not.toContain('token=');
      expect(req.path).not.toContain('api_key=');
      expect(req.path).not.toContain('secret_tok_123');
      expect(req.path).not.toContain('ak_live_xyz');
      expect(req.path).toBe('/resource');
    });

    it('strips auth-related query params from breadcrumb URLs', async () => {
      const req = await captureOutboundFetch(
        fetchSpy,
        'https://api.example.com/callback?code=auth_code_789&state=random',
        { method: 'GET' },
      );

      // Path captured must be clean
      expect(req.path).toBe('/callback');
      expect(req.path).not.toContain('auth_code_789');
    });
  });

  // ─── Bearer Tokens in Plain-Text Bodies ─────────────────────────────

  describe('Bearer tokens in plain-text bodies', () => {
    it('redacts Bearer tokens in plain text request bodies', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/log', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig -- logged in',
      });

      // The bearer token must be scrubbed
      expect(req.requestBody).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(req.requestBody).toContain('Bearer [REDACTED]');
    });

    it('redacts standalone JWTs in plain text bodies', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/log', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'User token was eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U check complete',
      });

      expect(req.requestBody).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(req.requestBody).toContain('[REDACTED_JWT]');
    });
  });

  // ─── Session / OTP / X-AllStak-Key Headers ──────────────────────────

  describe('Other sensitive headers', () => {
    it('redacts session headers', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/data', {
        method: 'GET',
        headers: {
          'X-Session-Id': 'sess_abc123',
        },
      });

      // "session" is in the sensitive header pattern
      expect(req.requestHeaders?.['x-session-id']).toBe('[REDACTED]');
    });

    it('redacts OTP headers', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/verify', {
        method: 'POST',
        headers: {
          'X-OTP': '123456',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'verify' }),
      });

      expect(req.requestHeaders?.['x-otp']).toBe('[REDACTED]');
      expect(payloadString(req)).not.toContain('123456');
    });
  });

  // ─── Custom Redact Fields ───────────────────────────────────────────

  describe('Custom redact fields via SDK config', () => {
    it('redacts user-specified custom fields', async () => {
      // Destroy the default instance and re-init with custom redact fields
      AllStak.destroy();
      vi.restoreAllMocks();

      const customSpy = vi.fn().mockResolvedValue(
        new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
      vi.stubGlobal('fetch', customSpy);

      AllStak.init({
        dsn: TEST_DSN,
        environment: 'test',
        httpBodyCapture: {
          enabled: true,
          redactFields: ['ssn', 'socialSecurityNumber'],
        },
      });

      const req = await captureOutboundFetch(customSpy, 'https://api.example.com/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Alice',
          ssn: '123-45-6789',
          socialSecurityNumber: '987-65-4321',
        }),
      });

      const parsed = JSON.parse(req.requestBody!);
      expect(parsed.ssn).toBe('[REDACTED]');
      expect(parsed.socialSecurityNumber).toBe('[REDACTED]');
      expect(parsed.name).toBe('Alice');
    });
  });

  // ─── The SDK's own X-AllStak-Key is not leaked in captured headers ──

  describe('SDK API key is not leaked', () => {
    it('does not include X-AllStak-Key in captured request headers of user requests', async () => {
      const req = await captureOutboundFetch(fetchSpy, 'https://api.example.com/data', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      // The SDK adds X-AllStak-Key to its own ingest calls but NOT to
      // user-facing outbound requests.
      expect(req.requestHeaders?.['x-allstak-key']).toBeUndefined();
      expect(payloadString(req)).not.toContain('test-key');
    });
  });
});
