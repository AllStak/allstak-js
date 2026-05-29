import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpTransport } from '../src/transport/http';
import {
  LocalStorageOfflineQueue,
  FsOfflineQueue,
  AdapterOfflineQueue,
  NoopOfflineQueue,
  createOfflineQueue,
  setPersistence,
  nextPersistedId,
  isPersistablePath,
  PersistedEvent,
  PersistenceAdapter,
} from '../src/transport/offline-queue';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Minimal in-memory localStorage shim (jsdom provides one, but we want control). */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

// `order` lets a test impose deterministic chronological order via small
// monotonic offsets near "now" (NOT tiny epoch values, which would age out).
const T0 = Date.now();
function evt(path: string, payload: unknown, order = 0): PersistedEvent {
  return { id: nextPersistedId(), path, payload, ts: T0 + order };
}

const SECRET = 'super-secret-token-value';
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  setPersistence(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── 1. Path filtering: sessions are NOT persistable ──────────────────────────

describe('isPersistablePath', () => {
  it('excludes session lifecycle calls', () => {
    expect(isPersistablePath('/ingest/v1/sessions/start')).toBe(false);
    expect(isPersistablePath('/ingest/v1/sessions/end')).toBe(false);
  });

  it('allows error/log/span/http/db telemetry', () => {
    for (const p of [
      '/ingest/v1/errors',
      '/ingest/v1/logs',
      '/ingest/v1/spans',
      '/ingest/v1/http-requests',
      '/ingest/v1/db',
      '/ingest/v1/heartbeat',
    ]) {
      expect(isPersistablePath(p)).toBe(true);
    }
  });
});

// ── 2. LocalStorage backend ──────────────────────────────────────────────────

describe('LocalStorageOfflineQueue', () => {
  it('persists, loads (oldest-first), and removes by id', () => {
    const store = memoryStorage();
    const q = new LocalStorageOfflineQueue(store, 50, 1_000_000, 48 * 3600_000);
    const a = evt('/ingest/v1/errors', { i: 1 }, 1);
    const b = evt('/ingest/v1/logs', { i: 2 }, 2);
    q.enqueue(a);
    q.enqueue(b);

    const loaded = q.load();
    expect(loaded.map((e) => (e.payload as any).i)).toEqual([1, 2]);

    q.remove(a.id);
    expect(q.load().map((e) => e.id)).toEqual([b.id]);
  });

  it('caps by count and drops OLDEST', () => {
    const store = memoryStorage();
    const q = new LocalStorageOfflineQueue(store, 3, 1_000_000, 48 * 3600_000);
    for (let i = 0; i < 6; i++) q.enqueue(evt('/ingest/v1/errors', { i }, i + 1));

    const loaded = q.load();
    expect(loaded).toHaveLength(3);
    // oldest (0,1,2) dropped; newest 3 kept
    expect(loaded.map((e) => (e.payload as any).i)).toEqual([3, 4, 5]);
  });

  it('drops entries older than maxAge on load', () => {
    const store = memoryStorage();
    const q = new LocalStorageOfflineQueue(store, 50, 1_000_000, 1000);
    const stale: PersistedEvent = {
      id: nextPersistedId(),
      path: '/ingest/v1/errors',
      payload: { stale: true },
      ts: Date.now() - 5000,
    };
    const fresh: PersistedEvent = {
      id: nextPersistedId(),
      path: '/ingest/v1/errors',
      payload: { fresh: true },
      ts: Date.now(),
    };
    q.enqueue(stale);
    q.enqueue(fresh);

    const loaded = q.load();
    expect(loaded).toHaveLength(1);
    expect((loaded[0].payload as any).fresh).toBe(true);
  });

  it('degrades silently when localStorage throws (quota / private mode)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const q = new LocalStorageOfflineQueue(throwing, 50, 1_000_000, 48 * 3600_000);
    expect(() => q.enqueue(evt('/ingest/v1/errors', { x: 1 }))).not.toThrow();
    expect(q.load()).toEqual([]);
    expect(() => q.remove('nope')).not.toThrow();
  });
});

// ── 3. Filesystem (Node) backend ─────────────────────────────────────────────

describe('FsOfflineQueue', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'allstak-oq-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeFs() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:fs');
  }

  it('spools one file per event and survives a "restart" (new instance, same dir)', () => {
    const q1 = new FsOfflineQueue(makeFs(), dir, 500, 5_000_000, 48 * 3600_000);
    const a = evt('/ingest/v1/errors', { i: 1 }, 1);
    const b = evt('/ingest/v1/logs', { i: 2 }, 2);
    q1.enqueue(a);
    q1.enqueue(b);

    // Simulate a restart: brand-new queue object reading the same spool dir.
    const q2 = new FsOfflineQueue(makeFs(), dir, 500, 5_000_000, 48 * 3600_000);
    const loaded = q2.load();
    expect(loaded.map((e) => (e.payload as any).i)).toEqual([1, 2]);

    q2.remove(a.id);
    expect(new FsOfflineQueue(makeFs(), dir, 500, 5_000_000, 48 * 3600_000).load().map((e) => e.id)).toEqual([b.id]);
  });

  it('caps by count and drops OLDEST file', () => {
    const q = new FsOfflineQueue(makeFs(), dir, 3, 5_000_000, 48 * 3600_000);
    for (let i = 0; i < 6; i++) q.enqueue(evt('/ingest/v1/errors', { i }, i + 1));
    const loaded = q.load();
    expect(loaded).toHaveLength(3);
    expect(loaded.map((e) => (e.payload as any).i)).toEqual([3, 4, 5]);
  });

  it('drops corrupt entries on load without throwing', () => {
    const fs = makeFs();
    const q = new FsOfflineQueue(fs, dir, 500, 5_000_000, 48 * 3600_000);
    q.enqueue(evt('/ingest/v1/errors', { ok: true }, 1));
    // Drop a garbage file the queue should ignore + clean.
    fs.writeFileSync(join(dir, 'allstak-garbage.json'), '{not json');
    const loaded = q.load();
    expect(loaded).toHaveLength(1);
    expect((loaded[0].payload as any).ok).toBe(true);
  });
});

// ── 4. Pluggable adapter backend (React Native) ──────────────────────────────

describe('AdapterOfflineQueue', () => {
  it('mirrors writes through a sync adapter', () => {
    const store = memoryStorage();
    const adapter: PersistenceAdapter = {
      getItem: store.getItem,
      setItem: store.setItem,
      removeItem: store.removeItem,
    };
    const q = new AdapterOfflineQueue(adapter, 50, 1_000_000, 48 * 3600_000);
    const a = evt('/ingest/v1/errors', { i: 1 });
    q.enqueue(a);
    expect(q.load().map((e) => (e.payload as any).i)).toEqual([1]);
    q.remove(a.id);
    expect(q.load()).toEqual([]);
  });

  it('hydrates from an async adapter', async () => {
    const initial = JSON.stringify([evt('/ingest/v1/errors', { i: 9 }, 1)]);
    const adapter: PersistenceAdapter = {
      getItem: () => Promise.resolve(initial),
      setItem: () => Promise.resolve(),
      removeItem: () => Promise.resolve(),
    };
    const q = new AdapterOfflineQueue(adapter, 50, 1_000_000, 48 * 3600_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(q.isHydrated()).toBe(true);
    expect(q.load().map((e) => (e.payload as any).i)).toEqual([9]);
  });
});

// ── 5. Factory: runtime selection + opt-out + graceful degradation ───────────

describe('createOfflineQueue', () => {
  it('returns a Noop when disabled (opt-out)', () => {
    const q = createOfflineQueue({ enabled: false });
    expect(q).toBeInstanceOf(NoopOfflineQueue);
    q.enqueue(evt('/ingest/v1/errors', { x: 1 }));
    expect(q.load()).toEqual([]);
  });

  it('prefers an injected pluggable adapter (setPersistence)', () => {
    const store = memoryStorage();
    setPersistence({ getItem: store.getItem, setItem: store.setItem, removeItem: store.removeItem });
    const q = createOfflineQueue({});
    expect(q).toBeInstanceOf(AdapterOfflineQueue);
  });

  it('selects the fs spool under Node', () => {
    // The test env is jsdom (window defined). Force the Node-build marker the
    // SDK uses so the factory takes the fs branch like a real Node bundle.
    vi.stubGlobal('__ALLSTAK_NODE__', true);
    const dir = mkdtempSync(join(tmpdir(), 'allstak-oq-fac-'));
    try {
      const q = createOfflineQueue({ dir });
      expect(q).toBeInstanceOf(FsOfflineQueue);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws', () => {
    expect(() => createOfflineQueue({ dir: '/this/should/not/matter' })).not.toThrow();
  });
});

// ── 6. Transport integration: persist-on-failure + drain-on-init ─────────────

describe('HttpTransport offline persistence', () => {
  it('automatically retries buffered events after an outage without a new event', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const store = memoryStorage();
    const q = new LocalStorageOfflineQueue(store, 1000, 5_000_000, 48 * 3600_000);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('backend down'))
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport('https://api.invalid', 'ask_test', q);
    await transport.send('/ingest/v1/errors', { message: 'recover me' });
    await wait(25);

    expect(transport.getBufferSize()).toBe(1);
    expect(q.load()).toHaveLength(1);

    await wait(350);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transport.getBufferSize()).toBe(0);
    expect(q.load()).toEqual([]);
  });

  it('persists circuit-open events and schedules a bounded retry', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const store = memoryStorage();
    const q = new LocalStorageOfflineQueue(store, 1000, 5_000_000, 48 * 3600_000);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const transport = new HttpTransport('https://api.invalid', 'ask_test', q);

    for (let i = 0; i < 3; i++) await transport.send('/ingest/v1/errors', { i });
    await wait(50);
    expect(transport.getStats().circuitOpenUntil).toBeGreaterThan(Date.now());

    await transport.send('/ingest/v1/errors', { duringCircuit: true });
    await wait(10);

    expect(q.load().some((e) => (e.payload as any).duringCircuit === true)).toBe(true);
    expect(transport.getStats().persisted).toBeGreaterThan(0);
    expect(transport.getStats().failed).toBe(3);

    await wait(1_200);
    expect((globalThis.fetch as any).mock.calls.length).toBeLessThan(25);
  });

  it('counts buffer overflow drops when no persistent queue is available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const transport = new HttpTransport('https://api.invalid', 'ask_test');

    for (let i = 0; i < 150; i++) await transport.send('/ingest/v1/errors', { i });
    await new Promise((r) => setTimeout(r, 0));

    expect(transport.getBufferSize()).toBeLessThanOrEqual(100);
    expect(transport.getStats().dropped).toBeGreaterThan(0);
    expect(transport.getStats().persisted).toBe(0);
  });

  it('persists buffered events during unload/shutdown flush', async () => {
    const store = memoryStorage();
    const q = new LocalStorageOfflineQueue(store, 1000, 5_000_000, 48 * 3600_000);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const transport = new HttpTransport('https://api.invalid', 'ask_test', q);

    await transport.send('/ingest/v1/errors', { unload: true });
    await wait(25);
    transport.persistBufferedNow();

    expect(transport.getBufferSize()).toBe(0);
    expect(q.load().some((e) => (e.payload as any).unload === true)).toBe(true);
  });

  it('persists evicted events when the buffer overflows during an outage', async () => {
    const store = memoryStorage();
    const q = new LocalStorageOfflineQueue(store, 1000, 5_000_000, 48 * 3600_000);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const transport = new HttpTransport('https://api.invalid', 'ask_test', q);

    // 150 events with an in-memory cap of 100 → ~50 spill to the offline store.
    for (let i = 0; i < 150; i++) await transport.send('/ingest/v1/errors', { i });
    await new Promise((r) => setTimeout(r, 0));

    const persisted = q.load();
    expect(persisted.length).toBeGreaterThan(0);
    expect(transport.getStats().persisted).toBeGreaterThan(0);
    // Nothing was silently dropped: buffered + persisted accounts for the spill.
    expect(transport.getBufferSize() + persisted.length).toBeGreaterThanOrEqual(100);
  });

  it('does NOT persist session lifecycle calls even when the buffer overflows', async () => {
    const store = memoryStorage();
    const q = new LocalStorageOfflineQueue(store, 1000, 5_000_000, 48 * 3600_000);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const transport = new HttpTransport('https://api.invalid', 'ask_test', q);

    for (let i = 0; i < 150; i++) await transport.send('/ingest/v1/sessions/start', { i });
    await new Promise((r) => setTimeout(r, 0));

    expect(q.load()).toEqual([]);
  });

  it('drains persisted events on init and removes them after a 2xx', async () => {
    const store = memoryStorage();
    const seed = new LocalStorageOfflineQueue(store, 1000, 5_000_000, 48 * 3600_000);
    seed.enqueue(evt('/ingest/v1/errors', { replayed: 1 }));
    seed.enqueue(evt('/ingest/v1/logs', { replayed: 2 }));
    expect(seed.load()).toHaveLength(2);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const q = new LocalStorageOfflineQueue(store, 1000, 5_000_000, 48 * 3600_000);
    const transport = new HttpTransport('https://api.invalid', 'ask_test', q);
    transport.drainPersisted();
    await transport.flush(2000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transport.getStats().replayed).toBe(2);
    expect(q.load()).toEqual([]); // cleared after successful resend
  });

  it('keeps a replayed event in the store when the resend fails (transient)', async () => {
    const store = memoryStorage();
    const seed = new LocalStorageOfflineQueue(store, 1000, 5_000_000, 48 * 3600_000);
    const e = evt('/ingest/v1/errors', { replayed: 1 });
    seed.enqueue(e);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('still offline')));
    const q = new LocalStorageOfflineQueue(store, 1000, 5_000_000, 48 * 3600_000);
    const transport = new HttpTransport('https://api.invalid', 'ask_test', q);
    transport.drainPersisted();
    await new Promise((r) => setTimeout(r, 0));

    // The single event re-buffers in memory; it is still recoverable. On a
    // graceful shutdown it is spilled back to the store under the SAME id (no dup).
    transport.persistBufferedNow();
    const persisted = q.load();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(e.id);
  });

  it('removes a persisted event after a permanent (400) failure', async () => {
    const store = memoryStorage();
    const seed = new LocalStorageOfflineQueue(store, 1000, 5_000_000, 48 * 3600_000);
    seed.enqueue(evt('/ingest/v1/errors', { bad: true }));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 400 })));
    const q = new LocalStorageOfflineQueue(store, 1000, 5_000_000, 48 * 3600_000);
    const transport = new HttpTransport('https://api.invalid', 'ask_test', q);
    transport.drainPersisted();
    await transport.flush(2000);

    expect(q.load()).toEqual([]); // 400 → dropped + purged from store
    expect(transport.getStats().dropped).toBeGreaterThan(0);
  });

  it('scrub-before-persist: only already-scrubbed payloads reach the store', async () => {
    // The transport persists exactly what `send()` receives. Modules redact
    // BEFORE calling send, so a payload that still contains a secret must never
    // appear if the caller scrubbed it. We assert the store contains the bytes
    // passed to send() verbatim and that a redacted payload carries no secret.
    const store = memoryStorage();
    const q = new LocalStorageOfflineQueue(store, 1000, 5_000_000, 48 * 3600_000);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const transport = new HttpTransport('https://api.invalid', 'ask_test', q);

    // Simulate the module layer having already redacted the secret.
    const scrubbed = { message: 'boom', metadata: { token: '[REDACTED]' } };
    for (let i = 0; i < 150; i++) await transport.send('/ingest/v1/errors', scrubbed);
    await new Promise((r) => setTimeout(r, 0));

    const raw = store.map.get('allstak.offline.v1') ?? '';
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('[REDACTED]');
  });

  it('falls back to in-memory behavior with a Noop queue (graceful degradation)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    // No queue arg → NoopOfflineQueue. Must behave exactly like before.
    const transport = new HttpTransport('https://api.invalid', 'ask_test');
    for (let i = 0; i < 150; i++) await transport.send('/ingest/v1/errors', { i });
    await new Promise((r) => setTimeout(r, 0));

    expect(transport.getBufferSize()).toBeLessThanOrEqual(100);
    const stats = transport.getStats();
    expect(stats.failed).toBeGreaterThan(0);
    // Noop store never persists; overflow counts as dropped (legacy behavior).
    expect(stats.persisted).toBe(0);
    expect(stats.dropped).toBeGreaterThan(0);
    expect(() => transport.drainPersisted()).not.toThrow();
  });
});
