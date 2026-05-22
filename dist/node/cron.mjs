import { createRequire as __allstakCreateRequire } from 'node:module';
const require = __allstakCreateRequire(import.meta.url);
import {
  AllStak
} from "./chunk-I6GQYBPI.mjs";
import "./chunk-2Z2PH3DC.mjs";
import "./chunk-6GVGKK5H.mjs";

// src/integrations/cron.ts
var SLUG_RE = /^[a-z0-9-]+$/;
function normalizeSlug(slug) {
  return slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, 64);
}
function monitor(slug, fn) {
  const safeSlug = normalizeSlug(slug);
  if (!SLUG_RE.test(safeSlug)) {
    throw new Error(`AllStak.monitor: invalid slug '${slug}' \u2014 must match ${SLUG_RE}`);
  }
  return async function monitored(...args) {
    const start = Date.now();
    try {
      const result = await fn.apply(this, args);
      try {
        AllStak.heartbeat({
          slug: safeSlug,
          status: "success",
          durationMs: Date.now() - start
        });
      } catch {
      }
      return result;
    } catch (err) {
      try {
        AllStak.heartbeat({
          slug: safeSlug,
          status: "failed",
          durationMs: Date.now() - start,
          message: err instanceof Error ? err.message : String(err)
        });
      } catch {
      }
      throw err;
    }
  };
}
var cron_default = { monitor };
export {
  cron_default as default,
  monitor
};
//# sourceMappingURL=cron.mjs.map