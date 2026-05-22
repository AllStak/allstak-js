import { createRequire as __allstakCreateRequire } from 'node:module';
const require = __allstakCreateRequire(import.meta.url);
import {
  AllStak
} from "./chunk-LH2BGYDJ.mjs";
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
  requestHandler() {
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
      const upstreamTrace = firstHeader(req.headers["x-allstak-trace-id"]) ?? firstHeader(req.headers["x-trace-id"]) ?? traceIdFromTraceparent(firstHeader(req.headers["traceparent"]));
      sdk.withTraceContext(upstreamTrace, () => {
        let rootSpan = null;
        try {
          rootSpan = sdk.startSpan(`${method} ${path}`, {
            description: `HTTP ${method} ${path}`,
            tags: {
              "http.method": method,
              "http.url": path,
              "http.host": host
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
              direction: "inbound",
              method,
              host,
              path,
              statusCode: res.statusCode,
              durationMs,
              userId: u?.id,
              timestamp: new Date(start).toISOString()
            });
            if (rootSpan) {
              try {
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
          AllStak.captureException(e, {
            httpMethod: methodOf(req),
            httpPath: pathFromRequest(req),
            httpHost: hostOf(req)
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
var express_default = allstakExpress;
export {
  allstakExpress,
  express_default as default
};
//# sourceMappingURL=express.mjs.map