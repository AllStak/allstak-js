import {
  __require,
  instrumentMysql2,
  instrumentPg,
  instrumentSqlite,
  setTraceResolver
} from "./chunk-46REABUF.mjs";

// src/transport/buffer.ts
var MAX_BUFFER_SIZE = 100;
var EventBuffer = class {
  constructor() {
    this.queue = [];
  }
  push(event) {
    if (this.queue.length >= MAX_BUFFER_SIZE) {
      this.queue.shift();
    }
    this.queue.push(event);
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

// src/utils/retry.ts
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function withRetry(fn, maxRetries = 3, baseDelay = 500) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw new Error("Max retries reached");
}

// src/transport/http.ts
var REQUEST_TIMEOUT = 3e3;
var HttpTransport = class {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.buffer = new EventBuffer();
    this.flushing = false;
  }
  async send(path, payload) {
    const url = `${this.baseUrl}${path}`;
    try {
      await this.doFetch(url, payload);
      await this.flushBuffer(path);
    } catch {
      this.buffer.push({ path, payload });
    }
  }
  async doFetch(url, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AllStak-Key": this.apiKey
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }
  async flushBuffer(currentPath) {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;
    try {
      const items = this.buffer.drain();
      for (const item of items) {
        const url = `${this.baseUrl}${item.path || currentPath}`;
        await withRetry(() => this.doFetch(url, item.payload));
      }
    } catch {
    } finally {
      this.flushing = false;
    }
  }
  getBufferSize() {
    return this.buffer.size;
  }
};

// src/modules/errors.ts
function browserRequestContext() {
  if (typeof window === "undefined" || typeof location === "undefined") return void 0;
  return {
    method: "GET",
    path: location.pathname || "/",
    host: location.host || "",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : void 0
  };
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
    this.maxBreadcrumbs = config.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    this.setupAutocapture();
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
  captureException(error, context) {
    const stackLines = error.stack?.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at ")) ?? [];
    const currentBreadcrumbs = this.breadcrumbs.length > 0 ? [...this.breadcrumbs] : void 0;
    this.breadcrumbs = [];
    const payload = {
      exceptionClass: error.constructor?.name || error.name || "Error",
      message: error.message,
      stackTrace: stackLines.length > 0 ? stackLines : void 0,
      level: "error",
      environment: this.config.environment,
      release: this.config.release,
      sessionId: this.sessionId,
      user: this.config.user,
      metadata: context ? { ...this.config.tags, ...context } : this.config.tags,
      breadcrumbs: currentBreadcrumbs,
      requestContext: browserRequestContext()
    };
    this.transport.send(INGEST_PATH, payload);
  }
  captureMessage(message, level = "info") {
    const payload = {
      exceptionClass: "Message",
      message,
      level,
      environment: this.config.environment,
      release: this.config.release,
      sessionId: this.sessionId,
      user: this.config.user,
      metadata: this.config.tags,
      requestContext: browserRequestContext()
    };
    this.transport.send(INGEST_PATH, payload);
  }
  setupAutocapture() {
    if (typeof window === "undefined") return;
    this.onErrorHandler = ((event) => {
      const errorEvent = event;
      const err = errorEvent.error instanceof Error ? errorEvent.error : new Error(errorEvent.message || "Unknown error");
      this.captureException(err);
    });
    this.onUnhandledRejectionHandler = (event) => {
      const err = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
      this.captureException(err);
    };
    window.addEventListener("error", this.onErrorHandler);
    window.addEventListener(
      "unhandledrejection",
      this.onUnhandledRejectionHandler
    );
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
    const payload = {
      level,
      message,
      service: meta?.service ?? this.config.tags?.service,
      traceId: meta?.traceId,
      environment: meta?.environment ?? this.config.environment,
      release: meta?.release ?? this.config.release,
      spanId: meta?.spanId,
      requestId: meta?.requestId,
      userId: meta?.userId ?? this.config.user?.id,
      errorId: meta?.errorId,
      metadata: meta
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

// src/modules/http-requests.ts
var INGEST_PATH4 = "/ingest/v1/http-requests";
var FLUSH_INTERVAL_MS2 = 5e3;
var BATCH_SIZE_THRESHOLD2 = 20;
function generateTraceId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
var HttpRequestModule = class {
  constructor(transport) {
    this.transport = transport;
    this.queue = [];
    this.flushTimer = null;
    this.onCapture = null;
    this.defaults = {};
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS2);
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
      traceId: item.traceId ?? generateTraceId(),
      direction: item.direction,
      method: item.method,
      host: item.host,
      path: item.path,
      statusCode: item.statusCode,
      durationMs: item.durationMs,
      requestSize: item.requestSize,
      responseSize: item.responseSize,
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
    this._startTimeMillis = config.startTimeMillis;
    this._onFinish = config.onFinish;
  }
  /** Set a tag on this span. */
  setTag(key, value) {
    this._tags[key] = value;
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
    this._onFinish({
      traceId: this._traceId,
      spanId: this._spanId,
      parentSpanId: this._parentSpanId,
      operation: this._operation,
      description: this._description,
      status,
      durationMs: endTimeMillis - this._startTimeMillis,
      startTimeMillis: this._startTimeMillis,
      endTimeMillis,
      service: this._service,
      environment: this._environment,
      tags: this._tags,
      data: this._data
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
    this.currentTraceId = null;
    this.spanStack = [];
    this.completedSpans = [];
    this.flushTimer = null;
    this.transport = transport;
    this.service = config.service || "";
    this.environment = config.environment || "";
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS3);
  }
  /** Get the current trace ID, creating one if none exists. */
  getTraceId() {
    if (!this.currentTraceId) {
      this.currentTraceId = generateId().replace(/-/g, "");
    }
    return this.currentTraceId;
  }
  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId) {
    this.currentTraceId = traceId;
  }
  /** Get the current active span ID (top of the span stack), or null. */
  getCurrentSpanId() {
    return this.spanStack.length > 0 ? this.spanStack[this.spanStack.length - 1] : null;
  }
  /**
   * Start a new span. The span is automatically parented to the current
   * active span (if any). Call span.finish() when the operation completes.
   */
  startSpan(operation, options) {
    const spanId = generateId().replace(/-/g, "");
    const parentSpanId = this.getCurrentSpanId() || "";
    const traceId = this.getTraceId();
    this.spanStack.push(spanId);
    const span = new Span({
      traceId,
      spanId,
      parentSpanId,
      operation,
      description: options?.description || "",
      service: this.service,
      environment: this.environment,
      tags: options?.tags || {},
      startTimeMillis: Date.now(),
      onFinish: (spanData) => {
        const idx = this.spanStack.indexOf(spanId);
        if (idx >= 0) this.spanStack.splice(idx, 1);
        this.completedSpans.push(spanData);
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
  /** Reset trace context — clears trace ID and span stack. */
  resetTrace() {
    this.currentTraceId = null;
    this.spanStack = [];
  }
  /** Stop the flush timer and do a final flush. */
  destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
};

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

// src/modules/auto-breadcrumbs.ts
function instrumentFetch(addBreadcrumb, captureRequest, ownBaseUrl) {
  if (typeof globalThis.fetch !== "function") return;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const method = init?.method?.toUpperCase() || "GET";
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const safePath = url.split("?")[0];
    const isOwnIngest = ownBaseUrl && url.startsWith(ownBaseUrl);
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
      const response = await originalFetch.call(this, input, init);
      const durationMs = Date.now() - start;
      addBreadcrumb(
        "http",
        `${method} ${safePath} -> ${response.status}`,
        response.status >= 400 ? "error" : "info",
        { method, url: safePath, statusCode: response.status, durationMs }
      );
      if (captureRequest && !isOwnIngest) {
        try {
          captureRequest({
            direction: "outbound",
            method,
            host,
            path,
            statusCode: response.status,
            durationMs
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
            durationMs
          });
        } catch {
        }
      }
      throw err;
    }
  };
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

// src/modules/auto-node-http.ts
var PATCHED_FLAG = /* @__PURE__ */ Symbol.for("@allstak/node-http/patched");
function isAlreadyPatched(mod) {
  return mod[PATCHED_FLAG] === true;
}
function markPatched(mod) {
  mod[PATCHED_FLAG] = true;
}
function instrumentNodeHttp(capture, addBreadcrumb, ownBaseUrl) {
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
      const start = Date.now();
      const req = originalRequest(...args);
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
    const originalGet = mod.get?.bind(mod);
    if (originalGet) {
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

// src/client.ts
var INGEST_HOST = "https://api.allstak.sa";
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
    this.sessionReplay = null;
    // ─── Node uncaughtException / unhandledRejection auto-capture ─────
    this.nodeUncaughtHandler = null;
    this.nodeRejectionHandler = null;
    this.config = config;
    this.sessionId = generateId();
    const { baseUrl, apiKey } = resolveTransport(config);
    this.transport = new HttpTransport(baseUrl, apiKey);
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
    if (config.autoDbInstrumentation !== false && typeof window === "undefined") {
      enableDbAutoInstrumentation(this._database, {
        service: config.tags?.service,
        environment: config.environment
      });
    }
    this.tracing = new TracingModule(this.transport, {
      service: config.tags?.service,
      environment: config.environment
    });
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
    if (config.autoBreadcrumbs !== false) {
      instrumentFetch(
        (type, msg, level, data) => this.addBreadcrumb(type, msg, level, data),
        (item) => this.captureRequest({ ...item, method: item.method }),
        baseUrl
      );
      instrumentConsole((type, msg, level, data) => this.addBreadcrumb(type, msg, level, data));
      if (this.isNodeBuild() || typeof process !== "undefined" && process.versions?.node) {
        try {
          instrumentNodeHttp(
            (item) => this.captureRequest({ ...item, method: item.method }),
            (type, msg, level, data) => this.addBreadcrumb(type, msg, level, data),
            baseUrl
          );
        } catch {
        }
      }
      this.logs.setOnLogBreadcrumb((level, message) => {
        const bcLevel = level === "warn" ? "warn" : "error";
        this.addBreadcrumb("log", message, bcLevel, { logLevel: level });
      });
      this.httpRequests.setOnCapture((item) => {
        this.addBreadcrumb(
          "http",
          `${item.method} ${item.path} -> ${item.statusCode}`,
          item.statusCode >= 400 ? "error" : "info",
          { method: item.method, path: item.path, statusCode: item.statusCode, durationMs: item.durationMs }
        );
      });
    }
  }
  isNodeBuild() {
    return typeof globalThis.__ALLSTAK_NODE__ !== "undefined";
  }
  captureException(error, context) {
    const traceContext = {};
    const traceId = this.tracing.getTraceId();
    if (traceId) traceContext.traceId = traceId;
    const spanId = this.tracing.getCurrentSpanId();
    if (spanId) traceContext.spanId = spanId;
    this.errors.captureException(error, { ...traceContext, ...context });
  }
  addBreadcrumb(type, message, level, data) {
    this.errors.addBreadcrumb(type, message, level, data);
  }
  clearBreadcrumbs() {
    this.errors.clearBreadcrumbs();
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
    if (as === "log" || as === "both") {
      const logLevel = level === "warning" ? "warn" : level;
      this.logs.send(logLevel, message);
    }
    if (as === "error" || as === "both") {
      this.errors.captureMessage(message, level);
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
  setUser(user) {
    this.config.user = user;
  }
  setTag(key, value) {
    if (!this.config.tags) this.config.tags = {};
    this.config.tags[key] = value;
  }
  getSessionId() {
    return this.sessionId;
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
  /** Get the current trace ID (creates one if none exists). */
  getTraceId() {
    return this.tracing.getTraceId();
  }
  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId) {
    this.tracing.setTraceId(traceId);
  }
  /** Get the current active span ID, or null if no span is active. */
  getCurrentSpanId() {
    return this.tracing.getCurrentSpanId();
  }
  /** Reset trace context (trace ID and span stack). */
  resetTrace() {
    this.tracing.resetTrace();
  }
  destroy() {
    setTraceResolver(null);
    this.tracing.destroy();
    this.errors.destroy();
    this.httpRequests.destroy();
    this._database.destroy();
    this.sessionReplay?.destroy();
    this.uninstallNodeErrorHandlers();
  }
  installNodeErrorHandlers() {
    if (typeof process === "undefined" || typeof process.on !== "function") {
      return;
    }
    this.nodeUncaughtHandler = (err) => {
      try {
        const e = err instanceof Error ? err : new Error(String(err));
        this.errors.captureException(e, { source: "uncaughtException" });
      } catch {
      }
    };
    this.nodeRejectionHandler = (reason) => {
      try {
        const e = reason instanceof Error ? reason : new Error(String(reason));
        this.errors.captureException(e, { source: "unhandledRejection" });
      } catch {
      }
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
  addBreadcrumb(type, message, level, data) {
    ensureInit().addBreadcrumb(type, message, level, data);
  },
  clearBreadcrumbs() {
    ensureInit().clearBreadcrumbs();
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
  setUser(user) {
    ensureInit().setUser(user);
  },
  setTag(key, value) {
    ensureInit().setTag(key, value);
  },
  getSessionId() {
    return ensureInit().getSessionId();
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
  /** Get the current trace ID (creates one if none exists). */
  getTraceId() {
    return ensureInit().getTraceId();
  },
  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId) {
    ensureInit().setTraceId(traceId);
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
function ensureInit() {
  if (!instance) {
    throw new Error("AllStak.init() must be called before using the SDK");
  }
  return instance;
}

export {
  Span,
  DatabaseModule,
  AllStak
};
//# sourceMappingURL=chunk-ZKMM4EAU.mjs.map