import { createRequire as __allstakCreateRequire } from 'node:module';
const require = __allstakCreateRequire(import.meta.url);
import {
  AllStak,
  redactHeaderRecord,
  redactValue
} from "./chunk-HZP5SVKB.mjs";
import "./chunk-2Z2PH3DC.mjs";
import "./chunk-6GVGKK5H.mjs";

// src/integrations/express.ts
function pathFromRequest(req) {
  const raw = req.originalUrl ?? req.url ?? req.path ?? "/";
  const qIdx = raw.indexOf("?");
  return qIdx >= 0 ? raw.substring(0, qIdx) : raw;
}
function methodOf(req) {
  const m = (req.method || "GET").toUpperCase();
  if (m === "GET" || m === "POST" || m === "PUT" || m === "DELETE" || m === "PATCH" || m === "HEAD" || m === "OPTIONS") {
    return m;
  }
  return "GET";
}
function hostOf(req) {
  if (req.hostname) return req.hostname;
  const h = req.headers?.host;
  if (typeof h === "string") return h;
  return "unknown";
}
function routeOf(req) {
  const routePath = req.route?.path;
  const route = Array.isArray(routePath) ? routePath.map(String).join("|") : routePath != null ? String(routePath) : void 0;
  if (!route) return void 0;
  return `${req.baseUrl ?? ""}${route}`;
}
function queryOf(req) {
  const raw = req.originalUrl ?? req.url;
  if (!raw) return void 0;
  const qIdx = raw.indexOf("?");
  return qIdx >= 0 ? raw.substring(qIdx) : void 0;
}
function userAgentOf(req) {
  return firstHeader(req.headers["user-agent"]);
}
function userFromRequest(req) {
  const u = req.user;
  if (!u || typeof u !== "object") return null;
  const id = u.id != null ? String(u.id) : void 0;
  const email = typeof u.email === "string" ? u.email : void 0;
  if (!id && !email) return null;
  return { id, email };
}
var allstakExpress = {
  /**
   * Mount this BEFORE your routes. Opens a root span for the request,
   * captures the inbound HTTP request (with real round-trip timing) when
   * the response finishes, and auto-attaches `req.user` onto subsequent
   * captures.
   */
  requestHandler(options = {}) {
    return function allstakRequestHandler(req, res, next) {
      const sdk = AllStak._getInstance();
      if (!sdk) {
        next();
        return;
      }
      const start = Date.now();
      const path = pathFromRequest(req);
      const method = methodOf(req);
      const host = hostOf(req);
      const route = routeOf(req);
      const requestId = firstHeader(req.headers["x-allstak-request-id"]) ?? firstHeader(req.headers["x-request-id"]) ?? generateRequestId();
      const bodyCapture = resolveBodyCapture(sdk.getOptions().httpBodyCapture, options.bodyCapture);
      const responseCapture = installResponseCapture(res);
      try {
        res.setHeader?.("x-allstak-request-id", requestId);
      } catch {
      }
      const upstreamTrace = firstHeader(req.headers["x-allstak-trace-id"]) ?? firstHeader(req.headers["x-trace-id"]) ?? traceIdFromTraceparent(firstHeader(req.headers["traceparent"]));
      const upstreamSampled = sampledFromTraceparent(firstHeader(req.headers["traceparent"]));
      sdk.withTraceContext(upstreamTrace, requestId, () => {
        sdk.setParentSampled(upstreamSampled);
        const traceId = sdk.getTraceId();
        let rootSpan = null;
        try {
          rootSpan = sdk.startSpan(`${method} ${path}`, {
            description: `HTTP ${method} ${path}`,
            op: "http.server",
            platform: "node",
            tags: {
              "http.method": method,
              "http.url": path,
              "http.host": host,
              "http.request_id": requestId
            },
            attributes: {
              "http.method": method,
              "http.route": route || path,
              "http.target": path,
              "http.host": host,
              "http.request_id": requestId,
              "allstak.request_id": requestId
            }
          });
        } catch {
        }
        let finalized = false;
        const finalize = () => {
          if (finalized) return;
          finalized = true;
          try {
            const durationMs = Date.now() - start;
            const u = userFromRequest(req);
            if (u) sdk.setUser(u);
            AllStak.captureRequest({
              traceId,
              requestId,
              spanId: rootSpan?.spanId,
              direction: "inbound",
              method,
              host,
              path,
              statusCode: res.statusCode,
              durationMs,
              requestHeaders: redactHeaders(req.headers, sdk.getOptions().redactKeys),
              responseHeaders: redactResponseHeaders(res, sdk.getOptions().redactKeys),
              ...captureInboundBodies(req, responseCapture.body, responseCapture.contentType, bodyCapture),
              userId: u?.id,
              timestamp: new Date(start).toISOString()
            });
            if (rootSpan) {
              try {
                if (route) {
                  rootSpan.setTag?.(
                    "http.route",
                    route
                  );
                }
                rootSpan.setTag?.(
                  "http.status_code",
                  String(res.statusCode)
                );
                rootSpan.finish(res.statusCode >= 500 ? "error" : "ok");
              } catch {
              }
            }
            sdk.resetTrace();
          } catch {
          }
        };
        res.on("finish", finalize);
        res.on("close", finalize);
        next();
      });
    };
  },
  /**
   * Mount this AFTER your routes. Captures any error thrown by an Express
   * route or middleware (including async errors forwarded via `next(err)`).
   */
  errorHandler() {
    return function allstakErrorHandler(err, req, _res, next) {
      try {
        const sdk = AllStak._getInstance();
        if (sdk) {
          const u = userFromRequest(req);
          if (u) sdk.setUser(u);
          const e = err instanceof Error ? err : new Error(String(err));
          const method = methodOf(req);
          const path = pathFromRequest(req);
          const host = hostOf(req);
          const route = routeOf(req);
          const requestId = firstHeader(req.headers["x-allstak-request-id"]) ?? firstHeader(req.headers["x-request-id"]) ?? sdk.getRequestId() ?? void 0;
          AllStak.captureException(e, {
            traceId: sdk.getTraceId(),
            requestId,
            spanId: sdk.getCurrentSpanId() ?? void 0,
            transaction: route ? `${method} ${route}` : `${method} ${path}`,
            requestContext: {
              method,
              path,
              host,
              route,
              query: queryOf(req),
              userAgent: userAgentOf(req)
            },
            "request.method": method,
            "request.path": path,
            "request.host": host,
            ...requestId ? { "request.id": requestId } : {},
            ...route ? { "request.route": route } : {}
          });
        }
      } catch {
      }
      next(err);
    };
  }
};
function firstHeader(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}
function traceIdFromTraceparent(header) {
  if (!header) return void 0;
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(header.trim());
  return match?.[1];
}
function sampledFromTraceparent(header) {
  if (!header) return void 0;
  const match = /^00-[0-9a-f]{32}-[0-9a-f]{16}-([0-9a-f]{2})$/i.exec(header.trim());
  if (!match) return void 0;
  return (parseInt(match[1], 16) & 1) === 1;
}
function generateRequestId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
function resolveBodyCapture(globalOption, localOption) {
  const option = localOption === void 0 ? globalOption : localOption;
  if (option === true) return { enabled: true };
  if (!option || option.enabled === false) return false;
  return option;
}
function installResponseCapture(res) {
  const captured = { body: void 0 };
  const originalSend = typeof res.send === "function" ? res.send.bind(res) : null;
  const originalJson = typeof res.json === "function" ? res.json.bind(res) : null;
  if (originalSend) {
    res.send = (body) => {
      captured.body = body;
      captured.contentType = headerToString(res.getHeader("content-type"));
      return originalSend(body);
    };
  }
  if (originalJson) {
    res.json = (body) => {
      captured.body = body;
      captured.contentType = headerToString(res.getHeader("content-type")) ?? "application/json";
      return originalJson(body);
    };
  }
  return captured;
}
function captureInboundBodies(req, responseBody, responseContentType, options) {
  if (!options) {
    return {
      requestBodyCaptureStatus: "disabled",
      responseBodyCaptureStatus: "disabled",
      requestBodyCaptureReason: "HTTP body capture is disabled by SDK configuration.",
      responseBodyCaptureReason: "HTTP body capture is disabled by SDK configuration."
    };
  }
  const contentTypes = options.contentTypes ?? ["application/json", "text/plain"];
  const maxBodySize = Math.max(0, options.maxBodySize ?? 8192);
  const requestContentType = firstHeader(req.headers["content-type"]);
  const requestCapture = sanitizeBodyForTransport(req.body, requestContentType, contentTypes, maxBodySize, options.redactFields);
  const responseCapture = sanitizeBodyForTransport(responseBody, responseContentType, contentTypes, maxBodySize, options.redactFields);
  return {
    requestBody: requestCapture.body,
    responseBody: responseCapture.body,
    requestSize: requestCapture.sizeBytes,
    responseSize: responseCapture.sizeBytes,
    requestBodyCaptureStatus: requestCapture.status,
    responseBodyCaptureStatus: responseCapture.status,
    requestBodyCaptureReason: requestCapture.reason,
    responseBodyCaptureReason: responseCapture.reason
  };
}
function sanitizeBodyForTransport(value, contentType, allowedContentTypes, maxBodySize, redactFields) {
  if (value == null || value === "") {
    return { status: "empty", reason: "Body was empty.", sizeBytes: 0 };
  }
  if (!isAllowedContentType(contentType, allowedContentTypes)) {
    return { status: "unsupported", reason: "Content type is not allowlisted for HTTP body capture." };
  }
  const raw = typeof value === "string" || Buffer.isBuffer(value) ? value.toString() : JSON.stringify(redactValue(value, { extraKeys: redactFields }), null, 2);
  const truncated = raw.length > maxBodySize;
  const body = truncated ? raw.slice(0, maxBodySize) + "\n[TRUNCATED]" : raw;
  return {
    body,
    status: truncated ? "truncated" : "captured",
    reason: truncated ? `Body exceeded configured max size of ${maxBodySize} bytes.` : void 0,
    sizeBytes: raw.length
  };
}
function isAllowedContentType(contentType, allowed) {
  if (!contentType) return false;
  return allowed.some((candidate) => contentType.toLowerCase().includes(candidate.toLowerCase()));
}
function redactHeaders(headers, extraKeys) {
  const redacted = redactHeaderRecord(headers, { extraKeys }) ?? {};
  return Object.fromEntries(
    Object.entries(redacted).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(", ") : value
    ])
  );
}
function redactResponseHeaders(res, extraKeys) {
  const headers = {};
  for (const name of ["content-type", "content-length", "x-allstak-request-id"]) {
    const value = res.getHeader(name);
    if (typeof value === "string") headers[name] = value;
    else if (typeof value === "number") headers[name] = String(value);
    else if (Array.isArray(value)) headers[name] = value.map(String);
  }
  return redactHeaders(headers, extraKeys);
}
function headerToString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(String).join(", ");
  return void 0;
}
var express_default = allstakExpress;
export {
  allstakExpress,
  express_default as default
};
//# sourceMappingURL=express.mjs.map