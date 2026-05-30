import { createRequire as __allstakCreateRequire } from 'node:module';
const require = __allstakCreateRequire(import.meta.url);
import {
  instrumentMysql2,
  instrumentPg,
  instrumentSqlite,
  setTraceResolver
} from "./chunk-2Z2PH3DC.mjs";
import {
  __require
} from "./chunk-6GVGKK5H.mjs";

// src/transport/buffer.ts
var MAX_BUFFER_SIZE = 100;
var EventBuffer = class {
  constructor() {
    this.queue = [];
  }
  push(event) {
    return this.pushReturningEvicted(event) !== null;
  }
  /**
   * Like {@link push} but returns the OLDEST item that was evicted to make
   * room (or `null` when nothing was dropped). The transport uses the evictee
   * to spill into the persistent offline store instead of losing it.
   */
  pushReturningEvicted(event) {
    let evicted = null;
    if (this.queue.length >= MAX_BUFFER_SIZE) {
      evicted = this.queue.shift() ?? null;
    }
    this.queue.push(event);
    return evicted;
  }
  drain() {
    const items = [...this.queue];
    this.queue = [];
    return items;
  }
  get size() {
    return this.queue.length;
  }
  peek() {
    return [...this.queue];
  }
};

// src/transport/offline-queue.ts
var BROWSER_MAX_EVENTS = 50;
var BROWSER_MAX_BYTES = 1e6;
var NODE_MAX_EVENTS = 500;
var NODE_MAX_BYTES = 5e6;
var DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1e3;
var STORAGE_KEY = "allstak.offline.v1";
var idCounter = 0;
function nextPersistedId() {
  idCounter = (idCounter + 1) % 1e6;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function entryBytes(event) {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
}
function applyBounds(list, maxEvents, maxBytes, maxAgeMs) {
  const now = Date.now();
  let dropped = 0;
  let kept = list.filter((e) => {
    const fresh = now - e.ts <= maxAgeMs;
    if (!fresh) dropped++;
    return fresh;
  });
  while (kept.length > maxEvents) {
    kept.shift();
    dropped++;
  }
  let total = kept.reduce((sum, e) => sum + entryBytes(e), 0);
  while (kept.length > 0 && total > maxBytes) {
    const removed = kept.shift();
    total -= entryBytes(removed);
    dropped++;
  }
  return { kept, dropped };
}
var NoopOfflineQueue = class {
  enqueue() {
  }
  load() {
    return [];
  }
  remove() {
  }
  clear() {
  }
};
var LocalStorageOfflineQueue = class {
  constructor(storage, maxEvents, maxBytes, maxAgeMs, key = STORAGE_KEY) {
    this.storage = storage;
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
    this.key = key;
  }
  read() {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isPersistedEvent);
    } catch {
      return [];
    }
  }
  write(list) {
    try {
      const { kept } = applyBounds(list, this.maxEvents, this.maxBytes, this.maxAgeMs);
      if (kept.length === 0) {
        this.storage.removeItem(this.key);
        return;
      }
      this.storage.setItem(this.key, JSON.stringify(kept));
    } catch {
    }
  }
  enqueue(event) {
    const list = this.read().filter((e) => e.id !== event.id);
    list.push(event);
    this.write(list);
  }
  load() {
    const list = this.read();
    this.write(list);
    return this.read();
  }
  remove(id) {
    const list = this.read().filter((e) => e.id !== id);
    this.write(list);
  }
  clear() {
    try {
      this.storage.removeItem(this.key);
    } catch {
    }
  }
};
var AdapterOfflineQueue = class {
  constructor(adapter, maxEvents, maxBytes, maxAgeMs, key = STORAGE_KEY) {
    this.adapter = adapter;
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
    this.key = key;
    this.mirror = [];
    this.hydrated = false;
    this.hydrate();
  }
  hydrate() {
    try {
      const got = this.adapter.getItem(this.key);
      if (isThenable(got)) {
        got.then((raw) => {
          this.mirror = parseList(raw);
          this.hydrated = true;
        }).catch(() => {
          this.hydrated = true;
        });
      } else {
        this.mirror = parseList(got);
        this.hydrated = true;
      }
    } catch {
      this.hydrated = true;
    }
  }
  flush() {
    try {
      const { kept } = applyBounds(this.mirror, this.maxEvents, this.maxBytes, this.maxAgeMs);
      this.mirror = kept;
      const r = this.adapter.setItem(this.key, JSON.stringify(kept));
      if (isThenable(r)) r.catch(() => void 0);
    } catch {
    }
  }
  enqueue(event) {
    this.mirror = this.mirror.filter((e) => e.id !== event.id);
    this.mirror.push(event);
    this.flush();
  }
  load() {
    const { kept } = applyBounds(this.mirror, this.maxEvents, this.maxBytes, this.maxAgeMs);
    this.mirror = kept;
    return [...kept];
  }
  remove(id) {
    this.mirror = this.mirror.filter((e) => e.id !== id);
    this.flush();
  }
  clear() {
    this.mirror = [];
    try {
      const r = this.adapter.removeItem(this.key);
      if (isThenable(r)) r.catch(() => void 0);
    } catch {
    }
  }
  /** @internal test seam */
  isHydrated() {
    return this.hydrated;
  }
};
var FsOfflineQueue = class {
  constructor(fs, dir, maxEvents, maxBytes, maxAgeMs) {
    this.fs = fs;
    this.dir = dir;
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
    this.fs.mkdirSync(this.dir, { recursive: true });
  }
  fileFor(id) {
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `${this.dir}/allstak-${safe}.json`;
  }
  listFiles() {
    try {
      return this.fs.readdirSync(this.dir).filter((f) => f.startsWith("allstak-") && f.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }
  enqueue(event) {
    try {
      this.fs.writeFileSync(this.fileFor(event.id), JSON.stringify(event));
      this.enforceBounds();
    } catch {
    }
  }
  load() {
    const out = [];
    for (const f of this.listFiles()) {
      const full = `${this.dir}/${f}`;
      try {
        const parsed = JSON.parse(this.fs.readFileSync(full, "utf8"));
        if (isPersistedEvent(parsed)) out.push(parsed);
        else this.safeUnlink(full);
      } catch {
        this.safeUnlink(full);
      }
    }
    out.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    const { kept } = applyBounds(out, this.maxEvents, this.maxBytes, this.maxAgeMs);
    const keepIds = new Set(kept.map((e) => e.id));
    for (const e of out) if (!keepIds.has(e.id)) this.safeUnlink(this.fileFor(e.id));
    return kept;
  }
  remove(id) {
    this.safeUnlink(this.fileFor(id));
  }
  clear() {
    for (const f of this.listFiles()) this.safeUnlink(`${this.dir}/${f}`);
  }
  enforceBounds() {
    const events = this.load();
    void events;
  }
  safeUnlink(full) {
    try {
      this.fs.unlinkSync(full);
    } catch {
    }
  }
};
var injectedAdapter = null;
function setPersistence(adapter) {
  injectedAdapter = adapter && typeof adapter.getItem === "function" ? adapter : null;
}
function detectGlobalAsyncStorage() {
  try {
    const g = globalThis;
    const candidate = g.AsyncStorage ?? g.__ALLSTAK_ASYNC_STORAGE__;
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function" && typeof candidate.removeItem === "function") {
      return candidate;
    }
  } catch {
  }
  return null;
}
function isNodeRuntime() {
  try {
    return true;
  } catch {
    return false;
  }
}
function getLocalStorage() {
  try {
    if (typeof window === "undefined") return null;
    const ls = window.localStorage;
    if (!ls) return null;
    const probe = "__allstak_probe__";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}
function loadNodeFs() {
  try {
    if (!isNodeRuntime()) return null;
    const proc = globalThis.process;
    const fromProcess = proc?.getBuiltinModule?.("node:fs");
    if (fromProcess) return fromProcess;
    const req = typeof __require === "function" ? __require : void 0;
    return req ? req("node:fs") : null;
  } catch {
    return null;
  }
}
function defaultNodeDir() {
  try {
    const proc = globalThis.process;
    const os = proc?.getBuiltinModule?.("node:os") ?? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (typeof __require === "function" ? __require("os") : null);
    const tmp = os?.tmpdir?.() ?? "/tmp";
    return `${tmp.replace(/\/$/, "")}/allstak-offline-queue`;
  } catch {
    return "/tmp/allstak-offline-queue";
  }
}
function createOfflineQueue(options = {}) {
  try {
    if (options.enabled === false) return new NoopOfflineQueue();
    const node = isNodeRuntime();
    const maxEvents = options.maxEvents ?? (node ? NODE_MAX_EVENTS : BROWSER_MAX_EVENTS);
    const maxBytes = options.maxBytes ?? (node ? NODE_MAX_BYTES : BROWSER_MAX_BYTES);
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const adapter = options.adapter ?? injectedAdapter;
    if (adapter && typeof adapter.getItem === "function") {
      return new AdapterOfflineQueue(adapter, maxEvents, maxBytes, maxAgeMs);
    }
    if (node) {
      const fs = loadNodeFs();
      const dir = options.dir ?? defaultNodeDir();
      if (fs) {
        try {
          return new FsOfflineQueue(fs, dir, maxEvents, maxBytes, maxAgeMs);
        } catch {
          return new NoopOfflineQueue();
        }
      }
      return new NoopOfflineQueue();
    }
    const ls = getLocalStorage();
    if (ls) return new LocalStorageOfflineQueue(ls, maxEvents, maxBytes, maxAgeMs);
    const detected = detectGlobalAsyncStorage();
    if (detected) return new AdapterOfflineQueue(detected, maxEvents, maxBytes, maxAgeMs);
    return new NoopOfflineQueue();
  } catch {
    return new NoopOfflineQueue();
  }
}
function isPersistedEvent(v) {
  return !!v && typeof v === "object" && typeof v.id === "string" && typeof v.path === "string" && typeof v.ts === "number";
}
function parseList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPersistedEvent) : [];
  } catch {
    return [];
  }
}
function isThenable(v) {
  return !!v && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";
}
function isPersistablePath(path) {
  return !path.startsWith("/ingest/v1/sessions/");
}

// src/transport/http.ts
var REQUEST_TIMEOUT = 2e3;
var FAILURE_THRESHOLD = 3;
var BACKOFF_BASE_MS = 500;
var BACKOFF_MAX_MS = 3e4;
var RETRY_AFTER_MAX_MS = 3e5;
var COMPRESSION_THRESHOLD_BYTES = 1024;
var HttpResponseError = class extends Error {
  constructor(status, retryAfter) {
    super(`HTTP ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
    this.name = "HttpResponseError";
  }
};
var HttpTransport = class {
  constructor(baseUrl, apiKey, offlineQueue) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.buffer = new EventBuffer();
    this.inFlight = /* @__PURE__ */ new Set();
    this.flushing = false;
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    this.sent = 0;
    this.failed = 0;
    this.dropped = 0;
    this.retryAttempts = 0;
    this.rateLimited = 0;
    this.persisted = 0;
    this.replayed = 0;
    this.compressed = 0;
    this.uncompressed = 0;
    this.compressionBytesSaved = 0;
    this.retryTimer = null;
    this.retryTimerDueAt = 0;
    this.pendingRetryDelayMs = 0;
    this.closed = false;
    this.offlineQueue = offlineQueue ?? new NoopOfflineQueue();
    this.offlineEnabled = !!offlineQueue && !(offlineQueue instanceof NoopOfflineQueue);
  }
  send(path, payload) {
    if (this.closed && !isPersistablePath(path)) {
      return Promise.resolve();
    }
    this.enqueueOrDispatch({ path, payload });
    return Promise.resolve();
  }
  enqueueOrDispatch(item) {
    if (Date.now() < this.circuitOpenUntil) {
      this.persistOne(item, false);
      this.bufferOrPersist(item);
      this.scheduleFlush();
      return;
    }
    this.track(this.dispatch(item));
  }
  /**
   * Push an item back onto the in-memory buffer. If the buffer is full the
   * OLDEST item is evicted — instead of dropping that evictee on the floor we
   * persist it to the offline store (already PII-scrubbed) so it survives a
   * restart/outage and is replayed on the next init. Session lifecycle paths
   * are never persisted. Fully fail-open.
   */
  bufferOrPersist(item) {
    if (this.closed) {
      this.persistOne(item);
      return;
    }
    const evicted = this.buffer.pushReturningEvicted(item);
    if (evicted) this.persistOne(evicted);
  }
  track(promise) {
    this.inFlight.add(promise);
    promise.finally(() => this.inFlight.delete(promise)).catch(() => void 0);
  }
  async dispatch(item) {
    try {
      await this.doFetch(`${this.baseUrl}${item.path}`, item.payload);
      this.onSendSuccess(item);
      if (!this.closed) this.scheduleFlush();
    } catch (err) {
      this.onSendFailure(item, err);
    }
  }
  /** A 2xx (or replay) succeeded: clear the persisted copy if this was one. */
  onSendSuccess(item) {
    this.sent++;
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    if (item.persistId) {
      try {
        this.offlineQueue.remove(item.persistId);
      } catch {
      }
    }
  }
  /**
   * A send failed. Transient errors (network, 429, 5xx) re-buffer the item
   * (spilling the buffer evictee to the offline store). A PERMANENT failure
   * — a 4xx other than 429 — means the server will never accept this payload,
   * so we drop it and remove any persisted copy rather than replaying forever.
   */
  onSendFailure(item, err) {
    this.failed++;
    if (err instanceof HttpResponseError && err.status === 429) this.rateLimited++;
    const retryDelay = this.recordFailure(err);
    if (isPermanentFailure(err)) {
      this.dropped++;
      if (item.persistId) {
        try {
          this.offlineQueue.remove(item.persistId);
        } catch {
        }
      }
      return;
    }
    if (this.closed) {
      this.persistOne(item);
      return;
    }
    this.persistOne(item, false);
    this.bufferOrPersist(item);
    this.retryAttempts++;
    this.scheduleFlush(retryDelay);
  }
  async doFetch(url, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const started = Date.now();
    const bodyJson = JSON.stringify(payload);
    const body = await this.prepareRequestBody(bodyJson);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AllStak-Key": this.apiKey,
          ...body.headers
        },
        body: body.body,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) throw new HttpResponseError(res.status, res.headers.get("Retry-After"));
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    } finally {
      this.lastTransportLatencyMs = Date.now() - started;
    }
  }
  scheduleFlush(delayMs = 0) {
    if (this.closed) return;
    if (this.buffer.size === 0) return;
    if (this.flushing) {
      this.pendingRetryDelayMs = Math.max(this.pendingRetryDelayMs, delayMs);
      return;
    }
    const delay = Math.max(delayMs, this.pendingRetryDelayMs, Math.max(0, this.circuitOpenUntil - Date.now()));
    this.pendingRetryDelayMs = 0;
    const dueAt = Date.now() + delay;
    if (this.retryTimer && this.retryTimerDueAt <= dueAt) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimerDueAt = dueAt;
    const timer = setTimeout(() => {
      this.retryTimer = null;
      this.retryTimerDueAt = 0;
      void this.flushBuffer().catch(() => void 0);
    }, delay);
    this.retryTimer = timer;
    if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  }
  async flushBuffer() {
    if (this.flushing || this.buffer.size === 0) return;
    if (this.closed) return;
    this.flushing = true;
    const started = Date.now();
    try {
      const items = this.buffer.drain();
      for (const item of items) {
        if (Date.now() < this.circuitOpenUntil) {
          this.persistOne(item, false);
          this.bufferOrPersist(item);
          continue;
        }
        try {
          await this.doFetch(`${this.baseUrl}${item.path}`, item.payload);
          this.onSendSuccess(item);
        } catch (err) {
          this.onSendFailure(item, err);
        }
      }
    } catch {
    } finally {
      this.lastFlushDurationMs = Date.now() - started;
      this.flushing = false;
      if (this.buffer.size > 0) this.scheduleFlush();
    }
  }
  recordFailure(error) {
    this.consecutiveFailures++;
    const backoff = jitteredBackoff(this.consecutiveFailures);
    const retryAfterMs = retryAfterFromResponse(error);
    const delay = retryAfterMs > 0 ? retryAfterMs : backoff;
    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + delay;
    }
    return delay;
  }
  getBufferSize() {
    return this.buffer.size;
  }
  /**
   * Replay events persisted by a previous process/session (offline queue).
   * Loads the store, re-sends each entry through the existing transport (so it
   * honours the same retry/backoff/circuit-breaker), and removes an entry only
   * once it is accepted (2xx) or permanently undeliverable (non-429 4xx).
   * Transient failures keep the entry in the store for the NEXT init.
   *
   * Runs asynchronously and is fully fail-open — it never throws and never
   * blocks init. Items carry their `persistId` so a successful send clears the
   * stored copy in {@link onSendSuccess}.
   */
  drainPersisted() {
    let persistedItems;
    try {
      persistedItems = this.offlineQueue.load();
    } catch {
      return;
    }
    if (persistedItems.length === 0) return;
    for (const entry of persistedItems) {
      if (!isPersistablePath(entry.path)) {
        try {
          this.offlineQueue.remove(entry.id);
        } catch {
        }
        continue;
      }
      this.replayed++;
      this.enqueueOrDispatch({ path: entry.path, payload: entry.payload, persistId: entry.id });
    }
  }
  /**
   * Spill everything still buffered in memory into the persistent store. Called
   * on graceful shutdown (process exit / tab close) so in-flight telemetry that
   * could not be flushed in time survives a restart instead of being dropped.
   * Session lifecycle paths are skipped. Fail-open.
   */
  persistBufferedNow() {
    let items;
    try {
      items = this.buffer.drain();
    } catch {
      return;
    }
    for (const item of items) this.persistOne(item);
  }
  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryTimerDueAt = 0;
    this.pendingRetryDelayMs = 0;
    this.persistBufferedNow();
  }
  /**
   * Drain the in-memory buffer and hand the items to the caller. Used by the
   * browser unload path so the client can attempt a `navigator.sendBeacon` for
   * each event and persist only what the beacon could not take. Fail-open.
   */
  drainBufferForUnload() {
    try {
      return this.buffer.drain();
    } catch {
      return [];
    }
  }
  /**
   * Persist a single already-scrubbed item to the offline store. Session
   * lifecycle paths are skipped (counted as a real drop). Fail-open.
   */
  persistOne(item, countDropOnSkip = true) {
    if (item.persistId) {
      if (this.offlineEnabled && isPersistablePath(item.path)) {
        try {
          this.offlineQueue.enqueue({ id: item.persistId, path: item.path, payload: item.payload, ts: Date.now() });
          this.persisted++;
        } catch {
          if (countDropOnSkip) this.dropped++;
        }
      }
      return;
    }
    if (!this.offlineEnabled || !isPersistablePath(item.path)) {
      if (countDropOnSkip) this.dropped++;
      return;
    }
    try {
      const id = item.persistId ?? nextPersistedId();
      this.offlineQueue.enqueue({ id, path: item.path, payload: item.payload, ts: Date.now() });
      item.persistId = id;
      this.persisted++;
    } catch {
      if (countDropOnSkip) this.dropped++;
    }
  }
  async flush(timeoutMs = 2e3) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (this.buffer.size > 0 && !this.flushing && Date.now() >= this.circuitOpenUntil) {
        await this.flushBuffer();
      }
      if (this.buffer.size === 0 && this.inFlight.size === 0 && !this.flushing) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  noteDropped(count = 1) {
    this.dropped += Math.max(0, count);
  }
  async prepareRequestBody(bodyJson) {
    const rawBytes = byteLength(bodyJson);
    if (rawBytes < COMPRESSION_THRESHOLD_BYTES) {
      this.uncompressed++;
      return { body: bodyJson, headers: {} };
    }
    const compressed = await gzipBody(bodyJson);
    if (!compressed || compressed.byteLength >= rawBytes) {
      this.uncompressed++;
      return { body: bodyJson, headers: {} };
    }
    this.compressed++;
    this.compressionBytesSaved += rawBytes - compressed.byteLength;
    return {
      body: compressed,
      headers: { "Content-Encoding": "gzip" }
    };
  }
  getStats() {
    return {
      queued: this.buffer.size,
      sent: this.sent,
      failed: this.failed,
      dropped: this.dropped,
      retryAttempts: this.retryAttempts,
      rateLimited: this.rateLimited,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpenUntil: this.circuitOpenUntil,
      lastTransportLatencyMs: this.lastTransportLatencyMs,
      lastFlushDurationMs: this.lastFlushDurationMs,
      persisted: this.persisted,
      replayed: this.replayed,
      compressed: this.compressed,
      uncompressed: this.uncompressed,
      compressionBytesSaved: this.compressionBytesSaved
    };
  }
};
function byteLength(value) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).byteLength;
  return value.length;
}
async function gzipBody(bodyJson) {
  const compressionStream = globalThis.CompressionStream;
  if (typeof compressionStream === "function" && typeof Blob !== "undefined" && typeof Response !== "undefined") {
    try {
      const stream = new Blob([bodyJson], { type: "application/json" }).stream().pipeThrough(new compressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      return null;
    }
  }
  try {
    const proc = globalThis.process;
    const zlib = proc?.getBuiltinModule?.("node:zlib") ?? optionalRequire("node:zlib") ?? optionalRequire("zlib") ?? (proc?.versions?.node ? await import("zlib").catch(() => null) : null);
    const compressed = zlib?.gzipSync?.(bodyJson);
    return compressed ? new Uint8Array(compressed) : null;
  } catch {
    return null;
  }
}
function optionalRequire(id) {
  try {
    const req = Function('return typeof require === "function" ? require : undefined')();
    return typeof req === "function" ? req(id) : null;
  } catch {
    return null;
  }
}
function isPermanentFailure(error) {
  if (!(error instanceof HttpResponseError)) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 429;
}
function jitteredBackoff(failures) {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(8, failures - 1)));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}
function retryAfterFromResponse(error) {
  if (!(error instanceof HttpResponseError)) return 0;
  if (error.status !== 429 && error.status !== 503) return 0;
  return parseRetryAfter(error.retryAfter, Date.now());
}
function parseRetryAfter(headerValue, now) {
  if (headerValue == null) return 0;
  const value = headerValue.trim();
  if (value === "") return 0;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return 0;
    return clampRetryAfter(seconds * 1e3);
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return 0;
  const delta = dateMs - now;
  if (delta <= 0) return 0;
  return clampRetryAfter(delta);
}
function clampRetryAfter(ms) {
  if (ms <= 0) return 0;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

// src/utils/stack.ts
var V8_FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?((?:.+?):(\d+):(\d+))\)?\s*$/;
var GECKO_FRAME_RE = /^\s*(?:(.*?)@)?(.+?):(\d+):(\d+)\s*$/;
var NODE_INTERNAL_RE = /^(node:|internal\/|node_modules\/)/;
function parseStack(stack) {
  if (!stack || typeof stack !== "string") return [];
  const lines = stack.split("\n");
  const frames = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let m = V8_FRAME_RE.exec(line);
    if (m) {
      const fn = m[1] ? m[1].trim() : void 0;
      const loc = m[2];
      const lineno = parseInt(m[3], 10);
      const colno = parseInt(m[4], 10);
      const filename = stripQueryHash(loc.replace(/:\d+:\d+$/, ""));
      frames.push({
        filename,
        absPath: filename,
        function: fn,
        lineno,
        colno,
        inApp: isInApp(filename)
      });
      continue;
    }
    m = GECKO_FRAME_RE.exec(line);
    if (m && m[2]) {
      const fn = m[1] ? m[1].trim() : void 0;
      const filename = stripQueryHash(m[2]);
      frames.push({
        filename,
        absPath: filename,
        function: fn || void 0,
        lineno: parseInt(m[3], 10),
        colno: parseInt(m[4], 10),
        inApp: isInApp(filename)
      });
    }
  }
  return frames;
}
function stripQueryHash(url) {
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  let cut = url.length;
  if (q >= 0) cut = Math.min(cut, q);
  if (h >= 0) cut = Math.min(cut, h);
  return url.slice(0, cut);
}
function isInApp(filename) {
  if (!filename) return true;
  if (NODE_INTERNAL_RE.test(filename)) return false;
  if (filename.includes("/node_modules/")) return false;
  return true;
}

// src/utils/debug-id.ts
var REGISTRY_KEY = "_allstakDebugIds";
var DEBUG_ID_RE = /\/\/# debugId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;
var cache = /* @__PURE__ */ new Map();
function resolveDebugId(filename) {
  if (!filename) return void 0;
  if (cache.has(filename)) return cache.get(filename) ?? void 0;
  const registry = globalThis[REGISTRY_KEY];
  if (registry && typeof registry === "object") {
    const hit = registry[filename];
    if (typeof hit === "string" && hit.length > 0) {
      cache.set(filename, hit);
      return hit;
    }
  }
  if (typeof process === "undefined" || !process.versions?.node) {
    cache.set(filename, null);
    return void 0;
  }
  let path = filename;
  if (path.startsWith("file://")) path = path.slice("file://".length);
  if (!path.startsWith("/")) {
    cache.set(filename, null);
    return void 0;
  }
  try {
    const fs = __require("fs");
    const stat = fs.statSync(path);
    const tailSize = Math.min(stat.size, 4096);
    const fd = fs.openSync(path, "r");
    try {
      const buf = Buffer.alloc(tailSize);
      fs.readSync(fd, buf, 0, tailSize, Math.max(0, stat.size - tailSize));
      const text = buf.toString("utf8");
      const m = DEBUG_ID_RE.exec(text);
      if (m && m[1]) {
        cache.set(filename, m[1]);
        return m[1];
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
  }
  cache.set(filename, null);
  return void 0;
}

// src/utils/redact.ts
var REDACTED = "[REDACTED]";
var DEFAULT_REDACTED_KEY_PATTERNS = [
  /(^|\.)authorization$/i,
  /(^|\.)proxy-authorization$/i,
  /(^|\.)cookie$/i,
  /cookie$/i,
  /(^|\.)set-cookie$/i,
  /set[._-]?cookie$/i,
  /(^|\.)x-api-key$/i,
  /(^|\.)x-auth-token$/i,
  /(^|\.)x-access-token$/i,
  /(^|\.)x-allstak-key$/i,
  /(^|[._-])token$/i,
  /token$/i,
  /(^|[._-])api[._-]?key$/i,
  /(^|[._-])password$/i,
  /password$/i,
  /(^|[._-])passwd$/i,
  /passwd$/i,
  /(^|[._-])secret$/i,
  /secret$/i,
  /(^|[._-])session[._-]?id$/i,
  /(^|[._-])csrf$/i,
  /(^|[._-])jwt$/i,
  /jwt$/i,
  /(^|[._-])bearer$/i,
  /bearer$/i
];
var DEFAULT_MAX_DEPTH = 12;
function isSensitiveKey(key, extra = []) {
  for (const p of DEFAULT_REDACTED_KEY_PATTERNS) if (p.test(key)) return true;
  for (const p of extra) if (p.test(key)) return true;
  return false;
}
function compileExtraPatterns(extra) {
  if (!extra) return [];
  const out = [];
  for (const p of extra) {
    if (!p) continue;
    if (p instanceof RegExp) {
      out.push(p);
      continue;
    }
    try {
      out.push(new RegExp(escapeRegex(p), "i"));
    } catch {
    }
  }
  return out;
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var MAX_SCAN_LEN = 16384;
var CC_CANDIDATE = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
var SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
var EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
var IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
var IPV6 = /\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{0,4}(?:%[0-9A-Za-z]+)?\b|\b::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}\b/g;
var BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
var JWT_VALUE = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
function passesLuhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}
function scrubAlwaysPii(value) {
  try {
    let out = value.replace(CC_CANDIDATE, (match) => {
      const digits = match.replace(/[ -]/g, "");
      if (digits.length < 13 || digits.length > 19) return match;
      return passesLuhn(digits) ? REDACTED : match;
    });
    out = out.replace(SSN, REDACTED);
    out = out.replace(BEARER_VALUE, REDACTED);
    out = out.replace(JWT_VALUE, REDACTED);
    return out;
  } catch {
    return value;
  }
}
function scrubDefaultPii(value) {
  try {
    let out = value.replace(EMAIL, REDACTED);
    out = out.replace(IPV4, REDACTED);
    out = out.replace(IPV6, REDACTED);
    return out;
  } catch {
    return value;
  }
}
function scrubStringValue(value, opts) {
  if (!opts.scrubValues) return value;
  if (value.length === 0 || value.length > MAX_SCAN_LEN) return value;
  let out = scrubAlwaysPii(value);
  if (!opts.sendDefaultPii) out = scrubDefaultPii(out);
  return out;
}
function redactObject(input, options = {}) {
  if (input == null) return input;
  try {
    const extra = compileExtraPatterns(options.extraKeys);
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const seen = /* @__PURE__ */ new WeakMap();
    return walk(input, extra, 0, maxDepth, seen, options);
  } catch {
    return input;
  }
}
function redactValue(input, options = {}) {
  if (input == null) return input;
  if (typeof input !== "object") {
    return typeof input === "string" ? scrubStringValue(input, options) : input;
  }
  try {
    const extra = compileExtraPatterns(options.extraKeys);
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const seen = /* @__PURE__ */ new WeakMap();
    return walk(input, extra, 0, maxDepth, seen, options);
  } catch {
    return input;
  }
}
function walk(node, extra, depth, maxDepth, seen, valueOpts) {
  if (node == null) return node;
  const t = typeof node;
  if (t === "string") return scrubStringValue(node, valueOpts);
  if (t !== "object") return node;
  if (depth >= maxDepth) return "[MaxDepth]";
  const asObj = node;
  if (seen.has(asObj)) return "[Circular]";
  if (Array.isArray(node)) {
    const out2 = new Array(node.length);
    seen.set(asObj, out2);
    for (let i = 0; i < node.length; i++) {
      out2[i] = walk(node[i], extra, depth + 1, maxDepth, seen, valueOpts);
    }
    return out2;
  }
  const proto = Object.getPrototypeOf(node);
  if (proto !== Object.prototype && proto !== null) {
    return node;
  }
  const out = {};
  seen.set(asObj, out);
  for (const [k, v] of Object.entries(node)) {
    if (isSensitiveKey(k, extra)) {
      out[k] = REDACTED;
      continue;
    }
    out[k] = walk(v, extra, depth + 1, maxDepth, seen, valueOpts);
  }
  return out;
}
function redactHeaderRecord(headers, options = {}) {
  if (!headers) return headers;
  const extra = compileExtraPatterns(options.extraKeys);
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    out[k] = isSensitiveKey(k, extra) ? REDACTED : v;
  }
  return out;
}

// src/modules/errors.ts
function detectPlatform() {
  if (typeof globalThis.HermesInternal !== "undefined") return "react-native";
  if (typeof window !== "undefined") return "browser";
  return "node";
}
function frameToString(f) {
  const fn = f.function && f.function.length > 0 ? f.function : "<anonymous>";
  const file = f.filename || f.absPath || "<anonymous>";
  const line = typeof f.lineno === "number" ? f.lineno : 0;
  const col = typeof f.colno === "number" ? f.colno : 0;
  return `    at ${fn} (${file}:${line}:${col})`;
}
function browserRequestContext() {
  if (typeof window === "undefined" || typeof location === "undefined") return void 0;
  return {
    method: "GET",
    path: location.pathname || "/",
    host: location.host || "",
    query: location.search || void 0,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : void 0
  };
}
function runtimeMetadata(platform) {
  const out = {
    "runtime.platform": platform
  };
  if (typeof process !== "undefined" && process.versions?.node) {
    out["runtime.name"] = "node";
    out["runtime.version"] = process.versions.node;
    out["node.version"] = process.version;
    out["node.arch"] = process.arch;
    out["os.name"] = process.platform;
    out["os.arch"] = process.arch;
    if (typeof process.pid === "number") out["process.pid"] = process.pid;
    if (typeof process.title === "string" && process.title) out["process.title"] = process.title;
  } else if (typeof navigator !== "undefined") {
    out["runtime.name"] = "browser";
    out["browser.userAgent"] = navigator.userAgent;
    out["browser.language"] = navigator.language;
    if (typeof navigator.platform === "string" && navigator.platform) out["os.name"] = navigator.platform;
  }
  if (typeof window !== "undefined" && typeof location !== "undefined") {
    out["url"] = location.href;
    out["request.url"] = location.href;
  }
  return out;
}
function requestContextFromContext(context) {
  const raw = context?.requestContext;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw;
    return compactRequestContext({
      method: stringValue(r.method),
      path: stringValue(r.path),
      host: stringValue(r.host),
      route: stringValue(r.route),
      query: stringValue(r.query),
      statusCode: numberValue(r.statusCode),
      durationMs: numberValue(r.durationMs),
      userAgent: stringValue(r.userAgent)
    });
  }
  return compactRequestContext({
    method: stringValue(context?.["request.method"] ?? context?.httpMethod),
    path: stringValue(context?.["request.path"] ?? context?.httpPath),
    host: stringValue(context?.["request.host"] ?? context?.httpHost),
    route: stringValue(context?.["request.route"] ?? context?.httpRoute),
    query: stringValue(context?.["request.query"] ?? context?.httpQuery),
    statusCode: numberValue(context?.["request.status_code"] ?? context?.statusCode),
    durationMs: numberValue(context?.["request.duration_ms"] ?? context?.durationMs),
    userAgent: stringValue(context?.["request.userAgent"] ?? context?.userAgent)
  });
}
function compactRequestContext(ctx) {
  const out = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (value !== void 0 && value !== "") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
function requestMetadata(ctx) {
  if (!ctx) return {};
  const out = {};
  if (ctx.method) {
    out["request.method"] = ctx.method;
    out["http.method"] = ctx.method;
  }
  if (ctx.path) {
    out["request.path"] = ctx.path;
    out["http.path"] = ctx.path;
  }
  if (ctx.host) {
    out["request.host"] = ctx.host;
    out["http.host"] = ctx.host;
  }
  if (ctx.route) out["request.route"] = ctx.route;
  if (ctx.query) out["request.query"] = ctx.query;
  if (ctx.statusCode !== void 0) {
    out["request.status_code"] = ctx.statusCode;
    out["http.status_code"] = ctx.statusCode;
  }
  if (ctx.durationMs !== void 0) out["request.duration_ms"] = ctx.durationMs;
  if (ctx.userAgent) out["request.userAgent"] = ctx.userAgent;
  return out;
}
function stringValue(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed ? trimmed : void 0;
}
function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return void 0;
}
var INGEST_PATH = "/ingest/v1/errors";
var VALID_BREADCRUMB_TYPES = /* @__PURE__ */ new Set(["http", "log", "ui", "navigation", "query", "default"]);
var VALID_BREADCRUMB_LEVELS = /* @__PURE__ */ new Set(["info", "warn", "error", "debug"]);
var DEFAULT_MAX_BREADCRUMBS = 50;
var ErrorModule = class {
  constructor(transport, config, sessionId) {
    this.transport = transport;
    this.config = config;
    this.sessionId = sessionId;
    this.onErrorHandler = null;
    this.onUnhandledRejectionHandler = null;
    this.breadcrumbs = [];
    this.eventProcessors = [];
    this.pendingPipelines = /* @__PURE__ */ new Set();
    /**
     * Optional hook invoked when the browser autocapture observes an UNHANDLED
     * error/rejection. The client wires this to mark the release-health session
     * as crashed. Best-effort: a throwing hook never blocks capture.
     */
    this.onUnhandled = null;
    this.maxBreadcrumbs = config.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    this.setupAutocapture();
  }
  addEventProcessor(processor) {
    this.eventProcessors.push(processor);
  }
  /**
   * Register a callback fired when browser autocapture sees an unhandled
   * error/rejection (used by the client to mark the session crashed).
   */
  setOnUnhandled(callback) {
    this.onUnhandled = callback;
  }
  addBreadcrumb(type, message, level, data) {
    const crumb = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      type: VALID_BREADCRUMB_TYPES.has(type) ? type : "default",
      message,
      level: level && VALID_BREADCRUMB_LEVELS.has(level) ? level : "info",
      ...data ? { data } : {}
    };
    if (this.breadcrumbs.length >= this.maxBreadcrumbs) {
      this.breadcrumbs.shift();
    }
    this.breadcrumbs.push(crumb);
  }
  clearBreadcrumbs() {
    this.breadcrumbs = [];
  }
  getBreadcrumbCount() {
    return this.breadcrumbs.length;
  }
  /**
   * Build the release-metadata block we attach to every event. Backend stores
   * `release` + `environment` as first-class fields; the rest (sdk.name,
   * sdk.version, platform, dist, commitSha, branch) ride along inside
   * `metadata` so they survive the wire even before the backend has dedicated
   * columns. Once those columns land, the ingester reads them out of metadata.
   */
  /**
   * Value-pattern scrubbing options derived from config. `scrubValues` is
   * always on (the always-scrub CC/SSN layer must run); `sendDefaultPii`
   * gates the email/IP layer. Errors here can't throw — both fields are plain
   * boolean reads.
   */
  valueScrubOptions() {
    return { scrubValues: true, sendDefaultPii: this.config.sendDefaultPii === true };
  }
  releaseTags() {
    const out = {};
    if (this.config.sdkName) out["sdk.name"] = this.config.sdkName;
    if (this.config.sdkVersion) out["sdk.version"] = this.config.sdkVersion;
    if (this.config.platform) out["platform"] = this.config.platform;
    if (this.config.dist) out["dist"] = this.config.dist;
    if (this.config.commitSha) out["commit.sha"] = this.config.commitSha;
    if (this.config.branch) out["commit.branch"] = this.config.branch;
    return out;
  }
  captureException(error, context) {
    const parsed = parseStack(error.stack);
    const platform = this.config.platform || detectPlatform();
    const frames = parsed.map((f) => ({
      filename: f.filename,
      absPath: f.absPath,
      function: f.function,
      lineno: f.lineno,
      colno: f.colno,
      inApp: f.inApp,
      platform,
      // Try to attribute the frame to a specific bundle's debug-id so
      // the symbolicator can pick the right map. Reads either the
      // browser registry (`globalThis._allstakDebugIds`) or the bundle
      // file directly (Node). Cached per filename — repeated frames
      // pointing at the same bundle hit the cache.
      debugId: resolveDebugId(f.filename)
    }));
    const debugIdSet = /* @__PURE__ */ new Set();
    for (const f of frames) if (f.debugId) debugIdSet.add(f.debugId);
    const debugMeta = debugIdSet.size > 0 ? { images: Array.from(debugIdSet).map((id) => ({ type: "sourcemap", debugId: id })) } : void 0;
    const stackTrace = frames.length > 0 ? frames.map(frameToString) : void 0;
    const extraKeys = this.config.redactKeys;
    const scrub = this.valueScrubOptions();
    const currentBreadcrumbs = this.breadcrumbs.length > 0 ? this.breadcrumbs.map((bc) => ({
      ...bc,
      message: scrubStringValue(bc.message, scrub),
      ...bc.data ? { data: redactObject(bc.data, { extraKeys, ...scrub }) } : {}
    })) : void 0;
    this.breadcrumbs = [];
    if (!this.passesSampleRate()) return;
    const exceptionClass = (error.name && error.name !== "Error" ? error.name : void 0) || error.constructor?.name || "Error";
    const requestCtx = requestContextFromContext(context) ?? browserRequestContext();
    const transaction = stringContext(context, "transaction") ?? requestCtx?.route ?? (requestCtx?.method && requestCtx?.path ? `${requestCtx.method} ${requestCtx.path}` : void 0);
    const payload = {
      exceptionClass,
      // Scrub PII that leaked into the exception message free text. The
      // exceptionClass is a type name, not user data, so it is left intact.
      message: scrubStringValue(error.message, scrub),
      stackTrace,
      frames: frames.length > 0 ? frames : void 0,
      debugMeta,
      platform,
      sdkName: this.config.sdkName ?? SDK_NAME,
      sdkVersion: this.config.sdkVersion ?? SDK_VERSION,
      dist: this.config.dist,
      level: this.config.level ?? "error",
      environment: this.config.environment,
      release: this.config.release,
      sessionId: this.sessionId,
      traceId: stringContext(context, "traceId"),
      spanId: stringContext(context, "spanId"),
      parentSpanId: stringContext(context, "parentSpanId"),
      requestId: stringContext(context, "requestId"),
      replayId: stringContext(context, "replayId"),
      service: stringContext(context, "service"),
      user: this.config.user,
      metadata: this.buildMetadata(context, platform, requestCtx, transaction),
      breadcrumbs: currentBreadcrumbs,
      requestContext: requestCtx,
      fingerprint: this.config.fingerprint
    };
    this.enqueuePipeline(payload);
  }
  captureMessage(message, level = "info", options) {
    if (!this.passesSampleRate()) return;
    const platform = this.config.platform || detectPlatform();
    const callerMeta = options?.metadata ?? options?.data;
    const payload = {
      exceptionClass: "Message",
      // Free-text message: value-pattern scrub PII the same way as exceptions.
      message: scrubStringValue(message, this.valueScrubOptions()),
      platform,
      sdkName: this.config.sdkName ?? SDK_NAME,
      sdkVersion: this.config.sdkVersion ?? SDK_VERSION,
      dist: this.config.dist,
      level,
      environment: this.config.environment,
      release: this.config.release,
      sessionId: this.sessionId,
      user: this.config.user,
      metadata: this.buildMetadata(callerMeta, platform, browserRequestContext()),
      requestContext: browserRequestContext(),
      fingerprint: this.config.fingerprint
    };
    this.enqueuePipeline(payload);
  }
  async flush(timeoutMs = 2e3) {
    const deadline = Date.now() + timeoutMs;
    while (this.pendingPipelines.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await Promise.race([
        Promise.allSettled(Array.from(this.pendingPipelines)),
        new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
      ]);
    }
    return true;
  }
  // ── Filtering / control ─────────────────────────────────────────────
  passesSampleRate() {
    const r = this.config.sampleRate;
    if (typeof r !== "number" || r >= 1) return true;
    if (r <= 0) return false;
    return Math.random() < r;
  }
  buildMetadata(perCallContext, platform = this.config.platform || detectPlatform(), requestCtx, transaction) {
    const extraKeys = this.config.redactKeys;
    const scrub = this.valueScrubOptions();
    const opts = { extraKeys, ...scrub };
    const safePerCall = redactObject(perCallContext, opts);
    const safeTags = redactObject(this.config.tags, opts);
    const safeExtras = redactObject(this.config.extras, opts);
    const out = {
      ...this.releaseTags(),
      ...runtimeMetadata(platform),
      ...requestMetadata(requestCtx),
      ...safeTags ?? {},
      ...safeExtras ?? {},
      ...safePerCall ?? {}
    };
    delete out.requestContext;
    if (transaction) out.transaction = transaction;
    const contexts = this.config.contexts;
    if (contexts) {
      for (const [name, ctx] of Object.entries(contexts)) {
        out[`context.${name}`] = redactObject(ctx, opts) ?? ctx;
      }
    }
    return out;
  }
  async sendThroughPipeline(payload) {
    let final = this.sanitizeForWire(payload);
    for (const processor of this.allEventProcessors()) {
      if (!final) return;
      try {
        final = await processor(final);
      } catch {
      }
    }
    if (!final) return;
    const beforeSend = this.config.beforeSend;
    if (typeof beforeSend === "function") {
      try {
        final = await beforeSend(final);
      } catch {
      }
    }
    if (!final) return;
    final = this.sanitizeForWire(final);
    if (!final) return;
    this.transport.send(INGEST_PATH, final);
  }
  enqueuePipeline(payload) {
    const pending = this.sendThroughPipeline(payload).catch(() => void 0);
    this.pendingPipelines.add(pending);
    pending.finally(() => this.pendingPipelines.delete(pending)).catch(() => void 0);
  }
  sanitizeForWire(payload) {
    const extraKeys = this.config.redactKeys;
    const scrub = this.valueScrubOptions();
    const opts = { extraKeys, ...scrub };
    const out = {
      ...payload,
      message: scrubStringValue(payload.message, scrub)
    };
    if (payload.metadata) out.metadata = redactObject(payload.metadata, opts) ?? payload.metadata;
    if (payload.user) {
      out.user = redactObject(
        payload.user,
        { ...opts, sendDefaultPii: true }
      );
    }
    if (payload.requestContext) {
      out.requestContext = redactObject(payload.requestContext, opts);
    }
    if (Array.isArray(payload.breadcrumbs)) {
      out.breadcrumbs = payload.breadcrumbs.map((bc) => ({
        ...bc,
        message: scrubStringValue(bc.message, scrub),
        ...bc.data ? { data: redactObject(bc.data, opts) ?? bc.data } : {}
      }));
    }
    if (Array.isArray(payload.fingerprint)) {
      out.fingerprint = payload.fingerprint.map((part) => scrubStringValue(String(part), scrub));
    }
    return out;
  }
  allEventProcessors() {
    const configured = this.config.eventProcessors ?? [];
    return [...configured, ...this.eventProcessors];
  }
  setupAutocapture() {
    if (typeof window === "undefined") return;
    this.onErrorHandler = ((event) => {
      const errorEvent = event;
      const err = errorEvent.error instanceof Error ? errorEvent.error : new Error(errorEvent.message || "Unknown error");
      this.notifyUnhandled();
      this.captureException(err);
    });
    this.onUnhandledRejectionHandler = (event) => {
      const err = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
      this.notifyUnhandled();
      this.captureException(err);
    };
    window.addEventListener("error", this.onErrorHandler);
    window.addEventListener(
      "unhandledrejection",
      this.onUnhandledRejectionHandler
    );
  }
  notifyUnhandled() {
    try {
      this.onUnhandled?.();
    } catch {
    }
  }
  destroy() {
    if (typeof window === "undefined") return;
    if (this.onErrorHandler) {
      window.removeEventListener("error", this.onErrorHandler);
    }
    if (this.onUnhandledRejectionHandler) {
      window.removeEventListener(
        "unhandledrejection",
        this.onUnhandledRejectionHandler
      );
    }
  }
};
function stringContext(context, key) {
  const value = context?.[key];
  if (typeof value !== "string") return void 0;
  return value.trim().length > 0 ? value : void 0;
}

// src/modules/logs.ts
var INGEST_PATH2 = "/ingest/v1/logs";
var BREADCRUMB_LOG_LEVELS = /* @__PURE__ */ new Set(["warn", "error", "fatal"]);
var LogModule = class {
  constructor(transport, config) {
    this.transport = transport;
    this.config = config;
    this.onLogBreadcrumb = null;
  }
  /**
   * Register a callback for auto-breadcrumbs on warn/error/fatal logs.
   */
  setOnLogBreadcrumb(cb) {
    this.onLogBreadcrumb = cb;
  }
  send(level, message, meta) {
    if (this.onLogBreadcrumb && BREADCRUMB_LOG_LEVELS.has(level)) {
      this.onLogBreadcrumb(level, message);
    }
    const extraKeys = this.config.redactKeys;
    const scrub = {
      scrubValues: true,
      sendDefaultPii: this.config.sendDefaultPii === true
    };
    const safeMeta = redactObject(meta, { extraKeys, ...scrub });
    const payload = {
      level,
      message: scrubStringValue(message, scrub),
      service: meta?.service ?? this.config.tags?.service,
      traceId: meta?.traceId,
      environment: meta?.environment ?? this.config.environment,
      release: meta?.release ?? this.config.release,
      spanId: meta?.spanId,
      requestId: meta?.requestId,
      userId: meta?.userId ?? this.config.user?.id,
      errorId: meta?.errorId,
      metadata: safeMeta
    };
    this.transport.send(INGEST_PATH2, payload);
  }
};

// src/modules/session-replay.ts
var INGEST_PATH3 = "/ingest/v1/replay";
var FLUSH_INTERVAL_MS = 1e4;
var BATCH_SIZE_THRESHOLD = 50;
var SKIP_TAGS = /* @__PURE__ */ new Set([
  "script",
  "style",
  "link",
  "meta",
  "head",
  "noscript",
  "template",
  "svg",
  "path",
  "defs",
  "clippath"
]);
var SENSITIVE_FIELD_KEYWORDS = [
  "password",
  "passwd",
  "pass",
  "cardnumber",
  "ccnumber",
  "ccnum",
  "creditcard",
  "debitcard",
  "cvv",
  "cvc",
  "cvc2",
  "cvv2",
  "csc",
  "securitycode",
  "cardcode",
  "expiry",
  "expdate",
  "cardexpiry",
  "cardexp",
  "expirationdate",
  "expirydate",
  "ssn",
  "socialsecurity",
  "socialsecuritynumber",
  "pin",
  "secret",
  "token",
  "cardholder",
  "nameoncredit",
  "nameoncard",
  "bankaccount",
  "routingnumber",
  "accountnumber"
];
function normalizeForMasking(s) {
  return s.toLowerCase().replace(/[-_\s]/g, "");
}
var SessionReplayModule = class {
  constructor(transport, config, sessionId) {
    this.transport = transport;
    this.config = config;
    this.sessionId = sessionId;
    this.events = [];
    this.observer = null;
    this.flushTimer = null;
    this.handleClick = (e) => {
      const target = e.target instanceof Element ? e.target : null;
      this.pushEvent({
        type: "click",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        data: {
          x: e.clientX,
          y: e.clientY,
          target: target ? this.serializeElement(target) : null
        }
      });
    };
    this.handleScroll = () => {
      this.pushEvent({
        type: "scroll",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        data: {
          scrollX: window.scrollX,
          scrollY: window.scrollY
        }
      });
    };
    this.handleInput = (e) => {
      const target = e.target;
      if (!target) return;
      const shouldMask = this.shouldMaskInput(target);
      const value = shouldMask ? "[MASKED]" : target.value;
      this.pushEvent({
        type: "input",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        data: {
          target: this.serializeElement(target),
          value,
          masked: shouldMask
        }
      });
    };
    this.maskAllInputs = config.sessionReplay?.maskAllInputs ?? false;
    const sampleRate = config.sessionReplay?.sampleRate ?? 1;
    if (Math.random() > sampleRate) return;
    this.startRecording();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    if (typeof this.flushTimer === "object" && typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }
  startRecording() {
    if (typeof document === "undefined") return;
    this.captureSnapshot();
    this.flush();
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        this.pushEvent({
          type: "mutation",
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          data: {
            mutationType: mutation.type,
            target: this.serializeNode(mutation.target),
            addedNodes: mutation.addedNodes.length,
            removedNodes: mutation.removedNodes.length
          }
        });
      }
    });
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
    document.addEventListener("click", this.handleClick);
    document.addEventListener("scroll", this.handleScroll, { passive: true });
    document.addEventListener("input", this.handleInput, { capture: true });
  }
  captureSnapshot() {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const nodes = this.serializeVisibleDOM(document.body, 0);
    this.pushEvent({
      type: "snapshot",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      data: {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        title: document.title,
        nodes
      }
    });
  }
  serializeVisibleDOM(element, depth) {
    if (depth > 6) return [];
    const result = [];
    for (const child of Array.from(element.children)) {
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      const rect = child.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight * 2) continue;
      const cs = window.getComputedStyle(child);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const directText = Array.from(child.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent?.trim()).filter(Boolean).join(" ").slice(0, 150);
      const node = {
        tag,
        id: child.id || void 0,
        classes: Array.from(child.classList).slice(0, 6),
        text: directText || void 0,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        },
        styles: {
          bg: cs.backgroundColor,
          color: cs.color,
          borderRadius: cs.borderRadius,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          border: cs.border,
          display: cs.display
        },
        children: depth < 5 ? this.serializeVisibleDOM(child, depth + 1) : []
      };
      result.push(node);
    }
    return result;
  }
  /**
   * Determines whether an input field's value should be masked in replay events.
   *
   * Masking applies when ANY of the following are true:
   * 1. `maskAllInputs: true` is set in SDK config
   * 2. The input has `type="password"`
   * 3. The element has a `data-allstak-mask` attribute
   * 4. The field's name, id, autocomplete, placeholder, or aria-label contains
   *    a sensitive keyword (card, cvv, ssn, pin, password, expiry, etc.)
   */
  shouldMaskInput(el) {
    if (this.maskAllInputs) return true;
    const inputEl = el;
    if (inputEl.type?.toLowerCase() === "password") return true;
    if (el.hasAttribute("data-allstak-mask")) return true;
    const identifiers = normalizeForMasking([
      inputEl.name ?? "",
      el.id ?? "",
      inputEl.getAttribute("autocomplete") ?? "",
      inputEl.placeholder ?? "",
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("data-field") ?? ""
    ].join(" "));
    return SENSITIVE_FIELD_KEYWORDS.some((kw) => identifiers.includes(kw));
  }
  pushEvent(event) {
    this.events.push(event);
    if (this.events.length >= BATCH_SIZE_THRESHOLD) {
      this.flush();
    }
  }
  flush() {
    if (this.events.length === 0) return;
    const batch = this.events.splice(0, this.events.length);
    const currentUrl = typeof window !== "undefined" ? window.location.href : void 0;
    const payload = {
      // Use sessionId as the fingerprint — ties browser session to any captured errors
      fingerprint: this.sessionId,
      sessionId: this.sessionId,
      events: batch.map((e) => ({
        eventType: e.type,
        eventData: JSON.stringify(e.data),
        url: currentUrl,
        timestampMillis: new Date(e.timestamp).getTime()
      }))
    };
    this.transport.send(INGEST_PATH3, payload);
  }
  serializeNode(node) {
    if (node instanceof Element) {
      return this.serializeElement(node);
    }
    return node.nodeName;
  }
  serializeElement(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const classes = el.className ? `.${String(el.className).split(" ").join(".")}` : "";
    return `${tag}${id}${classes}`;
  }
  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("click", this.handleClick);
      document.removeEventListener("scroll", this.handleScroll);
      document.removeEventListener("input", this.handleInput, { capture: true });
    }
    this.flush();
  }
};

// src/modules/trace-propagation.ts
var TRACE_ID_RE = /^[0-9a-f]{32}$/;
var SPAN_ID_RE = /^[0-9a-f]{16}$/;
var ZERO_TRACE_ID_RE = /^0{32}$/;
var ZERO_SPAN_ID_RE = /^0{16}$/;
function randomHex(byteLength2) {
  const g = globalThis;
  if (g.crypto?.getRandomValues) {
    const bytes = new Uint8Array(byteLength2);
    g.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Array.from({ length: byteLength2 * 2 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}
function newTraceId() {
  let id = randomHex(16).toLowerCase();
  if (ZERO_TRACE_ID_RE.test(id)) id = `1${id.slice(1)}`;
  return id;
}
function newSpanId() {
  let id = randomHex(8).toLowerCase();
  if (ZERO_SPAN_ID_RE.test(id)) id = `1${id.slice(1)}`;
  return id;
}
function hexOnly(value) {
  return value.replace(/[^0-9a-f]/gi, "").toLowerCase();
}
function isValidTraceId(traceId) {
  return !!traceId && TRACE_ID_RE.test(traceId) && !ZERO_TRACE_ID_RE.test(traceId);
}
function isValidSpanId(spanId) {
  return !!spanId && SPAN_ID_RE.test(spanId) && !ZERO_SPAN_ID_RE.test(spanId);
}
function normalizeTraceId(traceId) {
  const hex = hexOnly(traceId);
  if (hex.length === 32 && !ZERO_TRACE_ID_RE.test(hex)) return hex;
  if (hex.length > 32) {
    const sliced = hex.slice(0, 32);
    return ZERO_TRACE_ID_RE.test(sliced) ? newTraceId() : sliced;
  }
  if (hex.length > 0) {
    const padded = hex.padEnd(32, "0");
    return ZERO_TRACE_ID_RE.test(padded) ? newTraceId() : padded;
  }
  return newTraceId();
}
function normalizeSpanId(spanId) {
  const hex = hexOnly(spanId);
  if (hex.length === 16 && !ZERO_SPAN_ID_RE.test(hex)) return hex;
  if (hex.length > 16) {
    const sliced = hex.slice(0, 16);
    return ZERO_SPAN_ID_RE.test(sliced) ? newSpanId() : sliced;
  }
  if (hex.length > 0) {
    const padded = hex.padEnd(16, "0");
    return ZERO_SPAN_ID_RE.test(padded) ? newSpanId() : padded;
  }
  return newSpanId();
}
function parseTraceparent(header) {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec((header ?? "").trim());
  if (!match) return void 0;
  const traceId = match[1].toLowerCase();
  const parentSpanId = match[2].toLowerCase();
  if (!isValidTraceId(traceId) || !isValidSpanId(parentSpanId)) return void 0;
  return {
    traceId,
    parentSpanId,
    sampled: (parseInt(match[3], 16) & 1) === 1
  };
}
function mergeBaggageValue(existing, baggage) {
  const preserved = existing.split(",").map((part) => part.trim()).filter((part) => part && !part.toLowerCase().startsWith("allstak-"));
  return [...preserved, ...baggage.split(",")].join(",");
}
function tracePropagationValues(traceId, requestId, options) {
  const sampled = options?.sampled !== false;
  const rawSpanId = options?.spanId && options.spanId.length > 0 ? options.spanId : requestId;
  const wireTraceId = normalizeTraceId(traceId);
  const spanId = normalizeSpanId(rawSpanId);
  const flag = sampled ? "01" : "00";
  const traceparent = `00-${wireTraceId}-${spanId}-${flag}`;
  const baggage = [
    `allstak-trace_id=${encodeURIComponent(wireTraceId)}`,
    `allstak-span_id=${encodeURIComponent(spanId)}`,
    `allstak-request_id=${encodeURIComponent(requestId)}`
  ].join(",");
  return { traceparent, allstakTrace: `${wireTraceId}-${spanId}-${sampled ? "1" : "0"}`, baggage, traceId: wireTraceId, requestId };
}
function findKey(headers, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return key;
  }
  return void 0;
}
function setIfMissing(headers, name, value) {
  if (!findKey(headers, name)) headers[name] = value;
}
function mergeBaggageInto(headers, name, baggage) {
  const key = findKey(headers, name);
  if (!key) {
    headers[name] = baggage;
    return;
  }
  const existing = headers[key];
  const existingStr = Array.isArray(existing) ? existing.join(",") : String(existing ?? "");
  headers[key] = mergeBaggageValue(existingStr, baggage);
}
function applyTracePropagationToHeaders(headers, traceId, requestId, options) {
  const p = tracePropagationValues(traceId, requestId, options);
  setIfMissing(headers, "traceparent", p.traceparent);
  setIfMissing(headers, "allstak-trace", p.allstakTrace);
  mergeBaggageInto(headers, "allstak-baggage", p.baggage);
  mergeBaggageInto(headers, "baggage", p.baggage);
  setIfMissing(headers, "x-allstak-trace-id", p.traceId);
  setIfMissing(headers, "x-allstak-request-id", p.requestId);
}
function targetMatches(url, targets) {
  if (!targets || targets.length === 0) return true;
  return targets.some((target) => typeof target === "string" ? url.includes(target) : target.test(url));
}
function newRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}

// src/modules/http-requests.ts
var INGEST_PATH4 = "/ingest/v1/http-requests";
var FLUSH_INTERVAL_MS2 = 5e3;
var BATCH_SIZE_THRESHOLD2 = 20;
var HttpRequestModule = class {
  constructor(transport) {
    this.transport = transport;
    this.queue = [];
    this.flushTimer = null;
    this.onCapture = null;
    this.defaults = {};
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS2);
    if (typeof this.flushTimer === "object" && typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }
  /** Apply environment / release tags to every captured request. */
  setDefaults(defaults) {
    this.defaults = { ...this.defaults, ...defaults };
  }
  /**
   * Register a callback invoked on every capture(), used for auto-breadcrumbs.
   */
  setOnCapture(cb) {
    this.onCapture = cb;
  }
  /**
   * Report an HTTP request (inbound or outbound) to AllStak.
   * Batches internally and flushes every 5s or when 20 items accumulate.
   */
  capture(item) {
    if (this.onCapture) {
      this.onCapture(item);
    }
    this.queue.push({
      traceId: item.traceId ? normalizeTraceId(item.traceId) : newTraceId(),
      requestId: item.requestId ?? newTraceId(),
      spanId: item.spanId ? normalizeSpanId(item.spanId) : void 0,
      parentSpanId: item.parentSpanId ? normalizeSpanId(item.parentSpanId) : void 0,
      direction: item.direction,
      method: item.method,
      host: item.host,
      path: item.path,
      statusCode: item.statusCode,
      durationMs: item.durationMs,
      requestSize: item.requestSize,
      responseSize: item.responseSize,
      requestBody: item.requestBody,
      responseBody: item.responseBody,
      requestHeaders: serializeHeaders(item.requestHeaders),
      responseHeaders: serializeHeaders(item.responseHeaders),
      requestBodyCaptureStatus: item.requestBodyCaptureStatus,
      responseBodyCaptureStatus: item.responseBodyCaptureStatus,
      requestBodyCaptureReason: item.requestBodyCaptureReason,
      responseBodyCaptureReason: item.responseBodyCaptureReason,
      userId: item.userId,
      errorFingerprint: item.errorFingerprint,
      environment: this.defaults.environment,
      release: this.defaults.release,
      timestamp: item.timestamp ?? (/* @__PURE__ */ new Date()).toISOString()
    });
    if (this.queue.length >= BATCH_SIZE_THRESHOLD2) {
      this.flush();
    }
  }
  flush() {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const payload = { requests: batch };
    this.transport.send(INGEST_PATH4, payload);
  }
  destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
};
function serializeHeaders(headers) {
  if (headers == null) return void 0;
  if (typeof headers === "string") return headers;
  try {
    return JSON.stringify(headers);
  } catch {
    return void 0;
  }
}

// src/modules/cron.ts
var INGEST_PATH5 = "/ingest/v1/heartbeat";
var CronModule = class {
  constructor(transport) {
    this.transport = transport;
  }
  /**
   * Report a cron job execution to AllStak.
   * The cron monitor must already exist in the dashboard with the matching slug.
   *
   * @example
   * const start = Date.now();
   * try {
   *   await runJob();
   *   AllStak.heartbeat({ slug: 'daily-report', status: 'success', durationMs: Date.now() - start });
   * } catch (err) {
   *   AllStak.heartbeat({ slug: 'daily-report', status: 'failed', durationMs: Date.now() - start, message: err.message });
   * }
   */
  heartbeat(options) {
    const payload = {
      slug: options.slug,
      status: options.status,
      durationMs: options.durationMs,
      message: options.message
    };
    this.transport.send(INGEST_PATH5, payload);
  }
};

// src/modules/tracing.ts
var INGEST_PATH6 = "/ingest/v1/spans";
var FLUSH_INTERVAL_MS3 = 5e3;
var BATCH_SIZE_THRESHOLD3 = 20;
var Span = class {
  constructor(config) {
    this._data = "";
    this._finished = false;
    this._traceId = config.traceId;
    this._spanId = config.spanId;
    this._parentSpanId = config.parentSpanId;
    this._operation = config.operation;
    this._description = config.description;
    this._service = config.service;
    this._environment = config.environment;
    this._tags = { ...config.tags };
    this._attributes = { ...config.attributes };
    this._measurements = { ...config.measurements };
    this._op = config.op;
    this._platform = config.platform;
    this._startTimeMillis = config.startTimeMillis;
    this._onFinish = config.onFinish;
  }
  /** Set a tag on this span. */
  setTag(key, value) {
    this._tags[key] = value;
    this._attributes[key] = value;
    return this;
  }
  /** Set a queryable span attribute. */
  setAttribute(key, value) {
    this._attributes[key] = value;
    return this;
  }
  /** Set a numeric span measurement. */
  setMeasurement(key, value) {
    this._measurements[key] = value;
    return this;
  }
  /** Set arbitrary string data on this span. */
  setData(data) {
    this._data = data;
    return this;
  }
  /** Set the description after creation. */
  setDescription(description) {
    this._description = description;
    return this;
  }
  /**
   * Finish the span. Status defaults to 'ok'.
   * Calling finish() more than once is a no-op.
   */
  finish(status = "ok") {
    if (this._finished) return;
    this._finished = true;
    const endTimeMillis = Date.now();
    const durationMs = endTimeMillis - this._startTimeMillis;
    this._onFinish({
      traceId: this._traceId,
      spanId: this._spanId,
      parentSpanId: this._parentSpanId,
      operation: this._operation,
      description: this._description,
      status,
      durationMs,
      startTimeMillis: this._startTimeMillis,
      endTimeMillis,
      service: this._service,
      environment: this._environment,
      tags: this._tags,
      data: this._data,
      op: this._op || inferOp(this._operation),
      platform: this._platform,
      measurements: {
        duration_ms: durationMs,
        ...this._measurements
      },
      attributes: {
        ...this._tags,
        ...this._attributes
      }
    });
  }
  get spanId() {
    return this._spanId;
  }
  get traceId() {
    return this._traceId;
  }
  get isFinished() {
    return this._finished;
  }
};
var TracingModule = class {
  constructor(transport, config) {
    this.globalState = { traceId: null, spanStack: [] };
    this.asyncStorage = createAsyncTraceStorage();
    this.completedSpans = [];
    this.spanProcessors = [];
    this.flushTimer = null;
    this.transport = transport;
    this.service = config.service || "";
    this.environment = config.environment || "";
    this.platform = config.platform || "";
    this.beforeSendSpan = config.beforeSendSpan;
    this.ignoreSpans = config.ignoreSpans ?? [];
    this.tracesSampleRate = config.tracesSampleRate;
    this.tracesSampler = config.tracesSampler;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS3);
    if (typeof this.flushTimer === "object" && typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }
  addSpanProcessor(processor) {
    this.spanProcessors.push(processor);
  }
  withTraceContext(traceId, requestIdOrCallback, maybeCallback, parentSpanId) {
    const requestId = typeof requestIdOrCallback === "function" ? void 0 : requestIdOrCallback;
    const callback = typeof requestIdOrCallback === "function" ? requestIdOrCallback : maybeCallback;
    const normalizedTraceId = traceId ? normalizeTraceId(traceId) : null;
    const spanStack = parentSpanId ? [normalizeSpanId(parentSpanId)] : [];
    if (!this.asyncStorage) {
      if (normalizedTraceId) this.globalState.traceId = normalizedTraceId;
      if (requestId) this.globalState.requestId = requestId;
      if (spanStack.length > 0) this.globalState.spanStack = spanStack;
      return callback();
    }
    return this.asyncStorage.run(
      { traceId: normalizedTraceId, requestId: requestId ?? null, spanStack, sampled: null },
      callback
    );
  }
  state() {
    return this.asyncStorage?.getStore() ?? this.globalState;
  }
  /**
   * Record the sampling decision inherited from an incoming `traceparent`.
   * Surfaced to {@link TracesSampler} as `parentSampled`; when no
   * `tracesSampler`/`tracesSampleRate` is configured this has no effect on the
   * local decision (back-compat: tracing stays always-on).
   */
  setParentSampled(parentSampled) {
    this.state().parentSampled = parentSampled;
  }
  /**
   * The sticky head-of-trace sampling decision for the current trace. Returns
   * `true` when undecided so propagation/recording stay in the historical
   * always-sampled behavior until a decision is forced.
   */
  getSampled() {
    const sampled = this.state().sampled;
    return sampled === void 0 || sampled === null ? true : sampled;
  }
  /** Get the current trace ID, creating one if none exists. */
  getTraceId() {
    const state = this.state();
    if (!state.traceId) {
      state.traceId = newTraceId();
    }
    return state.traceId;
  }
  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId) {
    this.state().traceId = normalizeTraceId(traceId);
  }
  /**
   * Continue a validated inbound W3C trace. Unlike setTraceId(), this rejects
   * malformed IDs and seeds the span stack with the upstream parent span so the
   * next local span is correctly linked as a child.
   */
  continueTrace(traceId, parentSpanId, sampled) {
    const normalizedTraceId = traceId.trim().toLowerCase();
    if (!isValidTraceId(normalizedTraceId)) return false;
    let normalizedParentSpanId = "";
    if (parentSpanId != null && parentSpanId.trim() !== "") {
      normalizedParentSpanId = parentSpanId.trim().toLowerCase();
      if (!isValidSpanId(normalizedParentSpanId)) return false;
    }
    const state = this.state();
    state.traceId = normalizedTraceId;
    state.spanStack = normalizedParentSpanId ? [normalizedParentSpanId] : [];
    state.parentSampled = typeof sampled === "boolean" ? sampled : void 0;
    state.sampled = typeof sampled === "boolean" ? sampled : null;
    return true;
  }
  getRequestId() {
    return this.state().requestId ?? null;
  }
  setRequestId(requestId) {
    this.state().requestId = requestId;
  }
  /** Get the current active span ID (top of the span stack), or null. */
  getCurrentSpanId() {
    const state = this.state();
    return state.spanStack.length > 0 ? state.spanStack[state.spanStack.length - 1] : null;
  }
  getCurrentTraceId() {
    return this.state().traceId;
  }
  getActiveSpanCount() {
    return this.state().spanStack.length;
  }
  /**
   * Start a new span. The span is automatically parented to the current
   * active span (if any). Call span.finish() when the operation completes.
   */
  startSpan(operation, options) {
    const state = this.state();
    const spanId = newSpanId();
    const parentSpanId = this.getCurrentSpanId() || "";
    const traceId = this.getTraceId();
    const recorded = this.ensureSamplingDecision(operation, {
      ...options?.tags || {},
      ...options?.attributes || {}
    });
    state.spanStack.push(spanId);
    const span = new Span({
      traceId,
      spanId,
      parentSpanId,
      operation,
      description: options?.description || "",
      service: this.service,
      environment: this.environment,
      tags: options?.tags || {},
      attributes: options?.attributes || {},
      measurements: options?.measurements || {},
      op: options?.op || inferOp(operation),
      platform: options?.platform || this.platform,
      startTimeMillis: Date.now(),
      onFinish: (spanData) => {
        const idx = state.spanStack.indexOf(spanId);
        if (idx >= 0) state.spanStack.splice(idx, 1);
        if (!recorded) return;
        const finalSpan = this.processSpan(spanData);
        if (finalSpan) this.completedSpans.push(finalSpan);
        if (this.completedSpans.length >= BATCH_SIZE_THRESHOLD3) {
          this.flush();
        }
      }
    });
    return span;
  }
  /** Flush all completed spans to the backend. */
  flush() {
    if (this.completedSpans.length === 0) return;
    const spans = this.completedSpans.splice(0, this.completedSpans.length);
    const payload = { spans };
    this.transport.send(INGEST_PATH6, payload);
  }
  /**
   * Emit a fully-formed span that was assembled outside the normal
   * start/finish lifecycle (e.g. Core Web Vitals, which are observed
   * asynchronously and reported at page-hide as a single `web.vital` span).
   *
   * The span still runs through the same ignore-list + span-processor +
   * beforeSendSpan pipeline and the same batched transport (so it respects the
   * offline queue and retry/backoff). Service/environment/platform defaults are
   * back-filled from the module config when the caller leaves them blank. Any
   * caller-supplied `traceId`/`spanId` are kept, otherwise fresh ids are minted
   * so the span is self-contained. Fully fail-open.
   */
  emitSpan(partial) {
    try {
      const now = Date.now();
      const spanData = {
        traceId: partial.traceId ? normalizeTraceId(partial.traceId) : newTraceId(),
        spanId: partial.spanId ? normalizeSpanId(partial.spanId) : newSpanId(),
        parentSpanId: partial.parentSpanId ? normalizeSpanId(partial.parentSpanId) : "",
        operation: partial.operation,
        description: partial.description ?? "",
        status: partial.status ?? "ok",
        durationMs: partial.durationMs ?? 0,
        startTimeMillis: partial.startTimeMillis ?? now,
        endTimeMillis: partial.endTimeMillis ?? now,
        service: partial.service ?? this.service,
        environment: partial.environment ?? this.environment,
        tags: partial.tags ?? {},
        data: partial.data ?? "",
        op: partial.op ?? inferOp(partial.operation),
        platform: partial.platform ?? this.platform,
        measurements: partial.measurements,
        attributes: partial.attributes
      };
      const finalSpan = this.processSpan(spanData);
      if (!finalSpan) return;
      this.completedSpans.push(finalSpan);
      this.flush();
    } catch {
    }
  }
  /** Reset trace context — clears trace ID and span stack. */
  resetTrace() {
    const state = this.state();
    state.traceId = null;
    state.requestId = null;
    state.spanStack = [];
    state.sampled = null;
    state.parentSampled = void 0;
  }
  /**
   * Resolve (and memoize) the sticky head-of-trace sampling decision for the
   * current trace.
   *
   * Precedence:
   * 1. A decision already made for this trace is reused (sticky inheritance).
   * 2. `tracesSampler(context)` — return value coerced to a decision.
   * 3. `tracesSampleRate` — probabilistic.
   * 4. Neither configured → `true` (BACK-COMPAT default: existing users who set
   *    nothing keep full tracing; we never silently disable it).
   */
  ensureSamplingDecision(operation, attributes) {
    const state = this.state();
    if (state.sampled === true || state.sampled === false) return state.sampled;
    let decision;
    if (this.tracesSampler) {
      const context = {
        name: operation,
        parentSampled: state.parentSampled,
        attributes
      };
      let result;
      try {
        result = this.tracesSampler(context);
      } catch {
        result = true;
      }
      decision = typeof result === "number" ? rollSample(result) : !!result;
    } else if (typeof this.tracesSampleRate === "number") {
      decision = rollSample(this.tracesSampleRate);
    } else {
      decision = true;
    }
    state.sampled = decision;
    return decision;
  }
  /** Stop the flush timer and do a final flush. */
  destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
  processSpan(span) {
    if (this.shouldIgnoreSpan(span)) return null;
    let final = span;
    for (const processor of this.spanProcessors) {
      if (!final) return null;
      try {
        final = processor(final) ?? null;
      } catch {
      }
    }
    if (!final) return null;
    if (this.beforeSendSpan) {
      try {
        final = this.beforeSendSpan(final) ?? null;
      } catch {
      }
    }
    return final ?? null;
  }
  shouldIgnoreSpan(span) {
    return this.ignoreSpans.some((pattern) => {
      if (typeof pattern === "function") return pattern(span);
      const target = `${span.operation} ${span.description}`;
      if (typeof pattern === "string") return target.includes(pattern);
      return pattern.test(target);
    });
  }
};
function createAsyncTraceStorage() {
  const proc = globalThis.process;
  if (false) return null;
  try {
    const fromProcess = proc?.getBuiltinModule?.("node:async_hooks")?.AsyncLocalStorage;
    if (fromProcess) return new fromProcess();
    const req = typeof __require === "function" ? __require : void 0;
    const AsyncLocalStorage = req?.("node:async_hooks").AsyncLocalStorage;
    return AsyncLocalStorage ? new AsyncLocalStorage() : null;
  } catch {
    return null;
  }
}
function rollSample(rate) {
  if (!(typeof rate === "number") || Number.isNaN(rate)) return true;
  const clamped = Math.max(0, Math.min(1, rate));
  if (clamped >= 1) return true;
  if (clamped <= 0) return false;
  return Math.random() < clamped;
}
function inferOp(operation) {
  const trimmed = operation.trim();
  const methodMatch = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i.exec(trimmed);
  if (methodMatch) return "http.server";
  if (trimmed.startsWith("db.") || trimmed.includes(".query")) return "db";
  if (trimmed.startsWith("http.") || trimmed.includes("fetch") || trimmed.includes("request")) return "http.client";
  return trimmed.includes(".") ? trimmed.split(".")[0] || trimmed : "custom";
}

// src/modules/web-vitals.ts
var WEB_VITAL_OP = "web.vital";
function isWebVitalsSupported() {
  return typeof window !== "undefined" && typeof globalThis.PerformanceObserver !== "undefined";
}
var WebVitalsModule = class {
  constructor(tracing, context = {}) {
    this.observers = [];
    this.cleanup = [];
    this.sent = false;
    this.started = false;
    this.cls = 0;
    this.clsObserved = false;
    this.tracing = tracing;
    this.context = context;
  }
  /**
   * Begin observing Core Web Vitals. Idempotent and fail-open: a second call is
   * a no-op, and any error wiring an observer is swallowed so the host page is
   * never affected. Does nothing outside a browser-with-PerformanceObserver.
   */
  start() {
    if (this.started) return;
    this.started = true;
    if (!isWebVitalsSupported()) return;
    this.collectNavigationTiming();
    this.observeLcp();
    this.observeCls();
    this.observeInp();
    this.observeFcp();
    this.installReportHooks();
  }
  // ── Observers ──────────────────────────────────────────────────────────────
  get PO() {
    return globalThis.PerformanceObserver;
  }
  safeObserve(type, handle, extra = { buffered: true }) {
    const Ctor = this.PO;
    if (!Ctor) return;
    try {
      const observer = new Ctor((list) => {
        try {
          handle(list.getEntries());
        } catch {
        }
      });
      observer.observe({ type, buffered: extra.buffered !== false });
      this.observers.push(observer);
    } catch {
    }
  }
  /** LCP = the value of the LAST largest-contentful-paint entry. */
  observeLcp() {
    this.safeObserve("largest-contentful-paint", (entries) => {
      const last = entries[entries.length - 1];
      if (last && typeof last.startTime === "number") {
        const value = typeof last.renderTime === "number" && last.renderTime > 0 ? last.renderTime : typeof last.loadTime === "number" && last.loadTime > 0 ? last.loadTime : last.startTime;
        this.lcp = value;
      }
    });
  }
  /** CLS = sum of layout-shift values WITHOUT recent user input. */
  observeCls() {
    this.safeObserve("layout-shift", (entries) => {
      for (const entry of entries) {
        if (!entry.hadRecentInput && typeof entry.value === "number") {
          this.cls += entry.value;
          this.clsObserved = true;
        }
      }
    });
  }
  /**
   * INP from `event` timing (max interaction latency), and FID from the first
   * `first-input` entry as a fallback. INP entries are large, so the browser
   * requires an explicit `durationThreshold`; we keep the default and read the
   * worst observed duration.
   */
  observeInp() {
    this.safeObserve("event", (entries) => {
      for (const entry of entries) {
        if (typeof entry.duration === "number") {
          this.inp = this.inp === void 0 ? entry.duration : Math.max(this.inp, entry.duration);
        }
      }
    });
    this.safeObserve("first-input", (entries) => {
      const first = entries[0];
      if (first && typeof first.processingStart === "number" && typeof first.startTime === "number") {
        this.fid = Math.max(0, first.processingStart - first.startTime);
      }
    });
  }
  /** FCP from the paint-timing `first-contentful-paint` entry. */
  observeFcp() {
    this.safeObserve("paint", (entries) => {
      for (const entry of entries) {
        if (entry.name === "first-contentful-paint" && typeof entry.startTime === "number") {
          this.fcp = entry.startTime;
        }
      }
    });
  }
  /**
   * TTFB (and a fallback FCP) from navigation timing. `responseStart` relative
   * to the navigation start is TTFB. Read eagerly at start so it is available
   * even if the navigation entry buffer is empty by report time.
   */
  collectNavigationTiming() {
    try {
      const perf = globalThis.performance;
      const navEntries = perf?.getEntriesByType?.("navigation");
      const nav = navEntries && navEntries[0];
      if (nav && typeof nav.responseStart === "number" && nav.responseStart >= 0) {
        this.ttfb = nav.responseStart;
      } else if (perf?.timing && typeof perf.timing.responseStart === "number") {
        const t = perf.timing;
        if (typeof t.navigationStart === "number") {
          this.ttfb = Math.max(0, t.responseStart - t.navigationStart);
        }
      }
    } catch {
    }
  }
  // ── Report on hide ──────────────────────────────────────────────────────────
  installReportHooks() {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onHide = () => this.report();
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        this.report();
      }
    };
    window.addEventListener("pagehide", onHide);
    this.cleanup.push(() => window.removeEventListener("pagehide", onHide));
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", onVisibility);
      this.cleanup.push(() => document.removeEventListener("visibilitychange", onVisibility));
    }
  }
  /**
   * Finalize the collected metrics and emit a single `web.vital` span. Guarded
   * so it sends at most once (visibilitychange + pagehide can both fire on a
   * single tab close). Emits nothing when no metric was collected.
   */
  report() {
    if (this.sent) return;
    this.sent = true;
    if (this.ttfb === void 0) this.collectNavigationTiming();
    const measurements = {};
    const set = (key, value) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        measurements[key] = key === "CLS" ? round(value, 4) : Math.round(value);
      }
    };
    set("LCP", this.lcp);
    if (this.clsObserved) set("CLS", this.cls);
    set("INP", this.inp ?? this.fid);
    set("FCP", this.fcp);
    set("TTFB", this.ttfb);
    this.disconnectObservers();
    if (Object.keys(measurements).length === 0) return;
    this.tracing.emitSpan({
      operation: WEB_VITAL_OP,
      op: WEB_VITAL_OP,
      description: "Core Web Vitals",
      status: "ok",
      durationMs: 0,
      service: this.context.service,
      environment: this.context.environment,
      platform: this.context.platform ?? "browser",
      measurements,
      attributes: pruneUndefined({
        "web_vital.report": "page_hide",
        release: this.context.release,
        sessionId: this.context.sessionId
      })
    });
  }
  disconnectObservers() {
    for (const observer of this.observers) {
      try {
        observer.disconnect();
      } catch {
      }
    }
    this.observers = [];
  }
  /** Stop observing and remove report hooks. Best-effort, idempotent. */
  destroy() {
    this.disconnectObservers();
    for (const fn of this.cleanup) {
      try {
        fn();
      } catch {
      }
    }
    this.cleanup = [];
  }
};
function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
function pruneUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

// src/modules/database.ts
var INGEST_PATH7 = "/ingest/v1/db";
var FLUSH_INTERVAL_MS4 = 5e3;
var BATCH_SIZE_THRESHOLD4 = 20;
var DatabaseModule = class {
  constructor(transport, moduleConfig) {
    this.transport = transport;
    this.moduleConfig = moduleConfig;
    this.queue = [];
    this.flushTimer = null;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS4);
    if (typeof this.flushTimer === "object" && typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }
  /**
   * Record a database query. Batches internally and flushes every 5s or
   * when 20 items accumulate.
   */
  capture(item) {
    this.queue.push({
      ...item,
      service: item.service ?? this.moduleConfig.service,
      environment: item.environment ?? this.moduleConfig.environment
    });
    if (this.queue.length >= BATCH_SIZE_THRESHOLD4) {
      this.flush();
    }
  }
  flush() {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const payload = { queries: batch };
    this.transport.send(INGEST_PATH7, payload);
  }
  destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
};
function enableDbAutoInstrumentation(dbModule, config) {
  instrumentPg(dbModule, config);
  instrumentMysql2(dbModule, config);
  instrumentSqlite(dbModule, config);
}

// src/utils/uuid.ts
function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}

// src/release-registration.ts
var registered = /* @__PURE__ */ new Set();
var SDK_NAME2 = "allstak-js";
var SDK_VERSION2 = "0.2.4";
function canRegisterRuntimeRelease() {
  return typeof window === "undefined" && typeof process !== "undefined" && !!process.versions?.node;
}
function registerRuntimeRelease(options) {
  if (options.enabled === false) return;
  if (options.enabled !== true && isTestRuntime()) return;
  const release = options.release?.trim();
  if (options.enabled !== true && !canRegisterRuntimeRelease()) return;
  if (!options.apiKey || !release) return;
  const environment = options.environment || "production";
  const key = `${options.host}|${options.apiKey}|${environment}|${release}`;
  if (registered.has(key)) return;
  registered.add(key);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return;
  const payload = {
    version: release,
    environment,
    commitSha: options.commitSha,
    branch: options.branch,
    author: `${SDK_NAME2}/${SDK_VERSION2}`,
    message: "Registered automatically by AllStak SDK at runtime"
  };
  if (options.service) payload.service = options.service;
  void fetchImpl(`${options.host.replace(/\/$/, "")}/ingest/v1/releases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AllStak-Key": options.apiKey,
      "User-Agent": `${SDK_NAME2}/${SDK_VERSION2}`
    },
    body: JSON.stringify(payload)
  }).catch(() => void 0);
}
function isTestRuntime() {
  try {
    if (process.env.NODE_ENV === "test" || process.env.VITEST === "true" || process.env.VITEST_WORKER_ID != null || process.env.VITEST_POOL_ID != null) {
      return true;
    }
  } catch {
    return false;
  }
  try {
    return globalThis.__vitest_worker__ != null;
  } catch {
    return false;
  }
}
function _resetRuntimeReleaseRegistrationForTest() {
  registered.clear();
}

// src/session.ts
var PATH_START = "/ingest/v1/sessions/start";
var PATH_END = "/ingest/v1/sessions/end";
var SESSION_STATE_VERSION = 1;
var SESSION_STATE_PREFIX = "allstak.session.v1";
var SESSION_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_RECOVERY_LOCK_MS = 3e4;
var SESSION_RECOVERY_MAX_ATTEMPTS = 3;
var Session = class {
  constructor(id = generateId(), startedAt = Date.now()) {
    this._status = "ok";
    this._errorCount = 0;
    this.id = id;
    this.startedAt = startedAt;
  }
  get status() {
    return this._status;
  }
  get errorCount() {
    return this._errorCount;
  }
  /** Increment the error counter and bump OK→ERRORED (terminal status wins). */
  recordError() {
    this._errorCount++;
    if (this._status === "ok") this._status = "errored";
  }
  /** Mark a terminal crashed status (overrides ERRORED). Used by the uncaught handler. */
  recordCrash() {
    this._status = "crashed";
    this._errorCount++;
  }
  /** Promote to ABNORMAL only if still OK or ERRORED (never downgrade CRASHED). */
  recordAbnormalExit() {
    if (this._status === "ok" || this._status === "errored") this._status = "abnormal";
  }
  /** Duration from start to now, floored at 0. */
  durationMs() {
    return Math.max(0, Date.now() - this.startedAt);
  }
};
function isTestRuntime2() {
  try {
    if (typeof process !== "undefined" && process.env) {
      return process.env.NODE_ENV === "test" || process.env.VITEST === "true" || process.env.VITEST_WORKER_ID != null || process.env.VITEST_POOL_ID != null;
    }
  } catch {
  }
  try {
    if (globalThis.__vitest_worker__ != null) return true;
  } catch {
  }
  return false;
}
var SessionTracker = class {
  constructor(config, transport, sessionId, options = {}) {
    this.config = config;
    this.transport = transport;
    this.sessionId = sessionId;
    this.active = null;
    this.ended = false;
    this.cleanup = [];
    this.storageKey = options.storageKey ?? sessionStorageKey(config);
    this.storage = options.storage === void 0 ? defaultSessionStateStorage() : options.storage;
  }
  /**
   * Idempotent. Reuses the client's existing session id, sends `/sessions/start`,
   * and installs the graceful-shutdown end hooks. Returns the active session.
   * Fail-open: never throws.
   */
  start() {
    if (this.active) return this.active;
    this.recoverPreviousSession();
    const session = new Session(this.sessionId);
    this.active = session;
    try {
      const release = this.resolveRelease();
      this.writeState({
        version: SESSION_STATE_VERSION,
        sessionId: session.id,
        startedAt: session.startedAt,
        updatedAt: Date.now(),
        status: session.status,
        release,
        environment: this.config.environment,
        userId: this.config.user?.id,
        sdkName: this.config.sdkName,
        sdkVersion: this.config.sdkVersion,
        platform: this.config.platform,
        closed: false
      });
      if (release) {
        const payload = {
          sessionId: session.id,
          release,
          environment: this.config.environment,
          userId: this.config.user?.id,
          sdkName: this.config.sdkName,
          sdkVersion: this.config.sdkVersion,
          platform: this.config.platform
        };
        this.transport.send(PATH_START, payload);
      }
      this.installShutdownHooks();
    } catch {
    }
    return session;
  }
  /** The active session, or null if not started / already ended. */
  current() {
    return this.ended ? null : this.active;
  }
  /** Record a HANDLED error against the active session. No I/O. */
  recordError() {
    const session = this.current();
    session?.recordError();
    if (session) this.updateOpenState(session);
  }
  /** Record an UNHANDLED/fatal crash. No I/O — the end POST carries the status. */
  recordCrash() {
    const session = this.current();
    session?.recordCrash();
    if (session) this.updateOpenState(session);
  }
  /**
   * Terminate the session and POST `/sessions/end`. Idempotent and best-effort.
   * When `finalStatus` is omitted the session's accumulated status is used.
   * Fail-open: never throws.
   */
  end(finalStatus) {
    if (this.ended) return;
    const session = this.active;
    this.active = null;
    if (!session) {
      this.ended = true;
      return;
    }
    this.ended = true;
    this.removeShutdownHooks();
    try {
      const status = finalStatus ?? session.status;
      this.writeState({
        version: SESSION_STATE_VERSION,
        sessionId: session.id,
        startedAt: session.startedAt,
        updatedAt: Date.now(),
        status,
        release: this.resolveRelease(),
        environment: this.config.environment,
        userId: this.config.user?.id,
        sdkName: this.config.sdkName,
        sdkVersion: this.config.sdkVersion,
        platform: this.config.platform,
        closed: true,
        endedAt: Date.now()
      });
      const release = this.resolveRelease();
      if (!release) return;
      const payload = {
        sessionId: session.id,
        durationMs: Math.min(Number.MAX_SAFE_INTEGER, session.durationMs()),
        status
      };
      this.transport.send(PATH_END, payload);
    } catch {
    }
  }
  /**
   * The session's `release` falls back to `sdkVersion` (then nothing) so a
   * session is still attributable even when no release is configured.
   */
  resolveRelease() {
    const release = this.config.release?.trim();
    if (release) return release;
    const sdkVersion = this.config.sdkVersion?.trim();
    return sdkVersion || void 0;
  }
  recoverPreviousSession() {
    const previous = this.readState();
    if (!previous) return;
    const now = Date.now();
    if (previous.closed) {
      this.removeState();
      return;
    }
    if (now - previous.startedAt > SESSION_STATE_MAX_AGE_MS) {
      this.removeState();
      return;
    }
    if ((previous.recoveryAttempts ?? 0) >= SESSION_RECOVERY_MAX_ATTEMPTS) {
      this.removeState();
      return;
    }
    if (previous.recoveryLockUntil && previous.recoveryLockUntil > now) {
      return;
    }
    const owner = generateId();
    const locked = {
      ...previous,
      recoveryAttempts: (previous.recoveryAttempts ?? 0) + 1,
      recoveryLockOwner: owner,
      recoveryLockUntil: now + SESSION_RECOVERY_LOCK_MS,
      updatedAt: now
    };
    this.writeState(locked);
    const claimed = this.readState();
    if (!claimed || claimed.recoveryLockOwner !== owner) return;
    const status = previous.status === "crashed" ? "crashed" : "abnormal";
    const endedAt = previous.updatedAt || now;
    try {
      this.transport.send(PATH_END, {
        sessionId: previous.sessionId,
        durationMs: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, endedAt - previous.startedAt)),
        status
      });
      this.writeState({
        ...locked,
        status,
        closed: true,
        endedAt: now,
        recoveredAt: now,
        recoveryLockUntil: void 0
      });
    } catch {
      this.writeState({
        ...locked,
        recoveryLockUntil: 0
      });
    }
  }
  updateOpenState(session) {
    const current = this.readState();
    if (!current || current.sessionId !== session.id || current.closed) return;
    this.writeState({
      ...current,
      status: session.status,
      updatedAt: Date.now(),
      userId: this.config.user?.id
    });
  }
  readState() {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!isPersistedSessionState(parsed)) {
        this.removeState();
        return null;
      }
      return parsed;
    } catch {
      this.removeState();
      return null;
    }
  }
  writeState(state) {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(state));
    } catch {
    }
  }
  removeState() {
    if (!this.storage) return;
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
    }
  }
  // ── Graceful-shutdown hooks ───────────────────────────────────────────────
  installShutdownHooks() {
    const endOnce = () => this.end();
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      const onPageHide = () => endOnce();
      const onVisibility = () => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") endOnce();
      };
      window.addEventListener("pagehide", onPageHide);
      this.cleanup.push(() => window.removeEventListener("pagehide", onPageHide));
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("visibilitychange", onVisibility);
        this.cleanup.push(() => document.removeEventListener("visibilitychange", onVisibility));
      }
      return;
    }
    if (typeof process !== "undefined" && typeof process.on === "function") {
      const onExit = () => endOnce();
      process.on("beforeExit", onExit);
      process.on("exit", onExit);
      process.on("SIGTERM", onExit);
      this.cleanup.push(() => {
        if (typeof process.off === "function") {
          process.off("beforeExit", onExit);
          process.off("exit", onExit);
          process.off("SIGTERM", onExit);
        }
      });
    }
  }
  removeShutdownHooks() {
    for (const fn of this.cleanup) {
      try {
        fn();
      } catch {
      }
    }
    this.cleanup = [];
  }
};
function isPersistedSessionState(value) {
  if (!value || typeof value !== "object") return false;
  const s = value;
  return s.version === SESSION_STATE_VERSION && typeof s.sessionId === "string" && s.sessionId.length > 0 && typeof s.startedAt === "number" && Number.isFinite(s.startedAt) && typeof s.updatedAt === "number" && Number.isFinite(s.updatedAt) && (s.status === "ok" || s.status === "errored" || s.status === "crashed" || s.status === "abnormal");
}
function sessionStorageKey(config) {
  return `${SESSION_STATE_PREFIX}.${stableHash([
    config.host ?? "",
    config.apiKey ?? "",
    config.release ?? "",
    config.sdkName ?? ""
  ].join("|"))}`;
}
function stableHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
function defaultSessionStateStorage() {
  return browserSessionStateStorage() ?? nodeSessionStateStorage();
}
function browserSessionStateStorage() {
  try {
    const storage = typeof window !== "undefined" ? window.localStorage : void 0;
    if (!storage) return null;
    const probe = "__allstak_session_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}
var FileSessionStateStorage = class {
  constructor(fs, dir) {
    this.fs = fs;
    this.dir = dir;
    this.fs.mkdirSync(this.dir, { recursive: true });
  }
  getItem(key) {
    try {
      const file = this.fileFor(key);
      return this.fs.existsSync(file) ? this.fs.readFileSync(file, "utf8") : null;
    } catch {
      return null;
    }
  }
  setItem(key, value) {
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      this.fs.writeFileSync(this.fileFor(key), value);
    } catch {
    }
  }
  removeItem(key) {
    try {
      const file = this.fileFor(key);
      if (this.fs.existsSync(file)) this.fs.unlinkSync(file);
    } catch {
    }
  }
  fileFor(key) {
    return `${this.dir}/${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
  }
};
function nodeSessionStateStorage() {
  try {
    if (typeof process === "undefined" || !process.versions?.node || typeof window !== "undefined") {
      return null;
    }
    const proc = globalThis.process;
    const fs = proc?.getBuiltinModule?.("node:fs") ?? (typeof __require === "function" ? __require("fs") : null);
    const os = proc?.getBuiltinModule?.("node:os") ?? (typeof __require === "function" ? __require("os") : null);
    if (!fs) return null;
    const tmp = os?.tmpdir?.() ?? "/tmp";
    return new FileSessionStateStorage(fs, `${String(tmp).replace(/\/$/, "")}/allstak-session-state`);
  } catch {
    return null;
  }
}

// src/integration.ts
var installedOnce = /* @__PURE__ */ new Set();
function defineIntegration(factory) {
  return factory;
}
function getIntegrationsToSetup(options) {
  const defaults = resolveDefaultIntegrations(options.defaultIntegrations);
  for (const integration of defaults) {
    integration.isDefaultInstance = true;
  }
  const user = options.integrations;
  if (Array.isArray(user)) {
    return filterDuplicateIntegrations([...defaults, ...user]);
  }
  if (typeof user === "function") {
    const resolved = user(defaults);
    return filterDuplicateIntegrations(Array.isArray(resolved) ? resolved : [resolved]);
  }
  return filterDuplicateIntegrations(defaults);
}
function setupIntegrations(client, integrations) {
  const index = {};
  for (const integration of integrations) {
    if (index[integration.name]) continue;
    index[integration.name] = integration;
    if (integration.setupOnce && !installedOnce.has(integration.name)) {
      integration.setupOnce();
      installedOnce.add(integration.name);
    }
    integration.setup?.(client);
    if (integration.processEvent) {
      client.addEventProcessor((event) => integration.processEvent(event, client));
    }
    if (integration.processSpan) {
      client.addSpanProcessor((span) => integration.processSpan(span, client));
    }
  }
  return index;
}
function resolveDefaultIntegrations(value) {
  if (value === false) return [];
  if (Array.isArray(value)) return [...value];
  return [];
}
function filterDuplicateIntegrations(integrations) {
  const byName = {};
  for (const integration of integrations) {
    const existing = byName[integration.name];
    if (existing && !existing.isDefaultInstance && integration.isDefaultInstance) {
      continue;
    }
    byName[integration.name] = integration;
  }
  return Object.values(byName);
}

// src/modules/auto-breadcrumbs.ts
var CLICK_FLAG = "__allstak_click_patched__";
function instrumentFetch(addBreadcrumb, captureRequest, ownBaseUrl, traceContext, bodyCapture, tracePropagationTargets) {
  if (typeof globalThis.fetch !== "function") return;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const method = init?.method?.toUpperCase() || "GET";
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const safePath = url.split("?")[0];
    const isOwnIngest = ownBaseUrl && url.startsWith(ownBaseUrl);
    const correlation = !isOwnIngest ? traceContext?.() : void 0;
    const requestId = correlation?.requestId ?? generateRequestId();
    const traceId = correlation?.traceId;
    const shouldPropagate = !isOwnIngest && traceId && targetMatches2(url, tracePropagationTargets);
    const propagatedInit = shouldPropagate ? withTraceHeaders(input, init, traceId, requestId, {
      sampled: correlation?.sampled,
      spanId: correlation?.spanId
    }) : init;
    let host = "";
    let path = safePath;
    try {
      const u = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost");
      host = u.host;
      path = u.pathname || "/";
    } catch {
    }
    const start = Date.now();
    try {
      const response = await originalFetch.call(this, input, propagatedInit);
      const durationMs = Date.now() - start;
      addBreadcrumb(
        "http",
        `${method} ${safePath} -> ${response.status}`,
        response.status >= 400 ? "error" : "info",
        { method, url: safePath, statusCode: response.status, durationMs }
      );
      if (captureRequest && !isOwnIngest) {
        try {
          const captured = await captureBodies(input, propagatedInit, response, bodyCapture);
          captureRequest({
            direction: "outbound",
            method,
            host,
            path,
            statusCode: response.status,
            durationMs,
            traceId,
            requestId,
            ...captured
          });
        } catch {
        }
      }
      return response;
    } catch (err) {
      const durationMs = Date.now() - start;
      addBreadcrumb("http", `${method} ${safePath} -> failed`, "error", {
        method,
        url: safePath,
        error: String(err),
        durationMs
      });
      if (captureRequest && !isOwnIngest) {
        try {
          captureRequest({
            direction: "outbound",
            method,
            host,
            path,
            statusCode: 0,
            durationMs,
            traceId,
            requestId
          });
        } catch {
        }
      }
      throw err;
    }
  };
}
async function captureBodies(input, init, response, options) {
  if (!options?.enabled) {
    return {
      requestBodyCaptureStatus: "disabled",
      responseBodyCaptureStatus: "disabled",
      requestBodyCaptureReason: "HTTP body capture is disabled by SDK configuration.",
      responseBodyCaptureReason: "HTTP body capture is disabled by SDK configuration."
    };
  }
  const requestHeaders = headersToObject(init?.headers);
  const responseHeaders = headersToObject(response.headers);
  const contentTypes = options.contentTypes ?? ["application/json", "text/plain"];
  const maxBodySize = Math.max(0, options.maxBodySize ?? 8192);
  const requestCapture = typeof init?.body === "string" ? sanitizeBody(init.body, requestHeaders["content-type"], contentTypes, maxBodySize, options.redactFields) : { status: "unsupported", reason: "Request body was not a string init.body and cannot be safely cloned." };
  let responseCapture = { status: "unsupported", reason: "Response content type is not allowlisted for body capture." };
  const responseContentType = responseHeaders["content-type"];
  if (isAllowedContentType(responseContentType, contentTypes)) {
    try {
      responseCapture = sanitizeBody(await response.clone().text(), responseContentType, contentTypes, maxBodySize, options.redactFields);
    } catch {
      responseCapture = { status: "unsupported", reason: "Response body could not be cloned safely." };
    }
  }
  void input;
  return {
    requestBody: requestCapture.body,
    responseBody: responseCapture.body,
    requestHeaders: sanitizeHeaders(requestHeaders),
    responseHeaders: sanitizeHeaders(responseHeaders),
    requestBodyCaptureStatus: requestCapture.status,
    responseBodyCaptureStatus: responseCapture.status,
    requestBodyCaptureReason: requestCapture.reason,
    responseBodyCaptureReason: responseCapture.reason
  };
}
function headersToObject(headers) {
  if (!headers) return {};
  const out = {};
  new Headers(headers).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}
function sanitizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    out[normalized] = /authorization|cookie|token|secret|password|otp|session/i.test(normalized) ? "[REDACTED]" : value;
  }
  return out;
}
function sanitizeBody(body, contentType, allowedContentTypes, maxBodySize, customFields) {
  if (!isAllowedContentType(contentType, allowedContentTypes)) {
    return { status: "unsupported", reason: "Content type is not allowlisted for HTTP body capture." };
  }
  const truncated = body.length > maxBodySize;
  const raw = truncated ? body.slice(0, maxBodySize) + "\n[TRUNCATED]" : body;
  let sanitized;
  try {
    const parsed = JSON.parse(raw.replace(/\n\[TRUNCATED]$/, ""));
    sanitized = JSON.stringify(redactValue2(parsed, customFields), null, 2) + (truncated ? "\n[TRUNCATED]" : "");
  } catch {
    sanitized = redactText(raw);
  }
  const redacted = sanitized !== raw;
  return {
    body: sanitized,
    status: truncated ? "truncated" : redacted ? "redacted" : "captured",
    reason: truncated ? `Body exceeded configured max size of ${maxBodySize} bytes.` : redacted ? "Sensitive fields or values were redacted before transport." : void 0
  };
}
function isAllowedContentType(contentType, allowed) {
  if (!contentType) return false;
  return allowed.some((candidate) => contentType.toLowerCase().includes(candidate.toLowerCase()));
}
function redactValue2(value, customFields = []) {
  if (Array.isArray(value)) return value.map((item) => redactValue2(item, customFields));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSensitiveKey2(key, customFields) ? "[REDACTED]" : redactValue2(child, customFields);
    }
    return out;
  }
  if (typeof value === "string") return redactText(value);
  return value;
}
function isSensitiveKey2(key, customFields) {
  return /password|passcode|authorization|cookie|otp|token|jwt|secret|refresh|iban|national.?id|card/i.test(key) || customFields.some((field) => field.toLowerCase() === key.toLowerCase());
}
function redactText(value) {
  const tokenScrubbed = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
  return scrubStringValue(tokenScrubbed, { scrubValues: true, sendDefaultPii: true });
}
function generateRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
function targetMatches2(url, targets) {
  if (!targets || targets.length === 0) return true;
  return targets.some((target) => typeof target === "string" ? url.includes(target) : target.test(url));
}
function withTraceHeaders(input, init, traceId, requestId, options) {
  const next = { ...init ?? {} };
  const headers = new Headers(init?.headers ?? requestHeadersFromInput(input));
  const sampled = options?.sampled !== false;
  const rawSpanId = options?.spanId && options.spanId.length > 0 ? options.spanId : requestId;
  const spanId = normalizeSpanId(rawSpanId.replace(/-/g, ""));
  const flag = sampled ? "01" : "00";
  const traceparent = `00-${normalizeTraceId(traceId)}-${spanId}-${flag}`;
  const baggage = [
    `allstak-trace_id=${encodeURIComponent(traceId)}`,
    `allstak-span_id=${encodeURIComponent(spanId)}`,
    `allstak-request_id=${encodeURIComponent(requestId)}`
  ].join(",");
  setHeaderIfMissing(headers, "traceparent", traceparent);
  setHeaderIfMissing(headers, "allstak-trace", `${traceId}-${spanId}-${sampled ? "1" : "0"}`);
  mergeAllStakBaggage(headers, baggage);
  setHeaderIfMissing(headers, "x-allstak-trace-id", traceId);
  setHeaderIfMissing(headers, "x-allstak-request-id", requestId);
  next.headers = headers;
  return next;
}
function requestHeadersFromInput(input) {
  if (typeof Request !== "undefined" && input instanceof Request) return input.headers;
  return void 0;
}
function setHeaderIfMissing(headers, key, value) {
  if (!headers.has(key)) headers.set(key, value);
}
function mergeAllStakBaggage(headers, baggage) {
  const allstakBaggage = headers.get("allstak-baggage");
  if (!allstakBaggage) {
    headers.set("allstak-baggage", baggage);
  } else {
    headers.set("allstak-baggage", mergeBaggageValue(allstakBaggage, baggage));
  }
  const standardBaggage = headers.get("baggage");
  if (!standardBaggage) {
    headers.set("baggage", baggage);
  } else {
    headers.set("baggage", mergeBaggageValue(standardBaggage, baggage));
  }
}
function instrumentConsole(addBreadcrumb) {
  if (typeof console === "undefined") return;
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = function(...args) {
    addBreadcrumb("log", args.map(String).join(" "), "warn");
    origWarn.apply(console, args);
  };
  console.error = function(...args) {
    addBreadcrumb("log", args.map(String).join(" "), "error");
    origError.apply(console, args);
  };
}
function instrumentClicks(addBreadcrumb, options = {}) {
  const doc = globalThis.document;
  if (!doc || typeof doc.addEventListener !== "function") return;
  if (doc[CLICK_FLAG]) return;
  const maxSelectorLength = Math.max(32, options.maxSelectorLength ?? 160);
  const handler = (event) => {
    try {
      const target = closestClickable(event.target);
      if (!target || isSensitiveClickable(target)) return;
      const selector = selectorSummary(target, maxSelectorLength);
      if (!selector) return;
      const breadcrumb = {
        type: "ui",
        message: `click ${selector}`,
        level: "info",
        data: { action: "click", selector, tag: tagName(target) }
      };
      const next = options.beforeBreadcrumb ? options.beforeBreadcrumb(breadcrumb) : breadcrumb;
      if (!next) return;
      const safe = sanitizeAutoBreadcrumb(next);
      addBreadcrumb(safe.type, safe.message, safe.level, safe.data);
    } catch {
    }
  };
  doc.addEventListener("click", handler, true);
  doc[CLICK_FLAG] = true;
}
function sanitizeAutoBreadcrumb(breadcrumb) {
  const safe = redactValue(
    {
      type: breadcrumb.type,
      message: breadcrumb.message,
      level: breadcrumb.level,
      data: breadcrumb.data
    },
    { scrubValues: true, sendDefaultPii: false }
  );
  return {
    type: typeof safe.type === "string" ? safe.type : "default",
    message: typeof safe.message === "string" ? safe.message : "",
    level: typeof safe.level === "string" ? safe.level : void 0,
    data: safe.data && typeof safe.data === "object" && !Array.isArray(safe.data) ? safe.data : void 0
  };
}
function closestClickable(target) {
  let el = asElement(target);
  while (el) {
    const tag = tagName(el);
    if (tag === "button" || tag === "a" || tag === "input" || tag === "select" || tag === "textarea" || attr(el, "role") === "button" || attr(el, "data-allstak-click") !== null) {
      return el;
    }
    el = asElement(el.parentElement);
  }
  return asElement(target);
}
function asElement(value) {
  if (!value || typeof value !== "object") return null;
  const maybe = value;
  return typeof maybe.tagName === "string" || maybe.nodeType === 1 ? value : null;
}
function isSensitiveClickable(el) {
  if (tagName(el) !== "input") return false;
  const type = (attr(el, "type") ?? "").toLowerCase();
  return type === "password" || type === "hidden";
}
function selectorSummary(el, maxLength) {
  const tag = tagName(el) || "element";
  const parts = [tag];
  const id = cleanSelectorPart(attr(el, "id"));
  if (id) parts.push(`#${id}`);
  const classes = classNames(el).slice(0, 3).map(cleanSelectorPart).filter(Boolean);
  if (classes.length) parts.push(classes.map((c) => `.${c}`).join(""));
  const role = cleanSelectorPart(attr(el, "role"));
  if (role) parts.push(`[role="${role}"]`);
  const type = cleanSelectorPart(attr(el, "type"));
  if (type && tag === "input") parts.push(`[type="${type}"]`);
  return truncateSelector(parts.join(""), maxLength);
}
function tagName(el) {
  return (el.tagName ?? "").toLowerCase();
}
function attr(el, name) {
  try {
    const getter = el.getAttribute;
    if (typeof getter === "function") return getter.call(el, name);
    const value = el[name];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
function classNames(el) {
  try {
    const list = el.classList;
    if (list) return Array.from(list).filter((v) => typeof v === "string");
    const className = el.className;
    return typeof className === "string" ? className.split(/\s+/).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function cleanSelectorPart(value) {
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}
function truncateSelector(value, maxLength) {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 12)) + "[truncated]";
}
function __resetClickInstrumentationFlagForTest() {
  const doc = globalThis.document;
  if (doc) delete doc[CLICK_FLAG];
}

// src/integrations/click.ts
var clickIntegration = defineIntegration(() => ({
  name: "ClickBreadcrumbs",
  setup(client) {
    const options = client.getOptions();
    if (options.autoBreadcrumbs === false || options.autoBreadcrumbsClick === false) return;
    instrumentClicks(
      (type, msg, level, data) => client.addBreadcrumb(type, msg, level, data),
      {
        beforeBreadcrumb: options.beforeBreadcrumb,
        maxSelectorLength: options.clickBreadcrumbMaxSelectorLength
      }
    );
  }
}));

// src/integrations/console.ts
var consoleIntegration = defineIntegration(() => ({
  name: "Console",
  setup(client) {
    if (client.getOptions().autoBreadcrumbs === false) return;
    instrumentConsole((type, msg, level, data) => client.addBreadcrumb(type, msg, level, data));
    client.onLogBreadcrumb((level, message) => {
      const breadcrumbLevel = level === "warn" ? "warn" : "error";
      client.addBreadcrumb("log", message, breadcrumbLevel, { logLevel: level });
    });
  }
}));

// src/integrations/database.ts
var databaseIntegration = defineIntegration(() => ({
  name: "Database",
  setup(client) {
    const options = client.getOptions();
    if (options.autoDbInstrumentation === false) return;
    if (!client.isNodeRuntime()) return;
    enableDbAutoInstrumentation(client.database, {
      service: options.tags?.service,
      environment: options.environment
    });
  }
}));

// src/integrations/dedupe.ts
var dedupeIntegration = defineIntegration(() => {
  let previousEventSignature = null;
  return {
    name: "Dedupe",
    processEvent(event, client) {
      if (client.getOptions().dedupe === false) return event;
      const signature = eventSignature(event);
      if (!signature) return event;
      if (signature === previousEventSignature) return null;
      previousEventSignature = signature;
      return event;
    }
  };
});
function eventSignature(payload) {
  const frameKey = (payload.frames ?? []).map((frame) => [
    frame.filename ?? "",
    frame.function ?? "",
    frame.lineno ?? "",
    frame.colno ?? ""
  ].join(":")).join("|");
  const fingerprint = payload.fingerprint?.join("\0") ?? "";
  const base = [
    payload.exceptionClass,
    payload.message,
    fingerprint,
    frameKey
  ].join("");
  return base.trim().length > 0 ? base : null;
}

// src/integrations/event-filters.ts
var DEFAULT_IGNORE_ERRORS = [
  /^Script error\.?$/i,
  /^Javascript error: Script error\.? on line 0$/i,
  /^ResizeObserver loop completed with undelivered notifications\.?$/i,
  /^ResizeObserver loop limit exceeded$/i,
  /^Non-Error promise rejection captured with value: null$/i,
  /^Non-Error promise rejection captured with value: undefined$/i
];
var eventFiltersIntegration = defineIntegration(() => ({
  name: "EventFilters",
  processEvent(event, client) {
    const options = client.getOptions();
    return shouldDropEvent(event, options) ? null : event;
  }
}));
var inboundFiltersIntegration = eventFiltersIntegration;
function shouldDropEvent(payload, config) {
  const ignoreErrors = [
    ...config.disableDefaultIgnoreErrors ? [] : DEFAULT_IGNORE_ERRORS,
    ...config.ignoreErrors ?? []
  ];
  if (matchesAny(possibleMessages(payload), ignoreErrors)) return true;
  const url = eventFilterUrl(payload);
  const denyUrls = config.denyUrls ?? [];
  if (url && matchesPattern(url, denyUrls)) return true;
  const allowUrls = config.allowUrls ?? [];
  if (allowUrls.length > 0 && url && !matchesPattern(url, allowUrls)) return true;
  return false;
}
function possibleMessages(payload) {
  return [
    payload.message,
    `${payload.exceptionClass}: ${payload.message}`,
    payload.exceptionClass
  ].filter((value) => typeof value === "string" && value.length > 0);
}
function matchesAny(values, patterns) {
  return values.some((value) => matchesPattern(value, patterns));
}
function matchesPattern(value, patterns) {
  return patterns.some((pattern) => {
    if (typeof pattern === "string") return value.includes(pattern);
    return pattern.test(value);
  });
}
function eventFilterUrl(payload) {
  const frames = payload.frames;
  if (frames?.length) {
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      const candidate = frame.filename || frame.absPath;
      if (candidate && candidate !== "<anonymous>" && candidate !== "[native code]") {
        return candidate;
      }
    }
  }
  return payload.requestContext?.path || payload.requestContext?.host;
}

// src/modules/auto-node-http.ts
var PATCHED_FLAG = /* @__PURE__ */ Symbol.for("@allstak/node-http/patched");
function isAlreadyPatched(mod) {
  return mod[PATCHED_FLAG] === true;
}
function markPatched(mod) {
  mod[PATCHED_FLAG] = true;
}
function instrumentNodeHttp(capture, addBreadcrumb, ownBaseUrl, getTraceId, tracePropagationTargets, getActiveTraceContext) {
  const restorers = [];
  for (const protocol of ["http", "https"]) {
    let mod;
    try {
      mod = __require(`node:${protocol}`);
    } catch {
      continue;
    }
    if (isAlreadyPatched(mod)) continue;
    const originalRequest = mod.request.bind(mod);
    mod.request = function patchedRequest(...args) {
      let url;
      let options = {};
      let callback;
      let consumed = 0;
      if (typeof args[consumed] === "string" || args[consumed] instanceof URL) {
        url = String(args[consumed]);
        consumed++;
      }
      if (args[consumed] && typeof args[consumed] === "object" && !(args[consumed] instanceof Function)) {
        options = args[consumed];
        consumed++;
      }
      if (typeof args[consumed] === "function") {
        callback = args[consumed];
      }
      const method = (options.method || "GET").toString().toUpperCase();
      let host = "";
      let path = "/";
      try {
        if (url) {
          const u = new URL(url);
          host = u.host;
          path = (u.pathname || "/") + (options.path && !url.includes("?") ? "" : "");
        } else {
          host = options.host || options.hostname || "";
          if (options.port) host += `:${options.port}`;
          path = options.path || "/";
        }
      } catch {
      }
      const fullUrl = url || `${protocol}://${host}${path}`;
      const isOwnIngest = ownBaseUrl && fullUrl.startsWith(ownBaseUrl);
      let callArgs = args;
      const traceId = getTraceId ? getTraceId() : void 0;
      if (!isOwnIngest && traceId && !Array.isArray(options.headers) && targetMatches(fullUrl, tracePropagationTargets)) {
        try {
          const existingHeaders = options.headers;
          const headers = Object.assign({}, existingHeaders);
          const activeCtx = getActiveTraceContext ? getActiveTraceContext() : void 0;
          applyTracePropagationToHeaders(headers, traceId, newRequestId(), {
            sampled: activeCtx?.sampled,
            spanId: activeCtx?.spanId
          });
          const nextOptions = Object.assign({}, options, { headers });
          const rebuilt = [];
          if (url !== void 0) rebuilt.push(args[0]);
          rebuilt.push(nextOptions);
          if (callback) rebuilt.push(callback);
          callArgs = rebuilt;
        } catch {
          callArgs = args;
        }
      }
      const start = Date.now();
      const req = originalRequest(...callArgs);
      req.on("response", (res) => {
        const durationMs = Date.now() - start;
        const status = res.statusCode ?? 0;
        if (addBreadcrumb) {
          addBreadcrumb(
            "http",
            `${method} ${fullUrl.split("?")[0]} -> ${status}`,
            status >= 400 ? "error" : "info",
            { method, url: fullUrl.split("?")[0], statusCode: status, durationMs }
          );
        }
        if (!isOwnIngest) {
          try {
            capture({
              direction: "outbound",
              method,
              host,
              path: path.split("?")[0],
              statusCode: status,
              durationMs
            });
          } catch {
          }
        }
      });
      req.on("error", (err) => {
        const durationMs = Date.now() - start;
        if (addBreadcrumb) {
          addBreadcrumb("http", `${method} ${fullUrl.split("?")[0]} -> failed`, "error", {
            method,
            url: fullUrl.split("?")[0],
            error: err.message,
            durationMs
          });
        }
        if (!isOwnIngest) {
          try {
            capture({
              direction: "outbound",
              method,
              host,
              path: path.split("?")[0],
              statusCode: 0,
              durationMs
            });
          } catch {
          }
        }
      });
      void callback;
      return req;
    };
    let originalGet;
    if (typeof mod.get === "function") {
      originalGet = mod.get.bind(mod);
      mod.get = function patchedGet(...args) {
        const req = mod.request(...args);
        req.end();
        return req;
      };
    }
    markPatched(mod);
    restorers.push(() => {
      mod.request = originalRequest;
      if (originalGet) mod.get = originalGet;
      mod[PATCHED_FLAG] = false;
    });
  }
  return () => restorers.forEach((r) => r());
}

// src/integrations/http-client.ts
var httpClientIntegration = defineIntegration(() => ({
  name: "HttpClient",
  setup(client) {
    const options = client.getOptions();
    if (options.autoBreadcrumbs === false) return;
    const baseUrl = client.getBaseUrl();
    instrumentFetch(
      (type, msg, level, data) => client.addBreadcrumb(type, msg, level, data),
      (item) => client.captureRequest({ ...item, method: item.method }),
      baseUrl,
      () => ({
        traceId: client.getTraceId(),
        sampled: client.getTraceSampled(),
        spanId: client.getCurrentSpanId() ?? void 0
      }),
      options.httpBodyCapture,
      options.tracePropagationTargets
    );
    if (client.isNodeRuntime()) {
      try {
        instrumentNodeHttp(
          (item) => client.captureRequest({ ...item, method: item.method }),
          (type, msg, level, data) => client.addBreadcrumb(type, msg, level, data),
          baseUrl,
          () => client.getTraceId(),
          options.tracePropagationTargets,
          () => ({
            sampled: client.getTraceSampled(),
            spanId: client.getCurrentSpanId() ?? void 0
          })
        );
      } catch {
      }
    }
    client.onHttpRequestCaptured((item) => {
      client.addBreadcrumb(
        "http",
        `${item.method} ${item.path} -> ${item.statusCode}`,
        item.statusCode >= 400 ? "error" : "info",
        { method: item.method, path: item.path, statusCode: item.statusCode, durationMs: item.durationMs }
      );
    });
  }
}));

// src/integrations/defaults.ts
function getDefaultIntegrations() {
  return [
    eventFiltersIntegration(),
    dedupeIntegration(),
    clickIntegration(),
    consoleIntegration(),
    httpClientIntegration(),
    databaseIntegration()
  ];
}

// src/release-detect.ts
function parseGitRelease(describeOut, revParseOut, porcelainOut) {
  const describe = normalizeLine(describeOut);
  if (describe) return describe;
  const sha = normalizeLine(revParseOut);
  if (!sha) return void 0;
  const dirty = typeof porcelainOut === "string" && porcelainOut.trim().length > 0;
  return dirty ? `${sha}-dirty` : sha;
}
function normalizeLine(out) {
  if (!out) return void 0;
  const first = out.split("\n")[0]?.trim();
  return first && first.length > 0 ? first : void 0;
}
function isNodeRuntime2() {
  try {
    return typeof process !== "undefined" && !!process.versions && typeof process.versions.node === "string" && // No `window`/`document` → not a DOM/browser host.
    typeof globalThis.window === "undefined" && // React Native sets navigator.product === 'ReactNative'.
    !(typeof navigator !== "undefined" && navigator.product === "ReactNative");
  } catch {
    return false;
  }
}
function createNodeGitRunner(timeoutMs = 1500) {
  if (!isNodeRuntime2()) return null;
  let cp;
  try {
    const req = typeof __require === "function" ? __require : (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typeof module !== "undefined" && module.require || void 0
    );
    if (!req) return null;
    cp = req("child_process");
  } catch {
    return null;
  }
  if (!cp || typeof cp.execFileSync !== "function") return null;
  return (args) => {
    try {
      const out = cp.execFileSync("git", args, {
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        windowsHide: true
      });
      return typeof out === "string" ? out : "";
    } catch {
      return "";
    }
  };
}
var cachedRelease = null;
function detectGitRelease(runner) {
  if (cachedRelease !== null) return cachedRelease ?? void 0;
  const run = runner === void 0 ? createNodeGitRunner() : runner;
  if (!run) {
    cachedRelease = void 0;
    return void 0;
  }
  try {
    const describe = run(["describe", "--tags", "--always", "--dirty"]);
    let release = parseGitRelease(describe);
    if (!release) {
      const sha = run(["rev-parse", "--short", "HEAD"]);
      const porcelain = run(["status", "--porcelain"]);
      release = parseGitRelease(void 0, sha, porcelain);
    }
    cachedRelease = release;
    return release;
  } catch {
    cachedRelease = void 0;
    return void 0;
  }
}

// src/scope.ts
var Scope = class {
  constructor() {
    this.tags = {};
    this.extras = {};
    this.contexts = {};
  }
  setUser(user) {
    this.user = user;
    return this;
  }
  setTag(key, value) {
    this.tags[key] = value;
    return this;
  }
  setTags(tags) {
    Object.assign(this.tags, tags);
    return this;
  }
  setExtra(key, value) {
    this.extras[key] = value;
    return this;
  }
  setExtras(extras) {
    Object.assign(this.extras, extras);
    return this;
  }
  setContext(name, ctx) {
    if (ctx === null) delete this.contexts[name];
    else this.contexts[name] = ctx;
    return this;
  }
  setLevel(level) {
    this.level = level;
    return this;
  }
  setFingerprint(fingerprint) {
    this.fingerprint = fingerprint && fingerprint.length > 0 ? fingerprint : void 0;
    return this;
  }
  clear() {
    this.user = void 0;
    this.tags = {};
    this.extras = {};
    this.contexts = {};
    this.fingerprint = void 0;
    this.level = void 0;
    return this;
  }
};
function mergeScopes(base, stack) {
  const out = { ...base };
  out.tags = { ...base.tags ?? {} };
  out.extras = { ...base.extras ?? {} };
  out.contexts = { ...base.contexts ?? {} };
  for (const scope of stack) {
    if (scope.user) out.user = scope.user;
    Object.assign(out.tags, scope.tags);
    Object.assign(out.extras, scope.extras);
    Object.assign(out.contexts, scope.contexts);
    if (scope.fingerprint) out.fingerprint = scope.fingerprint;
    if (scope.level) out.level = scope.level;
  }
  return out;
}

// src/client.ts
var INGEST_HOST = "https://api.allstak.sa";
var SDK_VERSION = "0.3.1";
var SDK_NAME = "allstak-js";
function envVar(name) {
  try {
    if (typeof process !== "undefined" && process.env) {
      const v = process.env[name];
      if (v && v.length > 0) return v;
    }
  } catch {
  }
  return void 0;
}
function applyReleaseAutodetect(config, gitRunner) {
  const isBrowser = typeof window !== "undefined";
  if (!config.platform) config.platform = isBrowser ? "browser" : "node";
  if (!config.sdkName) config.sdkName = SDK_NAME;
  if (!config.sdkVersion) config.sdkVersion = SDK_VERSION;
  const autoDetect = config.autoDetectRelease !== false;
  if (!config.release) {
    config.release = envVar("ALLSTAK_RELEASE") ?? envVar("npm_package_version") ?? envVar("VERCEL_GIT_COMMIT_SHA")?.slice(0, 12) ?? envVar("RAILWAY_GIT_COMMIT_SHA")?.slice(0, 12) ?? envVar("RENDER_GIT_COMMIT")?.slice(0, 12);
  }
  if (!config.release && autoDetect) {
    config.release = detectGitRelease(gitRunner);
  }
  if (!config.release && autoDetect) {
    config.release = config.sdkVersion ?? SDK_VERSION;
  }
  if (!config.commitSha) {
    config.commitSha = envVar("ALLSTAK_COMMIT_SHA") ?? envVar("GIT_COMMIT") ?? envVar("VERCEL_GIT_COMMIT_SHA") ?? envVar("RAILWAY_GIT_COMMIT_SHA") ?? envVar("RENDER_GIT_COMMIT");
  }
  if (!config.branch) {
    config.branch = envVar("ALLSTAK_BRANCH") ?? envVar("GIT_BRANCH") ?? envVar("VERCEL_GIT_COMMIT_REF") ?? envVar("RAILWAY_GIT_BRANCH");
  }
  if (!config.environment) {
    config.environment = envVar("ALLSTAK_ENVIRONMENT") ?? envVar("NODE_ENV") ?? "production";
  }
}
function resolveTransport(config) {
  if (config.apiKey) {
    return {
      apiKey: config.apiKey,
      baseUrl: (config.host ?? INGEST_HOST).replace(/\/$/, "")
    };
  }
  if (config.dsn) {
    const url = new URL(config.dsn);
    const apiKey = decodeURIComponent(url.username);
    url.username = "";
    return { apiKey, baseUrl: url.origin };
  }
  throw new Error("AllStak: config.apiKey is required");
}
var AllStakClient = class {
  constructor(config) {
    this.offlineQueue = null;
    this.apiKey = "";
    this.offlineFlushCleanup = [];
    this.webVitals = null;
    this.integrations = {};
    this.sessionReplay = null;
    this.sessionTracker = null;
    this.globalScopeStack = [];
    this.asyncScopeStorage = createAsyncScopeStorage();
    // ─── Node uncaughtException / unhandledRejection auto-capture ─────
    this.nodeUncaughtHandler = null;
    this.nodeRejectionHandler = null;
    applyReleaseAutodetect(config);
    this.config = config;
    this.sessionId = generateId();
    const { baseUrl, apiKey } = resolveTransport(config);
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.offlineQueue = createOfflineQueue({
      enabled: config.enableOfflineQueue,
      dir: config.offlineQueue?.dir,
      maxEvents: config.offlineQueue?.maxEvents,
      maxBytes: config.offlineQueue?.maxBytes,
      maxAgeMs: config.offlineQueue?.maxAgeMs
    });
    this.transport = new HttpTransport(baseUrl, apiKey, this.offlineQueue);
    if (config.enableOfflineQueue !== false) {
      try {
        this.transport.drainPersisted();
      } catch {
      }
      this.installOfflineFlushHooks();
    }
    if (config.autoRegisterRelease !== false) {
      registerRuntimeRelease({
        host: baseUrl,
        apiKey,
        release: config.release,
        environment: config.environment,
        commitSha: config.commitSha,
        branch: config.branch,
        service: config.tags?.service,
        enabled: config.autoRegisterRelease
      });
    }
    if (config.autoNodeErrorCapture !== false && typeof process !== "undefined" && typeof window === "undefined") {
      this.installNodeErrorHandlers();
    }
    this.errors = new ErrorModule(this.transport, this.config, this.sessionId);
    this.logs = new LogModule(this.transport, this.config);
    this.httpRequests = new HttpRequestModule(this.transport);
    this.httpRequests.setDefaults({
      environment: config.environment,
      release: config.release
    });
    this.cron = new CronModule(this.transport);
    this._database = new DatabaseModule(this.transport, {
      service: config.tags?.service,
      environment: config.environment
    });
    this.tracing = new TracingModule(this.transport, {
      service: config.tags?.service,
      environment: config.environment,
      platform: config.platform,
      beforeSendSpan: config.beforeSendSpan,
      ignoreSpans: config.ignoreSpans,
      tracesSampleRate: config.tracesSampleRate,
      tracesSampler: config.tracesSampler
    });
    const defaultIntegrations = config.defaultIntegrations === void 0 ? getDefaultIntegrations() : config.defaultIntegrations;
    this.integrations = setupIntegrations(
      this,
      getIntegrationsToSetup({
        defaultIntegrations,
        integrations: config.integrations
      })
    );
    setTraceResolver(() => ({
      traceId: this.tracing.getTraceId() ?? void 0,
      spanId: this.tracing.getCurrentSpanId() ?? void 0
    }));
    if (typeof window !== "undefined" && config.sessionReplay?.enabled && !this.isNodeBuild()) {
      this.sessionReplay = new SessionReplayModule(
        this.transport,
        this.config,
        this.sessionId
      );
    }
    if (config.enableWebVitals !== false && isWebVitalsSupported() && !this.isNodeBuild()) {
      this.webVitals = new WebVitalsModule(this.tracing, {
        release: config.release,
        environment: config.environment,
        service: config.tags?.service,
        sessionId: this.sessionId,
        platform: config.platform
      });
      this.webVitals.start();
    }
    if (config.enableAutoSessionTracking !== false && !isTestRuntime2()) {
      this.sessionTracker = new SessionTracker(this.config, this.transport, this.sessionId);
      this.errors.setOnUnhandled(() => this.sessionTracker?.recordCrash());
      this.sessionTracker.start();
    }
  }
  isNodeBuild() {
    return true;
  }
  isNodeRuntime() {
    return this.isNodeBuild() || typeof process !== "undefined" && !!process.versions?.node;
  }
  getBaseUrl() {
    return this.baseUrl;
  }
  captureException(error, context) {
    this.sessionTracker?.recordError();
    const traceContext = {};
    const traceId = this.tracing.getTraceId();
    if (traceId) traceContext.traceId = traceId;
    const requestId = this.tracing.getRequestId();
    if (requestId) traceContext.requestId = requestId;
    const spanId = this.tracing.getCurrentSpanId();
    if (spanId) traceContext.spanId = spanId;
    this.withScopedConfig(
      () => this.errors.captureException(error, { ...traceContext, ...context })
    );
  }
  withScopedConfig(work) {
    const stack = this.scopeStack();
    if (stack.length === 0) return work();
    const eff = mergeScopes(this.config, stack);
    const snap = {
      user: this.config.user,
      tags: this.config.tags,
      extras: this.config.extras,
      contexts: this.config.contexts,
      fingerprint: this.config.fingerprint,
      level: this.config.level
    };
    this.config.user = eff.user;
    this.config.tags = eff.tags;
    this.config.extras = eff.extras;
    this.config.contexts = eff.contexts;
    this.config.fingerprint = eff.fingerprint;
    this.config.level = eff.level;
    try {
      return work();
    } finally {
      this.config.user = snap.user;
      this.config.tags = snap.tags;
      this.config.extras = snap.extras;
      this.config.contexts = snap.contexts;
      this.config.fingerprint = snap.fingerprint;
      this.config.level = snap.level;
    }
  }
  scopeStack() {
    return this.asyncScopeStorage?.getStore() ?? this.globalScopeStack;
  }
  withScope(callback) {
    const scope = new Scope();
    if (this.asyncScopeStorage) {
      const parent = this.scopeStack();
      return this.asyncScopeStorage.run([...parent, scope], () => callback(scope));
    }
    this.globalScopeStack.push(scope);
    let popped = false;
    const pop = () => {
      if (!popped) {
        popped = true;
        this.globalScopeStack.pop();
      }
    };
    try {
      const result = callback(scope);
      if (result && typeof result.then === "function") {
        return result.then(
          (v) => {
            pop();
            return v;
          },
          (e) => {
            pop();
            throw e;
          }
        );
      }
      pop();
      return result;
    } catch (err) {
      pop();
      throw err;
    }
  }
  getCurrentScope() {
    const stack = this.scopeStack();
    return stack[stack.length - 1] ?? null;
  }
  configureScope(callback) {
    const current = this.getCurrentScope();
    if (current) {
      callback(current);
      return;
    }
    const scope = new Scope();
    callback(scope);
    const eff = mergeScopes(this.config, [scope]);
    this.config.user = eff.user;
    this.config.tags = eff.tags;
    this.config.extras = eff.extras;
    this.config.contexts = eff.contexts;
    this.config.fingerprint = eff.fingerprint;
    this.config.level = eff.level;
  }
  addBreadcrumb(typeOrCrumb, message, level, data) {
    if (typeof typeOrCrumb === "object") {
      this.errors.addBreadcrumb(typeOrCrumb.type, typeOrCrumb.message, typeOrCrumb.level, typeOrCrumb.data);
    } else {
      this.errors.addBreadcrumb(typeOrCrumb, message, level, data);
    }
  }
  clearBreadcrumbs() {
    this.errors.clearBreadcrumbs();
  }
  addEventProcessor(processor) {
    this.errors.addEventProcessor(processor);
  }
  addSpanProcessor(processor) {
    this.tracing.addSpanProcessor(processor);
  }
  onLogBreadcrumb(callback) {
    this.logs.setOnLogBreadcrumb(callback);
  }
  onHttpRequestCaptured(callback) {
    this.httpRequests.setOnCapture(callback);
  }
  addIntegration(integration) {
    const existing = this.integrations[integration.name];
    if (existing) return;
    this.integrations[integration.name] = integration;
    integration.setupOnce?.();
    integration.setup?.(this);
    if (integration.processEvent) {
      this.addEventProcessor((event) => integration.processEvent(event, this));
    }
    if (integration.processSpan) {
      this.addSpanProcessor((span) => integration.processSpan(span, this));
    }
  }
  getIntegration(name) {
    return this.integrations[name];
  }
  getOptions() {
    return this.config;
  }
  /**
   * Capture a freeform message. Routes to the **logs** ingest stream by default
   * (so messages appear in the dashboard's "Logs" view and don't pollute the
   * Errors view). For severities >= warning, it ALSO writes to errors so the
   * message is visible alongside real exceptions when triaging.
   *
   * Pass `{ as: 'error' }` to send only to the errors stream (preserves the
   * legacy behaviour for callers that need it).
   */
  captureMessage(message, level = "info", options = {}) {
    const as = options.as ?? (level === "fatal" || level === "error" ? "both" : "log");
    const callerMeta = options.metadata ?? options.data;
    if (as === "log" || as === "both") {
      const logLevel = level === "warning" ? "warn" : level;
      this.logs.send(logLevel, message, callerMeta);
    }
    if (as === "error" || as === "both") {
      this.withScopedConfig(() => this.errors.captureMessage(message, level, { metadata: callerMeta }));
    }
  }
  /**
   * Report an HTTP request (inbound or outbound).
   * Batches internally and flushes every 5s or when 20 items accumulate.
   * Automatically attaches current traceId if not already set on the item.
   */
  captureRequest(item) {
    if (!item.traceId) {
      item.traceId = this.tracing.getTraceId();
    }
    if (!item.requestId) {
      item.requestId = this.tracing.getRequestId() ?? void 0;
    }
    if (!item.spanId) {
      item.spanId = this.tracing.getCurrentSpanId() ?? void 0;
    }
    this.httpRequests.capture(item);
  }
  /**
   * Access the database module for capturing DB query telemetry.
   */
  get database() {
    return this._database;
  }
  /**
   * Report a database query to AllStak.
   * Batches internally and flushes every 5s or when 20 items accumulate.
   */
  captureDbQuery(item) {
    this._database.capture(item);
  }
  /**
   * Report a cron job execution.
   * The cron monitor slug must match one configured in the AllStak dashboard.
   */
  heartbeat(options) {
    this.cron.heartbeat(options);
  }
  get log() {
    const withTrace = (meta) => {
      const enriched = { ...meta };
      if (!enriched.traceId) {
        const traceId = this.tracing.getTraceId();
        if (traceId) enriched.traceId = traceId;
      }
      if (!enriched.spanId) {
        const spanId = this.tracing.getCurrentSpanId();
        if (spanId) enriched.spanId = spanId;
      }
      if (!enriched.requestId) {
        const requestId = this.tracing.getRequestId();
        if (requestId) enriched.requestId = requestId;
      }
      return enriched;
    };
    return {
      debug: (message, meta) => this.logs.send("debug", message, withTrace(meta)),
      info: (message, meta) => this.logs.send("info", message, withTrace(meta)),
      warn: (message, meta) => this.logs.send("warn", message, withTrace(meta)),
      error: (message, meta) => this.logs.send("error", message, withTrace(meta)),
      fatal: (message, meta) => this.logs.send("fatal", message, withTrace(meta))
    };
  }
  get logger() {
    return this.log;
  }
  setUser(user) {
    this.config.user = user;
  }
  setTag(key, value) {
    if (!this.config.tags) this.config.tags = {};
    this.config.tags[key] = value;
  }
  /** Bulk-set tags. Merges with existing tags. */
  setTags(tags) {
    if (!this.config.tags) this.config.tags = {};
    Object.assign(this.config.tags, tags);
  }
  /** Set a single extra value. */
  setExtra(key, value) {
    if (!this.config.extras) this.config.extras = {};
    this.config.extras[key] = value;
  }
  /** Bulk-set extras. Merges with existing extras. */
  setExtras(extras) {
    if (!this.config.extras) this.config.extras = {};
    Object.assign(this.config.extras, extras);
  }
  /**
   * Attach a named context bag (e.g. `app`, `device`, `runtime`) that appears
   * under `metadata['context.<name>']` on every subsequent event. Pass
   * `null` to remove a previously-set context.
   */
  setContext(name, ctx) {
    if (!this.config.contexts) this.config.contexts = {};
    if (ctx === null) delete this.config.contexts[name];
    else this.config.contexts[name] = ctx;
  }
  /** Set the default severity level applied to subsequent captures. */
  setLevel(level) {
    this.config.level = level;
  }
  /**
   * Set a custom grouping fingerprint applied to subsequent events.
   * Pass `null` or an empty array to clear and revert to default grouping.
   */
  setFingerprint(fingerprint) {
    this.config.fingerprint = fingerprint && fingerprint.length > 0 ? fingerprint : void 0;
  }
  /**
   * Flush queued module batches and wait for in-flight transport work to
   * finish. Resolves `true` when telemetry drains within `timeoutMs`
   * (default 2000ms), `false` otherwise.
   */
  async flush(timeoutMs = 2e3) {
    const deadline = Date.now() + timeoutMs;
    this.httpRequests.flush();
    this._database.flush();
    this.tracing.flush();
    this.sessionReplay?.flush();
    const errorsReady = await this.errors.flush(Math.max(0, deadline - Date.now()));
    if (!errorsReady) return false;
    return this.transport.flush(Math.max(0, deadline - Date.now()));
  }
  /**
   * Phase 3 — runtime override of the SDK identity fields. Used by
   * platform-specific integrations (e.g. installReactNative) so the
   * resulting wire payload says `sdkName=allstak-react-native` and
   * carries an auto-detected `dist` such as `ios-hermes`.
   */
  setIdentity(identity) {
    if (identity.sdkName) this.config.sdkName = identity.sdkName;
    if (identity.sdkVersion) this.config.sdkVersion = identity.sdkVersion;
    if (identity.platform) this.config.platform = identity.platform;
    if (identity.dist) this.config.dist = identity.dist;
  }
  getSessionId() {
    return this.sessionId;
  }
  getTransportStats() {
    return this.transport.getStats();
  }
  getDiagnostics() {
    const transport = this.transport.getStats();
    return {
      transport,
      breadcrumbs: this.errors.getBreadcrumbCount(),
      sessionId: this.sessionId,
      activeTraceCount: this.tracing.getCurrentTraceId() ? 1 : 0,
      activeSpanCount: this.tracing.getActiveSpanCount(),
      queueSize: transport.queued
    };
  }
  /**
   * Start Core Web Vitals collection (browser only). Auto-started at init in the
   * browser bundle unless `enableWebVitals === false`; call this manually to
   * (re)arm it after an explicit opt-out, or from a custom integration. A no-op
   * off-browser and idempotent once collection is running.
   */
  startWebVitals() {
    if (this.isNodeBuild() || !isWebVitalsSupported()) return;
    if (!this.webVitals) {
      this.webVitals = new WebVitalsModule(this.tracing, {
        release: this.config.release,
        environment: this.config.environment,
        service: this.config.tags?.service,
        sessionId: this.sessionId,
        platform: this.config.platform
      });
    }
    this.webVitals.start();
  }
  // ------------------------------------------------------------------
  // Distributed Tracing
  // ------------------------------------------------------------------
  /**
   * Start a new span. Automatically parented to the current active span.
   * Call `span.finish()` when the operation completes.
   */
  startSpan(operation, options) {
    return this.tracing.startSpan(operation, options);
  }
  /**
   * AllStak-style helper: creates a span, runs the callback, then finishes the
   * span automatically. Async callbacks are supported, and thrown/rejected
   * errors mark the span as failed before being rethrown.
   */
  trace(operation, callback, options) {
    const span = this.tracing.startSpan(operation, options);
    let finished = false;
    const finish = (status) => {
      if (!finished) {
        finished = true;
        span.finish(status);
      }
    };
    try {
      const result = callback(span);
      if (result && typeof result.then === "function") {
        return result.then(
          (value) => {
            finish("ok");
            return value;
          },
          (error) => {
            finish("error");
            throw error;
          }
        );
      }
      finish("ok");
      return result;
    } catch (error) {
      finish("error");
      throw error;
    }
  }
  withTraceContext(traceId, requestIdOrCallback, maybeCallback, parentSpanId) {
    if (typeof requestIdOrCallback === "function") {
      return this.tracing.withTraceContext(traceId, requestIdOrCallback);
    }
    return this.tracing.withTraceContext(traceId, requestIdOrCallback, maybeCallback, parentSpanId);
  }
  /** Get the current trace ID (creates one if none exists). */
  getTraceId() {
    return this.tracing.getTraceId();
  }
  /** Get the current request ID, when inside a server framework request context. */
  getRequestId() {
    return this.tracing.getRequestId();
  }
  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId) {
    this.tracing.setTraceId(traceId);
  }
  /** Continue a valid inbound W3C trace with the upstream span as parent. */
  continueTrace(traceId, parentSpanId, sampled) {
    return this.tracing.continueTrace(traceId, parentSpanId, sampled);
  }
  /** Get the current active span ID, or null if no span is active. */
  getCurrentSpanId() {
    return this.tracing.getCurrentSpanId();
  }
  /**
   * The sticky head-of-trace sampling decision for the current trace. Drives
   * the propagated `traceparent` sampled flag. Returns `true` when no decision
   * has been forced yet (back-compat: always-sampled).
   */
  getTraceSampled() {
    return this.tracing.getSampled();
  }
  /**
   * Record the sampling decision inherited from an incoming `traceparent`, so
   * a configured {@link AllStakConfig.tracesSampler} can honor `parentSampled`.
   * @internal Used by server framework integrations.
   */
  setParentSampled(parentSampled) {
    this.tracing.setParentSampled(parentSampled);
  }
  /** Reset trace context (trace ID and span stack). */
  resetTrace() {
    this.tracing.resetTrace();
  }
  destroy() {
    this.sessionTracker?.end();
    setTraceResolver(null);
    this.webVitals?.destroy();
    this.tracing.destroy();
    this.errors.destroy();
    this.httpRequests.destroy();
    this._database.destroy();
    this.sessionReplay?.destroy();
    this.uninstallNodeErrorHandlers();
    this.uninstallOfflineFlushHooks();
    this.transport.close();
  }
  uninstallOfflineFlushHooks() {
    for (const fn of this.offlineFlushCleanup) {
      try {
        fn();
      } catch {
      }
    }
    this.offlineFlushCleanup = [];
  }
  shouldCaptureScreenshot() {
    const screenshot = this.config.screenshot;
    if (!screenshot?.enabled || screenshot.captureOnError === false || !screenshot.provider) {
      return false;
    }
    const sampleRate = screenshot.sampleRate ?? 1;
    return !(sampleRate <= 0 || sampleRate < 1 && Math.random() >= sampleRate);
  }
  async withScreenshotMetadata(error, context) {
    const screenshot = this.config.screenshot;
    if (!screenshot?.provider) return { ...context, "screenshot.status": "unsupported" };
    const timeoutMs = Math.max(100, Math.min(screenshot.timeoutMs ?? 1500, 5e3));
    const maxBytes = Math.max(1024, screenshot.maxBytes ?? 2e5);
    const traceId = typeof context.traceId === "string" ? context.traceId : void 0;
    const requestId = typeof context.requestId === "string" ? context.requestId : void 0;
    try {
      const artifact = await Promise.race([
        Promise.resolve(screenshot.provider({ type: "error", error, traceId, requestId })),
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
      ]);
      if (!artifact) return { ...context, "screenshot.status": "timeout_or_empty" };
      const size = artifact.sizeBytes ?? byteSize(artifact.data);
      if (size > maxBytes) {
        this.transport.noteDropped();
        return { ...context, "screenshot.status": "dropped_too_large", "screenshot.sizeBytes": size };
      }
      return {
        ...context,
        "screenshot.status": "captured",
        "screenshot.contentType": artifact.contentType,
        "screenshot.width": artifact.width,
        "screenshot.height": artifact.height,
        "screenshot.sizeBytes": size,
        "screenshot.redacted": artifact.redacted ?? false,
        "screenshot.redactionStrategy": artifact.redactionStrategy,
        ...artifact.data ? { "screenshot.data": artifact.data } : {}
      };
    } catch {
      return { ...context, "screenshot.status": "failed" };
    }
  }
  // ─── Offline-queue shutdown flush ────────────────────────────────
  /**
   * On graceful shutdown spill any still-buffered telemetry into the
   * persistent store so it survives a restart.
   *
   * In the browser we ALSO try a best-effort `navigator.sendBeacon` for each
   * buffered event on `pagehide` / `visibilitychange('hidden')` so in-flight
   * events have a chance to leave the tab before it closes; whatever the
   * beacon can't take is persisted for the next page load. Session lifecycle
   * paths are skipped (the SessionTracker owns its own end-of-session beacon).
   * Fail-open throughout.
   */
  installOfflineFlushHooks() {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      const onHide = () => this.flushOfflineOnHide();
      const onVisibility = () => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          this.flushOfflineOnHide();
        }
      };
      window.addEventListener("pagehide", onHide);
      this.offlineFlushCleanup.push(() => window.removeEventListener("pagehide", onHide));
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("visibilitychange", onVisibility);
        this.offlineFlushCleanup.push(
          () => document.removeEventListener("visibilitychange", onVisibility)
        );
      }
      return;
    }
    if (typeof process !== "undefined" && typeof process.on === "function") {
      const onExit = () => {
        try {
          this.transport.persistBufferedNow();
        } catch {
        }
      };
      process.on("beforeExit", onExit);
      process.on("SIGTERM", onExit);
      this.offlineFlushCleanup.push(() => {
        if (typeof process.off === "function") {
          process.off("beforeExit", onExit);
          process.off("SIGTERM", onExit);
        }
      });
    }
  }
  flushOfflineOnHide() {
    try {
      const drained = this.transport.drainBufferForUnload();
      const nav = typeof navigator !== "undefined" ? navigator : void 0;
      const canBeacon = !!nav && typeof nav.sendBeacon === "function";
      for (const item of drained) {
        let beaconed = false;
        if (canBeacon && isPersistablePath(item.path)) {
          try {
            const blob = new Blob([JSON.stringify(item.payload)], { type: "application/json" });
            beaconed = nav.sendBeacon(
              `${this.baseUrl}${item.path}?k=${encodeURIComponent(this.apiKey)}`,
              blob
            );
          } catch {
            beaconed = false;
          }
        }
        if (!beaconed) this.transport.persistOne(item);
      }
    } catch {
    }
  }
  installNodeErrorHandlers() {
    if (typeof process === "undefined" || typeof process.on !== "function") {
      return;
    }
    this.nodeUncaughtHandler = (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      try {
        this.sessionTracker?.recordCrash();
        this.errors.captureException(e, { source: "uncaughtException" });
      } catch {
      }
      this.uninstallNodeErrorHandlers();
      throw e;
    };
    this.nodeRejectionHandler = (reason) => {
      const e = reason instanceof Error ? reason : new Error(String(reason));
      try {
        this.sessionTracker?.recordCrash();
        this.errors.captureException(e, { source: "unhandledRejection" });
      } catch {
      }
      this.uninstallNodeErrorHandlers();
      setTimeout(() => {
        throw e;
      }, 0);
    };
    process.on("uncaughtException", this.nodeUncaughtHandler);
    process.on("unhandledRejection", this.nodeRejectionHandler);
  }
  uninstallNodeErrorHandlers() {
    if (typeof process === "undefined" || typeof process.off !== "function") {
      return;
    }
    if (this.nodeUncaughtHandler) {
      process.off("uncaughtException", this.nodeUncaughtHandler);
      this.nodeUncaughtHandler = null;
    }
    if (this.nodeRejectionHandler) {
      process.off("unhandledRejection", this.nodeRejectionHandler);
      this.nodeRejectionHandler = null;
    }
  }
};
function createAsyncScopeStorage() {
  const proc = globalThis.process;
  if (false) return null;
  try {
    const fromProcess = proc?.getBuiltinModule?.("node:async_hooks")?.AsyncLocalStorage;
    if (fromProcess) return new fromProcess();
    const req = typeof __require === "function" ? __require : void 0;
    const AsyncLocalStorage = req?.("node:async_hooks").AsyncLocalStorage;
    return AsyncLocalStorage ? new AsyncLocalStorage() : null;
  } catch {
    return null;
  }
}
function byteSize(value) {
  if (!value) return 0;
  try {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
  } catch {
  }
  return value.length;
}

// src/index.ts
var instance = null;
var AllStak = {
  init(config) {
    if (instance) {
      instance.destroy();
    }
    instance = new AllStakClient(config);
    return instance;
  },
  captureException(error, context) {
    ensureInit().captureException(error, context);
  },
  addBreadcrumb(typeOrCrumb, message, level, data) {
    if (typeof typeOrCrumb === "object") {
      ensureInit().addBreadcrumb(typeOrCrumb.type, typeOrCrumb.message, typeOrCrumb.level, typeOrCrumb.data);
    } else {
      ensureInit().addBreadcrumb(typeOrCrumb, message, level, data);
    }
  },
  clearBreadcrumbs() {
    ensureInit().clearBreadcrumbs();
  },
  addEventProcessor(processor) {
    ensureInit().addEventProcessor(processor);
  },
  addSpanProcessor(processor) {
    ensureInit().addSpanProcessor(processor);
  },
  addIntegration(integration) {
    ensureInit().addIntegration(integration);
  },
  getIntegration(name) {
    return ensureInit().getIntegration(name);
  },
  /** Phase 3 — runtime SDK-identity override (used by RN install). */
  setIdentity(identity) {
    ensureInit().setIdentity(identity);
  },
  /**
   * Capture a freeform message. By default routes to the **logs** stream
   * (so it shows up under "Logs" in the dashboard). For `error` / `fatal`
   * severities it ALSO writes to the errors stream so the message is visible
   * during incident triage. Override with `{ as: 'log' | 'error' | 'both' }`.
   */
  captureMessage(message, level = "info", options) {
    ensureInit().captureMessage(message, level, options);
  },
  /**
   * Report an HTTP request (inbound or outbound) to AllStak.
   * Batches internally and flushes every 5s or when 20 items accumulate.
   */
  captureRequest(item) {
    ensureInit().captureRequest(item);
  },
  /**
   * Report a cron job execution to AllStak.
   * The slug must match a cron monitor configured in the AllStak dashboard.
   */
  heartbeat(options) {
    ensureInit().heartbeat(options);
  },
  /**
   * Access the database module for capturing DB query telemetry.
   */
  get database() {
    return ensureInit().database;
  },
  /**
   * Report a database query to AllStak.
   * Batches internally and flushes every 5s or when 20 items accumulate.
   */
  captureDbQuery(item) {
    ensureInit().captureDbQuery(item);
  },
  get log() {
    return ensureInit().log;
  },
  get logger() {
    return ensureInit().logger;
  },
  setUser(user) {
    ensureInit().setUser(user);
  },
  setTag(key, value) {
    ensureInit().setTag(key, value);
  },
  setTags(tags) {
    ensureInit().setTags(tags);
  },
  setExtra(key, value) {
    ensureInit().setExtra(key, value);
  },
  setExtras(extras) {
    ensureInit().setExtras(extras);
  },
  setContext(name, ctx) {
    ensureInit().setContext(name, ctx);
  },
  setLevel(level) {
    ensureInit().setLevel(level);
  },
  setFingerprint(fingerprint) {
    ensureInit().setFingerprint(fingerprint);
  },
  /**
   * Flush queued module batches and wait for in-flight transport work to drain.
   * Resolves `true` if telemetry drains within `timeoutMs` (default 2000ms),
   * `false` otherwise.
   */
  flush(timeoutMs) {
    return ensureInit().flush(timeoutMs);
  },
  close() {
    instance?.destroy();
    instance = null;
  },
  getDiagnostics() {
    return instance?.getDiagnostics() ?? null;
  },
  /**
   * Run `callback` with a fresh, temporary {@link Scope} that isolates any
   * user/tag/extra/context/fingerprint/level it sets. Pop is automatic for
   * sync, async, and throwing callbacks.
   */
  withScope(callback) {
    return ensureInit().withScope(callback);
  },
  getCurrentScope() {
    return ensureInit().getCurrentScope();
  },
  configureScope(callback) {
    ensureInit().configureScope(callback);
  },
  getSessionId() {
    return ensureInit().getSessionId();
  },
  /**
   * Start Core Web Vitals collection (browser only). Auto-started at init in the
   * browser unless `enableWebVitals: false` was passed. Call manually to re-arm
   * after an opt-out. No-op off-browser; idempotent once running.
   */
  startWebVitals() {
    ensureInit().startWebVitals();
  },
  getTransportStats() {
    return ensureInit().getTransportStats();
  },
  // ------------------------------------------------------------------
  // Distributed Tracing
  // ------------------------------------------------------------------
  /**
   * Start a new span. Automatically parented to the current active span.
   * Call `span.finish()` when the operation completes.
   */
  startSpan(operation, options) {
    return ensureInit().startSpan(operation, options);
  },
  /**
   * Run a sync or async function inside a span and finish it automatically.
   */
  trace(operation, callback, options) {
    return ensureInit().trace(operation, callback, options);
  },
  /** Get the current trace ID (creates one if none exists). */
  getTraceId() {
    return ensureInit().getTraceId();
  },
  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId) {
    ensureInit().setTraceId(traceId);
  },
  /** Continue a valid inbound W3C trace with the upstream span as parent. */
  continueTrace(traceId, parentSpanId, sampled) {
    return ensureInit().continueTrace(traceId, parentSpanId, sampled);
  },
  /** Get the current active span ID, or null if no span is active. */
  getCurrentSpanId() {
    return ensureInit().getCurrentSpanId();
  },
  /** Reset trace context (trace ID and span stack). */
  resetTrace() {
    ensureInit().resetTrace();
  },
  destroy() {
    instance?.destroy();
    instance = null;
  },
  /** @internal — exposed for testing */
  _getInstance() {
    return instance;
  }
};
var src_default = AllStak;
function ensureInit() {
  if (!instance) {
    throw new Error("AllStak.init() must be called before using the SDK");
  }
  return instance;
}

export {
  setPersistence,
  createOfflineQueue,
  redactValue,
  redactHeaderRecord,
  isValidTraceId,
  parseTraceparent,
  Span,
  isWebVitalsSupported,
  WebVitalsModule,
  DatabaseModule,
  canRegisterRuntimeRelease,
  registerRuntimeRelease,
  _resetRuntimeReleaseRegistrationForTest,
  Session,
  SessionTracker,
  defineIntegration,
  instrumentClicks,
  __resetClickInstrumentationFlagForTest,
  clickIntegration,
  consoleIntegration,
  databaseIntegration,
  dedupeIntegration,
  eventFiltersIntegration,
  inboundFiltersIntegration,
  httpClientIntegration,
  parseGitRelease,
  isNodeRuntime2 as isNodeRuntime,
  detectGitRelease,
  Scope,
  applyReleaseAutodetect,
  AllStak,
  src_default
};
//# sourceMappingURL=chunk-Y3JEHE6Y.mjs.map