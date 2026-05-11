/**
 * Debug-ID injection.
 *
 * For each `(bundle.js, bundle.js.map)` pair we:
 *
 *   - Generate a stable per-bundle UUID (one already on the bundle is
 *     reused so re-running is idempotent — repeated builds don't churn
 *     the registry).
 *   - Append `//# debugId=<uuid>` to the JS so the runtime resolver in
 *     `src/utils/debug-id.ts` can read it back.
 *   - Write a top-level `debugId` field into the `.map` JSON so the
 *     symbolicator on the backend can join `bundle.js` ↔ `bundle.js.map`
 *     by ID rather than by guessing from filenames.
 *
 * Bundlers re-write hashed filenames on every build, so joining by ID
 * (instead of by URL or path) is what makes resolved stack frames
 * survive across releases.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type { BundlePair } from './walk';

const DEBUG_ID_LINE_RE = /^\/\/# debugId=([0-9a-f-]{36})\s*$/m;

/**
 * Marker for the self-registration snippet so we can find and replace
 * it on re-injection (idempotency).
 */
const REGISTRATION_MARKER = '/*!__allstak_debug_id_registration__*/';

/**
 * Build the chunk-self-registration snippet.
 *
 * In ESM (Vite output, modern Webpack), `import.meta.url` is the chunk's
 * own URL. In classic scripts (some library bundles, IIFE builds),
 * `document.currentScript.src` plays the same role. We pick which form
 * to emit based on whether the bundle uses `import.meta` syntax — using
 * `import.meta.url` in a non-module is a hard SyntaxError.
 */
function buildRegistrationSnippet(jsBody: string, debugId: string): string {
  const isEsm = /\bimport\.meta\b/.test(jsBody) || /^\s*(?:import|export)\b/m.test(jsBody);
  // Single-line so it's invisible in pretty-printed bundles. The IIFE
  // wrapper means the snippet's locals never escape into the chunk's
  // module scope, even in strict mode.
  if (isEsm) {
    return `${REGISTRATION_MARKER}try{(globalThis._allstakDebugIds=globalThis._allstakDebugIds||{})[import.meta.url]="${debugId}"}catch(_){}`;
  }
  return `${REGISTRATION_MARKER}(function(){try{var u=(typeof document!=="undefined"&&document.currentScript&&document.currentScript.src)||(typeof location!=="undefined"?location.href:"");(globalThis._allstakDebugIds=globalThis._allstakDebugIds||{})[u]="${debugId}"}catch(_){}})();`;
}

/** Strip any prior `REGISTRATION_MARKER` line so re-injection stays idempotent. */
function stripRegistration(js: string): string {
  // The marker is unique enough that a line-based regex is robust across
  // the two snippet shapes (ESM vs classic).
  const lineRe = new RegExp(
    '^' + REGISTRATION_MARKER.replace(/[/*!]/g, (c) => '\\' + c) + '.*$',
    'm',
  );
  return js.replace(lineRe, '');
}

/** Outcome of injecting one pair. */
export interface InjectResult {
  /** UUID injected (or reused) for this bundle. */
  debugId: string;
  /** True if the bundle already had a debugId — we reused it. */
  reused: boolean;
}

/**
 * Inject (or reuse) the debug ID for a single bundle/sourcemap pair.
 *
 * Mutates both files on disk. Pure synchronous Node — safe to call from
 * a Vite `closeBundle` or Webpack `afterEmit` hook.
 */
export function injectPair(p: BundlePair): InjectResult {
  const jsRaw = readFileSync(p.jsPath, 'utf8');
  const mapRaw = readFileSync(p.mapPath, 'utf8');
  const map = JSON.parse(mapRaw) as { debugId?: unknown; [k: string]: unknown };

  // Resolution order: existing map.debugId → existing line in JS → new UUID.
  // Either source surviving means we keep the same ID across rebuilds.
  let debugId = typeof map.debugId === 'string' ? map.debugId : '';
  const existing = DEBUG_ID_LINE_RE.exec(jsRaw);
  if (existing && existing[1]) debugId = debugId || existing[1];
  const reused = !!debugId;
  if (!debugId) debugId = randomUUID();

  // Map: write back with a canonical `debugId` field. We re-stringify
  // even when nothing changed because some bundlers leave the map
  // pretty-printed and we want the backend to see a stable byte stream.
  map.debugId = debugId;
  writeFileSync(p.mapPath, JSON.stringify(map));

  // JS: ensure exactly one debugId line + one self-registration line
  // at the tail. We strip both the prior debugId comment and the prior
  // registration line so re-injection never duplicates.
  let jsOut = stripRegistration(jsRaw.replace(DEBUG_ID_LINE_RE, ''));
  jsOut = jsOut.replace(/\s+$/, '');
  jsOut += `\n${buildRegistrationSnippet(jsOut, debugId)}\n//# debugId=${debugId}\n`;
  writeFileSync(p.jsPath, jsOut);

  return { debugId, reused };
}

/** Inject every pair under `root`. Returns one record per pair. */
export function injectAll(pairs: BundlePair[]): Array<{ pair: BundlePair; result: InjectResult }> {
  return pairs.map((pair) => ({ pair, result: injectPair(pair) }));
}

/**
 * Read a debug ID back from a `.map` file.
 * Used by the upload step to join the in-memory state to disk artifacts.
 */
export function readDebugIdFromMap(mapPath: string): string | null {
  const json = JSON.parse(readFileSync(mapPath, 'utf8')) as { debugId?: unknown };
  return typeof json.debugId === 'string' ? json.debugId : null;
}
