"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/integrations/react.tsx
var react_exports = {};
__export(react_exports, {
  AllStak: () => AllStak,
  AllStakErrorBoundary: () => AllStakErrorBoundary,
  useAllStak: () => useAllStak,
  withAllStakProfiler: () => withAllStakProfiler
});
module.exports = __toCommonJS(react_exports);
var React = __toESM(require("react"));

// src/transport/buffer.ts
var MAX_BUFFER_SIZE = 100;
var EventBuffer = class {
  constructor() {
    this.queue = [];
  }
  push(event) {
    let dropped = false;
    if (this.queue.length >= MAX_BUFFER_SIZE) {
      this.queue.shift();
      dropped = true;
    }
    this.queue.push(event);
    return dropped;
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

// src/transport/http.ts
var REQUEST_TIMEOUT = 2e3;
var FAILURE_THRESHOLD = 3;
var BACKOFF_BASE_MS = 500;
var BACKOFF_MAX_MS = 3e4;
var HttpTransport = class {
  constructor(baseUrl, apiKey) {
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
  }
  send(path, payload) {
    this.enqueueOrDispatch({ path, payload });
    return Promise.resolve();
  }
  enqueueOrDispatch(item) {
    if (Date.now() < this.circuitOpenUntil) {
      if (this.buffer.push(item)) this.dropped++;
      return;
    }
    this.track(this.dispatch(item));
  }
  track(promise) {
    this.inFlight.add(promise);
    promise.finally(() => this.inFlight.delete(promise)).catch(() => void 0);
  }
  async dispatch(item) {
    try {
      await this.doFetch(`${this.baseUrl}${item.path}`, item.payload);
      this.sent++;
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
      this.scheduleFlush();
    } catch (err) {
      this.failed++;
      this.recordFailure(err);
      if (this.buffer.push(item)) this.dropped++;
    }
  }
  async doFetch(url, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const started = Date.now();
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
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    } finally {
      this.lastTransportLatencyMs = Date.now() - started;
    }
  }
  scheduleFlush() {
    if (this.buffer.size === 0 || this.flushing) return;
    const delay = Math.max(0, this.circuitOpenUntil - Date.now());
    const timer = setTimeout(() => {
      void this.flushBuffer().catch(() => void 0);
    }, delay);
    if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  }
  async flushBuffer() {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;
    const started = Date.now();
    try {
      const items = this.buffer.drain();
      for (const item of items) {
        if (Date.now() < this.circuitOpenUntil) {
          if (this.buffer.push(item)) this.dropped++;
          continue;
        }
        try {
          await this.doFetch(`${this.baseUrl}${item.path}`, item.payload);
          this.sent++;
          this.consecutiveFailures = 0;
          this.circuitOpenUntil = 0;
        } catch (err) {
          this.failed++;
          this.recordFailure(err);
          if (this.buffer.push(item)) this.dropped++;
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
    if (this.consecutiveFailures < FAILURE_THRESHOLD) return;
    const retryAfterMs = retryAfterFromError(error);
    const backoff = retryAfterMs ?? jitteredBackoff(this.consecutiveFailures);
    this.circuitOpenUntil = Date.now() + backoff;
  }
  getBufferSize() {
    return this.buffer.size;
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
  getStats() {
    return {
      queued: this.buffer.size,
      sent: this.sent,
      failed: this.failed,
      dropped: this.dropped,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpenUntil: this.circuitOpenUntil,
      lastTransportLatencyMs: this.lastTransportLatencyMs,
      lastFlushDurationMs: this.lastFlushDurationMs
    };
  }
};
function jitteredBackoff(failures) {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(8, failures - FAILURE_THRESHOLD));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}
function retryAfterFromError(error) {
  const message = error instanceof Error ? error.message : "";
  const match = /HTTP\s+(429|503)/.exec(message);
  return match ? BACKOFF_MAX_MS : null;
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
    const fs = require("fs");
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
  /(^|\.)set-cookie$/i,
  /(^|\.)x-api-key$/i,
  /(^|\.)x-auth-token$/i,
  /(^|\.)x-access-token$/i,
  /(^|\.)x-allstak-key$/i,
  /(^|[._-])token$/i,
  /(^|[._-])api[._-]?key$/i,
  /(^|[._-])password$/i,
  /(^|[._-])passwd$/i,
  /(^|[._-])secret$/i,
  /(^|[._-])session[._-]?id$/i,
  /(^|[._-])csrf$/i,
  /(^|[._-])jwt$/i,
  /(^|[._-])bearer$/i
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
function redactObject(input, options = {}) {
  if (input == null) return input;
  const extra = compileExtraPatterns(options.extraKeys);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seen = /* @__PURE__ */ new WeakMap();
  return walk(input, extra, 0, maxDepth, seen);
}
function walk(node, extra, depth, maxDepth, seen) {
  if (node == null) return node;
  const t = typeof node;
  if (t !== "object") return node;
  if (depth >= maxDepth) return "[MaxDepth]";
  const asObj = node;
  if (seen.has(asObj)) return "[Circular]";
  if (Array.isArray(node)) {
    const out2 = new Array(node.length);
    seen.set(asObj, out2);
    for (let i = 0; i < node.length; i++) {
      out2[i] = walk(node[i], extra, depth + 1, maxDepth, seen);
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
    out[k] = walk(v, extra, depth + 1, maxDepth, seen);
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
    this.maxBreadcrumbs = config.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    this.setupAutocapture();
  }
  addEventProcessor(processor) {
    this.eventProcessors.push(processor);
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
  /**
   * Build the release-metadata block we attach to every event. Backend stores
   * `release` + `environment` as first-class fields; the rest (sdk.name,
   * sdk.version, platform, dist, commitSha, branch) ride along inside
   * `metadata` so they survive the wire even before the backend has dedicated
   * columns. Once those columns land, the ingester reads them out of metadata.
   */
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
    const currentBreadcrumbs = this.breadcrumbs.length > 0 ? this.breadcrumbs.map((bc) => bc.data ? { ...bc, data: redactObject(bc.data, { extraKeys }) } : bc) : void 0;
    this.breadcrumbs = [];
    if (!this.passesSampleRate()) return;
    const exceptionClass = (error.name && error.name !== "Error" ? error.name : void 0) || error.constructor?.name || "Error";
    const requestCtx = requestContextFromContext(context) ?? browserRequestContext();
    const transaction = stringContext(context, "transaction") ?? requestCtx?.route ?? (requestCtx?.method && requestCtx?.path ? `${requestCtx.method} ${requestCtx.path}` : void 0);
    const payload = {
      exceptionClass,
      message: error.message,
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
    this.sendThroughPipeline(payload);
  }
  captureMessage(message, level = "info", options) {
    if (!this.passesSampleRate()) return;
    const platform = this.config.platform || detectPlatform();
    const callerMeta = options?.metadata ?? options?.data;
    const payload = {
      exceptionClass: "Message",
      message,
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
    this.sendThroughPipeline(payload);
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
    const safePerCall = redactObject(perCallContext, { extraKeys });
    const safeTags = redactObject(this.config.tags, { extraKeys });
    const safeExtras = redactObject(this.config.extras, { extraKeys });
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
        out[`context.${name}`] = ctx;
      }
    }
    return out;
  }
  async sendThroughPipeline(payload) {
    let final = payload;
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
    this.transport.send(INGEST_PATH, final);
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
    const safeMeta = redactObject(meta, { extraKeys });
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
      traceId: item.traceId ?? generateTraceId(),
      requestId: item.requestId ?? generateTraceId(),
      spanId: item.spanId,
      parentSpanId: item.parentSpanId,
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
    this.globalState = { traceId: null, spanStack: [] };
    this.asyncStorage = createAsyncTraceStorage();
    this.completedSpans = [];
    this.spanProcessors = [];
    this.flushTimer = null;
    this.transport = transport;
    this.service = config.service || "";
    this.environment = config.environment || "";
    this.beforeSendSpan = config.beforeSendSpan;
    this.ignoreSpans = config.ignoreSpans ?? [];
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS3);
    if (typeof this.flushTimer === "object" && typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }
  addSpanProcessor(processor) {
    this.spanProcessors.push(processor);
  }
  withTraceContext(traceId, requestIdOrCallback, maybeCallback) {
    const requestId = typeof requestIdOrCallback === "function" ? void 0 : requestIdOrCallback;
    const callback = typeof requestIdOrCallback === "function" ? requestIdOrCallback : maybeCallback;
    if (!this.asyncStorage) {
      if (traceId) this.globalState.traceId = traceId;
      if (requestId) this.globalState.requestId = requestId;
      return callback();
    }
    return this.asyncStorage.run({ traceId: traceId ?? null, requestId: requestId ?? null, spanStack: [] }, callback);
  }
  state() {
    return this.asyncStorage?.getStore() ?? this.globalState;
  }
  /** Get the current trace ID, creating one if none exists. */
  getTraceId() {
    const state = this.state();
    if (!state.traceId) {
      state.traceId = generateId().replace(/-/g, "");
    }
    return state.traceId;
  }
  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId) {
    this.state().traceId = traceId;
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
  /**
   * Start a new span. The span is automatically parented to the current
   * active span (if any). Call span.finish() when the operation completes.
   */
  startSpan(operation, options) {
    const state = this.state();
    const spanId = generateId().replace(/-/g, "");
    const parentSpanId = this.getCurrentSpanId() || "";
    const traceId = this.getTraceId();
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
      startTimeMillis: Date.now(),
      onFinish: (spanData) => {
        const idx = state.spanStack.indexOf(spanId);
        if (idx >= 0) state.spanStack.splice(idx, 1);
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
  /** Reset trace context — clears trace ID and span stack. */
  resetTrace() {
    const state = this.state();
    state.traceId = null;
    state.requestId = null;
    state.spanStack = [];
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
  if (typeof globalThis.__ALLSTAK_NODE__ === "undefined") return null;
  try {
    const req = typeof require === "function" ? require : void 0;
    const AsyncLocalStorage = req?.("node:async_hooks").AsyncLocalStorage;
    return AsyncLocalStorage ? new AsyncLocalStorage() : null;
  } catch {
    return null;
  }
}

// src/integrations/db/shared.ts
var traceResolver = null;
function setTraceResolver(resolver) {
  traceResolver = resolver;
}
function getTraceContext() {
  if (!traceResolver) return {};
  try {
    return traceResolver() ?? {};
  } catch {
    return {};
  }
}
function normalizeQuery(sql) {
  if (!sql) return "";
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/'(?:''|[^'])*'/g, "?").replace(/\$[a-zA-Z0-9_]*\$[\s\S]*?\$[a-zA-Z0-9_]*\$/g, "?").replace(/\b\d+(?:\.\d+)?\b/g, "?").replace(/\s+/g, " ").trim();
}
function hashQuery(normalized) {
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + c;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
function detectQueryType(sql) {
  const first = sql.trim().split(/\s+/)[0]?.toUpperCase();
  if (!first) return "OTHER";
  if (["SELECT", "INSERT", "UPDATE", "DELETE", "BEGIN", "COMMIT", "ROLLBACK"].includes(first)) {
    return first;
  }
  return "OTHER";
}
function safeCapture(dbModule, config, item) {
  try {
    const ctx = getTraceContext();
    dbModule.capture({
      ...item,
      service: config.service,
      environment: config.environment,
      traceId: ctx.traceId,
      spanId: ctx.spanId
    });
  } catch {
  }
}
var DEDUPE_SYMBOL = /* @__PURE__ */ Symbol.for("allstak.db.ownedByOrm");
function isOwnedByOrm(target) {
  try {
    if (target && typeof target === "object") {
      return target[DEDUPE_SYMBOL] === true;
    }
  } catch {
  }
  return false;
}
function tryRequire(name) {
  const req = typeof require !== "undefined" ? require : null;
  if (!req) {
    if (process?.env?.ALLSTAK_DB_DEBUG === "1") {
      console.error(`[allstak-db] tryRequire('${name}') skipped: no require`);
    }
    return null;
  }
  const bases = [];
  try {
    bases.push(process.cwd());
  } catch {
  }
  try {
    const mainPaths = req.main?.paths;
    if (mainPaths) bases.push(...mainPaths);
  } catch {
  }
  for (const base of bases) {
    try {
      const resolved = req.resolve(name, { paths: [base] });
      return req(resolved);
    } catch {
    }
  }
  try {
    return req(name);
  } catch (e) {
    if (typeof process !== "undefined" && process?.env?.ALLSTAK_DB_DEBUG === "1") {
      console.error(`[allstak-db] tryRequire('${name}') failed:`, e.message);
    }
    return null;
  }
}

// src/integrations/db/pg.ts
var patched = false;
function instrumentPg(dbModule, config = {}) {
  if (patched) return true;
  const pg = tryRequire("pg");
  if (!pg || !pg.Client || !pg.Client.prototype || !pg.Client.prototype.query) {
    return false;
  }
  const originalQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = function patchedPgQuery(...args) {
    if (isOwnedByOrm(this)) {
      return originalQuery.apply(this, args);
    }
    const startTime = Date.now();
    const firstArg = args[0];
    const queryText = typeof firstArg === "string" ? firstArg : firstArg?.text ?? "";
    const normalized = normalizeQuery(queryText);
    const databaseName = this.database ?? "";
    const record2 = (status, err, rowsAffected = -1) => {
      safeCapture(dbModule, config, {
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: detectQueryType(queryText),
        durationMs: Date.now() - startTime,
        timestampMillis: startTime,
        status,
        errorMessage: err?.message?.slice(0, 500),
        databaseName,
        databaseType: "postgresql",
        rowsAffected
      });
    };
    let cbIndex = -1;
    for (let i = args.length - 1; i >= 0; i--) {
      if (typeof args[i] === "function") {
        cbIndex = i;
        break;
      }
    }
    const submittable = firstArg && typeof firstArg === "object" ? firstArg : null;
    if (cbIndex >= 0) {
      const originalCb = args[cbIndex];
      args[cbIndex] = function wrappedCb(err, res) {
        record2(err ? "error" : "success", err ?? void 0, res?.rowCount ?? -1);
        return originalCb.call(this, err, res);
      };
      try {
        return originalQuery.apply(this, args);
      } catch (err) {
        record2("error", err);
        throw err;
      }
    } else if (submittable?.callback && typeof submittable.callback === "function") {
      const originalCb = submittable.callback;
      submittable.callback = function wrappedCb(err, res) {
        record2(err ? "error" : "success", err ?? void 0, res?.rowCount ?? -1);
        return originalCb.call(this, err, res);
      };
      try {
        return originalQuery.apply(this, args);
      } catch (err) {
        record2("error", err);
        throw err;
      }
    }
    try {
      const result = originalQuery.apply(this, args);
      if (result && typeof result.then === "function") {
        return result.then(
          (res) => {
            record2("success", void 0, res?.rowCount ?? -1);
            return res;
          },
          (err) => {
            record2("error", err);
            throw err;
          }
        );
      }
      const maybeEmitter = result;
      if (maybeEmitter && typeof maybeEmitter.on === "function") {
        maybeEmitter.on("end", () => record2("success"));
        maybeEmitter.on("error", (err) => record2("error", err));
      }
      return result;
    } catch (err) {
      record2("error", err);
      throw err;
    }
  };
  patched = true;
  return true;
}

// src/integrations/db/mysql2.ts
var patched2 = false;
function instrumentMysql2(dbModule, config = {}) {
  if (patched2) return true;
  const mysql2 = tryRequire("mysql2");
  if (!mysql2?.Connection?.prototype) return false;
  const proto = mysql2.Connection.prototype;
  const getSql = (args) => {
    const first = args[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      const o = first;
      if (typeof o.sql === "string") return o.sql;
    }
    return "";
  };
  const wrapProtoMethod = (methodName) => {
    const original = proto[methodName];
    if (typeof original !== "function") return;
    proto[methodName] = function wrapped(...args) {
      if (isOwnedByOrm(this)) {
        return original.apply(this, args);
      }
      const startTime = Date.now();
      const sql = getSql(args);
      const normalized = normalizeQuery(sql);
      const databaseName = this.config?.database ?? "";
      const record2 = (status, err, rowsAffected = -1) => {
        safeCapture(dbModule, config, {
          normalizedQuery: normalized,
          queryHash: hashQuery(normalized),
          queryType: detectQueryType(sql),
          durationMs: Date.now() - startTime,
          timestampMillis: startTime,
          status,
          errorMessage: err?.message?.slice(0, 500),
          databaseName,
          databaseType: "mysql",
          rowsAffected
        });
      };
      let cbIndex = -1;
      for (let i = args.length - 1; i >= 0; i--) {
        if (typeof args[i] === "function") {
          cbIndex = i;
          break;
        }
      }
      const wrapOriginalCb = (original2) => {
        return function wrappedCb(err, results, fields) {
          const rows = results?.affectedRows ?? results?.length ?? -1;
          record2(err ? "error" : "success", err ?? void 0, rows);
          return original2.call(this, err, results, fields);
        };
      };
      if (cbIndex >= 0) {
        const originalCb = args[cbIndex];
        args[cbIndex] = wrapOriginalCb(originalCb);
        try {
          return original.apply(this, args);
        } catch (err) {
          record2("error", err);
          throw err;
        }
      }
      const first = args[0];
      if (first && typeof first.onResult === "function") {
        const origOnResult = first.onResult;
        first.onResult = wrapOriginalCb(origOnResult);
        try {
          return original.apply(this, args);
        } catch (err) {
          record2("error", err);
          throw err;
        }
      }
      try {
        const result = original.apply(this, args);
        record2("success");
        return result;
      } catch (err) {
        record2("error", err);
        throw err;
      }
    };
  };
  wrapProtoMethod("query");
  wrapProtoMethod("execute");
  patched2 = true;
  return true;
}

// src/integrations/db/sqlite.ts
var patched3 = false;
function record(dbModule, config, startTime, sql, databaseName, status, err, rowsAffected = -1) {
  const normalized = normalizeQuery(sql);
  safeCapture(dbModule, config, {
    normalizedQuery: normalized,
    queryHash: hashQuery(normalized),
    queryType: detectQueryType(sql),
    durationMs: Date.now() - startTime,
    timestampMillis: startTime,
    status,
    errorMessage: err?.message?.slice(0, 500),
    databaseName,
    databaseType: "sqlite",
    rowsAffected
  });
}
function patchBetterSqlite3(dbModule, config) {
  const mod = tryRequire("better-sqlite3");
  if (!mod || !mod.prototype) return false;
  const origPrepare = mod.prototype.prepare;
  const origExec = mod.prototype.exec;
  if (typeof origPrepare === "function") {
    mod.prototype.prepare = function(sql) {
      if (isOwnedByOrm(this)) {
        return origPrepare.call(this, sql);
      }
      const databaseName = this.name ?? "";
      let stmt;
      try {
        stmt = origPrepare.call(this, sql);
      } catch (err) {
        record(dbModule, config, Date.now(), sql, databaseName, "error", err);
        throw err;
      }
      for (const method of ["run", "get", "all", "iterate"]) {
        const original = stmt[method];
        if (typeof original === "function") {
          stmt[method] = function(...args) {
            const startTime = Date.now();
            try {
              const result = original.apply(this, args);
              const rows = result?.changes ?? (Array.isArray(result) ? result.length : -1);
              record(dbModule, config, startTime, sql, databaseName, "success", void 0, rows);
              return result;
            } catch (err) {
              record(dbModule, config, startTime, sql, databaseName, "error", err);
              throw err;
            }
          };
        }
      }
      return stmt;
    };
  }
  if (typeof origExec === "function") {
    mod.prototype.exec = function(sql) {
      if (isOwnedByOrm(this)) return origExec.call(this, sql);
      const startTime = Date.now();
      const databaseName = this.name ?? "";
      try {
        const result = origExec.call(this, sql);
        record(dbModule, config, startTime, sql, databaseName, "success");
        return result;
      } catch (err) {
        record(dbModule, config, startTime, sql, databaseName, "error", err);
        throw err;
      }
    };
  }
  return true;
}
function patchSqlite3(dbModule, config) {
  const mod = tryRequire("sqlite3");
  if (!mod?.Database?.prototype) return false;
  const proto = mod.Database.prototype;
  for (const method of ["run", "get", "all", "each", "exec"]) {
    const original = proto[method];
    if (typeof original !== "function") continue;
    proto[method] = function(...args) {
      if (isOwnedByOrm(this)) {
        return original.apply(this, args);
      }
      const startTime = Date.now();
      const sql = typeof args[0] === "string" ? args[0] : "";
      const databaseName = this.filename ?? "";
      const cbIndex = args.findIndex((a) => typeof a === "function");
      if (cbIndex >= 0) {
        const cb = args[cbIndex];
        args[cbIndex] = function(err, ...rest) {
          const rows = this?.changes ?? -1;
          record(
            dbModule,
            config,
            startTime,
            sql,
            databaseName,
            err ? "error" : "success",
            err ?? void 0,
            rows
          );
          return cb.apply(this, [err, ...rest]);
        };
      } else {
        record(dbModule, config, startTime, sql, databaseName, "success");
      }
      try {
        return original.apply(this, args);
      } catch (err) {
        record(dbModule, config, startTime, sql, databaseName, "error", err);
        throw err;
      }
    };
  }
  return true;
}
function patchNodeSqlite(dbModule, config) {
  const origEmit = process.emitWarning;
  process.emitWarning = function(warning, ...args) {
    if (typeof warning === "string" && warning.includes("SQLite is an experimental feature")) return;
    return origEmit.call(process, warning, ...args);
  };
  const mod = tryRequire("node:sqlite");
  process.emitWarning = origEmit;
  if (!mod?.DatabaseSync?.prototype) return false;
  const dbProto = mod.DatabaseSync.prototype;
  const origPrepare = dbProto.prepare;
  if (typeof origPrepare === "function") {
    dbProto.prepare = function(sql) {
      const stmt = origPrepare.call(this, sql);
      const databaseName = this.location ?? "";
      for (const method of ["run", "get", "all"]) {
        const original = stmt[method];
        if (typeof original === "function") {
          stmt[method] = function(...args) {
            const startTime = Date.now();
            try {
              const result = original.apply(this, args);
              const rows = result?.changes ?? (Array.isArray(result) ? result.length : -1);
              record(dbModule, config, startTime, sql, databaseName, "success", void 0, rows);
              return result;
            } catch (err) {
              record(dbModule, config, startTime, sql, databaseName, "error", err);
              throw err;
            }
          };
        }
      }
      return stmt;
    };
  }
  const origExec = dbProto.exec;
  if (typeof origExec === "function") {
    dbProto.exec = function(sql) {
      const startTime = Date.now();
      const databaseName = this.location ?? "";
      try {
        const result = origExec.call(this, sql);
        record(dbModule, config, startTime, sql, databaseName, "success");
        return result;
      } catch (err) {
        record(dbModule, config, startTime, sql, databaseName, "error", err);
        throw err;
      }
    };
  }
  return true;
}
function instrumentSqlite(dbModule, config = {}) {
  if (patched3) return true;
  let any = false;
  any = patchBetterSqlite3(dbModule, config) || any;
  any = patchSqlite3(dbModule, config) || any;
  any = patchNodeSqlite(dbModule, config) || any;
  if (any) patched3 = true;
  return any;
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
    const shouldPropagate = !isOwnIngest && traceId && targetMatches(url, tracePropagationTargets);
    const propagatedInit = shouldPropagate ? withTraceHeaders(input, init, traceId, requestId) : init;
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
    sanitized = JSON.stringify(redactValue(parsed, customFields), null, 2) + (truncated ? "\n[TRUNCATED]" : "");
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
function redactValue(value, customFields = []) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, customFields));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSensitiveKey2(key, customFields) ? "[REDACTED]" : redactValue(child, customFields);
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
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]").replace(/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED_CARD]");
}
function generateRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
function targetMatches(url, targets) {
  if (!targets || targets.length === 0) return true;
  return targets.some((target) => typeof target === "string" ? url.includes(target) : target.test(url));
}
function withTraceHeaders(input, init, traceId, requestId) {
  const next = { ...init ?? {} };
  const headers = new Headers(init?.headers ?? requestHeadersFromInput(input));
  const spanId = requestId.replace(/-/g, "").slice(0, 16).padEnd(16, "0");
  const traceparent = `00-${normalizeTraceId(traceId)}-${normalizeSpanId(spanId)}-01`;
  const baggage = [
    `allstak-trace_id=${encodeURIComponent(traceId)}`,
    `allstak-span_id=${encodeURIComponent(spanId)}`,
    `allstak-request_id=${encodeURIComponent(requestId)}`
  ].join(",");
  setHeaderIfMissing(headers, "traceparent", traceparent);
  setHeaderIfMissing(headers, "allstak-trace", `${traceId}-${spanId}-1`);
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
  } else if (!allstakBaggage.includes("allstak-trace_id=")) {
    headers.set("allstak-baggage", `${allstakBaggage},${baggage}`);
  }
  const standardBaggage = headers.get("baggage");
  if (!standardBaggage) {
    headers.set("baggage", baggage);
  } else if (!standardBaggage.includes("allstak-trace_id=")) {
    headers.set("baggage", `${standardBaggage},${baggage}`);
  }
}
function normalizeTraceId(traceId) {
  return traceId.replace(/-/g, "").slice(0, 32).padEnd(32, "0");
}
function normalizeSpanId(spanId) {
  return spanId.replace(/-/g, "").slice(0, 16).padEnd(16, "0");
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
function instrumentNodeHttp(capture, addBreadcrumb, ownBaseUrl) {
  const restorers = [];
  for (const protocol of ["http", "https"]) {
    let mod;
    try {
      mod = require(`node:${protocol}`);
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
      () => ({ traceId: client.getTraceId() }),
      options.httpBodyCapture,
      options.tracePropagationTargets
    );
    if (client.isNodeRuntime()) {
      try {
        instrumentNodeHttp(
          (item) => client.captureRequest({ ...item, method: item.method }),
          (type, msg, level, data) => client.addBreadcrumb(type, msg, level, data),
          baseUrl
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
    consoleIntegration(),
    httpClientIntegration(),
    databaseIntegration()
  ];
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
var SDK_VERSION = "0.2.3";
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
function applyReleaseAutodetect(config) {
  const isBrowser = typeof window !== "undefined";
  if (!config.platform) config.platform = isBrowser ? "browser" : "node";
  if (!config.sdkName) config.sdkName = SDK_NAME;
  if (!config.sdkVersion) config.sdkVersion = SDK_VERSION;
  if (!config.release) {
    config.release = envVar("ALLSTAK_RELEASE") ?? envVar("npm_package_version") ?? envVar("VERCEL_GIT_COMMIT_SHA")?.slice(0, 12) ?? envVar("RAILWAY_GIT_COMMIT_SHA")?.slice(0, 12) ?? envVar("RENDER_GIT_COMMIT")?.slice(0, 12);
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
    this.integrations = {};
    this.sessionReplay = null;
    this.scopeStack = [];
    // ─── Node uncaughtException / unhandledRejection auto-capture ─────
    this.nodeUncaughtHandler = null;
    this.nodeRejectionHandler = null;
    applyReleaseAutodetect(config);
    this.config = config;
    this.sessionId = generateId();
    const { baseUrl, apiKey } = resolveTransport(config);
    this.baseUrl = baseUrl;
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
    this.tracing = new TracingModule(this.transport, {
      service: config.tags?.service,
      environment: config.environment,
      beforeSendSpan: config.beforeSendSpan,
      ignoreSpans: config.ignoreSpans
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
  }
  isNodeBuild() {
    return typeof globalThis.__ALLSTAK_NODE__ !== "undefined";
  }
  isNodeRuntime() {
    return this.isNodeBuild() || typeof process !== "undefined" && !!process.versions?.node;
  }
  getBaseUrl() {
    return this.baseUrl;
  }
  captureException(error, context) {
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
    if (this.scopeStack.length === 0) return work();
    const eff = mergeScopes(this.config, this.scopeStack);
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
  withScope(callback) {
    const scope = new Scope();
    this.scopeStack.push(scope);
    let popped = false;
    const pop = () => {
      if (!popped) {
        popped = true;
        this.scopeStack.pop();
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
    return this.scopeStack[this.scopeStack.length - 1] ?? null;
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
    this.httpRequests.flush();
    this._database.flush();
    this.tracing.flush();
    this.sessionReplay?.flush();
    return this.transport.flush(timeoutMs);
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
  withTraceContext(traceId, requestIdOrCallback, maybeCallback) {
    if (typeof requestIdOrCallback === "function") {
      return this.tracing.withTraceContext(traceId, requestIdOrCallback);
    }
    return this.tracing.withTraceContext(traceId, requestIdOrCallback, maybeCallback);
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
  installNodeErrorHandlers() {
    if (typeof process === "undefined" || typeof process.on !== "function") {
      return;
    }
    this.nodeUncaughtHandler = (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      try {
        this.errors.captureException(e, { source: "uncaughtException" });
      } catch {
      }
      this.uninstallNodeErrorHandlers();
      throw e;
    };
    this.nodeRejectionHandler = (reason) => {
      const e = reason instanceof Error ? reason : new Error(String(reason));
      try {
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
  /**
   * Run `callback` with a fresh, temporary {@link Scope} that isolates any
   * user/tag/extra/context/fingerprint/level it sets. Pop is automatic for
   * sync, async, and throwing callbacks.
   */
  withScope(callback) {
    return ensureInit().withScope(callback);
  },
  getSessionId() {
    return ensureInit().getSessionId();
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

// src/integrations/react.tsx
var AllStakErrorBoundary = class extends React.Component {
  constructor() {
    super(...arguments);
    this.state = { error: null };
    this.reset = () => this.setState({ error: null });
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    try {
      AllStak.addBreadcrumb("ui", "React error boundary caught error", "error", {
        componentStack: info.componentStack ?? ""
      });
      const context = {
        componentStack: info.componentStack ?? "",
        source: "react-error-boundary"
      };
      if (this.props.tags) {
        for (const [k, v] of Object.entries(this.props.tags)) {
          context[`tag.${k}`] = v;
        }
      }
      AllStak.captureException(error, context);
    } catch {
    }
    try {
      this.props.onError?.(error, info);
    } catch {
    }
  }
  render() {
    if (this.state.error) {
      const { fallback } = this.props;
      if (typeof fallback === "function") {
        return fallback({ error: this.state.error, reset: this.reset });
      }
      if (fallback !== void 0) return fallback;
      return null;
    }
    return this.props.children;
  }
};
function useAllStak() {
  return React.useMemo(
    () => ({
      captureException: (error, ctx) => AllStak.captureException(error, ctx),
      captureMessage: (msg, level = "info") => AllStak.captureMessage(msg, level),
      setUser: (user) => AllStak.setUser(user),
      setTag: (key, value) => AllStak.setTag(key, value),
      addBreadcrumb: (type, message, level, data) => AllStak.addBreadcrumb(type, message, level, data)
    }),
    []
  );
}
function withAllStakProfiler(Component2, name) {
  const displayName = name ?? Component2.displayName ?? Component2.name ?? "AnonymousComponent";
  const Wrapped = (props) => {
    React.useEffect(() => {
      AllStak.addBreadcrumb("navigation", `Mounted <${displayName}>`, "info");
    }, []);
    return React.createElement(Component2, props);
  };
  Wrapped.displayName = `withAllStakProfiler(${displayName})`;
  return Wrapped;
}
//# sourceMappingURL=react.js.map