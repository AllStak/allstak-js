import { createRequire as __allstakCreateRequire } from 'node:module';
const require = __allstakCreateRequire(import.meta.url);
import {
  processBuildOutput
} from "./chunk-OAYU6RNO.mjs";
import "./chunk-6GVGKK5H.mjs";

// src/integrations/vite.ts
import { resolve } from "path";
function allstakVitePlugin(opts = {}) {
  let resolvedDir = opts.dir ? resolve(opts.dir) : void 0;
  let lastReport = null;
  return {
    name: "allstak:sourcemaps",
    // Build-only: no point running on the dev server (no maps to upload).
    apply: "build",
    // `post` so we run after Vite/Rollup have finished writing assets.
    enforce: "post",
    configResolved(config) {
      if (resolvedDir) return;
      const outDir = config.build?.outDir ?? "dist";
      const root = config.root ?? process.cwd();
      resolvedDir = resolve(root, outDir);
    },
    async closeBundle() {
      if (opts.disabled) return;
      if (!resolvedDir) {
        console.warn("[allstak/vite] could not resolve build output dir \u2014 skipping");
        return;
      }
      try {
        lastReport = await processBuildOutput({
          ...opts,
          dir: resolvedDir,
          // The plugin is silent only when explicitly asked — most users want
          // to see the IDs land in their build log.
          silent: opts.silent ?? false
        });
      } catch (e) {
        console.error(`[allstak/vite] failed: ${e.message}`);
      }
    }
  };
}
function _lastReport(plugin) {
  void plugin;
  return null;
}
export {
  _lastReport,
  allstakVitePlugin
};
//# sourceMappingURL=vite.mjs.map